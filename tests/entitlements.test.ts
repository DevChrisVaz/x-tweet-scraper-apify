import { createHmac, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequest,
  EntitlementService,
  InMemoryEntitlementRepository,
  verifyRequest,
} from '../src/entitlements.js';
import { ActorEntitlementClient, EmissionGuard } from '../src/emission.js';

const subject = { actorId: 'actor-1', runId: 'run-1', userId: 'user-1' } as const;
const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function signedResolution(payload: { tier: 'free' | 'paid' | 'unknown'; effectiveLimit: number; expiresAt: string; issuedAt?: string }) {
  const unsigned = {
    subject,
    tier: payload.tier,
    effectiveLimit: payload.effectiveLimit,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt ?? '2023-11-14T22:13:20.000Z',
  };
  return { ...unsigned, signature: signBytes(null, Buffer.from(canonicalJson(unsigned)), keyPair.privateKey).toString('base64url'), keyId: 'test-key' };
}

function authHeaders(body: unknown, secret = 'hmac-secret', now = 1_700_000_000_000) {
  const timestamp = String(now);
  const nonce = 'nonce-1';
  const canonical = canonicalRequest('POST', '/entitlements/resolve', timestamp, nonce, body);
  const signature = createHmac('sha256', secret).update(canonical).digest('base64url');
  return { 'x-entitlement-timestamp': timestamp, 'x-entitlement-nonce': nonce, 'x-entitlement-signature': signature };
}

describe('entitlement authentication', () => {
  it('canonicalizes equivalent request objects and verifies HMAC with clock skew and nonce replay checks', async () => {
    const body = { subject, maxResults: 1_000 };
    expect(canonicalRequest('POST', '/entitlements/resolve', '1700000000000', 'nonce-1', body))
      .toBe(canonicalRequest('POST', '/entitlements/resolve', '1700000000000', 'nonce-1', { maxResults: 1000, subject }));
    const replayed = new Set<string>();
    const first = await verifyRequest({ method: 'POST', path: '/entitlements/resolve', headers: authHeaders(body), body }, {
      secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: replayed,
    });
    expect(first.subject).toEqual(subject);
    await expect(verifyRequest({ method: 'POST', path: '/entitlements/resolve', headers: authHeaders(body), body }, {
      secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: replayed,
    })).rejects.toThrow(/replay/i);
    await expect(verifyRequest({ method: 'POST', path: '/entitlements/resolve', headers: authHeaders(body, 'wrong'), body }, {
      secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: new Set(),
    })).rejects.toThrow(/signature/i);
    await expect(verifyRequest({ method: 'POST', path: '/entitlements/resolve', headers: authHeaders(body, 'hmac-secret', 1_700_100_000_000), body }, {
      secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: new Set(),
    })).rejects.toThrow(/timestamp/i);
  });

  it('keeps nonce replay protection in durable repository state across caller resets', async () => {
    const repository = new InMemoryEntitlementRepository();
    const body = { subject, maxResults: 100 };
    const request = { method: 'POST', path: '/entitlements/resolve', headers: authHeaders(body), body };
    await verifyRequest(request, { secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: new Set(), claimNonce: (nonce, ttl) => repository.claimNonce(nonce, ttl) });
    await expect(verifyRequest(request, { secret: 'hmac-secret', now: 1_700_000_000_000, replayedNonces: new Set(), claimNonce: (nonce, ttl) => repository.claimNonce(nonce, ttl) })).rejects.toThrow(/replay/i);
  });
});

describe('frozen entitlement reservations', () => {
  it('caps each free run at the smaller of the requested limit and ten', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, {
      signingPrivateKey: keyPair.privateKey,
      signingKeyId: 'test-key',
      now: () => 1_700_000_000_000,
    });
    for (const [requested, expected] of [[1, 1], [9, 9], [10, 10], [1_000, 10]] as const) {
      const resolution = await service.resolve({ subject: { ...subject, runId: `free-${requested}` }, maxResults: requested, isPaying: false });
      expect(resolution.effectiveLimit).toBe(expected);
    }
  });

  it('free runs freeze 10, paid runs freeze maxResults, and duplicate IDs are idempotent', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, {
      signingPrivateKey: keyPair.privateKey,
      signingKeyId: 'test-key',
      now: () => 1_700_000_000_000,
    });
    const free = await service.resolve({ subject, maxResults: 1_000, isPaying: false });
    expect(free.effectiveLimit).toBe(10);
    const paid = await service.resolve({ subject: { ...subject, runId: 'run-2' }, maxResults: 100, isPaying: true });
    expect(paid.effectiveLimit).toBe(100);
    const first = await service.reserve({ subject, tweetIds: ['tweet-1', 'tweet-2'] });
    const duplicate = await service.reserve({ subject, tweetIds: ['tweet-1', 'tweet-2'] });
    expect(first.decisions).toHaveLength(2);
    expect(duplicate.decisions).toEqual(first.decisions);
    expect(await service.reserve({ subject, tweetIds: Array.from({ length: 20 }, (_, i) => `tweet-${i + 3}`) })).toHaveProperty('decisions');
    expect((await service.reserve({ subject, tweetIds: ['tweet-99'] })).decisions[0]?.decision).toBe('deny');
  });
});

describe('actor emission guard', () => {
  it('accepts only a valid grant bound to the actor subject and refuses service failures', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test-key', now: () => 1_700_000_000_000 });
    await service.resolve({ subject, maxResults: 100, isPaying: false });
    await service.resolve({ subject: { ...subject, userId: 'other' }, maxResults: 100, isPaying: false });
    const client = new ActorEntitlementClient({
      subject,
      platformIsPaying: false,
      maxResults: 100,
      hmacSecret: 'hmac-secret',
      signer: async (request) => service.handleReservation({ subject, tweetIds: request.tweetIds }),
      pinnedPublicKey: publicKey,
      now: () => 1_700_000_000_000,
    });
    const guard = new EmissionGuard(client);
    const grant = await guard.reserve('tweet-1');
    expect(grant).toBe(true);
    expect(await guard.canEmit('tweet-1')).toBe(true);
    expect(await guard.canEmit('tweet-2')).toBe(false);
    const failing = new EmissionGuard(new ActorEntitlementClient({ subject, platformIsPaying: false, maxResults: 100, hmacSecret: 'hmac-secret', signer: async () => { throw new Error('offline'); }, pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 }));
    expect(await failing.reserve('tweet-3')).toBe(false);
    expect(await failing.canEmit('tweet-3')).toBe(false);
  });

  it('records a validated reservation batch before serialized emissions', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test-key', now: () => 1_700_000_000_000 });
    await service.resolve({ subject, maxResults: 100, isPaying: false });
    const client = new ActorEntitlementClient({
      subject, platformIsPaying: false, maxResults: 100, hmacSecret: 'hmac-secret',
      signer: async (request) => service.handleReservation({ subject, tweetIds: request.tweetIds }), pinnedPublicKey: publicKey, now: () => 1_700_000_000_000,
    });
    const guard = new EmissionGuard(client);
    await expect(guard.reserveBatch(['tweet-1', 'tweet-2'])).resolves.toEqual({ grantedIds: new Set(['tweet-1', 'tweet-2']), deniedIds: new Set() });
    expect(await guard.canEmit('tweet-1')).toBe(true);
    expect(await guard.canEmit('tweet-2')).toBe(true);
  });

  it('returns signed denials separately from grants and propagates signer outages', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test-key', now: () => 1_700_000_000_000 });
    await service.resolve({ subject, maxResults: 1, isPaying: true });
    const client = new ActorEntitlementClient({
      subject, platformIsPaying: true, maxResults: 1, hmacSecret: 'hmac-secret',
      signer: async (request) => service.handleReservation({ subject, tweetIds: request.tweetIds }), pinnedPublicKey: publicKey, now: () => 1_700_000_000_000,
    });
    const guard = new EmissionGuard(client);
    await expect(guard.reserveBatch(['tweet-1', 'tweet-2'])).resolves.toEqual({ grantedIds: new Set(['tweet-1']), deniedIds: new Set(['tweet-2']) });
    const offline = new EmissionGuard(new ActorEntitlementClient({
      subject, platformIsPaying: true, maxResults: 1, hmacSecret: 'hmac-secret', signer: async () => { throw new Error('signer offline'); }, pinnedPublicKey: publicKey, now: () => 1_700_000_000_000,
    }));
    await expect(offline.reserveBatch(['tweet-3'])).rejects.toThrow('signer offline');
  });

  it('does not emit a cached grant after its signed expiry', async () => {
    let now = 1_700_000_000_000;
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test-key', now: () => 1_700_000_000_000 });
    await service.resolve({ subject, maxResults: 1, isPaying: false });
    const client = new ActorEntitlementClient({
      subject, platformIsPaying: false, maxResults: 1, hmacSecret: 'hmac-secret',
      signer: async (request) => service.handleReservation({ subject, tweetIds: request.tweetIds }), pinnedPublicKey: publicKey, now: () => now,
    });
    const guard = new EmissionGuard(client);
    await guard.reserveBatch(['tweet-1']);
    now += 8 * 24 * 60 * 60 * 1_000;
    let pushed = false;
    await expect(guard.emit('tweet-1', async () => { pushed = true; })).rejects.toThrow(/expired/i);
    expect(pushed).toBe(false);
  });

  it('rejects a signed response whose subject does not match the platform identity', async () => {
    const repository = new InMemoryEntitlementRepository();
    const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test-key', now: () => 1_700_000_000_000 });
    await service.resolve({ subject, maxResults: 100, isPaying: false });
    await service.resolve({ subject: { ...subject, userId: 'other' }, maxResults: 100, isPaying: false });
    const client = new ActorEntitlementClient({
      subject,
      platformIsPaying: false,
      maxResults: 100,
      hmacSecret: 'hmac-secret',
      signer: async (request) => service.handleReservation({ subject: { ...subject, userId: 'other' }, tweetIds: request.tweetIds }),
      pinnedPublicKey: publicKey,
      now: () => 1_700_000_000_000,
    });
    await expect(client.reserve(['tweet-1'])).rejects.toThrow(/subject/i);
  });
});

describe('actor resolution validation', () => {
  it('rejects a signed resolution with a non-finite expiry before sources begin', async () => {
    const client = new ActorEntitlementClient({
      subject, platformIsPaying: false, maxResults: 100, hmacSecret: 'hmac-secret', pinnedPublicKey: publicKey, now: () => 1_700_000_000_000,
      resolver: async () => signedResolution({ tier: 'free', effectiveLimit: 10, expiresAt: 'not-a-date' }) as never,
      signer: async () => { throw new Error('not used'); },
    });
    await expect(client.resolve()).rejects.toThrow(/datetime|expiry/i);
  });

  it('rejects signed tier limits that exceed the local free, unknown, or requested cap', async () => {
    const cases = [
      signedResolution({ tier: 'unknown', effectiveLimit: 1, expiresAt: '2025-01-01T00:00:00.000Z' }),
      signedResolution({ tier: 'free', effectiveLimit: 11, expiresAt: '2025-01-01T00:00:00.000Z' }),
      signedResolution({ tier: 'paid', effectiveLimit: 101, expiresAt: '2025-01-01T00:00:00.000Z' }),
    ];
    for (const response of cases) {
      const client = new ActorEntitlementClient({
        subject, platformIsPaying: true, maxResults: 100, hmacSecret: 'hmac-secret', pinnedPublicKey: publicKey, now: () => 1_700_000_000_000,
        resolver: async () => response as never,
        signer: async () => { throw new Error('not used'); },
      });
      await expect(client.resolve()).rejects.toThrow(/limit/i);
    }
  });
});

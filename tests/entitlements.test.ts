import { createHmac, generateKeyPairSync } from 'node:crypto';
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

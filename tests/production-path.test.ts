import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEntitlementHandlers } from '../src/entitlement-http.js';
import { ActorEntitlementClient, createPlatformEntitlementClient, payingFromActorEnv, platformEntitlementIdentity, subjectFromActorEnv } from '../src/emission.js';
import {
  EntitlementService,
  InMemoryEntitlementRepository,
  UpstashEntitlementRepository,
  canonicalRequest,
  subjectStorageKey,
} from '../src/entitlements.js';

const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const endpoint = 'https://entitlements.example.test';

vi.mock('apify', () => ({ Actor: { getEnv: () => ({ actorId: 'actor-1', actorRunId: 'run-sdk-paid', userId: 'user-sdk-paid', userIsPaying: '1' }) } }));

function routeFetcher(handlers: ReturnType<typeof createEntitlementHandlers>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    return request.url.endsWith('/entitlements/resolve') ? handlers.resolve(request) : handlers.reserve(request);
  };
}

function createHandlers() {
  const repository = new InMemoryEntitlementRepository();
  const service = new EntitlementService(repository, {
    signingPrivateKey: keyPair.privateKey,
    signingKeyId: 'test-key',
    now: () => 1_700_000_000_000,
  });
  const handlers = createEntitlementHandlers({
    secret: 'hmac-secret',
    canonicalActorId: 'actor-1',
    repository,
    service,
    replayedNonces: new Set(),
    now: 1_700_000_000_000,
  });
  return { handlers, service };
}

describe('Actor HTTP to Vercel entitlement path', () => {
  it('uses only the Apify runtime user and payer fields, never a caller-style user override', () => {
    const identity = platformEntitlementIdentity({ actorId: 'actor-1', actorRunId: 'run-1', userId: 'runtime-user', APIFY_USER_ID: 'caller-user', userIsPaying: '1' });
    expect(identity).toEqual({ subject: { actorId: 'actor-1', runId: 'run-1', userId: 'runtime-user' }, isPaying: true });
    expect(() => subjectFromActorEnv({ actorId: 'actor-1', actorRunId: 'run-1', APIFY_USER_ID: 'caller-user' })).toThrow(/identity/i);
    expect(payingFromActorEnv({ userIsPaying: 'unrecognized' })).toBe(false);
  });

  it('creates a paid client from the real ApifyEnv shape and resolves the requested cap', async () => {
    const { handlers } = createHandlers();
    const client = await createPlatformEntitlementClient({ maxResults: 100, hmacSecret: 'hmac-secret', endpoint, fetcher: routeFetcher(handlers), pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 });
    expect((await client.resolve()).effectiveLimit).toBe(100);
  });

  it('resolves trusted payer identity then reserves through the concrete HTTP client', async () => {
    const { handlers } = createHandlers();
    const client = new ActorEntitlementClient({
      subject: { actorId: 'actor-1', runId: 'run-paid', userId: 'user-paid' },
      platformIsPaying: true,
      maxResults: 100,
      hmacSecret: 'hmac-secret',
      endpoint,
      fetcher: routeFetcher(handlers),
      pinnedPublicKey: publicKey,
      pinnedKeyId: 'test-key',
      now: () => 1_700_000_000_000,
    });
    const resolution = await client.resolve();
    expect(resolution.effectiveLimit).toBe(100);
    const reservation = await client.reserve(['tweet-1']);
    expect(reservation.decisions[0]?.decision).toBe('grant');
  });

  it('trusts payer status per authenticated run and never shares limits between users', async () => {
    const { handlers } = createHandlers();
    const paid = new ActorEntitlementClient({ subject: { actorId: 'actor-1', runId: 'run-paid', userId: 'user-paid' }, platformIsPaying: true, maxResults: 100, hmacSecret: 'hmac-secret', endpoint, fetcher: routeFetcher(handlers), pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 });
    const free = new ActorEntitlementClient({ subject: { actorId: 'actor-1', runId: 'run-free', userId: 'user-free' }, platformIsPaying: false, maxResults: 1_000, hmacSecret: 'hmac-secret', endpoint, fetcher: routeFetcher(handlers), pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 });
    expect((await paid.resolve()).effectiveLimit).toBe(100);
    expect((await free.resolve()).effectiveLimit).toBe(10);
  });

  it('uses a fresh random transport nonce for each retry while keeping the request body idempotent', async () => {
    const { handlers } = createHandlers();
    const nonces: string[] = [];
    const baseFetcher = routeFetcher(handlers);
    const client = new ActorEntitlementClient({ subject: { actorId: 'actor-1', runId: 'run-retry', userId: 'user-1' }, platformIsPaying: false, maxResults: 100, hmacSecret: 'hmac-secret', endpoint, fetcher: async (input, init) => {
      nonces.push(new Headers(init?.headers).get('x-entitlement-nonce') ?? '');
      return baseFetcher(input, init);
    }, pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 });
    await client.resolve();
    await client.resolve();
    expect(nonces[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('rejects a tampered Ed25519 response before a grant can be used', async () => {
    const { handlers } = createHandlers();
    const baseFetcher = routeFetcher(handlers);
    const client = new ActorEntitlementClient({ subject: { actorId: 'actor-1', runId: 'run-bad-signature', userId: 'user-1' }, platformIsPaying: false, maxResults: 100, hmacSecret: 'hmac-secret', endpoint, fetcher: async (input, init) => {
      const response = await baseFetcher(input, init);
      if (String(input).endsWith('/entitlements/resolve')) return response;
      const payload = await response.json() as { signature: string; [key: string]: unknown };
      return Response.json({ ...payload, signature: `${payload.signature[0] === 'A' ? 'B' : 'A'}${payload.signature.slice(1)}` });
    }, pinnedPublicKey: publicKey, now: () => 1_700_000_000_000 });
    await client.resolve();
    await expect(client.reserve(['tweet-1'])).rejects.toThrow(/signature/i);
  });

  it('hashes the canonical subject so separator-containing IDs cannot alias another run', () => {
    expect(subjectStorageKey({ actorId: 'a:b', runId: 'c', userId: 'd' })).not.toBe(subjectStorageKey({ actorId: 'a', runId: 'b:c', userId: 'd' }));
  });

  it('rejects replayed and tampered wire requests', async () => {
    const { handlers } = createHandlers();
    const body = { version: 1, actorId: 'actor-1', runId: 'run-1', userId: 'user-1', platformIsPaying: false, requestedMaxResults: 100 };
    const timestamp = '1700000000000';
    const nonce = 'fixed-test-nonce';
    const signature = createHmac('sha256', 'hmac-secret').update(canonicalRequest('POST', '/entitlements/resolve', timestamp, nonce, body)).digest('base64url');
    const request = () => new Request(`${endpoint}/entitlements/resolve`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-entitlement-timestamp': timestamp, 'x-entitlement-nonce': nonce, 'x-entitlement-signature': signature } });
    expect((await handlers.resolve(request())).status).toBe(200);
    expect((await handlers.resolve(request())).status).toBe(401);
    const tampered = { ...body, requestedMaxResults: 10_000 };
    expect((await handlers.resolve(new Request(`${endpoint}/entitlements/resolve`, { method: 'POST', body: JSON.stringify(tampered), headers: { 'x-entitlement-timestamp': timestamp, 'x-entitlement-nonce': 'tampered-nonce', 'x-entitlement-signature': signature } }))).status).toBe(401);
  });
});

describe('Upstash persisted reservation boundary', () => {
  it('initializes the Lua map and preserves first, duplicate, cap, and TTL behavior', async () => {
    const values = new Map<string, string>();
    const ttls = new Map<string, number>();
    const calls: unknown[][] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      calls.push(command);
      const op = String(command[0]);
      const key = op === 'EVAL' ? String(command[3] ?? '') : String(command[1] ?? '');
      if (op === 'GET') return Response.json({ result: values.get(key) ?? null });
      if (op === 'SET' && command[3] === 'NX') {
        if (values.has(key)) return Response.json({ result: null });
        values.set(key, String(command[2]));
        ttls.set(key, Number(command[5]));
        return Response.json({ result: 'OK' });
      }
      if (op === 'SET') {
        values.set(key, String(command[2]));
        return Response.json({ result: 'OK' });
      }
      if (op === 'EVAL') {
        expect(String(command[1])).toContain('run.granted = run.granted or {}');
        const run = JSON.parse(values.get(key) ?? '{}') as { reserved: number; effectiveLimit: number; granted?: Record<string, true> };
        run.granted ??= {};
        const granted: string[] = [];
        const decisions: boolean[] = [];
        for (const hash of command.slice(4).map(String)) {
          if (run.granted[hash] === true) {
            granted.push(hash);
            decisions.push(true);
          } else if (run.reserved < run.effectiveLimit) {
            run.reserved += 1;
            run.granted[hash] = true;
            granted.push(hash);
            decisions.push(true);
          } else decisions.push(false);
        }
        values.set(key, JSON.stringify(run));
        return Response.json({ result: [JSON.stringify(granted), decisions.map((value) => value ? '1' : '0').join(',')] });
      }
      return Response.json({ result: null });
    };
    const repository = new UpstashEntitlementRepository('https://redis.test', 'token', fetcher);
    const subject = { actorId: 'actor-1', runId: 'run-1', userId: 'user-1' };
    await repository.getOrCreateRun({ subject, tier: 'free', effectiveLimit: 1, issuedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-08T00:00:00.000Z' });
    const key = [...values.keys()][0] ?? '';
    expect(JSON.parse(values.get(key) ?? '{}')).toMatchObject({ effectiveLimit: 1, reserved: 0, granted: {} });
    expect(ttls.get(key)).toBe(604_800);
    expect(await repository.reserve({ subject, hashes: ['hash-1'], effectiveLimit: 1, expiresAt: '2025-01-08T00:00:00.000Z' })).toEqual({ grantedHashes: ['hash-1'], decisions: [true] });
    expect(await repository.reserve({ subject, hashes: ['hash-1'], effectiveLimit: 1, expiresAt: '2025-01-08T00:00:00.000Z' })).toEqual({ grantedHashes: ['hash-1'], decisions: [true] });
    expect(await repository.reserve({ subject, hashes: ['hash-2'], effectiveLimit: 1, expiresAt: '2025-01-08T00:00:00.000Z' })).toEqual({ grantedHashes: [], decisions: [false] });
    expect(ttls.get(key)).toBe(604_800);
    expect(calls.filter((call) => String(call[0]) === 'EVAL')).toHaveLength(3);
  });
});

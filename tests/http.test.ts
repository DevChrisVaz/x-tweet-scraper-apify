import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEntitlementHandlers } from '../src/entitlement-http.js';
import { EntitlementService, InMemoryEntitlementRepository, canonicalRequest } from '../src/entitlements.js';

function setup() {
  const keyPair = generateKeyPairSync('ed25519');
  const repository = new InMemoryEntitlementRepository();
  const service = new EntitlementService(repository, { signingPrivateKey: keyPair.privateKey, signingKeyId: 'test', now: () => 1_700_000_000_000 });
  return { handlers: createEntitlementHandlers({ secret: 'secret', canonicalActorId: 'actor-1', repository, service, replayedNonces: new Set(), now: 1_700_000_000_000 }), service };
}

async function signedRequest(path: string, body: unknown, nonce: string, signatureSecret = 'secret'): Promise<Request> {
  const timestamp = '1700000000000';
  const signature = createHmac('sha256', signatureSecret).update(canonicalRequest('POST', path, timestamp, nonce, body)).digest('base64url');
  return new Request(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-entitlement-timestamp': timestamp, 'x-entitlement-nonce': nonce, 'x-entitlement-signature': signature } });
}

describe('Vercel entitlement handlers', () => {
  it('uses platform paying identity and freezes free resolution at ten', async () => {
    const { handlers } = setup();
    const body = { version: 1, actorId: 'actor-1', runId: 'run-1', userId: 'user-1', platformIsPaying: false, requestedMaxResults: 1000 };
    const response = await handlers.resolve(await signedRequest('/entitlements/resolve', body, 'resolve-1'));
    expect(response.status).toBe(200);
    const result = await response.json() as { tier: string; effectiveLimit: number };
    expect(result.tier).toBe('free');
    expect(result.effectiveLimit).toBe(10);
  });

  it('rejects a bad HMAC and a non-canonical actor before resolving', async () => {
    const { handlers } = setup();
    const body = { version: 1, actorId: 'forked-actor', runId: 'run-1', userId: 'user-1', platformIsPaying: true, requestedMaxResults: 100 };
    const response = await handlers.resolve(await signedRequest('/entitlements/resolve', body, 'resolve-2', 'wrong'));
    expect(response.status).toBe(401);
    const mismatch = await handlers.resolve(await signedRequest('/entitlements/resolve', body, 'resolve-3'));
    expect(mismatch.status).toBe(401);
  });
});

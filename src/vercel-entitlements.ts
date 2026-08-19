import { createPrivateKey } from 'node:crypto';
import { EntitlementService, UpstashEntitlementRepository } from './entitlements.js';
import { createEntitlementHandlers } from './entitlement-http.js';

function privateKeyFromEnvironment(value: string) {
  try {
    return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    return createPrivateKey(value);
  }
}

export function getEntitlementHandlers() {
  const privateKey = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY;
  const secret = process.env.ENTITLEMENT_HMAC_SECRET;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const actorId = process.env.CANONICAL_ACTOR_ID;
  const keyId = process.env.ENTITLEMENT_SIGNING_KEY_ID ?? 'primary';
  if (!privateKey || !secret || !url || !token || !actorId) throw new Error('entitlement service configuration is incomplete');
  const repository = new UpstashEntitlementRepository(url, token);
  const service = new EntitlementService(repository, { signingPrivateKey: privateKeyFromEnvironment(privateKey), signingKeyId: keyId });
  return createEntitlementHandlers({ secret, canonicalActorId: actorId, repository, service });
}

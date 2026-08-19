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

export interface RedisEnvironment {
  url: string;
  token: string;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Canonical aliases win; Vercel Marketplace's KV names are the compatibility fallback. */
export function redisEnvironment(environment: Record<string, string | undefined> = process.env): RedisEnvironment | null {
  const url = nonBlank(environment.UPSTASH_REDIS_REST_URL) ?? nonBlank(environment.KV_REST_API_URL);
  const token = nonBlank(environment.UPSTASH_REDIS_REST_TOKEN) ?? nonBlank(environment.KV_REST_API_TOKEN);
  return url === undefined || token === undefined ? null : { url, token };
}

export function getEntitlementHandlers() {
  const privateKey = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY;
  const secret = process.env.ENTITLEMENT_HMAC_SECRET;
  const redis = redisEnvironment();
  const actorId = process.env.CANONICAL_ACTOR_ID;
  const keyId = process.env.ENTITLEMENT_SIGNING_KEY_ID ?? 'primary';
  if (!privateKey || !secret || !redis || !actorId) throw new Error('entitlement service configuration is incomplete');
  const repository = new UpstashEntitlementRepository(redis.url, redis.token);
  const service = new EntitlementService(repository, { signingPrivateKey: privateKeyFromEnvironment(privateKey), signingKeyId: keyId });
  return createEntitlementHandlers({ secret, canonicalActorId: actorId, repository, service });
}

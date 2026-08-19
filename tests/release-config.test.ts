import { describe, expect, it } from 'vitest';
import { redisEnvironment } from '../src/vercel-entitlements.js';

describe('Marketplace entitlement environment mapping', () => {
  it('prefers canonical UPSTASH names when both canonical and Marketplace names exist', () => {
    expect(redisEnvironment({
      UPSTASH_REDIS_REST_URL: 'https://canonical.example',
      UPSTASH_REDIS_REST_TOKEN: 'canonical-token',
      KV_REST_API_URL: 'https://marketplace.example',
      KV_REST_API_TOKEN: 'marketplace-token',
    })).toEqual({ url: 'https://canonical.example', token: 'canonical-token' });
  });

  it('falls back to the Marketplace KV names when canonical aliases are absent', () => {
    expect(redisEnvironment({
      KV_REST_API_URL: 'https://marketplace.example',
      KV_REST_API_TOKEN: 'marketplace-token',
    })).toEqual({ url: 'https://marketplace.example', token: 'marketplace-token' });
  });

  it('treats blank values as absent and fails closed when neither mapping is complete', () => {
    expect(redisEnvironment({ UPSTASH_REDIS_REST_URL: ' ', KV_REST_API_URL: 'https://marketplace.example' })).toBeNull();
    expect(redisEnvironment({})).toBeNull();
  });
});

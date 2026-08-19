import { generateKeyPairSync } from 'node:crypto';
import { ActorEntitlementClient } from '../dist/src/emission.js';
import { EntitlementService, InMemoryEntitlementRepository } from '../dist/src/entitlements.js';

const now = 1_735_689_600_000;
const subject = { actorId: 'smoke-actor', runId: 'smoke-run', userId: 'smoke-user' };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const service = new EntitlementService(new InMemoryEntitlementRepository(), { signingPrivateKey: privateKey, signingKeyId: 'smoke', now: () => now });
const client = new ActorEntitlementClient({
  subject,
  platformIsPaying: true,
  maxResults: 20,
  hmacSecret: 'smoke-only-secret',
  pinnedPublicKey: publicKey,
  pinnedKeyId: 'smoke',
  now: () => now,
  resolver: async (request) => service.resolve({ subject: { actorId: request.actorId, runId: request.runId, userId: request.userId }, maxResults: request.requestedMaxResults, isPaying: request.platformIsPaying }),
  signer: async (request) => service.handleReservation({ subject: { actorId: request.actorId, runId: request.runId, userId: request.userId }, tweetIds: request.tweetIds }),
});
const resolution = await client.resolve();
const ids = Array.from({ length: 20 }, (_, index) => `smoke-${index + 1}`);
const first = await client.reserve(ids);
const duplicate = await client.reserve(ids.slice(0, 2));
if (resolution.tier !== 'paid' || resolution.effectiveLimit !== 20 || first.decisions.filter((decision) => decision.decision === 'grant').length !== 20 || duplicate.decisions.some((decision) => decision.decision !== 'grant')) {
  throw new Error('signer smoke did not verify the paid cap and idempotent reservation');
}
console.log(JSON.stringify({ signer: true, subject, tier: resolution.tier, effectiveLimit: resolution.effectiveLimit, grants: first.decisions.length, duplicateGrants: duplicate.decisions.length }));

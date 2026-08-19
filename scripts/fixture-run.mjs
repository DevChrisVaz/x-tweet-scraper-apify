import { generateKeyPairSync } from 'node:crypto';
import { runCoordinator } from '../dist/src/coordinator.js';
import { EmissionGuard, ActorEntitlementClient } from '../dist/src/emission.js';
import { EntitlementService, InMemoryEntitlementRepository } from '../dist/src/entitlements.js';
import { normalizeTweet } from '../dist/src/x-core.js';

const fixedNow = 1_735_689_600_000;
const subject = { actorId: 'fixture-actor', runId: 'fixture-run', userId: 'fixture-user' };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const service = new EntitlementService(new InMemoryEntitlementRepository(), { signingPrivateKey: privateKey, signingKeyId: 'fixture', now: () => fixedNow });
const client = new ActorEntitlementClient({
  subject,
  platformIsPaying: false,
  maxResults: 10,
  hmacSecret: 'fixture-only-secret',
  pinnedPublicKey: publicKey,
  pinnedKeyId: 'fixture',
  now: () => fixedNow,
  resolver: async (request) => service.resolve({ subject: { actorId: request.actorId, runId: request.runId, userId: request.userId }, maxResults: request.requestedMaxResults, isPaying: request.platformIsPaying }),
  signer: async (request) => service.handleReservation({ subject: { actorId: request.actorId, runId: request.runId, userId: request.userId }, tweetIds: request.tweetIds }),
});
const emission = new EmissionGuard(client);
const outputs = [];

function fixtureTweet(id) {
  return {
    rest_id: id,
    legacy: {
      full_text: `Fixture tweet ${id}`,
      created_at: 'Wed Jan 01 00:00:00 +0000 2025',
      conversation_id_str: id,
      in_reply_to_status_id_str: null,
      lang: 'en',
      favorite_count: 1,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
      entities: { urls: [], hashtags: [], user_mentions: [] },
      source: '<a>Fixture</a>',
    },
    core: { user_results: { result: { rest_id: 'fixture-user', legacy: { screen_name: 'fixture', name: 'Fixture', verified: false, followers_count: 0, friends_count: 0 } } } },
  };
}

const sourceFactory = async () => ({
  userByScreenName: async () => ({ rest_id: 'fixture-user' }),
  userTweets: async () => ({ tweets: [fixtureTweet('fixture-1'), fixtureTweet('fixture-2')], bottomCursor: null }),
  tweetById: async (id) => fixtureTweet(id),
});
let state;
let metadata;
const persistence = {
  load: async (fallback) => { state ??= structuredClone(fallback); return state; },
  save: async (next) => { state = structuredClone(next); },
  writeOutput: async (next) => { metadata = next; },
};

await runCoordinator({
  input: { fromUsers: ['fixture'], tweetIds: [], searchTerms: [], maxResults: 3 },
  subject,
  sourceFactory,
  entitlement: { resolve: () => client.resolve() },
  emission,
  persistence,
  pushData: async (tweet) => { outputs.push(tweet); return true; },
  normalize: (raw) => normalizeTweet(raw, new Date(fixedNow).toISOString()),
  now: () => new Date(fixedNow).toISOString(),
});

if (metadata?.tier !== 'free' || metadata.effectiveLimit !== 3 || metadata.statistics.emitted !== 2 || outputs.length !== 2) {
  throw new Error(`fixture run did not produce the expected free-tier output: ${JSON.stringify({ metadata, outputCount: outputs.length, state })}`);
}
console.log(JSON.stringify({ fixture: true, subject, outputIds: outputs.map((tweet) => tweet.id), metadata }));

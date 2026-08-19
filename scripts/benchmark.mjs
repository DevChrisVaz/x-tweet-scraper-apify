import { performance } from 'node:perf_hooks';
import { createStickyProxyFetch, GuestSession, OperationRegistry, XGraphqlClient } from '../dist/src/x-core.js';

const env = process.env;
if (env.BENCHMARK_CONFIRM !== '1') throw new Error('Set BENCHMARK_CONFIRM=1 to opt into a live benchmark');
const username = env.BENCHMARK_USERNAME?.trim();
const tweetId = env.BENCHMARK_TWEET_ID?.trim();
const maxResults = Number(env.BENCHMARK_MAX_RESULTS ?? '100');
if (!username || !tweetId) throw new Error('BENCHMARK_USERNAME and BENCHMARK_TWEET_ID are required');
if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10_000) throw new Error('BENCHMARK_MAX_RESULTS must be an integer from 1 to 10000');

const transport = env.BENCHMARK_PROXY_URL ? createStickyProxyFetch(env.BENCHMARK_PROXY_URL) : fetch;
const started = performance.now();
const registry = new OperationRegistry({ fetch: transport });
const discovered = await registry.get(true);
if (!discovered.bearer) throw new Error('benchmark manifest did not provide a bearer token');
const session = new GuestSession({ fetch: transport, bearer: discovered.bearer, proxyUrl: env.BENCHMARK_PROXY_URL });
const client = new XGraphqlClient({ registry, session, fetch: transport });
const profile = await client.userByScreenName(username);
const profileId = typeof profile.rest_id === 'string' ? profile.rest_id : undefined;
if (!profileId) throw new Error('benchmark profile response did not contain rest_id');
const authorPage = await client.userTweets(profileId);
const tweet = await client.tweetById(tweetId);
const observedTweetId = tweet.rest_id ?? tweet.id;
if (typeof observedTweetId !== 'string' || observedTweetId.length === 0) throw new Error('benchmark tweet response did not contain an ID');

console.log(JSON.stringify({
  benchmark: true,
  httpOnly: true,
  measurementStatus: 'UNMEASURED_UNTIL_TASK6_PAID_RUN',
  requestedMaxResults: maxResults,
  username,
  profileId,
  authorTweetCount: authorPage.tweets.length,
  tweetId: observedTweetId,
  elapsedMs: Math.round(performance.now() - started),
}));

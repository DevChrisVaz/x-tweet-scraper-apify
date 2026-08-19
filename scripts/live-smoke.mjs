import { createStickyProxyFetch, GuestSession, OperationRegistry, XGraphqlClient } from '../dist/src/x-core.js';

const env = process.env;
if (env.LIVE_SMOKE_CONFIRM !== '1') throw new Error('Set LIVE_SMOKE_CONFIRM=1 to opt into live HTTP-only smoke testing');
const username = env.LIVE_X_USERNAME?.trim();
const tweetId = env.LIVE_X_TWEET_ID?.trim();
if (!username || !tweetId) throw new Error('LIVE_X_USERNAME and LIVE_X_TWEET_ID are required for live smoke testing');

const transport = env.LIVE_X_PROXY_URL ? createStickyProxyFetch(env.LIVE_X_PROXY_URL) : fetch;
const registry = new OperationRegistry({ fetch: transport });
const discovered = await registry.get(true);
if (!discovered.bearer) throw new Error('live manifest did not provide a bearer token');
const session = new GuestSession({ fetch: transport, bearer: discovered.bearer, proxyUrl: env.LIVE_X_PROXY_URL });
const client = new XGraphqlClient({ registry, session, fetch: transport });
const profile = await client.userByScreenName(username);
const profileId = typeof profile.rest_id === 'string' ? profile.rest_id : undefined;
if (!profileId) throw new Error('live profile response did not contain rest_id');
const authorPage = await client.userTweets(profileId);
const tweet = await client.tweetById(tweetId);
const tweetResult = tweet.rest_id ?? tweet.id;
if (typeof tweetResult !== 'string' || tweetResult.length === 0) throw new Error('live tweet response did not contain an ID');

console.log(JSON.stringify({
  live: true,
  httpOnly: true,
  username,
  profileId,
  authorTweetCount: authorPage.tweets.length,
  tweetId: tweetResult,
  discoveredBuildKey: discovered.buildKey,
}));

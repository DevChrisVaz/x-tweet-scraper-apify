import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  GuestSession,
  OperationDriftError,
  OperationRegistry,
  XGraphqlClient,
  applyTweetFilters,
  createStickyProxyFetch,
  extractTimelinePage,
  normalizeTweet,
  type FetchLike,
} from '../src/x-core.js';

const operations = {
  UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
  UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
  TweetResultByRestId: 'GZsN2Pc4knAoit6pXa4HSA',
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function queuedFetch(items: Array<Response | Error>, calls: Array<{ url: string; init?: RequestInit }>): FetchLike {
  return async (url, init) => {
    calls.push(init === undefined ? { url: String(url) } : { url: String(url), init });
    const item = items.shift();
    if (item === undefined) throw new Error('unexpected request');
    if (item instanceof Error) throw item;
    return item;
  };
}

const rawTweet = {
  rest_id: '101',
  legacy: {
    full_text: 'Read https://t.co/a #News @apify',
    created_at: 'Wed Jan 01 00:00:00 +0000 2025',
    conversation_id_str: '100',
    in_reply_to_status_id_str: null,
    lang: 'en',
    favorite_count: 4,
    retweet_count: 3,
    reply_count: 2,
    quote_count: 1,
    bookmark_count: 5,
    entities: {
      urls: [{ url: 'https://t.co/a', expanded_url: 'https://example.com/article' }],
      hashtags: [{ text: 'News' }],
      user_mentions: [{ screen_name: 'apify' }],
      media: [{ type: 'photo', media_url_https: 'https://img.example/p.jpg' }],
    },
    source: '<a href="https://client.example" rel="nofollow">Client App</a>',
  },
  core: {
    user_results: {
      result: {
        rest_id: '42',
        legacy: { screen_name: 'author', name: 'Author', verified: true, followers_count: 10, friends_count: 2 },
      },
    },
  },
  views: { count: '9' },
};

describe('operation discovery and caching', () => {
  it('discovers bearer and operation ids from the manifest and referenced public bundle', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = queuedFetch([
      new Response('"https://x.com/assets/a.js" "/assets/b.js"', { status: 200 }),
      new Response('window.__x={"api":"AAAAAAAAAAAAANRILgAAAAAAbearer-token","queryId":"new-user","operationName":"UserByScreenName"};', { status: 200 }),
      new Response('"queryId":"new-timeline","operationName":"UserTweets" "queryId":"new-tweet","operationName":"TweetResultByRestId"', { status: 200 }),
    ], calls);
    const registry = new OperationRegistry({ fetch, manifestUrl: 'https://x.com/manifest.js', bootstrap: operations });

    const discovered = await registry.get();

    expect(discovered.bearer).toBe('AAAAAAAAAAAAANRILgAAAAAAbearer-token');
    expect(discovered.operations).toEqual({ UserByScreenName: 'new-user', UserTweets: 'new-timeline', TweetResultByRestId: 'new-tweet' });
    await registry.get();
    expect(calls).toHaveLength(3);
  });

  it('uses verified bootstrap operation ids when discovery assets are incomplete', async () => {
    const registry = new OperationRegistry({
      fetch: async () => new Response('not a valid manifest', { status: 200 }),
      bootstrap: operations,
    });
    expect((await registry.get()).operations).toEqual(operations);
  });
});

describe('guest HTTP transport', () => {
  it('keeps every request on the session proxy without rotating it', async () => {
    const calls: Array<{ url: string; proxyUrl: string; sessionToken: object }> = [];
    const fetch = createStickyProxyFetch('http://proxy.example:8000', async (url, options) => {
      calls.push({ url, proxyUrl: options.proxyUrl, sessionToken: options.sessionToken });
      return { statusCode: 200, headers: { 'x-test': 'yes' }, body: Buffer.from('{"ok":true}') };
    });
    await expect((await fetch('https://api.x.com/a', { method: 'POST', body: '{}' })).json()).resolves.toEqual({ ok: true });
    await fetch('https://api.x.com/b');
    expect(calls.map((call) => call.proxyUrl)).toEqual(['http://proxy.example:8000', 'http://proxy.example:8000']);
    expect(calls[0]?.sessionToken).toBe(calls[1]?.sessionToken);
  });

  it('refreshes discovery once after a stale query id then succeeds', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let discovered = 0;
    const registry = {
      get: async () => ({ bearer: 'bearer', operations: { ...operations, UserByScreenName: discovered++ === 0 ? 'stale' : 'fresh' }, features: {}, fieldToggles: {} }),
      invalidate: () => undefined,
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({ authorization: 'Bearer bearer', 'x-guest-token': 'guest' }), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(404, {}), response(200, { data: { user: 'ok' } })], calls), sleep: async () => undefined });

    await expect(client.call('UserByScreenName', { screen_name: 'author' })).resolves.toEqual({ user: 'ok' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.x.com/graphql/stale/UserByScreenName',
      'https://api.x.com/graphql/fresh/UserByScreenName',
    ]);
  });

  it('raises operation drift after the single rediscovery retry also fails validation', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(404, {}), response(404, {})], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(OperationDriftError);
  });

  it('does not disguise an ordinary 400 as operation drift', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(400, { errors: [{ message: 'tweetId is required' }] })], []), sleep: async () => undefined });
    await expect(client.call('TweetResultByRestId', {})).rejects.toThrow(/HTTP 400/);
  });

  it('rediscovers once for a query validation response', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let queryId = 'old';
    const registry = {
      get: async () => ({ bearer: 'b', operations: { ...operations, UserTweets: queryId }, features: {}, fieldToggles: {} }),
      invalidate: () => { queryId = 'new'; },
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(400, { errors: [{ message: 'Query validation failed' }] }), response(200, { data: { ok: true } })], calls), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual(['https://api.x.com/graphql/old/UserTweets', 'https://api.x.com/graphql/new/UserTweets']);
  });

  it('activates a guest token and retries a 401 once in the same session', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = new GuestSession({
      fetch: queuedFetch([response(200, { guest_token: 'one' }), response(401, {}), response(200, { guest_token: 'two' }), response(200, { data: { tweet: 'ok' } })], calls),
      bearer: 'b',
    });
    const client = new XGraphqlClient({ registry, session, fetch: session.fetch, sleep: async () => undefined });
    await expect(client.call('TweetResultByRestId', { tweetId: '101' })).resolves.toEqual({ tweet: 'ok' });
    expect(calls.filter((call) => call.url.includes('guest/activate.json'))).toHaveLength(2);
    expect(calls[3]?.init?.headers).toMatchObject({ 'x-guest-token': 'two' });
  });

  it('stops when the refreshed guest session is also unauthorized', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(401, {}), response(401, {})], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('honors a rate-limit reset before retrying and stops generic 403 responses', async () => {
    const waits: number[] = [];
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(429, {}, { 'x-rate-limit-reset': '12' }), response(200, { data: { ok: true } })], []), now: () => 10_000, sleep: async (ms) => { waits.push(ms); } });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ ok: true });
    expect(waits).toEqual([2_000]);
    const denied = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(403, {})], []), sleep: async () => undefined });
    await expect(denied.call('UserTweets', {})).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('uses bounded retries for transient network and 5xx failures', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const waits: number[] = [];
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([new Error('socket reset'), response(503, {}), response(200, { data: { ok: true } })], []), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ ok: true });
    expect(waits).toEqual([250, 500]);
  });
});

describe('URT parsing, normalization, and filters', () => {
  it('unwraps module entries, extracts bottom cursors, and removes duplicate tweet ids', () => {
    const page = extractTimelinePage({
      data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
        { entryId: 'tweet-101', content: { itemContent: { tweet_results: { result: rawTweet } } } },
        { entryId: 'module-1', content: { items: [{ item: { itemContent: { tweet_results: { result: rawTweet } } } }] } },
        { entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: 'next-cursor' } },
      ] }] } } } } },
    });
    expect(page.tweets).toEqual([rawTweet]);
    expect(page.bottomCursor).toBe('next-cursor');
  });

  it('normalizes wrapped tweets with expanded URLs, media variants, and source labels', () => {
    const video = structuredClone(rawTweet) as typeof rawTweet & { legacy: typeof rawTweet.legacy & { extended_entities?: unknown } };
    video.legacy.extended_entities = { media: [
      { type: 'video', media_url_https: 'https://img.example/v.jpg', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://bad' }, { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.example/b.mp4' }, { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.example/a.mp4' }] } },
      { type: 'animated_gif', media_url_https: 'https://img.example/g.jpg', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.example/g.mp4' }] } },
    ] };
    const normalized = normalizeTweet({ __typename: 'TweetWithVisibilityResults', tweet: video }, '2025-01-02T00:00:00.000Z');
    expect(normalized).toMatchObject({
      id: '101', text: 'Read https://example.com/article #News @apify', url: 'https://x.com/author/status/101',
      source: 'Client App', entities: { hashtags: ['News'], mentions: ['apify'], urls: ['https://example.com/article'], media: [
        { type: 'video', url: 'https://video.example/b.mp4', thumbnail: 'https://img.example/v.jpg' },
        { type: 'animated_gif', url: 'https://video.example/g.mp4', thumbnail: 'https://img.example/g.jpg' },
      ] },
    });
  });

  it('filters replies, retweets, media, verification, dates inclusively, language, and engagement floors', () => {
    const base = normalizeTweet(rawTweet, '2025-01-02T00:00:00.000Z');
    expect(applyTweetFilters([base], { includeReplies: false })).toEqual([base]);
    expect(applyTweetFilters([{ ...base, isReply: true }], { includeReplies: false })).toEqual([]);
    expect(applyTweetFilters([{ ...base, isRetweet: true }], { includeRetweets: false })).toEqual([]);
    expect(applyTweetFilters([base], { mediaType: 'images', onlyVerified: true, since: '2025-01-01', until: '2025-01-01', language: 'en', minLikes: 4, minRetweets: 3, minReplies: 2 })).toEqual([base]);
    expect(applyTweetFilters([base], { mediaType: 'video' })).toEqual([]);
    expect(applyTweetFilters([base], { mediaType: 'links' })).toEqual([base]);
    expect(applyTweetFilters([base], { mediaType: 'text_only' })).toEqual([]);
    const plain = { ...base, entities: { ...base.entities, urls: [], media: [] } };
    expect(applyTweetFilters([plain], { mediaType: 'text_only' })).toEqual([plain]);
    expect(applyTweetFilters([{ ...base, author: { ...base.author, verified: false } }], { onlyVerified: true })).toEqual([]);
    expect(applyTweetFilters([{ ...base, lang: 'es' }], { language: 'en' })).toEqual([]);
    expect(applyTweetFilters([base], { minLikes: 5 })).toEqual([]);
  });

  it('rejects malformed graphQL shapes rather than silently emitting partial data', () => {
    expect(() => extractTimelinePage({ data: { user: {} } })).toThrow(/timeline/i);
    expect(() => normalizeTweet({ rest_id: '101', legacy: {} }, '2025-01-02T00:00:00.000Z')).toThrow(/tweet/i);
  });
});

import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  GuestSession,
  GraphqlResponseError,
  OperationDriftError,
  OperationRegistry,
  RateLimitError,
  RequestTimeoutError,
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
  TweetDetail: 'XMOz5h24KAZ86qKffKTLdQ',
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
      new Response('"https://x.com/assets/a.js" "/assets/b.js"', { status: 200 }),
    ], calls);
    const registry = new OperationRegistry({ fetch, manifestUrl: 'https://x.com/manifest.js', bootstrap: operations });

    const discovered = await registry.get();

    expect(discovered.bearer).toBe('AAAAAAAAAAAAANRILgAAAAAAbearer-token');
    expect(discovered.operations).toEqual({ UserByScreenName: 'new-user', UserTweets: 'new-timeline', TweetResultByRestId: 'new-tweet', TweetDetail: 'XMOz5h24KAZ86qKffKTLdQ' });
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

  it('retains usable partial discovery when one public asset fails and records the build key', async () => {
    const registry = new OperationRegistry({
      bootstrap: operations,
      manifestUrl: 'https://x.com/manifest.js',
      fetch: queuedFetch([
        new Response('"/assets/a.js" "/assets/b.js" buildId:"web-2026" AAAAAAAAAAAAANRILgAAAAAAbearer-token {queryId:"current-user",operationName:"UserByScreenName"}', { status: 200 }),
        new Response('{queryId:"current-timeline",operationName:"UserTweets"}', { status: 200 }),
        new Error('temporary bundle timeout'),
      ], []),
    });
    await expect(registry.get()).resolves.toMatchObject({
      bearer: 'AAAAAAAAAAAAANRILgAAAAAAbearer-token',
      buildKey: 'web-2026',
      bootstrapOperations: ['TweetResultByRestId'],
      operations: { UserByScreenName: 'current-user', UserTweets: 'current-timeline', TweetResultByRestId: operations.TweetResultByRestId, TweetDetail: operations.TweetDetail },
    });
  });

  it('discovers unquoted operation metadata even when fields are separated by minified payload data', async () => {
    const padding = 'x'.repeat(1_000);
    const registry = new OperationRegistry({
      bootstrap: operations,
      fetch: async () => new Response(`{queryId:"fresh-user",${padding},operationName:"UserByScreenName"}{operationName:"UserTweets",queryId:"fresh-timeline"}{queryId:"fresh-tweet",operationName:"TweetResultByRestId"}`, { status: 200 }),
    });
    await expect(registry.get()).resolves.toMatchObject({ operations: { UserByScreenName: 'fresh-user', UserTweets: 'fresh-timeline', TweetResultByRestId: 'fresh-tweet', TweetDetail: 'XMOz5h24KAZ86qKffKTLdQ' } });
  });

  it('revalidates the manifest build key and replaces cached IDs, features, and toggles for a new build', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const registry = new OperationRegistry({
      bootstrap: operations,
      manifestUrl: 'https://x.com/manifest.js',
      freshnessTtlMs: 0,
      fetch: queuedFetch([
        new Response('buildId:"one" "/assets/one.js"', { status: 200 }),
        new Response('{queryId:"one-timeline",operationName:"UserTweets"}', { status: 200 }),
        new Response('buildId:"two" "/assets/two.js"', { status: 200 }),
        new Response('{queryId:"two-timeline",operationName:"UserTweets"}', { status: 200 }),
      ], calls),
    });
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'one', operations: { UserTweets: 'one-timeline' } });
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'two', operations: { UserTweets: 'two-timeline' } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://x.com/manifest.js', 'https://x.com/assets/one.js',
      'https://x.com/manifest.js', 'https://x.com/assets/two.js',
    ]);
  });

  it('parses nested unquoted and escaped JavaScript feature and field-toggle literals', async () => {
    const registry = new OperationRegistry({
      bootstrap: operations,
      fetch: async () => new Response('features:{enabled:true,nested:{disabled:false},label:"a; \\"quoted\\" value",items:[1,true,"x"]},fieldToggles:{withArticle:true,nested:{mode:\'compact\'}}', { status: 200 }),
    });
    await expect(registry.get()).resolves.toMatchObject({
      features: { enabled: true, nested: { disabled: false }, label: 'a; "quoted" value', items: [1, true, 'x'] },
      fieldToggles: { withArticle: true, nested: { mode: 'compact' } },
    });
  });

  it('keeps a registry snapshot fresh for a bounded TTL, then checks the next manifest build', async () => {
    let now = 0;
    const calls: string[] = [];
    const responses = [
      new Response('buildId:"one" "/assets/one.js"', { status: 200 }),
      new Response('{queryId:"one-timeline",operationName:"UserTweets"}', { status: 200 }),
      new Response('buildId:"two" "/assets/two.js"', { status: 200 }),
      new Response('{queryId:"two-timeline",operationName:"UserTweets"}', { status: 200 }),
    ];
    const registry = new OperationRegistry({
      bootstrap: operations,
      manifestUrl: 'https://x.com/manifest.js',
      freshnessTtlMs: 1_000,
      now: () => now,
      fetch: async (url) => {
        calls.push(String(url));
        const next = responses.shift();
        if (next === undefined) throw new Error('unexpected public discovery request');
        return next;
      },
    });
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'one', operations: { UserTweets: 'one-timeline' } });
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'one', operations: { UserTweets: 'one-timeline' } });
    expect(calls).toEqual(['https://x.com/manifest.js', 'https://x.com/assets/one.js']);
    now = 1_001;
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'two', operations: { UserTweets: 'two-timeline' } });
    expect(calls).toEqual([
      'https://x.com/manifest.js', 'https://x.com/assets/one.js',
      'https://x.com/manifest.js', 'https://x.com/assets/two.js',
    ]);
  });

  it('invalidates a fresh registry snapshot immediately on operation drift', async () => {
    const calls: string[] = [];
    const responses = [
      new Response('buildId:"one" "/assets/one.js"', { status: 200 }),
      new Response('{queryId:"one-timeline",operationName:"UserTweets"}', { status: 200 }),
      new Response('buildId:"two" "/assets/two.js"', { status: 200 }),
      new Response('{queryId:"two-timeline",operationName:"UserTweets"}', { status: 200 }),
    ];
    const registry = new OperationRegistry({
      bootstrap: operations,
      manifestUrl: 'https://x.com/manifest.js',
      freshnessTtlMs: 60_000,
      fetch: async (url) => {
        calls.push(String(url));
        const next = responses.shift();
        if (next === undefined) throw new Error('unexpected public discovery request');
        return next;
      },
    });
    await registry.get();
    registry.invalidate();
    await expect(registry.get()).resolves.toMatchObject({ buildKey: 'two', operations: { UserTweets: 'two-timeline' } });
    expect(calls).toEqual([
      'https://x.com/manifest.js', 'https://x.com/assets/one.js',
      'https://x.com/manifest.js', 'https://x.com/assets/two.js',
    ]);
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
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/graphql/stale/UserByScreenName',
      '/graphql/fresh/UserByScreenName',
    ]);
  });

  it('uses the verified public api GraphQL GET boundary with JSON query parameters', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const features = { responsive_web_graphql_exclude_directive_enabled: true };
    const fieldToggles = { withArticlePlainText: false };
    const registry = {
      get: async () => ({ bearer: 'b', operations, features, fieldToggles, buildKey: 'build' }),
      invalidate: () => undefined,
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({ authorization: 'Bearer b', 'x-guest-token': 'guest' }), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(200, { data: { ok: true } })], calls), sleep: async () => undefined });

    await expect(client.call('UserByScreenName', { screen_name: 'author', withSafetyModeUserFields: true })).resolves.toEqual({ ok: true });
    const call = calls[0];
    const url = new URL(call?.url ?? '');
    expect(url.origin).toBe('https://api.x.com');
    expect(url.pathname).toBe(`/graphql/${operations.UserByScreenName}/UserByScreenName`);
    expect(call?.init?.method).toBe('GET');
    expect(call?.init?.body).toBeUndefined();
    expect(new Headers(call?.init?.headers).has('content-type')).toBe(false);
    expect(JSON.parse(url.searchParams.get('variables') ?? '')).toEqual({ screen_name: 'author', withSafetyModeUserFields: true });
    expect(JSON.parse(url.searchParams.get('features') ?? '')).toEqual(features);
    expect(JSON.parse(url.searchParams.get('fieldToggles') ?? '')).toEqual(fieldToggles);
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
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/graphql/old/UserTweets', '/graphql/new/UserTweets']);
  });

  it('refreshes once for a successful HTTP response carrying GraphQL query validation errors', async () => {
    let queryId = 'old';
    const registry = {
      get: async () => ({ bearer: 'b', operations: { ...operations, UserTweets: queryId }, features: {}, fieldToggles: {}, buildKey: null }),
      invalidate: () => { queryId = 'new'; },
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([
      response(200, { data: { partial: true }, errors: [{ message: 'Query validation failed for operation' }] }),
      response(200, { data: { complete: true } }),
    ], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ complete: true });
  });

  it('refreshes once for a 200 PersistedQueryNotFound error-only payload', async () => {
    let queryId = 'old';
    const registry = {
      get: async () => ({ bearer: 'b', operations: { ...operations, UserTweets: queryId }, features: {}, fieldToggles: {}, buildKey: null, bootstrapOperations: [] }),
      invalidate: () => { queryId = 'new'; },
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([
      response(200, { errors: [{ code: 'PersistedQueryNotFound' }] }),
      response(200, { data: { complete: true } }),
    ], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ complete: true });
  });

  it('refreshes once for a 400 unknown stored operation and then raises drift if it persists', async () => {
    let queryId = 'old';
    const registry = {
      get: async () => ({ bearer: 'b', operations: { ...operations, UserTweets: queryId }, features: {}, fieldToggles: {}, buildKey: null, bootstrapOperations: [] }),
      invalidate: () => { queryId = 'new'; },
    } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const successfulRefresh = new XGraphqlClient({ registry, session, fetch: queuedFetch([
      response(400, { errors: [{ message: 'Could not resolve to a stored operation' }] }),
      response(200, { data: { complete: true } }),
    ], []), sleep: async () => undefined });
    await expect(successfulRefresh.call('UserTweets', {})).resolves.toEqual({ complete: true });
    const persistent = new XGraphqlClient({ registry, session, fetch: queuedFetch([
      response(400, { errors: [{ message: 'Unknown operation' }] }),
      response(400, { errors: [{ message: 'Unknown operation' }] }),
    ], []), sleep: async () => undefined });
    await expect(persistent.call('UserTweets', {})).rejects.toBeInstanceOf(OperationDriftError);
  });

  it('does not return partial data when GraphQL reports a non-retryable error', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {}, buildKey: null }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(200, { data: { partial: true }, errors: [{ message: 'internal resolver failure' }] })], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it('uses the same-session refresh once for GraphQL guest authorization errors', async () => {
    let refreshes = 0;
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {}, buildKey: null }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => { refreshes += 1; } } as unknown as GuestSession;
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([
      response(200, { errors: [{ message: 'Guest token is invalid' }] }),
      response(200, { errors: [{ message: 'Guest token is invalid' }] }),
    ], []), sleep: async () => undefined });
    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(AccessDeniedError);
    expect(refreshes).toBe(1);
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

  it('backs off without a reset header and terminates repeated rate limits', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {}, buildKey: null }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const waits: number[] = [];
    const recovered = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(429, {}), response(200, { data: { ok: true } })], []), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    await expect(recovered.call('UserTweets', {})).resolves.toEqual({ ok: true });
    expect(waits).toEqual([250]);
    const exhausted = new XGraphqlClient({ registry, session, fetch: queuedFetch([response(429, {}), response(429, {}), response(429, {}), response(429, {})], []), sleep: async () => undefined, random: () => 0 });
    await expect(exhausted.call('UserTweets', {})).rejects.toBeInstanceOf(RateLimitError);
  });

  it('uses bounded retries for transient network and 5xx failures', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const waits: number[] = [];
    const client = new XGraphqlClient({ registry, session, fetch: queuedFetch([new Error('socket reset'), response(503, {}), response(200, { data: { ok: true } })], []), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    await expect(client.call('UserTweets', {})).resolves.toEqual({ ok: true });
    expect(waits).toEqual([250, 500]);
  });

  it('classifies an AbortSignal deadline as a bounded transient retry', async () => {
    const registry = { get: async () => ({ bearer: 'b', operations, features: {}, fieldToggles: {} }), invalidate: () => undefined } as unknown as OperationRegistry;
    const session = { headers: async () => ({}), refresh: async () => undefined } as unknown as GuestSession;
    const waits: number[] = [];
    let calls = 0;
    const client = new XGraphqlClient({
      registry,
      session,
      requestTimeoutMs: 1,
      fetch: async (_url, init) => {
        calls += 1;
        if (init?.signal === undefined) throw new Error('request did not receive a deadline signal');
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0,
    });
    await expect(client.call('UserTweets', {})).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(calls).toBe(3);
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
    expect(() => extractTimelinePage({ data: { user: { result: { timeline_v2: { timeline: { instructions: ['bad'] } } } } } })).toThrow(/instruction/i);
    expect(() => extractTimelinePage({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: ['bad'] }] } } } } } })).toThrow(/entry/i);
    expect(() => extractTimelinePage({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'tweet-bad', content: { itemContent: { tweet_results: { result: {} } } } }] }] } } } } } })).toThrow(/rest_id/i);
    expect(extractTimelinePage({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: 'next' } }] }] } } } } } })).toEqual({ tweets: [], bottomCursor: 'next' });
    expect(extractTimelinePage({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'tweet-tombstone', content: { itemContent: { tweet_results: { result: { __typename: 'TweetTombstone' } } } } }] }] } } } } } })).toEqual({ tweets: [], bottomCursor: null });
    expect(() => normalizeTweet({ rest_id: '101', legacy: {} }, '2025-01-02T00:00:00.000Z')).toThrow(/tweet/i);
  });

  it('applies hashtag filters with case-insensitive AND semantics and safe standalone defaults', () => {
    const base = normalizeTweet(rawTweet, '2025-01-02T00:00:00.000Z');
    const twoTags = { ...base, entities: { ...base.entities, hashtags: ['News', 'Apify'] } };
    expect(applyTweetFilters([twoTags], { hashtags: ['news', 'APIFY'] })).toEqual([twoTags]);
    expect(applyTweetFilters([twoTags], { hashtags: ['news', 'missing'] })).toEqual([]);
    expect(applyTweetFilters([{ ...base, isRetweet: true }], {})).toEqual([]);
  });

  it('expands t.co URLs without swallowing punctuation and decodes named and numeric source entities', () => {
    const punctuated = structuredClone(rawTweet);
    punctuated.legacy.full_text = 'Read https://t.co/a, now';
    punctuated.legacy.source = '<a>Client &quot;App&quot; &#38; &#x1F680;</a>';
    const normalized = normalizeTweet(punctuated, '2025-01-02T00:00:00.000Z');
    expect(normalized.text).toBe('Read https://example.com/article, now');
    expect(normalized.source).toBe('Client "App" & 🚀');
  });

  it('prefers canonical note text and entities and recognizes outer Blue verification', () => {
    const note = structuredClone(rawTweet) as typeof rawTweet & { core: { user_results: { result: { is_blue_verified?: boolean } } }; legacy: typeof rawTweet.legacy & { note_tweet?: unknown } };
    note.core.user_results.result.is_blue_verified = true;
    note.legacy.note_tweet = {
      note_tweet_results: {
        result: {
          text: 'Long note https://t.co/n #Note @note',
          entity_set: {
            urls: [{ url: 'https://t.co/n', expanded_url: 'https://example.com/note' }],
            hashtags: [{ text: 'Note' }],
            user_mentions: [{ screen_name: 'note' }],
          },
        },
      },
    };
    note.legacy.source = '<a>Reader &copy; &mdash; &hellip;</a>';
    const normalized = normalizeTweet(note, '2025-01-02T00:00:00.000Z');
    expect(normalized).toMatchObject({
      text: 'Long note https://example.com/note #Note @note',
      author: { verified: true },
      entities: { hashtags: ['Note'], mentions: ['note'], urls: ['https://example.com/note'] },
      source: 'Reader © — …',
    });
  });
});

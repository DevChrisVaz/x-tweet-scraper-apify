import { describe, expect, it } from 'vitest';
import { runCoordinator, type CoordinatorState } from '../src/coordinator.js';
import type { TweetOutput } from '../src/contracts.js';

type RawTweet = Record<string, unknown>;

function rawTweet(id: string, options: { reply?: boolean; hashtags?: string[]; createdAt?: string } = {}): RawTweet {
  return {
    rest_id: id,
    legacy: {
      full_text: `tweet ${id}`,
      created_at: options.createdAt ?? 'Wed Jan 01 00:00:00 +0000 2025',
      conversation_id_str: id,
      in_reply_to_status_id_str: options.reply === true ? 'parent' : null,
      lang: 'en',
      favorite_count: 1,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      entities: { urls: [], hashtags: (options.hashtags ?? ['news']).map((text) => ({ text })), user_mentions: [], media: [] },
      source: '<a>Web</a>',
    },
    core: { user_results: { result: { rest_id: 'author-1', legacy: { screen_name: 'author', name: 'Author', verified: true, followers_count: 1, friends_count: 1 } } } },
  };
}

function output(id: string): TweetOutput {
  return {
    id, url: `https://x.com/author/status/${id}`, text: id, lang: 'en', createdAt: '2025-01-01T00:00:00.000Z', conversationId: id,
    isReply: false, isRetweet: false, isQuote: false, inReplyToId: null, quotedTweetId: null,
    author: { id: 'author-1', username: 'author', name: 'Author', verified: true, followers: 1, following: 1 },
    metrics: { likes: 1, retweets: 0, replies: 0, quotes: 0, bookmarks: null, views: null },
    entities: { hashtags: ['news'], mentions: [], urls: [], media: [] }, source: 'Web', scrapedAt: '2025-01-02T00:00:00.000Z',
  };
}

function memoryState(initial?: CoordinatorState) {
  let state = initial;
  const outputs: unknown[] = [];
  let saves = 0;
  return {
    persistence: {
      load: async (fallback: CoordinatorState) => structuredClone(state ?? fallback),
      save: async (next: CoordinatorState) => { state = structuredClone(next); saves += 1; },
      writeOutput: async (metadata: unknown) => { outputs.push(metadata); },
    },
    outputs,
    get state() { return state; },
    get saves() { return saves; },
  };
}

function source(timelines: Record<string, RawTweet[]>, tweetResults: Record<string, RawTweet> = {}) {
  return async () => ({
    userByScreenName: async (username: string) => ({ rest_id: username }),
    userTweets: async (userId: string, cursor?: string) => ({ tweets: timelines[userId] ?? [], bottomCursor: cursor === undefined ? null : null }),
    tweetById: async (tweetId: string) => {
      const value = tweetResults[tweetId];
      if (value === undefined) throw new Error(`missing tweet ${tweetId}`);
      return value;
    },
  });
}

function emitter(limit: number) {
  const batches: string[][] = [];
  const granted = new Set<string>();
  return {
    boundary: {
      reserveBatch: async (ids: string[]) => {
        batches.push([...ids]);
        const result = new Set<string>();
        for (const id of ids) if (granted.size < limit) { granted.add(id); result.add(id); }
        return { grantedIds: result, deniedIds: new Set(ids.filter((id) => !result.has(id))) };
      },
      emit: async (id: string, push: () => Promise<void>) => {
        if (!granted.has(id)) return false;
        await push();
        return true;
      },
    },
    batches,
  };
}

const subject = { actorId: 'actor-1', runId: 'run-1', userId: 'user-1' };

describe('actor coordinator integration', () => {
  it('writes fail-closed OUTPUT when checkpoint state cannot be loaded', async () => {
    const outputs: unknown[] = [];
    await expect(runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 },
      subject,
      sourceFactory: source({ a: [] }),
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: emitter(10).boundary,
      persistence: {
        load: async () => { throw new Error('state unavailable'); },
        save: async () => undefined,
        writeOutput: async (metadata) => { outputs.push(metadata); },
      },
      pushData: async () => undefined,
      now: () => '2025-01-02T00:00:00.000Z',
    })).resolves.toMatchObject({ tier: 'unknown', effectiveLimit: 0, statistics: { errors: 1 } });
    expect(outputs).toHaveLength(1);
  });

  it('caps a free 1000-result request at ten signed dataset pushes in batches of at most twenty', async () => {
    const pushed: TweetOutput[] = [];
    const storage = memoryState();
    const guard = emitter(10);
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 1_000 }, subject, sourceFactory: source({ a: Array.from({ length: 25 }, (_, index) => rawTweet(String(index + 1))) }),
      entitlement: { resolve: async () => ({ tier: 'free' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(pushed.map((tweet) => tweet.id)).toHaveLength(10);
    expect(guard.batches.every((ids) => ids.length <= 20)).toBe(true);
    expect(storage.outputs).toHaveLength(1);
  });

  it('honors the requested paid cap while continuing past filtered candidates', async () => {
    const pushed: TweetOutput[] = [];
    const storage = memoryState();
    const guard = emitter(100);
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 3, includeReplies: false, hashtags: ['news'] }, subject,
      sourceFactory: source({ a: [rawTweet('filtered-reply', { reply: true }), rawTweet('filtered-tag', { hashtags: ['other'] }), rawTweet('1'), rawTweet('2'), rawTweet('3'), rawTweet('4')] }),
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 100 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(pushed.map((tweet) => tweet.id)).toEqual(['1', '2', '3']);
  });

  it('deduplicates IDs globally across author and direct-ID sources', async () => {
    const pushed: TweetOutput[] = [];
    const storage = memoryState();
    const guard = emitter(10);
    await runCoordinator({
      input: { fromUsers: ['a'], tweetIds: ['duplicate', 'unique'], maxResults: 10 }, subject,
      sourceFactory: source({ a: [rawTweet('duplicate'), rawTweet('author-only')] }, { duplicate: rawTweet('duplicate'), unique: rawTweet('unique') }),
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z', concurrency: 3,
    });
    expect(new Set(pushed.map((tweet) => tweet.id))).toEqual(new Set(['duplicate', 'author-only', 'unique']));
  });

  it('limits independent target work to three concurrent sessions', async () => {
    const storage = memoryState();
    const guard = emitter(10);
    let active = 0;
    let peak = 0;
    const sourceFactory = async () => ({
      userByScreenName: async (username: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { rest_id: username };
      },
      userTweets: async () => ({ tweets: [], bottomCursor: null }),
      tweetById: async () => rawTweet('unused'),
    });
    await runCoordinator({
      input: { fromUsers: ['a', 'b', 'c', 'd'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async () => undefined, now: () => '2025-01-02T00:00:00.000Z', concurrency: 3,
    });
    expect(peak).toBe(3);
  });

  it('resumes a saved author cursor and persists exhaustion and global IDs', async () => {
    const pushed: TweetOutput[] = [];
    const storage = memoryState({ version: 1, targets: { 'author:a': { cursor: 'resume-cursor', exhausted: false } }, seenIds: [], statistics: { discovered: 0, filtered: 0, reserved: 0, emitted: 0, denied: 0, errors: 0 } });
    const guard = emitter(10);
    let cursor: string | undefined;
    const sourceFactory = async () => ({
      userByScreenName: async () => ({ rest_id: 'a' }),
      userTweets: async (_userId: string, received?: string) => { cursor = received; return { tweets: [rawTweet('resumed')], bottomCursor: null }; },
      tweetById: async () => rawTweet('unused'),
    });
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(cursor).toBe('resume-cursor');
    expect(storage.saves).toBeGreaterThan(0);
    expect(storage.state).toMatchObject({ targets: { 'author:a': { exhausted: true } }, seenIds: ['resumed'] });
  });

  it('stops a newest-first author cursor only when the entire page is safely older than since', async () => {
    const storage = memoryState();
    const guard = emitter(10);
    let pages = 0;
    const sourceFactory = async () => ({
      userByScreenName: async () => ({ rest_id: 'a' }),
      userTweets: async () => { pages += 1; return { tweets: [rawTweet('old', { createdAt: 'Wed Jan 01 00:00:00 +0000 2025' })], bottomCursor: 'older-cursor' }; },
      tweetById: async () => rawTweet('unused'),
    });
    await runCoordinator({
      input: { fromUsers: ['a'], since: '2025-01-02', maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async () => undefined, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(pages).toBe(1);
    expect(storage.state).toMatchObject({ targets: { 'author:a': { cursor: 'older-cursor', exhausted: true } } });
  });

  it('cancels further pagination when an authoritative reservation is partially denied', async () => {
    const storage = memoryState();
    const logs: unknown[] = [];
    let pages = 0;
    const sourceFactory = async () => ({
      userByScreenName: async () => ({ rest_id: 'a' }),
      userTweets: async () => {
        pages += 1;
        return { tweets: [rawTweet(`page-${pages}-a`), rawTweet(`page-${pages}-b`)], bottomCursor: `cursor-${pages}` };
      },
      tweetById: async () => rawTweet('unused'),
    });
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: {
        reserveBatch: async (ids) => ({ grantedIds: new Set(ids.slice(0, 1)), deniedIds: new Set(ids.slice(1)) }),
        emit: async (_id, push) => { await push(); return true; },
      },
      persistence: storage.persistence, pushData: async () => undefined, now: () => '2025-01-02T00:00:00.000Z', log: (entry) => { logs.push(entry); },
    });
    expect(pages).toBe(1);
    expect(storage.state?.seenIds).toEqual(expect.arrayContaining(['page-1-a', 'page-1-b']));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: 'signer_unavailable' }));
  });

  it('retains a signer-outage candidate for a resumed run instead of terminally seeing it', async () => {
    const storage = memoryState();
    const sourceFactory = source({ a: [rawTweet('retry-me')] });
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: { reserveBatch: async () => { throw new Error('signer unavailable'); }, emit: async () => false },
      persistence: storage.persistence, pushData: async () => undefined, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(storage.state).toMatchObject({ seenIds: [] });

    const pushed: TweetOutput[] = [];
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: emitter(10).boundary,
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(pushed.map((tweet) => tweet.id)).toEqual(['retry-me']);
  });

  it('retries a granted item after dataset push failure before advancing its saved cursor', async () => {
    const storage = memoryState();
    const sourceFactory = source({ a: [rawTweet('granted-retry')] });
    const logs: unknown[] = [];
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: {
        reserveBatch: async (ids) => ({ grantedIds: new Set(ids), deniedIds: new Set<string>() }),
        emit: async (_id, push) => { await push(); return true; },
      },
      persistence: storage.persistence, pushData: async () => { throw new Error('dataset unavailable'); }, now: () => '2025-01-02T00:00:00.000Z', log: (entry) => { logs.push(entry); },
    });
    expect(storage.state).toMatchObject({
      seenIds: [],
      targets: { 'author:a': { cursor: null, exhausted: false } },
      pending: { 'granted-retry': { granted: true } },
    });
    expect(logs).toContainEqual(expect.objectContaining({ event: 'emission_failed' }));

    const pushed: TweetOutput[] = [];
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: {
        reserveBatch: async (ids) => ({ grantedIds: new Set(ids), deniedIds: new Set<string>() }),
        emit: async (_id, push) => { await push(); return true; },
      },
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
    });
    expect(pushed.map((tweet) => tweet.id)).toEqual(['granted-retry']);
  });

  it('persists an exhausted target when a timeline repeats a cursor', async () => {
    const storage = memoryState();
    const guard = emitter(10);
    const logs: unknown[] = [];
    let pages = 0;
    const sourceFactory = async () => ({
      userByScreenName: async () => ({ rest_id: 'a' }),
      userTweets: async () => {
        pages += 1;
        if (pages > 2) throw new Error('repeat was not stopped');
        return { tweets: [], bottomCursor: 'repeated-cursor' };
      },
      tweetById: async () => rawTweet('unused'),
    });
    await runCoordinator({
      input: { fromUsers: ['a'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) }, emission: guard.boundary,
      persistence: storage.persistence, pushData: async () => undefined, now: () => '2025-01-02T00:00:00.000Z', log: (entry) => { logs.push(entry); },
    });
    expect(pages).toBe(2);
    expect(storage.state).toMatchObject({ targets: { 'author:a': { cursor: 'repeated-cursor', exhausted: true } } });
    expect(logs).toContainEqual(expect.objectContaining({ event: 'cursor_stopped', target: 'author:a' }));
  });

  it('serializes capacity calculation with reservation across concurrent targets', async () => {
    const storage = memoryState();
    const pushed: TweetOutput[] = [];
    await runCoordinator({
      input: { fromUsers: ['a', 'b'], maxResults: 10 }, subject,
      sourceFactory: source({ a: [rawTweet('a')], b: [rawTweet('b')] }),
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 1 }) },
      emission: {
        reserveBatch: async (ids) => { await Promise.resolve(); return { grantedIds: new Set(ids), deniedIds: new Set<string>() }; },
        emit: async (_id, push) => { await push(); return true; },
      },
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z', concurrency: 2,
    });
    expect(pushed).toHaveLength(1);
  });

  it('isolates target failures, rejects invalid output, fails closed on signer outage, and always writes OUTPUT', async () => {
    const pushed: TweetOutput[] = [];
    const storage = memoryState();
    const logEntries: unknown[] = [];
    const sourceFactory = async (target: { key: string }) => {
      if (target.key === 'author:broken') throw new Error('profile unavailable');
      return {
        userByScreenName: async () => ({ rest_id: 'valid' }),
        userTweets: async () => ({ tweets: [rawTweet('invalid'), rawTweet('outage')], bottomCursor: null }),
        tweetById: async () => rawTweet('unused'),
      };
    };
    await runCoordinator({
      input: { fromUsers: ['broken', 'valid'], maxResults: 10 }, subject, sourceFactory,
      entitlement: { resolve: async () => ({ tier: 'paid' as const, effectiveLimit: 10 }) },
      emission: { reserveBatch: async () => { throw new Error('signer offline'); }, emit: async () => { throw new Error('must not emit'); } },
      persistence: storage.persistence, pushData: async (tweet) => { pushed.push(tweet); }, now: () => '2025-01-02T00:00:00.000Z',
      log: (entry) => { logEntries.push(entry); },
      normalize: (raw) => (raw as RawTweet).rest_id === 'invalid' ? ({ ...output('invalid'), id: '' } as TweetOutput) : output((raw as RawTweet).rest_id as string),
    });
    expect(pushed).toEqual([]);
    expect(storage.outputs).toHaveLength(1);
    expect(storage.outputs[0]).toMatchObject({ tier: 'paid', statistics: { errors: 3 } });
    expect(logEntries).toContainEqual(expect.objectContaining({ event: 'target_failed', target: 'author:broken' }));
  });
});

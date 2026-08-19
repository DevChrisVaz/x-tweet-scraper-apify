import { ActorInputSchema, TweetOutputSchema, type ActorInput, type TweetOutput } from './contracts.js';
import type { EntitlementSubject } from './entitlements.js';
import { OutputMetadataSchema, createEmptyStatistics, type OutputMetadata, type RunStatistics } from './state.js';
import { applyTweetFilters, normalizeTweet, type TimelinePage, type TweetFilters } from './x-core.js';

type JsonRecord = Record<string, unknown>;

export interface CoordinatorTarget {
  key: string;
  kind: 'author' | 'tweet';
  value: string;
}

export interface XTargetClient {
  userByScreenName(screenName: string): Promise<JsonRecord>;
  userTweets(userId: string, cursor?: string): Promise<TimelinePage>;
  tweetById(tweetId: string): Promise<JsonRecord>;
}

export interface EntitlementBoundary {
  resolve(): Promise<{ tier: 'free' | 'paid' | 'unknown'; effectiveLimit: number }>;
}

export interface EmissionBoundary {
  reserveBatch(tweetIds: string[]): Promise<Set<string>>;
  emit(tweetId: string, push: () => Promise<void>): Promise<boolean>;
}

export interface PersistedTarget {
  cursor: string | null;
  exhausted: boolean;
}

export interface CoordinatorState {
  version: 1;
  targets: Record<string, PersistedTarget>;
  seenIds: string[];
  statistics: RunStatistics;
}

export interface CoordinatorPersistence {
  load(fallback: CoordinatorState): Promise<CoordinatorState>;
  save(state: CoordinatorState): Promise<void>;
  writeOutput(metadata: OutputMetadata): Promise<void>;
}

export interface CoordinatorLogEntry {
  event: 'entitlement_failed' | 'target_failed';
  message: string;
  target?: string;
}

export interface CoordinatorOptions {
  input: unknown;
  subject: EntitlementSubject;
  sourceFactory(target: CoordinatorTarget): Promise<XTargetClient>;
  entitlement: EntitlementBoundary;
  emission: EmissionBoundary;
  persistence: CoordinatorPersistence;
  pushData(tweet: TweetOutput): Promise<void>;
  now?: () => string;
  concurrency?: number;
  normalize?: (raw: unknown) => TweetOutput;
  log?: (entry: CoordinatorLogEntry) => void;
}

function defaultState(): CoordinatorState {
  return { version: 1, targets: {}, seenIds: [], statistics: createEmptyStatistics() };
}

function uniqueTargets(input: ActorInput): CoordinatorTarget[] {
  const targets = [
    ...input.fromUsers.map((value) => ({ key: `author:${value.toLowerCase()}`, kind: 'author' as const, value })),
    ...input.tweetIds.map((value) => ({ key: `tweet:${value}`, kind: 'tweet' as const, value })),
  ];
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.key)) return false;
    seen.add(target.key);
    return true;
  });
}

function targetState(state: CoordinatorState, key: string): PersistedTarget {
  const existing = state.targets[key];
  if (existing !== undefined) return existing;
  const created: PersistedTarget = { cursor: null, exhausted: false };
  state.targets[key] = created;
  return created;
}

function filtersFrom(input: ActorInput): TweetFilters {
  return {
    includeReplies: input.includeReplies,
    includeRetweets: input.includeRetweets,
    mediaType: input.mediaType,
    onlyVerified: input.onlyVerified,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.minLikes === undefined ? {} : { minLikes: input.minLikes }),
    ...(input.minRetweets === undefined ? {} : { minRetweets: input.minRetweets }),
    ...(input.minReplies === undefined ? {} : { minReplies: input.minReplies }),
    hashtags: input.hashtags,
  };
}

function dateStart(value: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Date.parse(value);
}

function safelyPastSince(tweets: TweetOutput[], since: string | undefined): boolean {
  if (since === undefined || tweets.length === 0) return false;
  const cutoff = dateStart(since);
  return Number.isFinite(cutoff) && tweets.every((tweet) => Date.parse(tweet.createdAt) < cutoff);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

async function withConcurrency<T>(values: T[], limit: number, handler: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      await handler(value);
    }
  });
  await Promise.all(workers);
}

export async function runCoordinator(options: CoordinatorOptions): Promise<OutputMetadata> {
  const input = ActorInputSchema.parse(options.input);
  const state = await options.persistence.load(defaultState());
  const seen = new Set(state.seenIds);
  const now = options.now ?? (() => new Date().toISOString());
  const normalize = options.normalize ?? normalizeTweet;
  const desiredLimit = input.maxResults;
  let tier: OutputMetadata['tier'] = 'unknown';
  let effectiveLimit = 0;
  let remoteExhausted = false;

  const persist = async (): Promise<void> => {
    state.seenIds = [...seen];
    await options.persistence.save(state);
  };
  const done = (): boolean => remoteExhausted || state.statistics.emitted >= desiredLimit || state.statistics.reserved >= effectiveLimit;

  const emitCandidates = async (candidates: TweetOutput[]): Promise<void> => {
    let offset = 0;
    while (offset < candidates.length && !done()) {
      const capacity = Math.min(20, desiredLimit - state.statistics.emitted, effectiveLimit - state.statistics.reserved);
      if (capacity <= 0) {
        remoteExhausted = state.statistics.reserved >= effectiveLimit;
        return;
      }
      const batch = candidates.slice(offset, offset + capacity);
      offset += batch.length;
      let grants: Set<string>;
      try {
        grants = await options.emission.reserveBatch(batch.map((tweet) => tweet.id));
      } catch {
        state.statistics.errors += 1;
        remoteExhausted = true;
        return;
      }
      const remoteCapExhausted = grants.size < batch.length;
      state.statistics.reserved += grants.size;
      state.statistics.denied += batch.length - grants.size;
      for (const tweet of batch) {
        if (!grants.has(tweet.id) || done() && state.statistics.emitted >= desiredLimit) continue;
        try {
          if (await options.emission.emit(tweet.id, async () => options.pushData(tweet))) state.statistics.emitted += 1;
        } catch {
          state.statistics.errors += 1;
        }
      }
      if (remoteCapExhausted || state.statistics.reserved >= effectiveLimit) remoteExhausted = true;
      await persist();
    }
  };

  const candidatesFrom = (rawTweets: JsonRecord[]): { candidates: TweetOutput[]; normalized: TweetOutput[] } => {
    const candidates: TweetOutput[] = [];
    const normalized: TweetOutput[] = [];
    for (const raw of rawTweets) {
      try {
        const tweet = normalize(raw);
        const parsed = TweetOutputSchema.safeParse(tweet);
        if (!parsed.success) {
          state.statistics.errors += 1;
          continue;
        }
        state.statistics.discovered += 1;
        normalized.push(parsed.data);
        if (seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        if (applyTweetFilters([parsed.data], filtersFrom(input)).length === 0) {
          state.statistics.filtered += 1;
          continue;
        }
        candidates.push(parsed.data);
      } catch {
        state.statistics.errors += 1;
      }
    }
    return { candidates, normalized };
  };

  const processAuthor = async (target: CoordinatorTarget, client: XTargetClient): Promise<void> => {
    const progress = targetState(state, target.key);
    if (progress.exhausted || done()) return;
    const profile = await client.userByScreenName(target.value);
    const userId = typeof profile.rest_id === 'string' ? profile.rest_id : undefined;
    if (userId === undefined) throw new Error(`profile ${target.value} did not contain rest_id`);
    while (!progress.exhausted && !done()) {
      const page = await client.userTweets(userId, progress.cursor ?? undefined);
      const { candidates, normalized } = candidatesFrom(page.tweets);
      await emitCandidates(candidates);
      progress.cursor = page.bottomCursor;
      if (page.bottomCursor === null || safelyPastSince(normalized, input.since)) progress.exhausted = true;
      await persist();
    }
  };

  const processTweet = async (target: CoordinatorTarget, client: XTargetClient): Promise<void> => {
    const progress = targetState(state, target.key);
    if (progress.exhausted || done()) return;
    const raw = await client.tweetById(target.value);
    const { candidates } = candidatesFrom([raw]);
    await emitCandidates(candidates);
    progress.exhausted = true;
    await persist();
  };

  try {
    const resolution = await options.entitlement.resolve();
    tier = resolution.tier;
    effectiveLimit = Math.min(resolution.effectiveLimit, desiredLimit);
    if (effectiveLimit > 0) {
      await withConcurrency(uniqueTargets(input), Math.max(1, Math.min(3, options.concurrency ?? 3)), async (target) => {
        if (done()) return;
        try {
          const client = await options.sourceFactory(target);
          if (target.kind === 'author') await processAuthor(target, client);
          else await processTweet(target, client);
        } catch (error) {
          state.statistics.errors += 1;
          const progress = targetState(state, target.key);
          progress.exhausted = true;
          options.log?.({ event: 'target_failed', target: target.key, message: errorMessage(error) });
          await persist();
        }
      });
    }
  } catch (error) {
    state.statistics.errors += 1;
    options.log?.({ event: 'entitlement_failed', message: errorMessage(error) });
  } finally {
    await persist();
  }

  const metadata = OutputMetadataSchema.parse({
    version: 1,
    ...options.subject,
    tier,
    effectiveLimit,
    statistics: state.statistics,
    completedAt: now(),
  });
  await options.persistence.writeOutput(metadata);
  return metadata;
}

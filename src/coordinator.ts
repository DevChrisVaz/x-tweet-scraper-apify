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

export interface ReservationOutcome {
  grantedIds: Set<string>;
  deniedIds: Set<string>;
}

export interface EmissionBoundary {
  reserveBatch(tweetIds: string[]): Promise<ReservationOutcome>;
  emit(tweetId: string, push: () => Promise<void>): Promise<boolean>;
}

export interface PersistedTarget {
  cursor: string | null;
  exhausted: boolean;
  visitedCursors?: string[];
}

export interface PendingTweet {
  tweet: TweetOutput;
  granted: boolean;
}

export interface CoordinatorState {
  version: 1;
  targets: Record<string, PersistedTarget>;
  seenIds: string[];
  statistics: RunStatistics;
  pending?: Record<string, PendingTweet>;
}

export interface CoordinatorPersistence {
  load(fallback: CoordinatorState): Promise<CoordinatorState>;
  save(state: CoordinatorState): Promise<void>;
  writeOutput(metadata: OutputMetadata): Promise<void>;
}

export interface CoordinatorLogEntry {
  event: 'checkpoint_failed' | 'cursor_stopped' | 'emission_failed' | 'entitlement_failed' | 'signer_unavailable' | 'target_failed';
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

interface DrainResult {
  unavailable: boolean;
}

function defaultState(): CoordinatorState {
  return { version: 1, targets: {}, seenIds: [], statistics: createEmptyStatistics(), pending: {} };
}

function hydrateState(state: CoordinatorState): CoordinatorState {
  state.pending ??= {};
  for (const target of Object.values(state.targets)) target.visitedCursors ??= [];
  return state;
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
  if (existing !== undefined) {
    existing.visitedCursors ??= [];
    return existing;
  }
  const created: PersistedTarget = { cursor: null, exhausted: false, visitedCursors: [] };
  state.targets[key] = created;
  return created;
}

function pendingState(state: CoordinatorState): Record<string, PendingTweet> {
  state.pending ??= {};
  return state.pending;
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
  const now = options.now ?? (() => new Date().toISOString());
  let state = defaultState();
  let seen = new Set<string>();
  let stateLoaded = false;
  let tier: OutputMetadata['tier'] = 'unknown';
  let effectiveLimit = 0;
  let desiredLimit = 0;
  let remoteExhausted = false;
  let signerUnavailable = false;
  let checkpointChain: Promise<void> = Promise.resolve();
  let emissionChain: Promise<void> = Promise.resolve();

  const persist = async (): Promise<void> => {
    state.seenIds = [...seen];
    const next = checkpointChain.then(() => options.persistence.save(state), () => options.persistence.save(state));
    checkpointChain = next.catch(() => undefined);
    await next;
  };
  const persistSafely = async (): Promise<void> => {
    try {
      await persist();
    } catch (error) {
      state.statistics.errors += 1;
      options.log?.({ event: 'checkpoint_failed', message: errorMessage(error) });
    }
  };
  const sourceDone = (): boolean => signerUnavailable
    || remoteExhausted
    || state.statistics.emitted >= desiredLimit
    || state.statistics.reserved >= effectiveLimit;

  try {
    const input = ActorInputSchema.parse(options.input);
    desiredLimit = input.maxResults;
    state = hydrateState(await options.persistence.load(defaultState()));
    seen = new Set(state.seenIds);
    stateLoaded = true;
    const normalize = options.normalize ?? normalizeTweet;

    const completeTerminal = (tweetId: string, denied: boolean): void => {
      delete pendingState(state)[tweetId];
      seen.add(tweetId);
      if (denied) state.statistics.denied += 1;
    };

    const reconcileUnreconciled = async (): Promise<void> => {
      let reconciled = false;
      for (const [tweetId, item] of Object.entries(pendingState(state))) {
        if (item.granted) continue;
        completeTerminal(tweetId, true);
        reconciled = true;
      }
      if (reconciled) await persistSafely();
    };

    const validateReservation = (outcome: ReservationOutcome, requested: string[]): void => {
      const requestedIds = new Set(requested);
      for (const tweetId of outcome.grantedIds) if (!requestedIds.has(tweetId)) throw new Error('reservation granted an unrequested tweet ID');
      for (const tweetId of outcome.deniedIds) if (!requestedIds.has(tweetId) || outcome.grantedIds.has(tweetId)) throw new Error('reservation result was inconsistent');
      if (outcome.grantedIds.size + outcome.deniedIds.size !== requestedIds.size) throw new Error('reservation result omitted a requested tweet ID');
    };

    const pauseForRetry = async (event: 'emission_failed' | 'signer_unavailable', error: unknown): Promise<DrainResult> => {
      signerUnavailable = true;
      state.statistics.errors += 1;
      options.log?.({ event, message: errorMessage(error) });
      await persistSafely();
      return { unavailable: true };
    };

    const pushGranted = async (tweetId: string, pending: PendingTweet): Promise<DrainResult> => {
      try {
        const emitted = await options.emission.emit(tweetId, async () => options.pushData(pending.tweet));
        if (emitted) {
          state.statistics.emitted += 1;
          completeTerminal(tweetId, false);
        } else completeTerminal(tweetId, true);
        await persistSafely();
        return { unavailable: false };
      } catch (error) {
        return pauseForRetry('emission_failed', error);
      }
    };

    const drainPendingInner = async (): Promise<DrainResult> => {
      if (signerUnavailable) return { unavailable: true };
      const pending = pendingState(state);
      for (const [tweetId, item] of Object.entries(pending)) {
        if (!item.granted) continue;
        const result = await pushGranted(tweetId, item);
        if (result.unavailable) return result;
      }
      if (remoteExhausted || signerUnavailable) {
        if (remoteExhausted) await reconcileUnreconciled();
        return { unavailable: signerUnavailable };
      }
      while (!sourceDone()) {
        const candidates = Object.entries(pendingState(state)).filter(([, item]) => !item.granted);
        if (candidates.length === 0) return { unavailable: false };
        const capacity = Math.min(20, desiredLimit - state.statistics.emitted, effectiveLimit - state.statistics.reserved);
        if (capacity <= 0) {
          await reconcileUnreconciled();
          return { unavailable: false };
        }
        const batch = candidates.slice(0, capacity);
        const tweetIds = batch.map(([tweetId]) => tweetId);
        let outcome: ReservationOutcome;
        try {
          outcome = await options.emission.reserveBatch(tweetIds);
          validateReservation(outcome, tweetIds);
        } catch (error) {
          return pauseForRetry('signer_unavailable', error);
        }
        state.statistics.reserved += outcome.grantedIds.size;
        for (const tweetId of outcome.grantedIds) {
          const item = pendingState(state)[tweetId];
          if (item !== undefined) item.granted = true;
        }
        for (const tweetId of outcome.deniedIds) completeTerminal(tweetId, true);
        if (outcome.deniedIds.size > 0) remoteExhausted = true;
        await persistSafely();
        for (const tweetId of outcome.grantedIds) {
          const item = pendingState(state)[tweetId];
          if (item === undefined) continue;
          const result = await pushGranted(tweetId, item);
          if (result.unavailable) return result;
        }
        if (remoteExhausted) {
          await reconcileUnreconciled();
          return { unavailable: false };
        }
      }
      if (state.statistics.reserved >= effectiveLimit || state.statistics.emitted >= desiredLimit) await reconcileUnreconciled();
      return { unavailable: signerUnavailable };
    };

    const drainPending = async (): Promise<DrainResult> => {
      let result: DrainResult | undefined;
      const next = emissionChain.then(async () => { result = await drainPendingInner(); }, async () => { result = await drainPendingInner(); });
      emissionChain = next.catch(() => undefined);
      await next;
      if (result === undefined) throw new Error('pending drain did not complete');
      return result;
    };

    const candidatesFrom = (rawTweets: JsonRecord[]): TweetOutput[] => {
      const normalized: TweetOutput[] = [];
      for (const raw of rawTweets) {
        try {
          const parsed = TweetOutputSchema.safeParse(normalize(raw));
          if (!parsed.success) {
            state.statistics.errors += 1;
            continue;
          }
          const tweet = parsed.data;
          state.statistics.discovered += 1;
          normalized.push(tweet);
          if (seen.has(tweet.id) || pendingState(state)[tweet.id] !== undefined) continue;
          if (applyTweetFilters([tweet], filtersFrom(input)).length === 0) {
            state.statistics.filtered += 1;
            seen.add(tweet.id);
            continue;
          }
          pendingState(state)[tweet.id] = { tweet, granted: false };
        } catch {
          state.statistics.errors += 1;
        }
      }
      return normalized;
    };

    const processAuthor = async (target: CoordinatorTarget, client: XTargetClient): Promise<void> => {
      const progress = targetState(state, target.key);
      if (progress.exhausted || sourceDone()) return;
      const profile = await client.userByScreenName(target.value);
      const userId = typeof profile.rest_id === 'string' ? profile.rest_id : undefined;
      if (userId === undefined) throw new Error(`profile ${target.value} did not contain rest_id`);
      while (!progress.exhausted && !sourceDone()) {
        const requestCursor = progress.cursor;
        const visited = new Set(progress.visitedCursors);
        if (requestCursor !== null) {
          if (visited.has(requestCursor)) {
            progress.exhausted = true;
            options.log?.({ event: 'cursor_stopped', target: target.key, message: 'cursor was already visited' });
            await persistSafely();
            return;
          }
        }
        const page = await client.userTweets(userId, requestCursor ?? undefined);
        if (requestCursor !== null) progress.visitedCursors?.push(requestCursor);
        const normalized = candidatesFrom(page.tweets);
        const drained = await drainPending();
        if (drained.unavailable) {
          await persistSafely();
          return;
        }
        progress.cursor = page.bottomCursor;
        const repeated = page.bottomCursor !== null && (page.bottomCursor === requestCursor || (progress.visitedCursors ?? []).includes(page.bottomCursor));
        if (page.bottomCursor === null || safelyPastSince(normalized, input.since) || repeated) {
          progress.exhausted = true;
          if (repeated) options.log?.({ event: 'cursor_stopped', target: target.key, message: 'timeline returned a repeated cursor' });
        }
        await persistSafely();
      }
    };

    const processTweet = async (target: CoordinatorTarget, client: XTargetClient): Promise<void> => {
      const progress = targetState(state, target.key);
      if (progress.exhausted || sourceDone()) return;
      const raw = await client.tweetById(target.value);
      candidatesFrom([raw]);
      const drained = await drainPending();
      if (drained.unavailable) {
        await persistSafely();
        return;
      }
      progress.exhausted = true;
      await persistSafely();
    };

    const resolution = await options.entitlement.resolve();
    tier = resolution.tier;
    effectiveLimit = Math.min(resolution.effectiveLimit, desiredLimit);
    const restored = await drainPending();
    if (!restored.unavailable && effectiveLimit > 0) {
      await withConcurrency(uniqueTargets(input), Math.max(1, Math.min(3, options.concurrency ?? 3)), async (target) => {
        if (sourceDone()) return;
        try {
          const client = await options.sourceFactory(target);
          if (target.kind === 'author') await processAuthor(target, client);
          else await processTweet(target, client);
        } catch (error) {
          state.statistics.errors += 1;
          const progress = targetState(state, target.key);
          progress.exhausted = true;
          options.log?.({ event: 'target_failed', target: target.key, message: errorMessage(error) });
          await persistSafely();
        }
      });
    }
  } catch (error) {
    state.statistics.errors += 1;
    tier = 'unknown';
    effectiveLimit = 0;
    options.log?.({ event: 'entitlement_failed', message: errorMessage(error) });
  } finally {
    if (stateLoaded) await persistSafely();
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

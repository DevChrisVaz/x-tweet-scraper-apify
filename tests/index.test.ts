import { describe, expect, it } from 'vitest';
import * as actorEntry from '../src/index.js';
import { createApifyPersistence, createDefaultDatasetDeliveryReconciler } from '../src/index.js';
import type { CoordinatorState } from '../src/coordinator.js';

describe('Apify coordinator adapter', () => {
  it('reconciles delivered TweetOutput IDs from every page of the default dataset after a restart', async () => {
    const calls: Array<{ offset: number; limit: number; clean: boolean; fields: string[] }> = [];
    const hasDelivered = await createDefaultDatasetDeliveryReconciler({
      openDataset: async () => ({
        getData: async (options) => {
          calls.push(options);
          if (options.offset === 0) return { items: [{ id: 'already-pushed' }], count: 1, total: 2 };
          return { items: [{ id: 'also-pushed' }], count: 1, total: 2 };
        },
      }),
    });
    await expect(hasDelivered('also-pushed')).resolves.toBe(true);
    await expect(hasDelivered('not-pushed')).resolves.toBe(false);
    expect(calls).toEqual([
      { offset: 0, limit: 1_000, clean: true, fields: ['id'] },
      { offset: 1, limit: 1_000, clean: true, fields: ['id'] },
    ]);
  });

  it('uses Actor.useState for resumable coordinator state and writes final OUTPUT metadata', async () => {
    const state: CoordinatorState = { version: 1, targets: {}, seenIds: [], statistics: { discovered: 0, filtered: 0, reserved: 0, emitted: 0, denied: 0, errors: 0 } };
    const values: Array<{ key: string; value: unknown; options?: Record<string, unknown> }> = [];
    const persistence = await createApifyPersistence({
      useState: async () => state,
      setValue: async (key, value, options) => { values.push(options === undefined ? { key, value } : { key, value, options }); },
    });
    const loaded = await persistence.load({ ...state, seenIds: ['fallback'] });
    loaded.seenIds = ['tweet-1'];
    await persistence.save(loaded);
    await persistence.writeOutput({ version: 1, actorId: 'actor-1', runId: 'run-1', userId: 'user-1', tier: 'free', effectiveLimit: 10, statistics: state.statistics, completedAt: '2025-01-01T00:00:00.000Z' });
    expect(state.seenIds).toEqual(['tweet-1']);
    expect(values).toEqual([{ key: 'OUTPUT', value: expect.objectContaining({ effectiveLimit: 10 }), options: { contentType: 'application/json' } }]);
  });

  it('writes minimal fail-closed OUTPUT and exits when Actor.useState fails', async () => {
    const values: Array<{ key: string; value: unknown }> = [];
    const events: string[] = [];
    const runner = (actorEntry as Record<string, unknown>).runApifyActorWithRuntime;
    expect(runner).toBeTypeOf('function');
    await (runner as (runtime: unknown) => Promise<void>)({
      init: async () => { events.push('init'); },
      exit: async () => { events.push('exit'); },
      getEnv: () => ({ actorId: 'actor-1', actorRunId: 'run-1', userId: 'user-1' }),
      useState: async () => { throw new Error('state unavailable'); },
      setValue: async (key: string, value: unknown) => { values.push({ key, value }); },
    });
    expect(values).toEqual([{ key: 'OUTPUT', value: expect.objectContaining({ tier: 'unknown', effectiveLimit: 0, statistics: expect.objectContaining({ errors: 1 }) }) }]);
    expect(events).toEqual(['init', 'exit']);
  });
});

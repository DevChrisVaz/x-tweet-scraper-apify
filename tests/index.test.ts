import { describe, expect, it } from 'vitest';
import { createApifyPersistence } from '../src/index.js';
import type { CoordinatorState } from '../src/coordinator.js';

describe('Apify coordinator adapter', () => {
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
});

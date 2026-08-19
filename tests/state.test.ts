import { describe, expect, it } from 'vitest';
import { OUTPUT, createEmptyStatistics, createMigrationState, OutputMetadataSchema } from '../src/state.js';

describe('persisted entitlement state', () => {
  it('creates versioned migration state and output metadata with run statistics', () => {
    const state = createMigrationState({ actorId: 'actor-1', runId: 'run-1', userId: 'user-1' }, '2025-01-01T00:00:00.000Z');
    expect(state).toMatchObject({ version: 1, resolved: false, effectiveLimit: 0, emitted: 0 });
    const metadata = OutputMetadataSchema.parse({
      version: 1, actorId: state.actorId, runId: state.runId, userId: state.userId, tier: 'free', effectiveLimit: 10,
      statistics: { ...createEmptyStatistics(), emitted: 3, denied: 1 }, completedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(metadata.statistics.emitted).toBe(3);
    expect(OUTPUT.name).toBe('OUTPUT');
  });
});

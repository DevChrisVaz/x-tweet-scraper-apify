import { z } from 'zod';

export const EntitlementMigrationStateSchema = z.object({
  version: z.literal(1),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  userId: z.string().min(1),
  resolved: z.boolean(),
  effectiveLimit: z.number().int().min(0).max(10_000),
  emitted: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().datetime({ offset: false }),
});

export const RunStatisticsSchema = z.object({
  discovered: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  emitted: z.number().int().nonnegative(),
  denied: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export const OutputMetadataSchema = z.object({
  version: z.literal(1),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  userId: z.string().min(1),
  tier: z.enum(['free', 'paid', 'unknown']),
  effectiveLimit: z.number().int().min(0).max(10_000),
  statistics: RunStatisticsSchema,
  completedAt: z.string().datetime({ offset: false }),
});

export type EntitlementMigrationState = z.infer<typeof EntitlementMigrationStateSchema>;
export type RunStatistics = z.infer<typeof RunStatisticsSchema>;
export type OutputMetadata = z.infer<typeof OutputMetadataSchema>;

export function createMigrationState(subject: { actorId: string; runId: string; userId: string }, now = new Date().toISOString()): EntitlementMigrationState {
  return EntitlementMigrationStateSchema.parse({ version: 1, ...subject, resolved: false, effectiveLimit: 0, emitted: 0, reserved: 0, lastUpdatedAt: now });
}

export function createEmptyStatistics(): RunStatistics {
  return { discovered: 0, filtered: 0, reserved: 0, emitted: 0, denied: 0, errors: 0 };
}

export const OUTPUT = {
  name: 'OUTPUT',
  contentType: 'application/json',
  schemaVersion: 1,
} as const;

import { Actor, log } from 'apify';
import { ActorInputSchema, type TweetOutput } from './contracts.js';
import { runCoordinator, type CoordinatorPersistence, type CoordinatorState, type XTargetClient } from './coordinator.js';
import { EmissionGuard, createPlatformEntitlementClient, platformEntitlementIdentity } from './emission.js';
import { OUTPUT, OutputMetadataSchema, createEmptyStatistics } from './state.js';
import { GuestSession, OperationRegistry, XGraphqlClient, createStickyProxyFetch } from './x-core.js';

export interface ApifyPersistenceApi {
  useState(name: string, defaultValue: CoordinatorState): Promise<CoordinatorState>;
  setValue(key: string, value: unknown, options?: Record<string, unknown>): Promise<void>;
}

export interface ActorRuntimeApi extends ApifyPersistenceApi {
  init(): Promise<void>;
  exit(): Promise<void>;
  getEnv(): unknown;
  getInput(): Promise<unknown>;
  createProxyConfiguration(options?: {
    useApifyProxy: boolean;
    apifyProxyGroups?: string[];
    apifyProxyCountry?: string;
  }): Promise<{ newUrl(sessionId?: string): Promise<string | undefined> } | undefined>;
  pushData(data: unknown): Promise<void>;
}

function emptyCoordinatorState(): CoordinatorState {
  return { version: 1, targets: {}, seenIds: [], statistics: createEmptyStatistics() };
}

export async function createApifyPersistence(actor: ApifyPersistenceApi): Promise<CoordinatorPersistence> {
  const state = await actor.useState('COORDINATOR_STATE', emptyCoordinatorState());
  return {
    load: async () => state,
    save: async (next) => {
      if (next !== state) Object.assign(state, next);
    },
    writeOutput: async (metadata) => actor.setValue(OUTPUT.name, metadata, { contentType: OUTPUT.contentType }),
  };
}

function proxySessionId(value: string): string {
  return value.replace(/[^0-9A-Za-z._~]/g, '_').slice(0, 50);
}

async function createTargetClient(proxyUrl: string | undefined): Promise<XTargetClient> {
  const transport = proxyUrl === undefined ? fetch : createStickyProxyFetch(proxyUrl);
  const registry = new OperationRegistry({ fetch: transport });
  const discovery = await registry.get();
  const session = new GuestSession({ fetch: transport, bearer: discovery.bearer, ...(proxyUrl === undefined ? {} : { proxyUrl }) });
  return new XGraphqlClient({ registry, session, fetch: transport });
}

function fallbackSubject(env: Record<string, unknown>): { actorId: string; runId: string; userId: string } {
  return {
    actorId: typeof env.actorId === 'string' && env.actorId.length > 0 ? env.actorId : 'unknown-actor',
    runId: typeof env.actorRunId === 'string' && env.actorRunId.length > 0 ? env.actorRunId : 'unknown-run',
    userId: typeof env.userId === 'string' && env.userId.length > 0 ? env.userId : 'unknown-user',
  };
}

async function writeFailClosedOutput(persistence: CoordinatorPersistence, env: Record<string, unknown>): Promise<void> {
  const metadata = OutputMetadataSchema.parse({
    version: 1,
    ...fallbackSubject(env),
    tier: 'unknown',
    effectiveLimit: 0,
    statistics: { ...createEmptyStatistics(), errors: 1 },
    completedAt: new Date().toISOString(),
  });
  await persistence.writeOutput(metadata);
}

async function writeMinimalFailClosedOutput(actor: ApifyPersistenceApi, env: Record<string, unknown>): Promise<void> {
  const metadata = OutputMetadataSchema.parse({
    version: 1,
    ...fallbackSubject(env),
    tier: 'unknown',
    effectiveLimit: 0,
    statistics: { ...createEmptyStatistics(), errors: 1 },
    completedAt: new Date().toISOString(),
  });
  await actor.setValue(OUTPUT.name, metadata, { contentType: OUTPUT.contentType });
}

export async function runApifyActorWithRuntime(actor: ActorRuntimeApi): Promise<void> {
  let env: Record<string, unknown> = {};
  let persistence: CoordinatorPersistence | undefined;
  let invalidInput = false;
  try {
    await actor.init();
    env = actor.getEnv() as Record<string, unknown>;
    persistence = await createApifyPersistence(actor);
    const parsedInput = ActorInputSchema.safeParse(await actor.getInput());
    if (!parsedInput.success) {
      invalidInput = true;
      throw parsedInput.error;
    }
    const input = parsedInput.data;
    const identity = platformEntitlementIdentity(env);
    const endpoint = process.env.ENTITLEMENT_ENDPOINT;
    const hmacSecret = process.env.ENTITLEMENT_HMAC_SECRET;
    const publicKey = process.env.ENTITLEMENT_PUBLIC_KEY;
    if (!endpoint || !hmacSecret || !publicKey) throw new Error('entitlement environment is incomplete');
    const entitlement = await createPlatformEntitlementClient({
      maxResults: input.maxResults,
      endpoint,
      hmacSecret,
      pinnedPublicKey: publicKey,
      ...(process.env.ENTITLEMENT_KEY_ID === undefined ? {} : { pinnedKeyId: process.env.ENTITLEMENT_KEY_ID }),
    });
    const guard = new EmissionGuard(entitlement);
    const proxyOptions = input.proxyConfiguration === undefined ? undefined : {
      useApifyProxy: input.proxyConfiguration.useApifyProxy,
      ...(input.proxyConfiguration.apifyProxyGroups === undefined ? {} : { apifyProxyGroups: input.proxyConfiguration.apifyProxyGroups }),
      ...(input.proxyConfiguration.apifyProxyCountry === undefined ? {} : { apifyProxyCountry: input.proxyConfiguration.apifyProxyCountry }),
    };
    const proxy = await actor.createProxyConfiguration(proxyOptions);
    await runCoordinator({
      input,
      subject: identity.subject,
      sourceFactory: async (target) => createTargetClient(await proxy?.newUrl(proxySessionId(target.key))),
      entitlement,
      emission: {
        reserveBatch: async (tweetIds) => guard.reserveBatch(tweetIds),
        emit: async (tweetId, push) => (await guard.emit(tweetId, async () => { await push(); return true; })) === true,
      },
      persistence,
      pushData: async (tweet: TweetOutput) => actor.pushData(tweet),
      log: (entry) => log.warning('X coordinator event', entry),
    });
  } catch (error) {
    try {
      if (persistence === undefined) await writeMinimalFailClosedOutput(actor, env);
      else await writeFailClosedOutput(persistence, env);
    } catch (outputError) {
      log.error('Unable to write fail-closed Actor OUTPUT', { message: outputError instanceof Error ? outputError.message : 'unknown error' });
    }
    if (invalidInput) throw error;
  } finally {
    await actor.exit();
  }
}

export async function runApifyActor(): Promise<void> {
  return runApifyActorWithRuntime(Actor as unknown as ActorRuntimeApi);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void runApifyActor();
}

import { createHmac, createPublicKey, randomUUID, verify as verifySignature, type KeyObject } from 'node:crypto';
import { canonicalRequest, hashTweetId, type EntitlementSubject } from './entitlements.js';
import type { EntitlementResolution, SignedDecision, SignedReservationResponse } from './contracts.js';

export interface ReservationCall {
  version: 1;
  actorId: string;
  runId: string;
  userId: string;
  tweetIds: string[];
  requestId: string;
}

export interface ResolutionCall {
  version: 1;
  actorId: string;
  runId: string;
  userId: string;
  platformIsPaying: boolean;
  requestedMaxResults: number;
}

export interface ActorEntitlementClientOptions {
  subject: EntitlementSubject;
  platformIsPaying: boolean;
  maxResults: number;
  signer?: (request: ReservationCall) => Promise<SignedReservationResponse>;
  resolver?: (request: ResolutionCall) => Promise<EntitlementResolution>;
  endpoint?: string;
  fetcher?: typeof fetch;
  hmacSecret: string;
  pinnedPublicKey: string | KeyObject;
  pinnedKeyId?: string;
  now?: () => number;
}

export interface PlatformApifyEnv {
  actorId?: string;
  actorRunId?: string;
  userId?: string;
  userIsPaying?: string;
}

export async function createPlatformEntitlementClient(options: Omit<ActorEntitlementClientOptions, 'subject' | 'platformIsPaying'>): Promise<ActorEntitlementClient> {
  const { Actor } = await import('apify');
  const env = Actor.getEnv() as unknown as Record<string, unknown>;
  const identity = platformEntitlementIdentity(env);
  return new ActorEntitlementClient({ ...options, subject: identity.subject, platformIsPaying: identity.isPaying });
}

export function subjectFromActorEnv(env: Record<string, unknown>): EntitlementSubject {
  const actorId = env.actorId ?? env.APIFY_ACTOR_ID;
  const runId = env.actorRunId ?? env.runId ?? env.APIFY_ACTOR_RUN_ID;
  const userId = env.userId;
  if (typeof actorId !== 'string' || typeof runId !== 'string' || typeof userId !== 'string' || !actorId || !runId || !userId) throw new Error('missing platform entitlement identity');
  return { actorId, runId, userId };
}

export function payingFromActorEnv(env: Record<string, unknown>): boolean {
  return env.userIsPaying === '1';
}

export function platformEntitlementIdentity(env: Record<string, unknown>): { subject: EntitlementSubject; isPaying: boolean } {
  return { subject: subjectFromActorEnv(env), isPaying: payingFromActorEnv(env) };
}

function keyFromPinned(value: string | KeyObject): KeyObject {
  if (typeof value !== 'string') return value;
  try {
    return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return createPublicKey(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function verifySigned(value: unknown, signature: string, key: KeyObject): boolean {
  return verifySignature(null, Buffer.from(canonicalJson(value)), key, Buffer.from(signature, 'base64url'));
}

function decisionPayload(decision: SignedDecision): Omit<SignedDecision, 'signature' | 'keyId'> {
  const payload = { ...decision } as Record<string, unknown>;
  delete payload.signature;
  delete payload.keyId;
  return payload as Omit<SignedDecision, 'signature' | 'keyId'>;
}

function responsePayload(response: SignedReservationResponse): Omit<SignedReservationResponse, 'signature' | 'keyId'> {
  const payload = { ...response } as Record<string, unknown>;
  delete payload.signature;
  delete payload.keyId;
  return payload as Omit<SignedReservationResponse, 'signature' | 'keyId'>;
}

export class ActorEntitlementClient {
  private readonly key: KeyObject;
  private readonly now: () => number;

  constructor(private readonly options: ActorEntitlementClientOptions) {
    if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 10_000) throw new Error('invalid maxResults');
    if (typeof options.platformIsPaying !== 'boolean') throw new Error('missing platform payer identity');
    if (!options.signer && !options.endpoint) throw new Error('entitlement endpoint is not configured');
    this.key = keyFromPinned(options.pinnedPublicKey);
    this.now = options.now ?? Date.now;
  }

  async reserve(tweetIds: string[]): Promise<SignedReservationResponse> {
    if (tweetIds.length < 1 || tweetIds.length > 20 || new Set(tweetIds).size !== tweetIds.length) throw new Error('reservation batches must contain 1..20 unique IDs');
    const body: ReservationCall = {
      version: 1,
      actorId: this.options.subject.actorId,
      runId: this.options.subject.runId,
      userId: this.options.subject.userId,
      tweetIds,
      requestId: `${this.options.subject.runId}:${tweetIds.map(hashTweetId).join(',')}`,
    };
    const response = this.options.signer ? await this.options.signer(body) : await this.post<SignedReservationResponse>('/entitlements/reserve', body);
    this.validateResponse(response);
    return response;
  }

  async grant(tweetId: string): Promise<boolean> {
    const response = await this.reserve([tweetId]);
    return response.decisions.some((decision) => decision.tweetId === tweetId && decision.decision === 'grant');
  }

  async resolve(): Promise<EntitlementResolution> {
    const body: ResolutionCall = {
      version: 1,
      actorId: this.options.subject.actorId,
      runId: this.options.subject.runId,
      userId: this.options.subject.userId,
      platformIsPaying: this.options.platformIsPaying,
      requestedMaxResults: this.options.maxResults,
    };
    const resolution = this.options.resolver ? await this.options.resolver(body) : await this.post<EntitlementResolution>('/entitlements/resolve', body);
    if (this.options.pinnedKeyId !== undefined && resolution.keyId !== this.options.pinnedKeyId) throw new Error('unexpected signing key');
    if (resolution.subject.actorId !== this.options.subject.actorId || resolution.subject.runId !== this.options.subject.runId || resolution.subject.userId !== this.options.subject.userId) throw new Error('signed resolution subject mismatch');
    if (Date.parse(resolution.expiresAt) <= this.now()) throw new Error('signed resolution expired');
    const payloadToVerify = { ...resolution } as Record<string, unknown>;
    const signature = String(payloadToVerify.signature);
    delete payloadToVerify.signature;
    delete payloadToVerify.keyId;
    if (!verifySigned(payloadToVerify, signature, this.key)) throw new Error('invalid resolution signature');
    return resolution;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const endpoint = this.options.endpoint;
    if (!endpoint) throw new Error('entitlement endpoint is not configured');
    const timestamp = String(this.now());
    const nonce = randomUUID();
    const signature = createHmac('sha256', this.options.hmacSecret).update(canonicalRequest('POST', path, timestamp, nonce, body)).digest('base64url');
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${endpoint.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-entitlement-timestamp': timestamp, 'x-entitlement-nonce': nonce, 'x-entitlement-signature': signature },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as T | { error?: string };
    if (!response.ok) throw new Error(typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : `entitlement request failed (${response.status})`);
    return payload as T;
  }

  private validateResponse(response: SignedReservationResponse): void {
    if (this.options.pinnedKeyId !== undefined && response.keyId !== this.options.pinnedKeyId) throw new Error('unexpected signing key');
    if (response.subject.actorId !== this.options.subject.actorId || response.subject.runId !== this.options.subject.runId || response.subject.userId !== this.options.subject.userId) throw new Error('signed response subject mismatch');
    if (Date.parse(response.expiresAt) <= this.now()) throw new Error('signed response expired');
    if (!verifySigned(responsePayload(response), response.signature, this.key)) throw new Error('invalid response signature');
    for (const decision of response.decisions) {
      if (decision.subject.actorId !== this.options.subject.actorId || decision.subject.runId !== this.options.subject.runId || decision.subject.userId !== this.options.subject.userId) throw new Error('signed decision subject mismatch');
      if (Date.parse(decision.expiresAt) <= this.now()) throw new Error('signed decision expired');
      if (!verifySigned(decisionPayload(decision), decision.signature, this.key)) throw new Error('invalid decision signature');
    }
  }
}

export class EmissionGuard {
  private chain: Promise<void> = Promise.resolve();
  private readonly granted = new Set<string>();

  constructor(private readonly client: ActorEntitlementClient) {}

  async reserve(tweetId: string): Promise<boolean> {
    let allowed = false;
    await this.enqueue(async () => {
      if (this.granted.has(tweetId)) {
        allowed = true;
        return;
      }
      try {
        allowed = await this.client.grant(tweetId);
        if (allowed) this.granted.add(tweetId);
      } catch {
        allowed = false;
      }
    });
    return allowed;
  }

  async reserveBatch(tweetIds: string[]): Promise<Set<string>> {
    const allowed = new Set<string>();
    await this.enqueue(async () => {
      const unique = [...new Set(tweetIds)];
      if (unique.length === 0 || unique.length > 20) throw new Error('reservation batches must contain 1..20 unique IDs');
      const pending = unique.filter((tweetId) => !this.granted.has(tweetId));
      for (const tweetId of unique) if (this.granted.has(tweetId)) allowed.add(tweetId);
      if (pending.length === 0) return;
      try {
        const response = await this.client.reserve(pending);
        for (const decision of response.decisions) {
          if (decision.decision !== 'grant' || !pending.includes(decision.tweetId)) continue;
          this.granted.add(decision.tweetId);
          allowed.add(decision.tweetId);
        }
      } catch {
        // The caller receives no grant when the signer is unavailable or invalid.
      }
    });
    return allowed;
  }

  async canEmit(tweetId: string): Promise<boolean> {
    return this.granted.has(tweetId);
  }

  async emit<T>(tweetId: string, push: () => Promise<T> | T): Promise<T | undefined> {
    let result: T | undefined;
    await this.enqueue(async () => {
      if (!this.granted.has(tweetId)) {
        try {
          if (!(await this.client.grant(tweetId))) return;
          this.granted.add(tweetId);
        } catch {
          return;
        }
      }
      result = await push();
    });
    return result;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

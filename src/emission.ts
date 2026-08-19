import { createHmac, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { canonicalRequest, hashTweetId, type EntitlementSubject } from './entitlements.js';
import type { EntitlementResolution, SignedDecision, SignedReservationResponse } from './contracts.js';

export interface ReservationCall {
  subject: EntitlementSubject;
  tweetIds: string[];
  requestId: string;
  issuedAt: string;
  signature: string;
}

export interface ActorEntitlementClientOptions {
  subject: EntitlementSubject;
  maxResults: number;
  signer: (request: ReservationCall) => Promise<SignedReservationResponse>;
  resolver?: (request: { subject: EntitlementSubject; maxResults: number; timestamp: string; nonce: string; signature: string }) => Promise<EntitlementResolution>;
  hmacSecret: string;
  pinnedPublicKey: string | KeyObject;
  pinnedKeyId?: string;
  now?: () => number;
}

export async function createPlatformEntitlementClient(options: Omit<ActorEntitlementClientOptions, 'subject'>): Promise<ActorEntitlementClient> {
  const { Actor } = await import('apify');
  const env = Actor.getEnv() as unknown as Record<string, unknown>;
  return new ActorEntitlementClient({ ...options, subject: subjectFromActorEnv(env) });
}

export function subjectFromActorEnv(env: Record<string, unknown>): EntitlementSubject {
  const actorId = env.APIFY_ACTOR_ID ?? env.actorId;
  const runId = env.APIFY_ACTOR_RUN_ID ?? env.actorRunId ?? env.runId;
  const userId = env.APIFY_USER_ID ?? env.userId;
  if (typeof actorId !== 'string' || typeof runId !== 'string' || typeof userId !== 'string' || !actorId || !runId || !userId) throw new Error('missing platform entitlement identity');
  return { actorId, runId, userId };
}

export function payingFromActorEnv(env: Record<string, unknown>): boolean {
  const value = env.APIFY_USER_IS_PAYING ?? env.userIsPaying;
  return value === true || value === 'true' || value === '1';
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
    this.key = keyFromPinned(options.pinnedPublicKey);
    this.now = options.now ?? Date.now;
  }

  async reserve(tweetIds: string[]): Promise<SignedReservationResponse> {
    if (tweetIds.length < 1 || tweetIds.length > 20 || new Set(tweetIds).size !== tweetIds.length) throw new Error('reservation batches must contain 1..20 unique IDs');
    const issuedAt = new Date(this.now()).toISOString();
    const requestBody = { subject: this.options.subject, tweetIds };
    const nonce = `${this.options.subject.runId}:${issuedAt}:${tweetIds[0] ?? ''}`;
    const timestamp = String(this.now());
    const requestId = `${this.options.subject.runId}:${tweetIds.map(hashTweetId).join(',')}`;
    const request: ReservationCall = {
      ...requestBody,
      requestId,
      issuedAt,
      signature: createHmac('sha256', this.options.hmacSecret).update(canonicalRequest('POST', '/entitlements/reserve', timestamp, nonce, { ...requestBody, requestId, issuedAt })).digest('base64url'),
    };
    const response = await this.options.signer(request);
    this.validateResponse(response);
    return response;
  }

  async grant(tweetId: string): Promise<boolean> {
    const response = await this.reserve([tweetId]);
    return response.decisions.some((decision) => decision.tweetId === tweetId && decision.decision === 'grant');
  }

  async resolve(): Promise<EntitlementResolution> {
    if (!this.options.resolver) throw new Error('entitlement resolver is not configured');
    const timestamp = String(this.now());
    const nonce = `${this.options.subject.runId}:resolve:${timestamp}`;
    const payload = { subject: this.options.subject, maxResults: this.options.maxResults };
    const resolution = await this.options.resolver({ ...payload, timestamp, nonce, signature: createHmac('sha256', this.options.hmacSecret).update(canonicalRequest('POST', '/entitlements/resolve', timestamp, nonce, payload)).digest('base64url') });
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

import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import {
  EntitlementResolutionSchema,
  SignedReservationResponseSchema,
  type BatchReservationRequest,
  type EntitlementResolution,
  type SignedDecision,
  type SignedReservationResponse,
} from './contracts.js';

export const ENTITLEMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const FREE_LIMIT = 10;
export const MAX_RESERVATION_BATCH = 20;
export const REQUEST_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface EntitlementSubject {
  actorId: string;
  runId: string;
  userId: string;
}

export interface AuthenticatedRequest {
  method: string;
  path: string;
  headers: Headers | Record<string, string | undefined>;
  body: unknown;
}

export interface VerifiedRequest {
  subject: EntitlementSubject;
  body: Record<string, unknown>;
  timestamp: number;
  nonce: string;
}

export interface VerifyRequestOptions {
  secret: string;
  now?: number;
  clockSkewMs?: number;
  replayedNonces: Set<string>;
  claimNonce?: (nonce: string, ttlSeconds: number) => Promise<boolean>;
}

export interface RunRecord {
  subject: EntitlementSubject;
  tier: 'free' | 'paid' | 'unknown';
  effectiveLimit: number;
  expiresAt: string;
  issuedAt: string;
  reserved: number;
  grantedHashes: Set<string>;
}

export interface EntitlementRepository {
  claimNonce?(nonce: string, ttlSeconds: number): Promise<boolean>;
  getRun(subject: EntitlementSubject): Promise<RunRecord | null>;
  getOrCreateRun(input: {
    subject: EntitlementSubject;
    tier: RunRecord['tier'];
    effectiveLimit: number;
    issuedAt: string;
    expiresAt: string;
  }): Promise<RunRecord>;
  reserve(input: {
    subject: EntitlementSubject;
    hashes: string[];
    effectiveLimit: number;
    expiresAt: string;
    now?: number;
  }): Promise<{ grantedHashes: string[]; decisions: boolean[] }>;
}

export interface EntitlementServiceOptions {
  signingPrivateKey: KeyObject | string | Buffer;
  signingKeyId: string;
  now?: () => number;
}

export interface ResolveInput {
  subject: EntitlementSubject;
  maxResults: number;
  isPaying: boolean;
}

function asHeaders(headers: Headers | Record<string, string | undefined>): (name: string) => string | undefined {
  if (headers instanceof Headers) return (name) => headers.get(name) ?? undefined;
  return (name) => headers[name] ?? headers[name.toLowerCase()];
}

function jsonValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jsonValue(record[key])}`).join(',')}}`;
}

export function canonicalRequest(method: string, path: string, timestamp: string, nonce: string, body: unknown): string {
  return [method.toUpperCase(), path, timestamp, nonce, jsonValue(body)].join('\n');
}

function decodeSignature(value: string): Buffer {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return Buffer.from(value, 'hex');
  }
}

function constantTimeStringEquals(left: string, right: string): boolean {
  const a = decodeSignature(left);
  const b = decodeSignature(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function subjectFromBody(body: unknown): EntitlementSubject {
  if (typeof body !== 'object' || body === null) throw new Error('invalid request body');
  const subject = (body as Record<string, unknown>).subject;
  if (typeof subject !== 'object' || subject === null) throw new Error('missing subject');
  const candidate = subject as Record<string, unknown>;
  if (typeof candidate.actorId !== 'string' || typeof candidate.runId !== 'string' || typeof candidate.userId !== 'string' || !candidate.actorId || !candidate.runId || !candidate.userId) {
    throw new Error('invalid subject');
  }
  return { actorId: candidate.actorId, runId: candidate.runId, userId: candidate.userId };
}

export async function verifyRequest(request: AuthenticatedRequest, options: VerifyRequestOptions): Promise<VerifiedRequest> {
  const header = asHeaders(request.headers);
  const timestampText = header('x-entitlement-timestamp');
  const nonce = header('x-entitlement-nonce');
  const provided = header('x-entitlement-signature');
  if (!timestampText || !nonce || !provided) throw new Error('missing authentication headers');
  const timestamp = Number(timestampText);
  const now = options.now ?? Date.now();
  const skew = options.clockSkewMs ?? REQUEST_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > skew) throw new Error('timestamp outside allowed clock skew');
  if (options.replayedNonces.has(nonce)) throw new Error('replay detected');
  const expected = createHmac('sha256', options.secret).update(canonicalRequest(request.method, request.path, timestampText, nonce, request.body)).digest('base64url');
  if (!constantTimeStringEquals(provided, expected)) throw new Error('invalid request signature');
  if (options.claimNonce && !(await options.claimNonce(nonce, Math.ceil(skew / 1_000)))) throw new Error('replay detected');
  options.replayedNonces.add(nonce);
  return { subject: subjectFromBody(request.body), body: request.body as Record<string, unknown>, timestamp, nonce };
}

export function hashTweetId(tweetId: string): string {
  if (!tweetId) throw new Error('tweet ID cannot be empty');
  return createHash('sha256').update(tweetId, 'utf8').digest('hex');
}

function runKey(subject: EntitlementSubject): string {
  return `${subject.actorId}:${subject.runId}:${subject.userId}`;
}

export class InMemoryEntitlementRepository implements EntitlementRepository {
  private readonly runs = new Map<string, RunRecord>();
  private readonly nonces = new Map<string, number>();

  async claimNonce(nonce: string, ttlSeconds: number, now = Date.now()): Promise<boolean> {
    const expiry = this.nonces.get(nonce);
    if (expiry !== undefined && expiry > now) return false;
    this.nonces.set(nonce, now + ttlSeconds * 1_000);
    return true;
  }

  async getRun(subject: EntitlementSubject): Promise<RunRecord | null> {
    return this.runs.get(runKey(subject)) ?? null;
  }

  async getOrCreateRun(input: {
    subject: EntitlementSubject;
    tier: RunRecord['tier'];
    effectiveLimit: number;
    issuedAt: string;
    expiresAt: string;
  }): Promise<RunRecord> {
    const key = runKey(input.subject);
    const existing = this.runs.get(key);
    if (existing) return existing;
    const run: RunRecord = { ...input, reserved: 0, grantedHashes: new Set<string>() };
    this.runs.set(key, run);
    return run;
  }

  async reserve(input: { subject: EntitlementSubject; hashes: string[]; effectiveLimit: number; expiresAt: string; now?: number }): Promise<{ grantedHashes: string[]; decisions: boolean[] }> {
    const run = this.runs.get(runKey(input.subject));
    if (!run) throw new Error('entitlement resolution required before reservation');
    if (Date.parse(run.expiresAt) <= (input.now ?? Date.now())) throw new Error('entitlement expired');
    const grantedHashes: string[] = [];
    const decisions: boolean[] = [];
    for (const hash of input.hashes) {
      if (run.grantedHashes.has(hash)) {
        grantedHashes.push(hash);
        decisions.push(true);
      } else if (run.reserved < run.effectiveLimit) {
        run.reserved += 1;
        run.grantedHashes.add(hash);
        grantedHashes.push(hash);
        decisions.push(true);
      } else decisions.push(false);
    }
    return { grantedHashes, decisions };
  }

  reset(): void {
    this.runs.clear();
  }
}

export class EntitlementService {
  constructor(private readonly repository: EntitlementRepository, private readonly options: EntitlementServiceOptions) {}

  async resolve(input: ResolveInput): Promise<EntitlementResolution> {
    if (!input.subject.actorId || !input.subject.runId || !input.subject.userId) throw new Error('missing subject identity');
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 10_000) throw new Error('invalid maxResults');
    const issuedAtMs = this.options.now?.() ?? Date.now();
    const issuedAt = new Date(issuedAtMs).toISOString();
    const expiresAt = new Date(issuedAtMs + ENTITLEMENT_TTL_SECONDS * 1_000).toISOString();
    const tier: RunRecord['tier'] = input.isPaying ? 'paid' : 'free';
    const effectiveLimit = input.isPaying ? input.maxResults : FREE_LIMIT;
    const run = await this.repository.getOrCreateRun({ subject: input.subject, tier, effectiveLimit, issuedAt, expiresAt });
    const payload = { subject: run.subject, tier: run.tier, effectiveLimit: run.effectiveLimit, expiresAt: run.expiresAt, issuedAt: run.issuedAt };
    return EntitlementResolutionSchema.parse({ ...payload, signature: this.sign(payload), keyId: this.options.signingKeyId });
  }

  async reserve(input: { subject: EntitlementSubject; tweetIds: string[] }): Promise<SignedReservationResponse> {
    if (input.tweetIds.length < 1 || input.tweetIds.length > MAX_RESERVATION_BATCH || new Set(input.tweetIds).size !== input.tweetIds.length) throw new Error('reservation batches must contain 1..20 unique IDs');
    const nowMs = this.options.now?.() ?? Date.now();
    const hashes = input.tweetIds.map(hashTweetId);
    const run = await this.repository.getRun(input.subject);
    if (!run) throw new Error('entitlement resolution required before reservation');
    const result = await this.repository.reserve({ subject: input.subject, hashes, effectiveLimit: run.effectiveLimit, expiresAt: run.expiresAt, now: nowMs });
    const decisions: SignedDecision[] = input.tweetIds.map((tweetId, index) => {
      const decision = result.decisions[index] === true ? 'grant' : 'deny';
      return { subject: input.subject, tweetId, decision, expiresAt: run.expiresAt, signature: this.sign({ subject: input.subject, tweetId, decision, expiresAt: run.expiresAt }), keyId: this.options.signingKeyId };
    });
    const responsePayload = { subject: input.subject, decisions, expiresAt: run.expiresAt };
    const response: SignedReservationResponse = { ...responsePayload, signature: this.sign(responsePayload), keyId: this.options.signingKeyId };
    return SignedReservationResponseSchema.parse(response);
  }

  async handleReservation(request: Omit<BatchReservationRequest, 'issuedAt' | 'requestId' | 'signature'>): Promise<SignedReservationResponse> {
    return this.reserve(request);
  }

  private sign(value: unknown): string {
    return signBytes(null, Buffer.from(jsonValue(value)), this.options.signingPrivateKey).toString('base64url');
  }
}

/** REST adapter for the Vercel Marketplace-provisioned Upstash Redis instance. */
export class UpstashEntitlementRepository implements EntitlementRepository {
  constructor(private readonly url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!url || !token) throw new Error('Upstash Redis credentials are required');
  }

  private async command(command: unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) throw new Error(`Upstash request failed (${response.status})`);
    const payload = await response.json() as { result?: unknown; error?: string };
    if (payload.error) throw new Error(`Upstash error: ${payload.error}`);
    return payload.result;
  }

  async getRun(subject: EntitlementSubject): Promise<RunRecord | null> {
    const existing = await this.command(['GET', `entitlement:${runKey(subject)}`]) as string | null;
    if (!existing) return null;
    const parsed = JSON.parse(existing) as Omit<RunRecord, 'grantedHashes'> & { grantedHashes: string[] };
    return { ...parsed, grantedHashes: new Set(parsed.grantedHashes) };
  }

  async claimNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.command(['SET', `entitlement:nonce:${nonce}`, '1', 'NX', 'EX', ttlSeconds]);
    return result === 'OK';
  }

  async getOrCreateRun(input: { subject: EntitlementSubject; tier: RunRecord['tier']; effectiveLimit: number; issuedAt: string; expiresAt: string }): Promise<RunRecord> {
    const key = `entitlement:${runKey(input.subject)}`;
    const existing = await this.command(['GET', key]) as string | null;
    if (existing) {
      const parsed = JSON.parse(existing) as Omit<RunRecord, 'grantedHashes'> & { grantedHashes: string[] };
      return { ...parsed, grantedHashes: new Set(parsed.grantedHashes) };
    }
    const run: Omit<RunRecord, 'grantedHashes'> & { grantedHashes: string[] } = { ...input, reserved: 0, grantedHashes: [] };
    const created = await this.command(['SET', key, JSON.stringify(run), 'NX', 'EX', ENTITLEMENT_TTL_SECONDS]) as string | null;
    if (created !== 'OK') return this.getOrCreateRun(input);
    return { ...run, grantedHashes: new Set() };
  }

  async reserve(input: { subject: EntitlementSubject; hashes: string[]; effectiveLimit: number; expiresAt: string; now?: number }): Promise<{ grantedHashes: string[]; decisions: boolean[] }> {
    if (input.hashes.length > MAX_RESERVATION_BATCH) throw new Error('reservation batch exceeds 20 IDs');
    const key = `entitlement:${runKey(input.subject)}`;
    const script = `local raw = redis.call('GET', KEYS[1]); if not raw then return redis.error_reply('missing entitlement') end; local run = cjson.decode(raw); local granted = {}; local decisions = {}; for i=1,#ARGV do local h=ARGV[i]; if run.granted[h] then granted[#granted+1]=h; decisions[#decisions+1]='1'; elseif tonumber(run.reserved) < tonumber(run.effectiveLimit) then run.reserved=tonumber(run.reserved)+1; run.granted[h]=true; granted[#granted+1]=h; decisions[#decisions+1]='1'; else decisions[#decisions+1]='0'; end end; redis.call('SET', KEYS[1], cjson.encode(run), 'KEEPTTL'); return {cjson.encode(granted), table.concat(decisions, ',')}`;
    const result = await this.command(['EVAL', script, '1', key, ...input.hashes]) as [string, string];
    const grantedHashes = JSON.parse(result[0] ?? '[]') as string[];
    const decisions = (result[1] ?? '').split(',').map((value) => value === '1');
    return { grantedHashes, decisions };
  }
}

export function publicKeyFromEnvironment(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

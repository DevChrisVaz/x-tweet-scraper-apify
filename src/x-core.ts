import type { TweetOutput } from './contracts.js';
import { gotScraping } from 'got-scraping';

export type OperationName = 'UserByScreenName' | 'UserTweets' | 'TweetResultByRestId';
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface StickyProxyRequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  proxyUrl: string;
  sessionToken: object;
}

export interface StickyProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

export type StickyProxyRequest = (url: string, options: StickyProxyRequestOptions) => Promise<StickyProxyResponse>;

const gotProxyRequest: StickyProxyRequest = async (url, options) => {
  const response = await gotScraping(url, {
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.body === undefined ? {} : { body: options.body }),
    proxyUrl: options.proxyUrl,
    sessionToken: options.sessionToken,
    useHeaderGenerator: false,
    throwHttpErrors: false,
    responseType: 'buffer',
  }) as unknown as StickyProxyResponse;
  return response;
};

/**
 * Creates a one-proxy, one-session transport. It never rotates a proxy: callers
 * create a new session only for a legitimate new actor target/run.
 */
export function createStickyProxyFetch(proxyUrl: string, request: StickyProxyRequest = gotProxyRequest): FetchLike {
  const sessionToken = {};
  return async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const method = init?.method?.toUpperCase();
    const supportedMethod: HttpMethod | undefined = method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' || method === 'HEAD' || method === 'OPTIONS' ? method : undefined;
    const result = await request(String(input), {
      ...(supportedMethod === undefined ? {} : { method: supportedMethod }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
      proxyUrl,
      sessionToken,
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
      else if (value !== undefined) responseHeaders.set(name, value);
    }
    return new Response(result.body, { status: result.statusCode, headers: responseHeaders });
  };
}

type OperationMap = Record<OperationName, string>;
type JsonRecord = Record<string, unknown>;

export interface DiscoverySnapshot {
  bearer: string;
  buildKey: string | null;
  bootstrapOperations: OperationName[];
  operations: OperationMap;
  features: JsonRecord;
  fieldToggles: JsonRecord;
}

export class OperationDriftError extends Error {
  public constructor(operation: OperationName) {
    super(`X GraphQL operation drift persisted after refresh: ${operation}`);
    this.name = 'OperationDriftError';
  }
}

export class AccessDeniedError extends Error {
  public constructor(status: number) {
    super(`X denied this guest session with HTTP ${status}; stopping without token or proxy rotation`);
    this.name = 'AccessDeniedError';
  }
}

export class GraphqlShapeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphqlShapeError';
  }
}

export class GraphqlResponseError extends Error {
  public constructor(message: string) {
    super(`X GraphQL returned an error: ${message}`);
    this.name = 'GraphqlResponseError';
  }
}

export class RateLimitError extends Error {
  public constructor() {
    super('X rate limit persisted after bounded retries');
    this.name = 'RateLimitError';
  }
}

const DEFAULT_OPERATIONS: OperationMap = {
  UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
  UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
  TweetResultByRestId: 'GZsN2Pc4knAoit6pXa4HSA',
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  return typeof record?.[key] === 'string' ? record[key] : undefined;
}

class JavaScriptLiteralParser {
  private position: number;

  public constructor(private readonly source: string, start: number) {
    this.position = start;
  }

  public parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const character = this.peek();
    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"' || character === "'") return this.parseString();
    if (character === '-' || (character !== undefined && /\d/.test(character))) return this.parseNumber();
    const identifier = this.parseIdentifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    if (identifier === 'undefined') return undefined;
    return identifier;
  }

  private parseObject(): JsonRecord {
    this.expect('{');
    const object: JsonRecord = {};
    this.skipWhitespace();
    while (this.peek() !== '}') {
      const key = this.peek() === '"' || this.peek() === "'" ? this.parseString() : this.parseIdentifier();
      if (key.length === 0) throw new Error('expected object key');
      this.skipWhitespace();
      this.expect(':');
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.peek() !== ',') break;
      this.position += 1;
      this.skipWhitespace();
    }
    this.expect('}');
    return object;
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const values: unknown[] = [];
    this.skipWhitespace();
    while (this.peek() !== ']') {
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek() !== ',') break;
      this.position += 1;
      this.skipWhitespace();
    }
    this.expect(']');
    return values;
  }

  private parseString(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") throw new Error('expected string');
    this.position += 1;
    let value = '';
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      this.position += 1;
      if (character === quote) return value;
      if (character !== '\\') {
        value += character;
        continue;
      }
      const escaped = this.source[this.position];
      this.position += 1;
      if (escaped === 'u') {
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('invalid unicode escape');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 4;
      } else if (escaped === 'x') {
        const hex = this.source.slice(this.position, this.position + 2);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error('invalid hexadecimal escape');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 2;
      } else {
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '/': '/' };
        value += escaped === undefined ? '' : (escapes[escaped] ?? escaped);
      }
    }
    throw new Error('unterminated string');
  }

  private parseNumber(): number {
    const matched = this.source.slice(this.position).match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (matched?.[0] === undefined) throw new Error('invalid number');
    this.position += matched[0].length;
    return Number(matched[0]);
  }

  private parseIdentifier(): string {
    const matched = this.source.slice(this.position).match(/^[A-Za-z_$][\w$]*/);
    if (matched?.[0] === undefined) throw new Error('expected literal');
    this.position += matched[0].length;
    return matched[0];
  }

  private skipWhitespace(): void {
    while (this.peek() !== undefined && /\s/.test(this.peek() ?? '')) this.position += 1;
  }

  private peek(): string | undefined {
    return this.source[this.position];
  }

  private expect(character: string): void {
    this.skipWhitespace();
    if (this.peek() !== character) throw new Error(`expected ${character}`);
    this.position += 1;
  }
}

function parseObjectLiteral(source: string, key: string): JsonRecord {
  const match = new RegExp(`(?:["']${key}["']|\\b${key}\\b)\\s*[:=]\\s*`).exec(source);
  if (match === null) return {};
  try {
    return asRecord(new JavaScriptLiteralParser(source, match.index + match[0].length).parse()) ?? {};
  } catch {
    return {};
  }
}

function bundleText(source: string): string {
  return source.replace(/\\u0022|\\x22|\\"/g, '"').replace(/\\u0027|\\x27|\\'/g, "'");
}

function objectBlocks(source: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) continue;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) blocks.push(source.slice(start, index + 1));
    }
  }
  return blocks;
}

function metadataValue(block: string, key: 'queryId' | 'operationName'): string | undefined {
  const escapedKey = key.replace(/[A-Z]/g, (character) => `[${character.toLowerCase()}${character}]`);
  const match = block.match(new RegExp(`(?:["']${escapedKey}["']|${escapedKey})\\s*:\\s*["']([^"']+)["']`));
  return match?.[1];
}

function extractOperationPairs(source: string): Partial<OperationMap> {
  const found: Partial<OperationMap> = {};
  const normalized = bundleText(source);
  for (const block of objectBlocks(normalized)) {
    const operation = metadataValue(block, 'operationName') as OperationName | undefined;
    const queryId = metadataValue(block, 'queryId');
    if ((operation === 'UserByScreenName' || operation === 'UserTweets' || operation === 'TweetResultByRestId') && queryId !== undefined) {
      found[operation] = queryId;
    }
  }
  const pair = /(?:["']?queryId["']?\s*:\s*["']([^"']+)["'][\s\S]{0,20000}?["']?operationName["']?\s*:\s*["'](UserByScreenName|UserTweets|TweetResultByRestId)["']|["']?operationName["']?\s*:\s*["'](UserByScreenName|UserTweets|TweetResultByRestId)["'][\s\S]{0,20000}?["']?queryId["']?\s*:\s*["']([^"']+)["'])/g;
  for (const match of normalized.matchAll(pair)) {
    const operation = (match[2] ?? match[3]) as OperationName | undefined;
    const queryId = match[1] ?? match[4];
    if (operation !== undefined && queryId !== undefined) found[operation] = queryId;
  }
  return found;
}

function buildKey(source: string): string | null {
  const match = bundleText(source).match(/(?:["'](?:buildId|build_id|build|version|hash)["']|\b(?:buildId|build_id|build|version|hash)\b)\s*[:=]\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

function assetUrls(manifest: string, manifestUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of manifest.matchAll(/["']([^"']+\.js(?:\?[^"']*)?)["']/g)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    try {
      urls.add(new URL(candidate, manifestUrl).href);
    } catch {
      // Ignore strings in a public bundle that are not URLs.
    }
  }
  return [...urls];
}

export class OperationRegistry {
  private readonly cachedByBuild = new Map<string, DiscoverySnapshot>();
  private latest: DiscoverySnapshot | undefined;
  private readonly fetcher: FetchLike;
  private readonly manifestUrl: string;
  private readonly bootstrap: OperationMap;

  public constructor(options: { fetch?: FetchLike; manifestUrl?: string; bootstrap?: OperationMap }) {
    this.fetcher = options.fetch ?? fetch;
    this.manifestUrl = options.manifestUrl ?? 'https://x.com/manifest.js';
    this.bootstrap = options.bootstrap ?? DEFAULT_OPERATIONS;
  }

  public invalidate(): void {
    this.cachedByBuild.clear();
    this.latest = undefined;
  }

  public async get(forceRefresh = false): Promise<DiscoverySnapshot> {
    let manifest: string;
    try {
      const manifestResponse = await this.fetcher(this.manifestUrl, { headers: { accept: 'application/javascript,text/javascript,*/*' } });
      if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
      manifest = await manifestResponse.text();
    } catch {
      return this.latest ?? { bearer: '', buildKey: null, bootstrapOperations: [...Object.keys(this.bootstrap)] as OperationName[], operations: { ...this.bootstrap }, features: {}, fieldToggles: {} };
    }
    const discoveredBuildKey = buildKey(manifest);
    const cacheKey = discoveredBuildKey ?? `manifest:${fingerprint(manifest)}`;
    const existing = this.cachedByBuild.get(cacheKey);
    if (!forceRefresh && existing !== undefined) {
      this.latest = existing;
      return existing;
    }
    const sources = [manifest];
    for (const url of assetUrls(manifest, this.manifestUrl)) {
      try {
        const bundle = await this.fetcher(url, { headers: { accept: 'application/javascript,text/javascript,*/*' } });
        if (bundle.ok) sources.push(await bundle.text());
      } catch {
        // Keep successful manifest and bundles; one flaky public asset must not erase discovery.
      }
    }
    const joined = sources.join('\n');
    const discovered = extractOperationPairs(joined);
    const snapshot: DiscoverySnapshot = {
      bearer: joined.match(/AAAA[A-Za-z0-9_%-]{20,}/)?.[0] ?? '',
      buildKey: discoveredBuildKey,
      bootstrapOperations: (Object.keys(this.bootstrap) as OperationName[]).filter((operation) => discovered[operation] === undefined),
      operations: { ...this.bootstrap, ...discovered },
      features: parseObjectLiteral(joined, 'features'),
      fieldToggles: parseObjectLiteral(joined, 'fieldToggles'),
    };
    this.cachedByBuild.set(cacheKey, snapshot);
    this.latest = snapshot;
    return snapshot;
  }
}

function fingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

function cookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie') ?? '']);
  const cookies = values.map((value) => value.split(';', 1)[0] ?? '').filter((value) => value.length > 0);
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

/** A session deliberately keeps one transport/proxy and guest identity for its lifetime. */
export class GuestSession {
  public readonly fetch: FetchLike;
  public readonly proxyUrl: string | undefined;
  private readonly bearer: string;
  private token: string | undefined;
  private cookies: string | undefined;

  public constructor(options: { fetch?: FetchLike; bearer: string; proxyUrl?: string }) {
    this.fetch = options.fetch ?? (options.proxyUrl === undefined ? fetch : createStickyProxyFetch(options.proxyUrl));
    this.bearer = options.bearer;
    this.proxyUrl = options.proxyUrl;
  }

  public async headers(): Promise<Record<string, string>> {
    if (this.token === undefined) await this.activate();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.bearer}`,
      'x-guest-token': this.token ?? '',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    };
    if (this.cookies !== undefined) headers.cookie = this.cookies;
    return headers;
  }

  public async refresh(): Promise<void> {
    this.token = undefined;
    await this.activate();
  }

  private async activate(): Promise<void> {
    if (this.bearer.length === 0) throw new GraphqlShapeError('X bearer token was not discovered from public assets');
    const response = await this.fetch('https://api.x.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.bearer}`, ...(this.cookies === undefined ? {} : { cookie: this.cookies }) },
    });
    this.cookies = cookieHeader(response) ?? this.cookies;
    if (!response.ok) throw new AccessDeniedError(response.status);
    const body: unknown = await response.json();
    const token = stringAt(body, 'guest_token');
    if (token === undefined) throw new GraphqlShapeError('guest activation response did not contain guest_token');
    this.token = token;
  }
}

export class XGraphqlClient {
  private readonly registry: OperationRegistry;
  private readonly session: GuestSession;
  private readonly fetcher: FetchLike;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  public constructor(options: {
    registry: OperationRegistry;
    session: GuestSession;
    fetch?: FetchLike;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
  }) {
    this.registry = options.registry;
    this.session = options.session;
    this.fetcher = options.fetch ?? this.session.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  public async call(operation: OperationName, variables: JsonRecord): Promise<JsonRecord> {
    let driftRetried = false;
    let unauthorizedRetried = false;
    let transientAttempts = 0;
    let rateLimitAttempts = 0;
    for (;;) {
      const snapshot = await this.registry.get();
      const headers = await this.session.headers();
      let response: Response;
      try {
        response = await this.fetcher(`https://api.x.com/graphql/${snapshot.operations[operation]}/${operation}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ variables, features: snapshot.features, fieldToggles: snapshot.fieldToggles }),
        });
      } catch (error) {
        if (transientAttempts >= 2) throw error;
        transientAttempts += 1;
        await this.sleep(this.backoff(transientAttempts));
        continue;
      }
      if (response.status === 401 && !unauthorizedRetried) {
        unauthorizedRetried = true;
        await this.session.refresh();
        continue;
      }
      if (response.status === 401) throw new AccessDeniedError(401);
      if (response.status === 403) throw new AccessDeniedError(403);
      const operationDrift = response.status === 404 || (response.status === 400 && await isOperationDriftResponse(response));
      if (operationDrift && !driftRetried) {
        driftRetried = true;
        this.registry.invalidate();
        continue;
      }
      if (operationDrift && driftRetried) throw new OperationDriftError(operation);
      if (response.status === 429) {
        if (rateLimitAttempts >= 3) throw new RateLimitError();
        rateLimitAttempts += 1;
        const resetHeader = response.headers.get('x-rate-limit-reset');
        const reset = resetHeader === null || resetHeader.trim() === '' ? Number.NaN : Number(resetHeader);
        const wait = Number.isFinite(reset) && reset * 1_000 > this.now()
          ? reset * 1_000 - this.now()
          : this.backoff(rateLimitAttempts);
        await this.sleep(wait);
        continue;
      }
      if (response.status >= 500 && response.status <= 599 && transientAttempts < 2) {
        transientAttempts += 1;
        await this.sleep(this.backoff(transientAttempts));
        continue;
      }
      if (!response.ok) throw new GraphqlShapeError(`X GraphQL HTTP ${response.status}`);
      const body: unknown = await response.json();
      const record = asRecord(body);
      const error = graphQlError(record?.errors);
      if (error !== undefined) {
        if (isOperationDriftError(error) && !driftRetried) {
          driftRetried = true;
          this.registry.invalidate();
          continue;
        }
        if (isOperationDriftError(error)) throw new OperationDriftError(operation);
        if (isGuestAuthorizationError(error)) {
          if (unauthorizedRetried) throw new AccessDeniedError(401);
          unauthorizedRetried = true;
          await this.session.refresh();
          continue;
        }
        throw new GraphqlResponseError(error);
      }
      const data = asRecord(record?.data);
      if (data === undefined) throw new GraphqlShapeError('X GraphQL response did not contain data');
      return data;
    }
  }

  public async userByScreenName(screenName: string): Promise<JsonRecord> {
    const data = await this.call('UserByScreenName', { screen_name: screenName, withSafetyModeUserFields: true });
    const result = asRecord(asRecord(data.user)?.result);
    if (result === undefined) throw new GraphqlShapeError('UserByScreenName response did not contain user.result');
    return result;
  }

  public async userTweets(userId: string, cursor?: string): Promise<TimelinePage> {
    const variables: JsonRecord = { userId, count: 100, includePromotedContent: false, withV2Timeline: true };
    if (cursor !== undefined) variables.cursor = cursor;
    return extractTimelinePage({ data: await this.call('UserTweets', variables) });
  }

  public async tweetById(tweetId: string): Promise<JsonRecord> {
    const data = await this.call('TweetResultByRestId', { tweetId, withCommunity: false, includePromotedContent: false });
    const result = asRecord(asRecord(data.tweetResult)?.result);
    if (result === undefined) throw new GraphqlShapeError('TweetResultByRestId response did not contain tweetResult.result');
    return result;
  }

  private backoff(attempt: number): number {
    return Math.min(4_000, 250 * (2 ** (attempt - 1))) + Math.floor(this.random() * 100);
  }
}

function graphQlError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new GraphqlShapeError('X GraphQL errors must be a non-empty array');
  const messages = value.map(asRecord).map((error) => stringAt(error, 'message') ?? stringAt(error, 'code')).filter((message): message is string => message !== undefined);
  if (messages.length === 0) throw new GraphqlShapeError('X GraphQL errors did not contain messages');
  return messages.join('; ');
}

function isOperationDriftError(message: string): boolean {
  const lower = message.toLowerCase();
  return (lower.includes('query') && (lower.includes('validation') || lower.includes('operation')))
    || lower.includes('persistedquerynotfound')
    || (lower.includes('persisted') && lower.includes('query') && lower.includes('not found'))
    || lower.includes('unknown operation')
    || lower.includes('operation not found')
    || (lower.includes('stored operation') && (lower.includes('resolve') || lower.includes('unknown') || lower.includes('not found')));
}

function isGuestAuthorizationError(message: string): boolean {
  return /auth|guest|unauthoriz|forbidden|denied/i.test(message);
}

async function isOperationDriftResponse(response: Response): Promise<boolean> {
  try {
    return isOperationDriftError(await response.clone().text());
  } catch {
    return false;
  }
}

export interface TimelinePage {
  tweets: JsonRecord[];
  bottomCursor: string | null;
}

function timelineInstructions(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const user = asRecord(asRecord(data?.user)?.result);
  const timeline = asRecord(asRecord(user?.timeline_v2)?.timeline) ?? asRecord(asRecord(user?.timeline)?.timeline);
  const instructions = timeline?.instructions;
  if (!Array.isArray(instructions)) throw new GraphqlShapeError('X timeline response did not contain timeline instructions');
  return instructions.map((instruction) => {
    const record = asRecord(instruction);
    if (record === undefined) throw new GraphqlShapeError('X timeline contained a malformed instruction');
    return record;
  });
}

function entryResults(entry: JsonRecord): JsonRecord[] {
  const content = asRecord(entry.content);
  if (content === undefined) throw new GraphqlShapeError('X timeline contained an entry without content');
  if (content.cursorType !== undefined) {
    if (typeof content.cursorType !== 'string' || typeof content.value !== 'string') throw new GraphqlShapeError('X timeline contained a malformed cursor entry');
    return [];
  }
  if (content.items !== undefined && !Array.isArray(content.items)) throw new GraphqlShapeError('X timeline module entry items must be an array');
  const items = Array.isArray(content.items) ? content.items : [content];
  const results: JsonRecord[] = [];
  for (const itemValue of items) {
    const item = asRecord(itemValue);
    if (item === undefined) throw new GraphqlShapeError('X timeline module contained a malformed item');
    const inner = asRecord(item?.item) ?? item;
    const itemContent = asRecord(inner?.itemContent) ?? inner;
    const tweetResults = asRecord(itemContent?.tweet_results);
    if (tweetResults === undefined) {
      if (typeof entry.entryId === 'string' && (entry.entryId.startsWith('tweet-') || entry.entryId.startsWith('module-'))) {
        throw new GraphqlShapeError('X timeline tweet entry did not contain tweet_results');
      }
      continue;
    }
    const result = asRecord(tweetResults.result);
    if (result === undefined) throw new GraphqlShapeError('X timeline tweet_results did not contain result');
    results.push(result);
  }
  return results;
}

export function extractTimelinePage(payload: unknown): TimelinePage {
  const tweets: JsonRecord[] = [];
  const seen = new Set<string>();
  let bottomCursor: string | null = null;
  for (const instruction of timelineInstructions(payload)) {
    const entriesValue = instruction.entries;
    const entryValue = instruction.entry;
    if (entriesValue !== undefined && !Array.isArray(entriesValue)) throw new GraphqlShapeError('X timeline instruction entries must be an array');
    const entries = Array.isArray(entriesValue) ? entriesValue : entryValue === undefined ? [] : [entryValue];
    if (entries.length === 0 && (instruction.type === 'TimelineAddEntries' || instruction.type === 'TimelineReplaceEntry')) {
      throw new GraphqlShapeError('X timeline instruction did not contain entries');
    }
    for (const value of entries) {
      const entry = asRecord(value);
      if (entry === undefined) throw new GraphqlShapeError('X timeline instruction contained a malformed entry');
      const content = asRecord(entry.content);
      if (content?.cursorType === 'Bottom' && typeof content.value === 'string') bottomCursor = content.value;
      for (const tweet of entryResults(entry)) {
        const unwrapped = unwrapTweet(tweet);
        const id = stringAt(unwrapped, 'rest_id');
        if (id === undefined) {
          if (isKnownNonTweetResult(unwrapped)) continue;
          throw new GraphqlShapeError('X timeline tweet result did not contain rest_id');
        }
        if (!seen.has(id)) {
          seen.add(id);
          tweets.push(tweet);
        }
      }
    }
  }
  return { tweets, bottomCursor };
}

function isKnownNonTweetResult(result: JsonRecord): boolean {
  const type = stringAt(result, '__typename');
  return type === 'TweetTombstone'
    || type === 'TweetUnavailable'
    || type === 'TweetWithheld'
    || type === 'TweetDelete'
    || type === 'TimelineMessagePrompt'
    || type === 'TimelinePrompt';
}

function unwrapTweet(value: JsonRecord): JsonRecord {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    const type = stringAt(current, '__typename');
    const nested = asRecord(current.tweet) ?? asRecord(current.result);
    if ((type === 'TweetWithVisibilityResults' || type === 'TweetResults') && nested !== undefined) current = nested;
    else break;
  }
  return current;
}

function integer(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function nullableInteger(value: unknown): number | null {
  return value === undefined || value === null ? null : integer(value);
}

function array(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => item !== undefined) : [];
}

function mediaFrom(legacy: JsonRecord): TweetOutput['entities']['media'] {
  const extended = asRecord(legacy.extended_entities);
  const entities = asRecord(legacy.entities);
  const source = array(extended?.media ?? entities?.media);
  const media: TweetOutput['entities']['media'] = [];
  for (const item of source) {
    const type = stringAt(item, 'type');
    const thumbnail = stringAt(item, 'media_url_https') ?? null;
    if (type === 'photo') {
      if (thumbnail !== null) media.push({ type, url: thumbnail, thumbnail: null });
      continue;
    }
    if (type !== 'video' && type !== 'animated_gif') continue;
    const variants = array(asRecord(item.video_info)?.variants)
      .filter((variant) => stringAt(variant, 'content_type') === 'video/mp4' && stringAt(variant, 'url') !== undefined)
      .sort((left, right) => integer(right.bitrate) - integer(left.bitrate));
    const url = variants[0] === undefined ? undefined : stringAt(variants[0], 'url');
    if (url !== undefined) media.push({ type, url, thumbnail });
  }
  return media;
}

function sourceLabel(source: unknown): string | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  const text = decodeHtmlEntities(source.replace(/<[^>]*>/g, '')).trim();
  return text.length > 0 ? text : null;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, token: string) => {
    const lower = token.toLowerCase();
    if (lower in named) return named[lower] ?? entity;
    const number = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

export function normalizeTweet(raw: unknown, scrapedAt = new Date().toISOString()): TweetOutput {
  const result = asRecord(raw);
  if (result === undefined) throw new GraphqlShapeError('tweet result is not an object');
  const tweet = unwrapTweet(result);
  const legacy = asRecord(tweet.legacy);
  const user = asRecord(asRecord(asRecord(tweet.core)?.user_results)?.result);
  const author = asRecord(user?.legacy);
  const id = stringAt(tweet, 'rest_id');
  const username = stringAt(author, 'screen_name');
  const name = stringAt(author, 'name');
  const authorId = stringAt(user, 'rest_id');
  const created = typeof legacy?.created_at === 'string' ? new Date(legacy.created_at) : undefined;
  if (legacy === undefined || user === undefined || author === undefined || id === undefined || username === undefined || name === undefined || authorId === undefined || created === undefined || Number.isNaN(created.valueOf())) {
    throw new GraphqlShapeError('tweet result is missing required tweet or author fields');
  }
  const entities = asRecord(legacy.entities);
  const urlEntities = array(entities?.urls);
  const replacements = new Map(urlEntities.map((item) => [stringAt(item, 'url'), stringAt(item, 'expanded_url') ?? stringAt(item, 'url')]));
  const fullText = stringAt(legacy, 'full_text') ?? stringAt(legacy, 'text') ?? '';
  const text = fullText.replace(/https:\/\/t\.co\/[A-Za-z0-9_-]+/g, (short) => replacements.get(short) ?? short);
  const inReplyToId = stringAt(legacy, 'in_reply_to_status_id_str') ?? null;
  const quotedTweetId = stringAt(legacy, 'quoted_status_id_str') ?? null;
  const isRetweet = asRecord(legacy.retweeted_status_result) !== undefined || fullText.startsWith('RT @');
  return {
    id,
    url: `https://x.com/${username}/status/${id}`,
    text,
    lang: stringAt(legacy, 'lang') ?? null,
    createdAt: created.toISOString(),
    conversationId: stringAt(legacy, 'conversation_id_str') ?? null,
    isReply: inReplyToId !== null,
    isRetweet,
    isQuote: quotedTweetId !== null,
    inReplyToId,
    quotedTweetId,
    author: {
      id: authorId,
      username,
      name,
      verified: author.verified === true || author.is_blue_verified === true,
      followers: integer(author.followers_count),
      following: integer(author.friends_count),
    },
    metrics: {
      likes: integer(legacy.favorite_count),
      retweets: integer(legacy.retweet_count),
      replies: integer(legacy.reply_count),
      quotes: integer(legacy.quote_count),
      bookmarks: nullableInteger(legacy.bookmark_count),
      views: nullableInteger(asRecord(tweet.views)?.count),
    },
    entities: {
      hashtags: array(entities?.hashtags).flatMap((item) => {
        const tag = stringAt(item, 'text');
        return tag === undefined ? [] : [tag];
      }),
      mentions: array(entities?.user_mentions).flatMap((item) => {
        const mention = stringAt(item, 'screen_name');
        return mention === undefined ? [] : [mention];
      }),
      urls: urlEntities.flatMap((item) => {
        const url = stringAt(item, 'expanded_url') ?? stringAt(item, 'url');
        return url === undefined ? [] : [url];
      }),
      media: mediaFrom(legacy),
    },
    source: sourceLabel(legacy.source),
    scrapedAt: new Date(scrapedAt).toISOString(),
  };
}

export interface TweetFilters {
  includeReplies?: boolean;
  includeRetweets?: boolean;
  mediaType?: 'any' | 'text_only' | 'images' | 'video' | 'links';
  onlyVerified?: boolean;
  since?: string;
  until?: string;
  language?: string;
  minLikes?: number;
  minRetweets?: number;
  minReplies?: number;
  hashtags?: string[];
}

function boundary(value: string, end: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Date.parse(value);
}

export function applyTweetFilters(tweets: TweetOutput[], filters: TweetFilters): TweetOutput[] {
  const since = filters.since === undefined ? undefined : boundary(filters.since, false);
  const until = filters.until === undefined ? undefined : boundary(filters.until, true);
  const requiredHashtags = (filters.hashtags ?? []).map((tag) => tag.replace(/^#/, '').toLowerCase()).filter((tag) => tag.length > 0);
  return tweets.filter((tweet) => {
    const created = Date.parse(tweet.createdAt);
    if (filters.includeReplies === false && tweet.isReply) return false;
    if (filters.includeRetweets !== true && tweet.isRetweet) return false;
    if (filters.onlyVerified === true && !tweet.author.verified) return false;
    if (filters.language !== undefined && tweet.lang?.toLowerCase() !== filters.language.toLowerCase()) return false;
    if (since !== undefined && created < since) return false;
    if (until !== undefined && created > until) return false;
    if (filters.minLikes !== undefined && tweet.metrics.likes < filters.minLikes) return false;
    if (filters.minRetweets !== undefined && tweet.metrics.retweets < filters.minRetweets) return false;
    if (filters.minReplies !== undefined && tweet.metrics.replies < filters.minReplies) return false;
    const availableHashtags = new Set(tweet.entities.hashtags.map((tag) => tag.toLowerCase()));
    if (!requiredHashtags.every((tag) => availableHashtags.has(tag))) return false;
    const mediaType = filters.mediaType ?? 'any';
    if (mediaType === 'text_only' && (tweet.entities.media.length > 0 || tweet.entities.urls.length > 0)) return false;
    if (mediaType === 'images' && !tweet.entities.media.some((media) => media.type === 'photo')) return false;
    if (mediaType === 'video' && !tweet.entities.media.some((media) => media.type === 'video' || media.type === 'animated_gif')) return false;
    if (mediaType === 'links' && tweet.entities.urls.length === 0) return false;
    return true;
  });
}

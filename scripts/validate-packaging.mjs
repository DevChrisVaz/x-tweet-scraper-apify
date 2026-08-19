import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const text = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(text(path));
const fail = (message) => {
  console.error(`Packaging validation failed: ${message}`);
  process.exit(1);
};

const dockerfile = text('Dockerfile');
if (!/^FROM node:24(?:[\w.-]*)?(?:\s+AS\s+build)?$/m.test(dockerfile)) fail('Dockerfile must build on Node 24');
if (!dockerfile.includes('RUN npm ci')) fail('Dockerfile must use npm ci');
if (!dockerfile.includes('RUN npm run build')) fail('Dockerfile must compile the Actor');
if (!dockerfile.includes('npm prune --omit=dev')) fail('Dockerfile must prune development dependencies');
if (!dockerfile.includes('CMD ["node", "dist/index.js"]')) fail('Dockerfile must start the compiled Actor');

const actor = json('.actor/actor.json');
if (actor.dockerfile !== '../Dockerfile') fail('Apify manifest must use the supported top-level dockerfile field');
if (Object.prototype.hasOwnProperty.call(actor, 'build')) fail('Apify manifest must not use the obsolete nested build field');
if (actor.storages?.dataset !== '../OUTPUT_SCHEMA.json') fail('Apify manifest must point dataset storage at the standalone item schema');
for (const [label, path] of [['Dockerfile', actor.dockerfile], ['input schema', actor.input], ['dataset schema', actor.storages?.dataset]]) {
  if (typeof path !== 'string') fail(`Apify manifest is missing its ${label} path`);
  try {
    readFileSync(new URL(`.actor/${path.replace(/^\.\//, '')}`, root));
  } catch {
    fail(`Apify manifest references a missing ${label}`);
  }
}
const datasetSchema = json('OUTPUT_SCHEMA.json');
if (datasetSchema.type === 'array' || datasetSchema.$schema === undefined || datasetSchema.definitions === undefined) fail('dataset schema must be a standalone per-item object schema');
const inputSchema = json('INPUT_SCHEMA.json');
if (inputSchema.properties?.searchTerms?.maxItems !== 0) fail('input schema must reject non-empty searchTerms');
if (!Array.isArray(inputSchema.anyOf) || inputSchema.anyOf.length !== 2) fail('input schema must require fromUsers or tweetIds');

const vercel = json('vercel.json');
if (vercel.buildCommand !== '' || vercel.outputDirectory !== 'public') fail('Vercel Functions-only config must skip the root build and constrain static output to public');
if (vercel.builds !== undefined || vercel.public !== undefined) fail('Vercel config must not enable legacy or public source/static exposure');
const publicDir = new URL('public/', root);
if (!existsSync(publicDir)) fail('Vercel Functions-only config must include its explicit public output directory');
const publicAssets = readdirSync(publicDir).sort();
if (publicAssets.length !== 1 || publicAssets[0] !== 'robots.txt') fail('public must contain only robots.txt');
if (readFileSync(new URL('public/robots.txt', root), 'utf8') !== 'User-agent: *\nDisallow: /\n') fail('public/robots.txt must be the inert no-crawl policy');
const functions = vercel.functions;
if (typeof functions !== 'object' || functions === null) fail('vercel.json must define Functions');
for (const [pattern, config] of Object.entries(functions)) {
  if (typeof config !== 'object' || config === null || config.runtime !== undefined || config.maxDuration !== 300) {
    fail(`Vercel Function ${pattern} must use the default Node.js runtime with a 300-second limit`);
  }
}
if (/edge/i.test(JSON.stringify(vercel))) fail('Edge runtime is prohibited for entitlement Functions');
if (JSON.stringify(vercel).includes('nodejs24.x')) fail('Vercel config must not use the invalid nodejs24.x runtime tag');
const packageEngines = json('package.json').engines;
if (packageEngines?.node !== '24.x') fail('package.json must pin Vercel builds and Functions to Node 24.x');
for (const path of ['api/entitlements/resolve.ts', 'api/entitlements/reserve.ts']) {
  if (/export\s+const\s+runtime\s*=/.test(text(path))) fail(`${path} must use the default Node.js runtime without route metadata`);
}

const eslint = text('eslint.config.mjs');
if (!eslint.includes("'**/.worktrees/**'") || !eslint.includes("'**/dist/**'")) fail('ESLint must ignore nested worktrees and generated dist directories');

const envExample = text('.env.example');
for (const name of ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'ENTITLEMENT_HMAC_SECRET', 'ENTITLEMENT_SIGNING_PRIVATE_KEY']) {
  const line = envExample.split('\n').find((value) => value.startsWith(`${name}=`));
  if (line !== `${name}=`) fail(`.env.example must not contain a value for ${name}`);
}
if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:sk|xox)[-_][A-Za-z0-9]/i.test(envExample)) fail('.env.example contains a private-value pattern');
const entitlementSource = text('src/vercel-entitlements.ts');
for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
  if (!entitlementSource.includes(name)) fail(`signer environment mapping is missing ${name}`);
}
const readme = text('README.md');
for (const identifier of ['x-tweet-scraper-entitlements', 'upstash-kv-cordovan-village']) {
  if (!readme.includes(identifier)) fail(`deployment documentation is missing ${identifier}`);
}

const dependencyCheck = spawnSync(process.execPath, ['scripts/check-browser-deps.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (dependencyCheck.status !== 0) fail(dependencyCheck.stderr || dependencyCheck.stdout || 'browser dependency check failed');

console.log('Packaging validation passed: Docker, Apify manifest, Vercel Node.js Functions, ESLint ignores, and dependency policy.');

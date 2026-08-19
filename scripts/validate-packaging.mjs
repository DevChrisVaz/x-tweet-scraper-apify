import { readFileSync } from 'node:fs';
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
if (actor.build?.dockerfile !== '../Dockerfile') fail('Apify manifest must point at the production Dockerfile');
for (const path of [actor.input, actor.storages?.dataset]) {
  if (typeof path !== 'string' || !text(`.actor/${path.replace(/^\.\//, '')}`)) fail('Apify manifest references a missing schema');
}

const vercel = json('vercel.json');
const functions = vercel.functions;
if (typeof functions !== 'object' || functions === null) fail('vercel.json must define Functions');
for (const [pattern, config] of Object.entries(functions)) {
  if (typeof config !== 'object' || config === null || config.runtime !== 'nodejs24.x') fail(`Vercel Function ${pattern} must use nodejs24.x`);
}
if (/edge/i.test(JSON.stringify(vercel))) fail('Edge runtime is prohibited for entitlement Functions');

const eslint = text('eslint.config.mjs');
if (!eslint.includes("'**/.worktrees/**'") || !eslint.includes("'**/dist/**'")) fail('ESLint must ignore nested worktrees and generated dist directories');

const envExample = text('.env.example');
for (const name of ['UPSTASH_REDIS_REST_TOKEN', 'ENTITLEMENT_HMAC_SECRET', 'ENTITLEMENT_SIGNING_PRIVATE_KEY']) {
  const line = envExample.split('\n').find((value) => value.startsWith(`${name}=`));
  if (line !== `${name}=`) fail(`.env.example must not contain a value for ${name}`);
}
if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:sk|xox)[-_][A-Za-z0-9]/i.test(envExample)) fail('.env.example contains a private-value pattern');

const dependencyCheck = spawnSync(process.execPath, ['scripts/check-browser-deps.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (dependencyCheck.status !== 0) fail(dependencyCheck.stderr || dependencyCheck.stdout || 'browser dependency check failed');

console.log('Packaging validation passed: Docker, Apify manifest, Vercel Node 24 Functions, ESLint ignores, and dependency policy.');

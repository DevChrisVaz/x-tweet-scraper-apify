import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<string, unknown>;
}

const representativeTweet = {
  id: '123', url: 'https://x.com/apify/status/123', text: 'hello', lang: null,
  createdAt: '2025-01-01T00:00:00Z', conversationId: null, isReply: false,
  isRetweet: false, isQuote: false, inReplyToId: null, quotedTweetId: null,
  author: { id: '42', username: 'apify', name: 'Apify', verified: false, followers: 1, following: 2 },
  metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: null, views: null },
  entities: { hashtags: [], mentions: [], urls: [], media: [] }, source: null,
  scrapedAt: '2025-01-01T00:00:01Z',
};

describe('fresh-clone packaging gates', () => {
  it('declares Ajv directly for schema validation', () => {
    const packageJson = readJson('package.json');
    const devDependencies = packageJson.devDependencies as Record<string, string>;
    expect(typeof devDependencies.ajv).toBe('string');
  });

  it('validates Docker, Apify, Vercel, and dependency policy', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-packaging.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses the valid default Node.js runtime instead of a legacy runtime tag', () => {
    const vercel = readJson('vercel.json');
    const functions = vercel.functions as Record<string, Record<string, unknown>>;
    const functionConfig = functions['api/**/*.ts'];
    expect(functionConfig).toEqual({ maxDuration: 300 });
    expect(JSON.stringify(vercel)).not.toContain('nodejs24.x');
    expect(functionConfig?.runtime).toBeUndefined();
  });

  it('declares a Functions-only Vercel project without static build output', () => {
    const vercel = readJson('vercel.json');
    expect(vercel.buildCommand).toBeNull();
    expect(vercel.outputDirectory).toBeNull();
  });

  it('pins Vercel builds and functions to the documented Node 24 selector', () => {
    const packageJson = readJson('package.json');
    const engines = packageJson.engines as Record<string, unknown>;
    expect(engines.node).toBe('24.x');
  });

  it('does not export unsupported runtime metadata from raw API modules', () => {
    for (const path of ['api/entitlements/resolve.ts', 'api/entitlements/reserve.ts']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/export const runtime\s*=/);
    }
  });

  it('requires the supported top-level Apify Dockerfile field', () => {
    const actor = readJson('.actor/actor.json');
    expect(actor.dockerfile).toBe('../Dockerfile');
    expect(actor.build).toBeUndefined();
  });

  it('compiles the exact Apify dataset schema path as a standalone item object', () => {
    const actor = readJson('.actor/actor.json');
    const datasetPath = (actor.storages as Record<string, unknown> | undefined)?.dataset;
    expect(datasetPath).toBe('../OUTPUT_SCHEMA.json');
    const schema = JSON.parse(readFileSync(new URL(`.actor/${String(datasetPath).replace(/^\.\//, '')}`, root), 'utf8')) as Record<string, unknown>;
    expect(schema.type).not.toBe('array');
    expect(() => new Ajv().compile(schema)).not.toThrow();
    const validate = new Ajv().compile(schema);
    expect(validate(representativeTweet)).toBe(true);
  });

  it('keeps deterministic fixture, signer, live, and benchmark commands explicit', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;
    expect(scripts['fixture:run']).toContain('fixture-run');
    expect(scripts['signer:smoke']).toContain('signer-smoke');
    expect(scripts['smoke:live']).toContain('live-smoke');
    expect(scripts['benchmark:live']).toContain('benchmark');
    expect(scripts['check:browser']).toContain('check-browser-deps');
    expect(scripts['docker:build']).toContain('docker build');
  });

  it('keeps secret-bearing example variables empty', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const name of ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'ENTITLEMENT_HMAC_SECRET', 'ENTITLEMENT_SIGNING_PRIVATE_KEY']) {
      expect(example).toContain(`${name}=`);
      expect(example.split('\n').find((line) => line.startsWith(`${name}=`))).toBe(`${name}=`);
    }
  });

  it('rejects representative browser runtimes and wrappers independently of the current lockfile', () => {
    const names = [
      'chrome-aws-lambda',
      '@sparticuz/chromium',
      'node_modules/example/node_modules/chrome-aws-lambda',
      'node_modules/example/node_modules/@sparticuz/chromium',
      'playwright-extra',
      'puppeteer-extra',
      'webdriverio',
      'selenium-webdriver',
      'cypress',
      'browserless',
    ];
    for (const name of names) {
      const result = spawnSync(process.execPath, ['scripts/check-browser-deps.mjs', name], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      });
      expect(result.status, `${name}: ${result.stderr || result.stdout}`).not.toBe(0);
    }
  });

  it('does not claim that the signer or deployment is complete', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('intended/provisioned names');
    expect(readme).toContain('remain Task 6 actions');
    expect(readme).not.toContain('The signer is deployed');
  });

  it('enforces Node 24 in npm configuration and every CI npm job', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;
    expect(scripts['preflight:node']).toContain('check-node-version');
    expect(readFileSync(new URL('../.npmrc', import.meta.url), 'utf8')).toContain('engine-strict=true');
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const dockerJob = workflow.slice(workflow.indexOf('  docker:'));
    expect(dockerJob).toContain('actions/setup-node@v4');
    expect(dockerJob).toContain('node-version: 24');
  });
});

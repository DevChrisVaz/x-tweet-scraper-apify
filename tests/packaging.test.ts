import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<string, unknown>;
}

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

  it('requires the supported top-level Apify Dockerfile field', () => {
    const actor = readJson('.actor/actor.json');
    expect(actor.dockerfile).toBe('../Dockerfile');
    expect(actor.build).toBeUndefined();
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
    for (const name of ['UPSTASH_REDIS_REST_TOKEN', 'ENTITLEMENT_HMAC_SECRET', 'ENTITLEMENT_SIGNING_PRIVATE_KEY']) {
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
});

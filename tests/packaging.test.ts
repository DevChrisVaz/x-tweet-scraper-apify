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
});

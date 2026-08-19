import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(lock.packages ?? {});
const prohibited = [
  /^@playwright\//i,
  /^playwright(?:$|-)/i,
  /^@puppeteer\//i,
  /^puppeteer(?:$|-)/i,
  /^@sparticuz\/chromium(?:$|-)/i,
  /^chrome-aws-lambda(?:$|-)/i,
  /^chrome-launcher(?:$|-)/i,
  /^chrome-remote-interface(?:$|-)/i,
  /^chromium(?:$|-)/i,
  /^webdriver(?:io)?(?:$|-)/i,
  /^@wdio\//i,
  /^selenium(?:$|-)/i,
  /^@selenium\//i,
  /^cypress(?:$|-)/i,
  /^@cypress\//i,
  /^browserless(?:$|-)/i,
  /^@browserless\//i,
  /^nightwatch(?:$|-)/i,
  /^testcafe(?:$|-)/i,
];
function packageSegments(lockPath) {
  const normalized = lockPath.replace(/^node_modules\//, '');
  return normalized.split('/node_modules/').map((segment) => {
    const parts = segment.split('/');
    return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? '';
  });
}

const found = packages.filter((name) => packageSegments(name).some((packageName) => prohibited.some((pattern) => pattern.test(packageName))));

if (found.length > 0) {
  console.error(`Browser-engine dependencies are prohibited: ${found.join(', ')}`);
  process.exit(1);
}

console.log(`Browser-engine dependency check passed (${packages.length} lockfile packages scanned).`);

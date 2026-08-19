import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = Object.keys(lock.packages ?? {});
const prohibited = /(^|\/)(@playwright\/|playwright(?:-core)?|@puppeteer\/|puppeteer(?:-core)?|selenium-webdriver|cypress|chromium(?:-|$)|browserless)(\/|$)/i;
const found = packages.filter((name) => prohibited.test(name.replace(/^node_modules\//, '')));

if (found.length > 0) {
  console.error(`Browser-engine dependencies are prohibited: ${found.join(', ')}`);
  process.exit(1);
}

console.log(`Browser-engine dependency check passed (${packages.length} lockfile packages scanned).`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createR5SetmatOwnedFixtureFactory,
  type R5SetmatOwnedConfig,
} from './r5-setmat-owned-fixture';
import { installR5SetmatFixtureFactory } from './r5-setmat-concurrency-barrier';
import { R5_SETMAT_DATABASE } from './r5-setmat-observation';

// Loaded only by the explicit standalone config. No standard e2e global setup,
// migration, worker database derivation, reset, extra grants or lifecycle hooks.
const started = performance.now();
const configPath = process.env.SRVF_R5_SETMAT_CONFIG_FILE;
assert(configPath, 'SRVF_R5_SETMAT_CONFIG_FILE must name the original executor configuration');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as R5SetmatOwnedConfig;
const originalUrl = process.env.DATABASE_URL;
assert(originalUrl, 'existing authorized original-environment DATABASE_URL is required');
const url = new URL(originalUrl);
assert(['postgresql:', 'postgres:'].includes(url.protocol));
assert.equal(decodeURIComponent(url.pathname.slice(1)), R5_SETMAT_DATABASE);
url.searchParams.set('connection_limit', '1');
process.env.DATABASE_URL = url.toString();
installR5SetmatFixtureFactory(createR5SetmatOwnedFixtureFactory(config));
afterAll(() => {
  process.env.DATABASE_URL = originalUrl;
  expect(performance.now() - started).toBeLessThan(600_000);
});

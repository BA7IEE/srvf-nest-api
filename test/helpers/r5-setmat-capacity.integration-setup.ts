import assert from 'node:assert/strict';
import { R5_SETMAT_DATABASE } from './r5-setmat-observation';

const existingUrl = process.env.DATABASE_URL;
assert(existingUrl);
const url = new URL(existingUrl);
assert.equal(decodeURIComponent(url.pathname.slice(1)), R5_SETMAT_DATABASE);
url.searchParams.set('connection_limit', '1');
process.env.DATABASE_URL = url.toString();
afterAll(() => {
  process.env.DATABASE_URL = existingUrl;
});

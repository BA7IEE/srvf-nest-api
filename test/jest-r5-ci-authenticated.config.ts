import type { Config } from 'jest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const suites = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/r5-authenticated-ci-suites.json'), 'utf8'),
) as Array<{ file: string }>;
const names = suites.map(({ file }) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const historicalPrefix =
  'active native full capacity: applicable business boundaries, original guards and budgets ';
export const R5_HISTORICAL_CAPACITY_TESTS = [
  'native2000 main accepts2000/10000/50000/8000, rejects2001/10001/50001 with all196 rollback and actual ledger COMMIT',
  'native2000 complete formal readback and unchanged_time copy/replay',
  'native2000 correction_time_proof full HumanV3 and exact replay with original15s commit',
].map((name) => historicalPrefix + name);
const historicalNames = R5_HISTORICAL_CAPACITY_TESTS.map((name) =>
  name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|');

// Driver supplies one exact file per runInBand process and fresh single DB.
// No ordinary clone lifecycle, environment file or secret-bearing argv/env.
const config: Config = {
  rootDir: '..',
  testRegex: `/test/e2e/(?:${names})$`,
  // Approved first launch excludes only these three historical capacity cases.
  // The unchanged full Native file remains available in the explicit historical config.
  testNamePattern: `^(?!(?:${historicalNames})$)[\\s\\S]*$`,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 30_000,
  setupFilesAfterEnv: ['<rootDir>/test/setup/r5-ci-authenticated-setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/', '<rootDir>/\\.worktrees/'],
};
export default config;

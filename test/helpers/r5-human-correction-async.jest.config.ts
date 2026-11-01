import type { Config } from 'jest';

// Dedicated opt-in entry: no standard e2e setup, migrate, seed, reset or db derivation.
const config: Config = {
  rootDir: '../..',
  testRegex: 'test/e2e/activity-os-r5-human-correction-background\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 600_000,
};
export default config;

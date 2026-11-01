import type { Config } from 'jest';

// Opt-in only. No standard setup, migrate, seed, reset or derived test database.
const config: Config = {
  rootDir: '../..',
  testRegex: 'test/e2e/activity-os-r5-human-correction-background-capacity1000\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 600_000,
};
export default config;

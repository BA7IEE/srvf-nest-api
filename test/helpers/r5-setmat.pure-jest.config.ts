import type { Config } from 'jest';

const config: Config = {
  rootDir: '../..',
  testRegex: [
    'test/helpers/r5-setmat-(observation|owned-fixture)\\.spec\\.ts$',
    'test/e2e/activity-os-r5-setmat-concurrency\\.e2e-spec\\.ts$',
  ],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 5_000,
};
export default config;

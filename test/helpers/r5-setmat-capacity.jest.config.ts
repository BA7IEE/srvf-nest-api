import type { Config } from 'jest';
const config: Config = {
  rootDir: '../..',
  testRegex: 'test/e2e/activity-os-r5-setmat-capacity\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  setupFilesAfterEnv: ['<rootDir>/test/helpers/r5-setmat-capacity.integration-setup.ts'],
  maxWorkers: 1,
  testTimeout: 600000,
};
export default config;

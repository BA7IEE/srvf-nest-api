import type { Config } from 'jest';
const config: Config = {
  rootDir: '../..',
  testRegex: 'test/helpers/r5-setmat-capacity\\.spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 5000,
};
export default config;

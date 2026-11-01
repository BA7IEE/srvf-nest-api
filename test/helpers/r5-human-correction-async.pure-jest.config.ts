import type { Config } from 'jest';

const config: Config = {
  rootDir: '../..',
  testRegex: 'test/helpers/r5-human-correction-async\\.spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
};
export default config;

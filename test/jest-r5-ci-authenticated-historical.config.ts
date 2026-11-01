import type { Config } from 'jest';

// Not part of required CI. A separately approved capacity window and a fresh
// authenticated instance are required; the setup refuses default invocation.
const config: Config = {
  rootDir: '..',
  testRegex: '/test/e2e/activity-os-r5-native-admission\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
  maxWorkers: 1,
  testTimeout: 30_000,
  setupFilesAfterEnv: ['<rootDir>/test/setup/r5-ci-authenticated-setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/', '<rootDir>/\\.worktrees/'],
};
export default config;

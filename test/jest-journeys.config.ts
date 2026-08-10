import type { Config } from 'jest';

// 旅程测试与既有 e2e 共用同一套真实应用、派生测试库与 storage 隔离；唯一差异是
// 只选取 test/journeys 下的金五条，并默认串行，避免五条跨域长链争用同一测试库。
//
// 不 import `jest-e2e.config.ts`：Jest 30 装载 TypeScript config 时不会为本地 ESM
// import 补全扩展名，继承会让配置本身在测试尚未启动前失败。这里刻意维持一份同构、独立
// 配置，而不是让 journey job 依赖另一份 config 的运行时解析细节。
const config: Config = {
  rootDir: '..',
  testRegex: '.*/test/journeys/.*\\.e2e-spec\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/.claude/worktrees/',
    '<rootDir>/\\.worktrees/',
  ],
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/', '<rootDir>/\\.worktrees/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/test/tsconfig.test.json',
      },
    ],
  },
  testEnvironment: 'node',
  maxWorkers: process.env.JEST_MAX_WORKERS || 1,
  testTimeout: 60_000,
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
  setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
};

export default config;

import type { Config } from 'jest';

// src/ 单测保持原匹配，另精确纳入不触库的测试入口范围回归。
// 与 jest-e2e.config.ts 解耦——单元测试不启动 NestJS / 不连库,反馈秒级。
const config: Config = {
  rootDir: '..',
  testRegex: ['src/.*(?<!\\.e2e)\\.spec\\.ts$', '/test/setup/test-run-scope\\.spec\\.ts$'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/.claude/worktrees/',
    '<rootDir>/\\.worktrees/',
  ],
  // testPathIgnorePatterns 只过滤"跑哪些 spec",不影响 haste map。
  // 各 `.claude/worktrees/<session>/` 内有同名(srvf-api)package.json 副本,
  // 冷启动 haste map 时触发 "Haste module naming collision: srvf-api" 重名 warning。
  // modulePathIgnorePatterns 把 worktree 子树排出 haste map → 消除 warning。
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
};

export default config;

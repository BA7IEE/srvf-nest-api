import type { Config } from 'jest';

// Unit test 配置(V1.3-1):仅跑 src/ 内 *.spec.ts(排除 *.e2e-spec.ts)。
// 与 jest-e2e.config.ts 解耦——单元测试不启动 NestJS / 不连库,反馈秒级。
const config: Config = {
  rootDir: '..',
  testRegex: 'src/.*(?<!\\.e2e)\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/.claude/worktrees/'],
  // testPathIgnorePatterns 只过滤"跑哪些 spec",不影响 haste map。
  // 各 `.claude/worktrees/<session>/` 内有同名(srvf-api)package.json 副本,
  // 冷启动 haste map 时触发 "Haste module naming collision: srvf-api" 重名 warning。
  // modulePathIgnorePatterns 把 worktree 子树排出 haste map → 消除 warning。
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/'],
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

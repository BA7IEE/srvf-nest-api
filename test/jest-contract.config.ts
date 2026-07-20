import type { Config } from 'jest';

// V1.3-3 Contract 测试专用 Jest 配置。
// 与 jest-e2e.config.ts 结构对齐(共享 globalSetup / setupFiles / 串行执行),
// 仅 testRegex 区分:contract spec 用 *.contract-spec.ts 后缀。
//
// 单独脚本(pnpm test:contract)的目的:
//   - 让 OpenAPI 快照漂移在快速反馈通道里立刻暴露
//   - 与 e2e 解耦,允许 CI 拆 job(本仓库 v1.3 范围内不强制拆)
//
// 仍使用与 e2e 相同的 globalSetup,因为 createTestApp() 经过 AppModule 会触发
// PrismaService.onModuleInit($connect),需要 app_test 库已就绪。
const config: Config = {
  rootDir: '..',
  testRegex: '.*\\.contract-spec\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/.claude/worktrees/',
    '<rootDir>/\\.worktrees/',
  ],
  // 把 worktree 子树排出 haste map,消除同名 package.json 副本的重名 warning;
  // testPathIgnorePatterns 只管 spec 选取,不影响 haste(详见 jest-unit.config.ts)。
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
  maxWorkers: 1,
  testTimeout: 30000,
  detectOpenHandles: true,
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
};

export default config;

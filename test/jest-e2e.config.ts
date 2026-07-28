import * as os from 'os';
import type { Config } from 'jest';

// worker 数上限 8:docker-compose 的 max_connections=200 正是按「最坏 8 worker ×
// 3 app/spec × connection_limit 5 + 余量」算出来的。用 '50%' 无上限会在高核数机器上
// 越过该预算(global-setup 的 assertConnectionCapacity 会拦下并给修复指令,但不该靠它兜底)。
// 空串按未设处理(|| 而非 ??):CI 里未展开的 env 表达式会传空串。
const DEFAULT_MAX_WORKERS = Math.min(8, Math.max(1, Math.floor(os.availableParallelism() / 2)));

// E2E 专用 Jest 配置。rootDir 指向项目根,便于 ts-jest 解析 src/ 与 test/ 的相对路径。
//
// 并行执行(Harness 3.0 P1):并行安全由三层隔离保证,缺一不可 ——
//   1. per-worker 派生测试库(worktree-db.ts:app_test*_w<N>,globalSetup 按模板克隆);
//      resetDb() 是 TRUNCATE 55 表的全库擦除,同库并发必然互擦,库隔离是第一性前提
//   2. per-worker STORAGE_LOCAL_ROOT(setup-files.ts:tmp/storage-w<N>)
//   3. 显式 connection_limit(.env.test:5/app)+ Postgres max_connections=200
// 句柄泄漏检测迁到 `pnpm test:e2e:leaks` 串行线(夜间 CI + 发版前),原因见下。
const config: Config = {
  rootDir: '..',
  testRegex: '.*\\.e2e-spec\\.ts$',
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
  // JEST_MAX_WORKERS 供 CI / 排障显式指定;默认 = min(8, 核数/2)(10 核本机 → 5 worker)。
  maxWorkers: process.env.JEST_MAX_WORKERS || DEFAULT_MAX_WORKERS,
  testTimeout: 30000,
  // 刻意不开启 forceExit:它会掩盖未关闭的连接 / timer / socket —— 该语义不变。
  // detectOpenHandles 已移除,**唯一原因**是 jest 30 的 shouldRunInBand() 只要它为真
  // 就强制串行(@jest/core:detectOpenHandles implies --runInBand),与并行互斥;
  // 不是放弃泄漏检测 —— 泄漏检测由 `pnpm test:e2e:leaks`(--runInBand --detectOpenHandles)
  // 承接,挂夜间 CI(.github/workflows/nightly-e2e-leaks.yml)并把 jest 的
  // 'failed to exit gracefully' 软警告升级为硬失败,倒逼 afterAll app.close() 的
  // 纪律约束力不降。
  //
  // globalSetup:整个 run 启动一次,负责 load .env.test → 断言 app_test → 模板库
  // migrate deploy → 按 maxWorkers 克隆 worker 库。
  // globalTeardown:回收 worker 克隆库(模板保留)。
  // setupFiles:每个测试文件加载前跑一次,再 load 一遍 .env.test 并派生 worker 库名
  // 与 per-worker STORAGE_LOCAL_ROOT(Jest 30 的 globalSetup 不向 worker 透传 process.env)。
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
  setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
};

export default config;

import { loadTestEnv } from './load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from './test-db';

// Jest globalTeardown:整个测试 run 结束时回收 worker 克隆库(app_test*_w1..N)。
// 模板库保留 —— 它是下次克隆的源,也让 pnpm db:test:reset / db:test:init 语义不变。
//
// jest 崩溃 / Ctrl-C 时本钩子不执行,worker 库会残留;泄漏有界:下次 globalSetup 的
// recreateWorkerDatabase 会 DROP ... WITH (FORCE) 重建同名库。换 worktree / 换
// maxWorkers 留下的孤儿库用 `pnpm db:test:prune` 按 git worktree 白名单差集回收。
// globalConfig 用结构化类型(@jest/types 非直接依赖)
export default async function globalTeardown(globalConfig: { maxWorkers: number }): Promise<void> {
  // SRVF_KEEP_TEST_DBS=1:保留 worker 库供失败后验尸(查数据落成什么样)。
  // 下次 globalSetup 会 DROP...WITH (FORCE) 重建,不会累积。
  if (process.env.SRVF_KEEP_TEST_DBS === '1') {
    console.log('[teardown] SRVF_KEEP_TEST_DBS=1:保留 worker 测试库供排查;下次 run 会自动重建');
    return;
  }

  loadTestEnv();
  assertTestDatabaseUrl(process.env.DATABASE_URL);

  const workers = Math.max(1, globalConfig.maxWorkers);
  for (let i = 1; i <= workers; i++) {
    dropWorkerDatabase(i);
  }
}

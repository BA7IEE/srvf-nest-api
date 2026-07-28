import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadTestEnv } from './load-env';
import {
  assertConnectionCapacity,
  assertTestDatabaseUrl,
  assertTemplateHasNoConnections,
  ensureTemplateDatabaseExists,
  recreateWorkerDatabase,
} from './test-db';

// Jest globalSetup:整个测试 run 启动一次(在任何 worker 起来之前的主进程,
// 读不到 JEST_WORKER_ID —— 因此 loadTestEnv 派生出的是「模板库」URL)。
// 顺序固定不可乱:
//   1. 加载 .env.test → DATABASE_URL 指向模板库(主仓 app_test / worktree 派生名)
//   2. 断言 DATABASE_URL 含 'app_test'(防止意外打开发库)
//   3. 幂等建模板库
//   4. prisma migrate deploy:只对模板库跑一次(CI 实测 65 个 migration ≈ 2s)
//   5. 断言 Postgres max_connections 足够本次并发(不足时给出人话修复指令),
//      再断言模板库零连接(CREATE DATABASE ... TEMPLATE 的硬前提)
//   6. 按 maxWorkers 克隆 worker 库 app_test*_w1..N(DROP+CREATE TEMPLATE,
//      每库 0.2-0.6s;克隆天然带 _prisma_migrations,worker 内 migrate 均为 no-op);
//      每个目标库在 DROP 前单独校验零连接,防止踩死另一条并发 jest 命令
//   7. 清理上一轮的 per-worker 本地存储目录 tmp/storage-w*
//
// globalConfig.maxWorkers 是 jest 已归一化的数字('50%' 已按核数换算);
// --runInBand 时为 1,且 jest-runner 会在主进程把 JEST_WORKER_ID 置 '1',
// 所以 worker 1 的库恒被建好,单 spec 调试路径不变。
//
// 注意:globalSetup 修改的 process.env 不会传给 spec worker。
// 所以同样的 loadTestEnv() 还需在 setupFiles 里再跑一次。
// globalConfig 用结构化类型(@jest/types 非直接依赖;jest 传入的对象含已归一化的 maxWorkers)
export default async function globalSetup(globalConfig: { maxWorkers: number }): Promise<void> {
  loadTestEnv();
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  ensureTemplateDatabaseExists();

  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
  });

  const workers = Math.max(1, globalConfig.maxWorkers);
  assertConnectionCapacity(workers);
  assertTemplateHasNoConnections();

  for (let i = 1; i <= workers; i++) {
    recreateWorkerDatabase(i);
  }

  // per-worker 本地存储目录(setup-files.ts 按 JEST_WORKER_ID 派生 STORAGE_LOCAL_ROOT):
  // 开跑前一次性清空上一轮残留,避免「断言文件不存在」类反向断言被旧文件翻面。
  // 放在 setup 而非 teardown:teardown 在 jest 崩溃/Ctrl-C 时不执行,setup 端清理更可靠。
  const tmpRoot = path.resolve(__dirname, '../../tmp');
  if (fs.existsSync(tmpRoot)) {
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (/^storage-w[0-9]{1,2}$/.test(entry)) {
        fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
      }
    }
  }
}

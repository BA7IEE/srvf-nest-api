import { config as loadDotenv } from 'dotenv';
import * as path from 'path';
import { applyTestDbDerivation } from './worktree-db';

const ENV_TEST_PATH = path.resolve(__dirname, '../../.env.test');

// 双层加载:
// - Jest globalSetup 启动时调用一次,让 globalSetup 自身能读到 DATABASE_URL 跑 migrate deploy。
// - Jest setupFiles 在每个 worker 进程入口再调用一次,因为 Jest 30 的 globalSetup 改动 process.env
//   不会传给 worker(worker 自带一份干净 env)。
//
// override:true 强制覆盖 shell 已 export 的同名变量,避免开发者本地
// `export DATABASE_URL=...` 污染测试库目标。
// quiet:true 关闭 dotenv 17 默认的提示横幅(◇ injected env / tip 广告字符串),
// 让 jest 输出干净。
export function loadTestEnv(): void {
  const result = loadDotenv({ path: ENV_TEST_PATH, override: true, quiet: true });
  if (result.error) {
    throw new Error(
      `加载 .env.test 失败,期望路径: ${ENV_TEST_PATH}\n原始错误: ${result.error.message}`,
    );
  }
  // linked worktree 内把库名派生为 app_test_<slug>,并行 lane 的 e2e 互不打架;
  // 主仓零变化,派生名仍含 'app_test' 子串,既有安全断言原样生效(worktree-db.ts)。
  applyTestDbDerivation();
}

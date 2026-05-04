import { execSync } from 'child_process';
import { loadTestEnv } from './load-env';
import { assertTestDatabaseUrl, ensureTestDatabaseExists } from './test-db';

// Jest globalSetup:整个测试 run 启动一次。
// 顺序固定不可乱:
//   1. 加载 .env.test → process.env.DATABASE_URL 指向 app_test
//   2. 断言 DATABASE_URL 含 'app_test',否则立即抛错(防止意外打开发库)
//   3. 幂等建库:不存在则 createdb app_test,已存在跳过
//   4. prisma migrate deploy:把现有 migrations 应用到 app_test
//
// 注意:globalSetup 修改的 process.env 不会传给 spec worker。
// 所以同样的 loadTestEnv() 还需在 setupFiles 里再跑一次。
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  ensureTestDatabaseExists();

  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
  });
}

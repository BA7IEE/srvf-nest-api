import { execSync } from 'child_process';
import { loadTestEnv } from './load-env';
import { assertTestDatabaseUrl, ensureTestDatabaseExists } from './test-db';

// pnpm db:test:reset 入口:把 app_test 库完全重置到 schema 初始状态。
// 用途:E2E 调试期间出现脏数据 / migration 状态不一致时的"核选项"。
//
// 与 globalSetup 共享同一套护栏:
//   1. 显式 load .env.test(override:true 覆盖 shell 中已 export 的 DATABASE_URL)
//   2. 断言 'app_test' 子串
//   3. 幂等确保库存在
//   4. prisma migrate reset --force --skip-seed:DROP/recreate schema 后只跑 migrations,不跑 seed
//
// --skip-seed 必须开:reset 后由各 spec 自己造 fixtures,seed 的 SUPER_ADMIN 不该被 reset 自动写入。
loadTestEnv();
assertTestDatabaseUrl(process.env.DATABASE_URL);
ensureTestDatabaseExists();

execSync('pnpm prisma migrate reset --force --skip-seed', {
  stdio: 'inherit',
  env: { ...process.env },
});

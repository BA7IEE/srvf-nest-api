import { loadTestEnv } from './load-env';
import { assertTestDatabaseUrl } from './test-db';

// Jest setupFiles:每个 worker 进程入口跑一次,在 spec 模块加载前。
// globalSetup 修改的 process.env 不会传给 worker,这里必须再 load 一遍 .env.test,
// 让 spec 内 import 的 NestJS ConfigModule / PrismaService 能拿到正确的 DATABASE_URL。
//
// 同时再断言一次 'app_test' 子串,防止任何环境路径上的 DATABASE_URL 漂移把
// truncate / 写操作打到开发库。
loadTestEnv();
assertTestDatabaseUrl(process.env.DATABASE_URL);

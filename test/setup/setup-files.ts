import { loadTestEnv } from './load-env';
import { assertTestDatabaseUrl } from './test-db';

// Jest setupFiles:每个测试文件加载前跑一次(worker 进程内)。
// globalSetup 修改的 process.env 不会传给 worker,这里必须再 load 一遍 .env.test,
// 让 spec 内 import 的 NestJS ConfigModule / PrismaService 能拿到正确的 DATABASE_URL
// (load-env → applyTestDbDerivation 在 worker 内自动追加 _w<JEST_WORKER_ID> 后缀,
// 每个 worker 连接自己的克隆库)。
//
// 同时再断言一次 'app_test' 子串,防止任何环境路径上的 DATABASE_URL 漂移把
// truncate / 写操作打到开发库。
loadTestEnv();
assertTestDatabaseUrl(process.env.DATABASE_URL);

// per-worker 本地存储目录(Harness 3.0 P1 并行化):
// app.config.ts 的 STORAGE_LOCAL_ROOT 默认 './tmp/storage' 是跨 worker 共享的文件系统态,
// 6 个 attachment/content spec 直接读写该目录、且 attachment key 由每文件重置的确定性
// 计数器生成 —— 并行下「断言文件不存在」类反向断言会被别的 worker 写入翻面。
// 必须在这里(ConfigModule 加载前)按 worker 隔离;.env.test 不设该变量,幂等安全。
const workerId = process.env.JEST_WORKER_ID ?? '1';
process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${workerId}`;

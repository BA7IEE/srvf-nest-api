import { execSync } from 'child_process';
import { deriveTemplateTestDbName, deriveWorkerTestDbName } from './worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';

// E2E 测试库的核心安全护栏。
//
// 任何破坏性操作(TRUNCATE / migrate reset / migrate deploy)在执行前都必须先调用
// assertTestDatabaseUrl(process.env.DATABASE_URL),不通过 → 立刻抛错,拒绝继续。
//
// 这是防止"测试代码意外打到开发库 app"的最后一道闸门——即使 .env.test 加载失败、
// 即使 shell 里 export 了奇怪的 DATABASE_URL,只要不含 'app_test' 子串,所有写操作一律被拒。
export function assertTestDatabaseUrl(url: string | undefined): void {
  if (!url) {
    throw new Error('DATABASE_URL 未设置,拒绝执行测试库操作');
  }
  if (!url.includes('app_test')) {
    throw new Error(
      `DATABASE_URL 必须指向 app_test 测试库,当前值不含 'app_test'。拒绝执行 truncate / migrate / reset 等破坏性操作。\n实际 DATABASE_URL: ${maskUrl(url)}`,
    );
  }
}

// 第二道护栏:任何建/删库操作前,库名必须以 'app_test' 开头。
// (worktree-db.ts 的派生函数已断言含子串与长度;这里再收紧为前缀匹配,
// 防止任何路径上把 DROP DATABASE 打到 app / postgres。)
function assertDroppableName(name: string): void {
  if (!name.startsWith('app_test')) {
    throw new Error(`测试库生命周期操作只允许 app_test* 库,拒绝对 '${name}' 执行`);
  }
}

function psql(sql: string): string {
  return execSync(`docker exec ${POSTGRES_CONTAINER} psql -U postgres -d postgres -tAc "${sql}"`, {
    encoding: 'utf-8',
  }).trim();
}

// 幂等地确保「模板库」存在;不存在则建之,已存在则跳过。
// 通过 docker exec 容器内 psql / createdb,与 npm script `db:test:init` 行为一致。
// 模板库 = checkout 级派生名(主仓 'app_test';linked worktree 'app_test_<slug>_<hash6>'),
// globalSetup 对它跑 migrate deploy,worker 库按它克隆。
export function ensureTemplateDatabaseExists(): string {
  const templateName = deriveTemplateTestDbName();
  let probeOutput = '';
  try {
    probeOutput = psql(`SELECT 1 FROM pg_database WHERE datname='${templateName}'`);
  } catch (err) {
    throw new Error(
      `无法连接 Postgres 容器 ${POSTGRES_CONTAINER}。请先执行 \`docker compose up -d\` 等待 healthy。\n原始错误: ${(err as Error).message}`,
    );
  }

  if (probeOutput !== '1') {
    execSync(`docker exec ${POSTGRES_CONTAINER} createdb -U postgres ${templateName}`, {
      stdio: 'inherit',
    });
  }
  return templateName;
}

// 兼容旧名(reset-test-db-cli.ts 等调用点):语义 = 确保模板库存在。
export const ensureTestDatabaseExists = ensureTemplateDatabaseExists;

function connectionCount(dbName: string): string {
  return psql(
    `SELECT count(*) FROM pg_stat_activity WHERE datname='${dbName}' AND pid<>pg_backend_pid()`,
  );
}

function inspectHint(dbName: string): string {
  return (
    `  docker exec ${POSTGRES_CONTAINER} psql -U postgres ` +
    `-c "SELECT pid, application_name, state FROM pg_stat_activity WHERE datname='${dbName}'"`
  );
}

// CREATE DATABASE ... TEMPLATE 要求模板库零连接;连接残留时给出人话错误,
// 否则非职业程序员维护者会卡死在一条 Postgres 原生报错上。
export function assertTemplateHasNoConnections(): void {
  const templateName = deriveTemplateTestDbName();
  const count = connectionCount(templateName);
  if (count !== '0') {
    throw new Error(
      `模板测试库 '${templateName}' 上还有 ${count} 个活跃连接(Prisma Studio?dev server?),` +
        `无法按模板克隆 worker 库。请关闭这些连接后重跑;查看来源:\n${inspectHint(templateName)}`,
    );
  }
}

// 并行 e2e 需要的最低连接容量:worker 数 × 每 spec 最多 3 个 app × connection_limit
// + seed 子进程/裸 PrismaClient 余量。容器 max_connections 不足时给人话错误,
// 否则表现为随机的 "too many clients" / P2024,极难归因。
export function assertConnectionCapacity(workers: number, connectionLimit = 5): void {
  const required = workers * 3 * connectionLimit + 20;
  const current = Number(psql('SHOW max_connections'));
  if (!Number.isFinite(current) || current < required) {
    throw new Error(
      `Postgres max_connections=${current},低于并行 e2e 所需的 ${required}` +
        `(${workers} worker × 3 app × ${connectionLimit} 连接 + 20 余量)。\n` +
        `修复:docker compose up -d postgres(让容器按 docker-compose.yml 的 max_connections=200 重建);\n` +
        `或临时降低并发:JEST_MAX_WORKERS=2 pnpm test:e2e`,
    );
  }
}

// 重建指定 worker 的克隆库:DROP ... WITH (FORCE)(PG13+,免手动 terminate)后按模板克隆。
// 文件级拷贝(单库实测 13-17MB,约 0.2-0.6s),且保证与模板逐字节同构、
// 天然带上 _prisma_migrations —— worker 内任何再次 migrate deploy 都是 no-op。
export function recreateWorkerDatabase(workerId: string | number): string {
  const templateName = deriveTemplateTestDbName();
  const workerName = deriveWorkerTestDbName(workerId);
  assertDroppableName(workerName);

  // ⚠️ DROP ... WITH (FORCE) 会先 terminate 目标库的全部连接。若同一 worktree 内
  // 另一条 jest 命令(另一个窗口的 test:e2e / test:contract / agent:check:full)
  // 正在用这个 worker 库,静默 FORCE 删除会让两条 run 共用重建后的同名库、互相
  // TRUNCATE —— 正是本设计要根除的跨 run 互擦。模板库零连接断言检测不到这种情况
  // (并发 run 的 worker 连的是 _wN 而非模板),所以必须在这里对目标库单独把关。
  const inUse = connectionCount(workerName);
  if (inUse !== '0') {
    throw new Error(
      `worker 测试库 '${workerName}' 上有 ${inUse} 个活跃连接,拒绝强制重建。\n` +
        `通常意味着同一 worktree 内已有另一条 jest 命令在跑(test:e2e / test:contract / agent:check:full),` +
        `两条 run 共用测试库会互相 TRUNCATE。请等它跑完或终止后重试;查看来源:\n${inspectHint(workerName)}`,
    );
  }

  psql(`DROP DATABASE IF EXISTS \\"${workerName}\\" WITH (FORCE)`);
  try {
    psql(`CREATE DATABASE \\"${workerName}\\" TEMPLATE \\"${templateName}\\"`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/being accessed by other users|source database .* is being accessed/i.test(msg)) {
      throw new Error(
        `按模板克隆 '${workerName}' 失败:模板库 '${templateName}' 在克隆期间被重新连接` +
          `(Prisma Studio?dev server?)。请关闭后重跑;查看来源:\n${inspectHint(templateName)}`,
      );
    }
    throw err;
  }
  return workerName;
}

// globalTeardown:回收 worker 克隆库(模板库保留 —— 它是下次克隆的源,
// 也让 pnpm db:test:reset / db:test:init 的语义保持不变)。
export function dropWorkerDatabase(workerId: string | number): void {
  const workerName = deriveWorkerTestDbName(workerId);
  assertDroppableName(workerName);
  psql(`DROP DATABASE IF EXISTS \\"${workerName}\\" WITH (FORCE)`);
}

function maskUrl(url: string): string {
  // 隐藏 user:password 部分,避免抛错信息泄漏凭据
  return url.replace(/:[^:@/]*@/, ':***@');
}

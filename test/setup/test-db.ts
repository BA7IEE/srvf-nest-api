import { execSync } from 'child_process';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const TEST_DB_NAME = 'app_test';

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

// 幂等地确保 app_test 库存在;不存在则建之,已存在则跳过。
// 通过 docker exec 容器内 psql / createdb,与 npm script `db:test:init` 行为一致。
export function ensureTestDatabaseExists(): void {
  const probeCmd = `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'"`;

  let probeOutput = '';
  try {
    probeOutput = execSync(probeCmd, { encoding: 'utf-8' }).trim();
  } catch (err) {
    throw new Error(
      `无法连接 Postgres 容器 ${POSTGRES_CONTAINER}。请先执行 \`docker compose up -d\` 等待 healthy。\n原始错误: ${(err as Error).message}`,
    );
  }

  if (probeOutput === '1') return;

  const createCmd = `docker exec ${POSTGRES_CONTAINER} createdb -U postgres ${TEST_DB_NAME}`;
  execSync(createCmd, { stdio: 'inherit' });
}

function maskUrl(url: string): string {
  // 隐藏 user:password 部分,避免抛错信息泄漏凭据
  return url.replace(/:[^:@/]*@/, ':***@');
}

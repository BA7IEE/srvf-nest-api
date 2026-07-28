import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// worktree + jest worker 测试库名派生(Harness 2.0 T0 §1.4 / d5;Harness 3.0 P1 并行化)。
//
// 两级派生,层层追加后缀:
//   1. checkout 级(Harness 2.0):并行 lane 各自在 git worktree 内跑 e2e 时,
//      共享同一个 app_test 会互相 truncate(已有竞态前科):
//        - 主仓(<root>/.git 是目录)      → 'app_test'
//        - linked worktree(.git 是文件) → 'app_test_<目录名 slug>_<路径哈希前 6 位>'
//      这一级的产物是「模板库名」:globalSetup 对它 migrate deploy 一次,再按模板克隆。
//   2. worker 级(Harness 3.0 P1):e2e 并行后,每个 jest worker 用
//      '<模板库名>_w<JEST_WORKER_ID>' 的独立克隆库 —— resetDb() 是 TRUNCATE 55 表的
//      全库擦除,同库并发必然互擦,worker 级隔离是并行的第一性前提。
//      globalSetup / reset-test-db-cli 在 jest 主进程运行、读不到 JEST_WORKER_ID,
//      天然落在模板库上;worker 内(含 --runInBand 时 jest-runner 显式置 '1')
//      自动追加 _wN。7 个直接调用 deriveTestDbName() 的 spec(psql 重放 migration /
//      current_database 断言)因此零改动即指向本 worker 的库。
//
// 哈希段(第五轮 review R5-04):slug 折叠(lane-a 与 lane_a 同 slug)+ 40 字符截断
// (长名共同前缀)使派生非单射,特殊目录名可跨 lane 共库;全非 [a-z0-9] 目录名(如中文)
// slug 为空,曾回落主仓 app_test。追加"仓绝对路径 sha256 前 6 位"后不同 checkout 恒不同库;
// 空 slug 也带哈希 —— **linked worktree 永不回落 'app_test'**。
//
// 派生名仍含 'app_test' 子串,test-db.ts 的 assertTestDatabaseUrl 安全护栏原样生效;
// 总长 ≤ 9+40+7+4=60 ≤ PostgreSQL 标识符 63 上限(超 63 会被静默截断导致跨 worker
// 撞库 —— R5-04 同类 bug 的加强版,因此下方对最终名做硬断言而不只靠算术推导)。
// CI 在仓库根 checkout(.git 为目录)→ 模板恒为 'app_test',与 ci.yml env 一致。

const BASE_TEST_DB = 'app_test';
const MAX_PG_IDENTIFIER = 63;
const REPO_ROOT = path.resolve(__dirname, '../..');

// worker 号必须是 1-2 位数字(jest worker 数不会超过两位;拒绝把任意字符串拼进库名)
const WORKER_ID_RE = /^[0-9]{1,2}$/;

function assertDerivedName(name: string): string {
  if (!name.includes(BASE_TEST_DB)) {
    throw new Error(`派生测试库名 '${name}' 不含 '${BASE_TEST_DB}' 子串,拒绝使用`);
  }
  if (name.length > MAX_PG_IDENTIFIER) {
    throw new Error(
      `派生测试库名 '${name}' 长度 ${name.length} 超过 PostgreSQL 标识符上限 ${MAX_PG_IDENTIFIER},` +
        `超长会被静默截断导致跨 worker/lane 撞库,拒绝使用`,
    );
  }
  return name;
}

// 纯派生核(导出供 scripts/harness-guards.selftest.ts 喂碰撞样例回归)
export function deriveTestDbNameFrom(repoRootAbs: string, isLinkedWorktree: boolean): string {
  if (!isLinkedWorktree) return BASE_TEST_DB;

  const slug = path
    .basename(repoRootAbs)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const pathHash = crypto.createHash('sha256').update(repoRootAbs).digest('hex').slice(0, 6);
  return slug ? `${BASE_TEST_DB}_${slug}_${pathHash}` : `${BASE_TEST_DB}_${pathHash}`;
}

// 模板库名(checkout 级派生,无 worker 后缀):globalSetup 建库 + migrate deploy 的对象,
// 也是 pnpm db:test:reset / db:test:init 的语义目标(与 Harness 2.0 行为一致)。
export function deriveTemplateTestDbName(): string {
  let isLinkedWorktree = false;
  try {
    // linked worktree 的 <root>/.git 是一个内容为 "gitdir: ..." 的文件;主仓是目录
    isLinkedWorktree = fs.statSync(path.join(REPO_ROOT, '.git')).isFile();
  } catch {
    isLinkedWorktree = false;
  }
  return assertDerivedName(deriveTestDbNameFrom(REPO_ROOT, isLinkedWorktree));
}

// 指定 worker 的克隆库名(globalSetup / globalTeardown / db:test:prune 用)。
export function deriveWorkerTestDbName(workerId: string | number): string {
  const id = String(workerId);
  if (!WORKER_ID_RE.test(id)) {
    throw new Error(`非法 JEST_WORKER_ID '${id}'(期望 1-2 位数字),拒绝拼入测试库名`);
  }
  return assertDerivedName(`${deriveTemplateTestDbName()}_w${id}`);
}

// 当前进程应使用的测试库名:jest worker 内(含 --runInBand 的主进程,jest-runner 会
// 显式置 JEST_WORKER_ID='1')→ worker 克隆库;jest 之外(globalSetup / CLI 脚本)→ 模板库。
export function deriveTestDbName(): string {
  const workerId = process.env.JEST_WORKER_ID;
  return workerId ? deriveWorkerTestDbName(workerId) : deriveTemplateTestDbName();
}

// 把 DATABASE_URL 的库名从 app_test 重写为派生名;仅当:
//   1. 处于 linked worktree(R5-04 起派生名恒 ≠ app_test),且
//   2. URL 库名恰为 '/app_test'(已被人工定制的 URL 不动)
// 才生效。URL 解析失败时不派生,交由 assertTestDatabaseUrl 兜底拒绝。
export function applyTestDbDerivation(): void {
  const url = process.env.DATABASE_URL;
  const dbName = deriveTestDbName();
  if (!url || dbName === BASE_TEST_DB) return;
  try {
    const u = new URL(url);
    if (u.pathname === `/${BASE_TEST_DB}`) {
      u.pathname = `/${dbName}`;
      process.env.DATABASE_URL = u.toString();
    }
  } catch {
    // 非法 URL:不派生,后续断言与连接自然失败并给出明确错误
  }
}

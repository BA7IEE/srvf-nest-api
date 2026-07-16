import * as fs from 'fs';
import * as path from 'path';

// worktree 测试库名派生(Harness 2.0 T0 §1.4 / d5)。
//
// 并行 lane 各自在 git worktree 内跑全量 e2e 时,共享同一个 app_test 会互相 truncate
// (已有竞态前科);本模块按"所在 checkout 是否为 linked worktree"派生独立库名:
//   - 主仓(<root>/.git 是目录)      → 'app_test'(行为零变化)
//   - linked worktree(.git 是文件) → 'app_test_<目录名 slug>'
//
// 派生名仍含 'app_test' 子串,test-db.ts 的 assertTestDatabaseUrl 安全护栏原样生效;
// CI 在仓库根 checkout(.git 为目录)→ 恒为 'app_test',与 ci.yml env 一致。

const BASE_TEST_DB = 'app_test';
const REPO_ROOT = path.resolve(__dirname, '../..');

export function deriveTestDbName(): string {
  let isLinkedWorktree = false;
  try {
    // linked worktree 的 <root>/.git 是一个内容为 "gitdir: ..." 的文件;主仓是目录
    isLinkedWorktree = fs.statSync(path.join(REPO_ROOT, '.git')).isFile();
  } catch {
    isLinkedWorktree = false;
  }
  if (!isLinkedWorktree) return BASE_TEST_DB;

  const slug = path
    .basename(REPO_ROOT)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug ? `${BASE_TEST_DB}_${slug}` : BASE_TEST_DB;
}

// 把 DATABASE_URL 的库名从 app_test 重写为派生名;仅当:
//   1. 处于 linked worktree(派生名 ≠ app_test),且
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

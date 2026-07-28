import { execSync } from 'child_process';
import * as path from 'path';
import { deriveTestDbNameFrom } from '../test/setup/worktree-db';

// pnpm db:test:prune — 按 git worktree 白名单差集回收孤儿测试库(Harness 3.0 P1)。
//
// 背景:worktree 级派生库(Harness 2.0)+ worker 级克隆库(P1)只建不删时会持续膨胀
// (实测曾泄漏 92 个 app_test* 库 / 1310 MB)。globalTeardown 负责常规回收;本脚本
// 处理 jest 崩溃残留与「worktree 已删、库还在」的孤儿。
//
// 白名单 = 对每个活 worktree(git worktree list --porcelain)算出模板库名 +
// 其 _w1.._w32 展开;凡 app_test* 且不在白名单 = 孤儿。
//
// 安全语义(fail-closed):
//   - 默认 dry-run 只打印;--force 才执行 DROP
//   - 硬拒任何不以 'app_test' 开头的库名(双保险,即使查询结果被污染也删不到 app)
//   - 有活跃连接的库跳过并提示(避免误杀正在跑的 e2e)
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
// 必须 ≥ deriveWorkerTestDbName 允许的最大 worker 号(WORKER_ID_RE 放行 1-2 位 = 99),
// 否则高核数机器上 _w33.._w99 会被误判为孤儿并在 --force 下删掉正在使用的库。
const MAX_WORKERS = 99;

function psql(sql: string): string {
  return execSync(
    `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d postgres -tAc "${sql}"`,
    { encoding: 'utf-8' },
  ).trim();
}

function main(): void {
  const force = process.argv.includes('--force');

  // 1) 活 worktree 白名单
  const porcelain = execSync('git worktree list --porcelain', { encoding: 'utf-8' });
  const worktrees: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push(line.slice('worktree '.length).trim());
  }
  if (worktrees.length === 0) {
    console.error('无法解析 git worktree list,拒绝继续(fail-closed)');
    process.exit(1);
  }
  const mainRoot = worktrees[0]; // porcelain 首个恒为主仓
  const allow = new Set<string>();
  for (const wt of worktrees) {
    const isLinked = path.resolve(wt) !== path.resolve(mainRoot);
    const base = deriveTestDbNameFrom(path.resolve(wt), isLinked);
    allow.add(base);
    for (let i = 1; i <= MAX_WORKERS; i++) allow.add(`${base}_w${i}`);
  }

  // 2) 现存 app_test* 库与孤儿差集
  const existing = psql("SELECT datname FROM pg_database WHERE datname LIKE 'app_test%'")
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const orphans = existing.filter((db) => !allow.has(db));

  console.log(`活 worktree: ${worktrees.length} 个;白名单库名: ${allow.size} 个`);
  console.log(`现存 app_test* 库: ${existing.length} 个;孤儿: ${orphans.length} 个`);
  if (orphans.length === 0) {
    console.log('✓ 无孤儿测试库');
    return;
  }

  let dropped = 0;
  let skipped = 0;
  for (const db of orphans) {
    if (!db.startsWith('app_test')) {
      console.error(`  ✗ 跳过非法名 '${db}'(不以 app_test 开头,拒绝处理)`);
      skipped++;
      continue;
    }
    const conns = psql(
      `SELECT count(*) FROM pg_stat_activity WHERE datname='${db}' AND pid<>pg_backend_pid()`,
    );
    if (conns !== '0') {
      console.log(`  ⏸ 跳过 ${db}(${conns} 个活跃连接 —— 可能有 e2e 正在跑)`);
      skipped++;
      continue;
    }
    if (force) {
      psql(`DROP DATABASE IF EXISTS \\"${db}\\" WITH (FORCE)`);
      console.log(`  ✓ 已删除 ${db}`);
      dropped++;
    } else {
      console.log(`  · [dry-run] 将删除 ${db}`);
    }
  }

  if (!force) {
    console.log(`\ndry-run 结束:${orphans.length - skipped} 个可删。执行删除请跑 pnpm db:test:prune --force`);
  } else {
    console.log(`\n完成:删除 ${dropped} 个,跳过 ${skipped} 个`);
  }
}

main();

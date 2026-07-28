import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// pnpm harness:grant —— 红区授权令牌工具(Harness 3.0 P2b)。
//
// 红区 hook 拒绝写操作后,**由维护者**跑这条命令授权本次改动:
//   pnpm harness:grant 'AGENTS.md' --reason "2026-07-28 拍板:P3 恒读重写"
//   pnpm harness:grant --list        # 看当前有哪些授权
//   pnpm harness:grant --clear       # 用完撤销(建议每次收工清)
//
// 令牌落在 $(git rev-parse --git-path srvf-redzone-grant.json):
//   - 每个 worktree 独立 → lane 之间不串权
//   - 在 .git/ 内 → 天然不入库,不会被误提交、不会跟着分支传播
//   - 路径由 hook 硬编码识别,不接受任何来自模型的覆盖
//
// ⚠️ 令牌本身**不是**拍板:它只是把维护者已经做出的拍板,翻译成 hook 能读的形态。
// reason 必填就是为了留下「授权依据是什么」的痕迹。

type Grant = { glob: string; reason: string; ts: string };

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function grantFilePath(): string {
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const p = git(['rev-parse', '--git-path', 'srvf-redzone-grant.json']);
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

function read(file: string): Grant[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { grants?: Grant[] };
    return parsed.grants ?? [];
  } catch {
    return [];
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const file = grantFilePath();

  if (argv.includes('--clear')) {
    if (fs.existsSync(file)) fs.rmSync(file);
    console.log(`✓ 已撤销本 worktree 的全部红区授权(${file})`);
    return;
  }

  if (argv.includes('--list') || argv.length === 0) {
    const grants = read(file);
    if (grants.length === 0) {
      console.log('当前无红区授权。');
      console.log("用法:pnpm harness:grant '<glob>' --reason \"<拍板出处>\"");
      return;
    }
    console.log(`本 worktree 当前红区授权(${file}):`);
    for (const g of grants) console.log(`  - ${g.glob}\n      理由:${g.reason}\n      时间:${g.ts}`);
    console.log('\n用完请跑 pnpm harness:grant --clear 撤销。');
    return;
  }

  const glob = argv.find((a) => !a.startsWith('--'));
  const reasonIdx = argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] : undefined;

  if (!glob) {
    console.error("✗ 缺少 glob。用法:pnpm harness:grant '<glob>' --reason \"<拍板出处>\"");
    process.exit(1);
  }
  if (!reason || reason.startsWith('--')) {
    console.error(
      '✗ --reason 必填(留下授权依据的痕迹)。\n' +
        '  例:pnpm harness:grant \'AGENTS.md\' --reason "2026-07-28 拍板:P3 恒读重写"',
    );
    process.exit(1);
  }

  const grants = read(file);
  grants.push({ glob, reason, ts: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify({ grants }, null, 2) + '\n');
  console.log(`✓ 已授权:${glob}`);
  console.log(`  理由:${reason}`);
  console.log(`  令牌:${file}(本 worktree 私有,不入库)`);
  console.log('  用完请跑 pnpm harness:grant --clear 撤销。');
}

main();

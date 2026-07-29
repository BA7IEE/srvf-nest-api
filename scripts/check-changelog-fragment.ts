/**
 * check-changelog-fragment.ts — 功能 PR 必须用 changelog.d fragment(Harness 3.0 P6)
 *
 * 立项证据(实测,不是推演):2026-07-28/29 通宵推进 Harness 3.0 期间开了 8 个 PR,
 * **每一个都在 CHANGELOG.md 上撞了合并冲突** —— 因为大家都往 `## Unreleased`
 * 同一处追加。为对齐 main 而产生的合并提交、解冲突的来回,全是纯损耗。
 *
 * 而 `changelog.d/` fragment 机制 **Harness 2.0 就建好了**(README 写着、
 * `pnpm changelog:merge` 能跑、`release:prepare` 会归并),当晚**一个都没人用**——
 * 包括我自己,全程直接改 CHANGELOG。
 *
 * 规则写了、工具有了、没人用 —— 这正是「散文规则不如机器执法」的又一个实例。
 * 所以本脚本不再写第二遍「请用 fragment」,直接判:
 *
 *   改了 CHANGELOG.md 的 `## Unreleased` 段 且 本次没有新增/修改任何 fragment
 *     → 红,并给出可直接照抄的修复命令
 *
 * 豁免(都是真实存在的合法形态,不是给自己留后门):
 *   ① **发版收口**:`release:prepare` 会归并并删除 fragment、同时 bump
 *      `package.json#version` —— 该形态放行(否则发版永远过不了自己这道门)
 *   ② **只改历史版本段**:修早前版本的笔误不碰 `## Unreleased`,不冲突,放行
 *   ③ 完全不碰 CHANGELOG 的 PR:放行(A 档 docs-only 本就不登记)
 *
 * 用法:
 *   tsx scripts/check-changelog-fragment.ts --base origin/main
 *   tsx scripts/check-changelog-fragment.ts --files <改动文件…>   # 自测用
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(`scripts/check-*.ts`)。
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = 'CHANGELOG.md';
const FRAGMENT_DIR = 'changelog.d/';

export interface Verdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * 纯函数判定,便于自测直接喂样例(不依赖 git)。
 *
 * @param changed      本次变更的文件路径
 * @param unreleasedTouched 是否改动了 `## Unreleased` 段(由调用方按 diff 判)
 * @param versionBumped     `package.json#version` 是否变化
 * @param fragmentsDeleted  是否删除了 fragment(归并的特征)
 */
export function judgeChangelog(
  changed: readonly string[],
  unreleasedTouched: boolean,
  versionBumped: boolean,
  fragmentsDeleted: boolean,
): Verdict {
  if (!changed.includes(CHANGELOG)) return { ok: true, reason: '未改 CHANGELOG' };
  if (!unreleasedTouched) return { ok: true, reason: '只改了历史版本段,不与并行 PR 争同一处' };
  if (versionBumped && fragmentsDeleted)
    return { ok: true, reason: '发版收口形态(归并 fragment + bump 版本)' };

  const hasFragment = changed.some((f) => f.startsWith(FRAGMENT_DIR) && f.endsWith('.md') && !f.endsWith('README.md'));
  if (hasFragment) return { ok: true, reason: '同时提供了 fragment' };

  return {
    ok: false,
    reason: '直接改了 CHANGELOG 的 ## Unreleased 段,却没有 fragment',
  };
}

// ---------------------------------------------------------------------------

interface DiffFacts {
  changed: string[];
  unreleasedTouched: boolean;
  versionBumped: boolean;
  fragmentsDeleted: boolean;
}

function gitDiff(args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function collect(base: string): DiffFacts {
  const nameStatus = gitDiff(['diff', '--name-status', '-z', `${base}...HEAD`]);
  const parts = nameStatus.split('\0').filter((s) => s !== '');
  const changed: string[] = [];
  let fragmentsDeleted = false;
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    const isRename = status.startsWith('R') || status.startsWith('C');
    const file = isRename ? parts[i + 2] : parts[i + 1];
    changed.push(file);
    if (status.startsWith('D') && file.startsWith(FRAGMENT_DIR)) fragmentsDeleted = true;
    i += isRename ? 3 : 2;
  }

  // `## Unreleased` 段是否被碰:只看 CHANGELOG 的 hunk 头行号落在该段内 —— 过于脆弱。
  // 改用更稳的判据:新增行里是否有落在 `## Unreleased` 与下一个 `## ` 之间的内容。
  // 实现上直接比对两版的该段文本,不同即算碰过。
  let unreleasedTouched = false;
  if (changed.includes(CHANGELOG)) {
    const section = (text: string): string => {
      const m = /^## Unreleased\s*$([\s\S]*?)(?=^## |\Z)/m.exec(text);
      return m ? m[1] : '';
    };
    let before = '';
    try {
      before = gitDiff(['show', `${base}:${CHANGELOG}`]);
    } catch {
      before = '';
    }
    const after = fs.readFileSync(path.join(ROOT, CHANGELOG), 'utf-8');
    unreleasedTouched = section(before) !== section(after);
  }

  let versionBumped = false;
  if (changed.includes('package.json')) {
    const ver = (t: string): string => {
      try {
        return (JSON.parse(t) as { version?: string }).version ?? '';
      } catch {
        return '';
      }
    };
    try {
      versionBumped =
        ver(gitDiff(['show', `${base}:package.json`])) !==
        ver(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    } catch {
      versionBumped = false;
    }
  }

  return { changed, unreleasedTouched, versionBumped, fragmentsDeleted };
}

function main(): void {
  const argv = process.argv.slice(2);
  const filesIdx = argv.indexOf('--files');
  let facts: DiffFacts;

  if (filesIdx >= 0) {
    const changed = argv.slice(filesIdx + 1);
    facts = {
      changed,
      unreleasedTouched: changed.includes(CHANGELOG),
      versionBumped: argv.includes('--version-bumped'),
      fragmentsDeleted: argv.includes('--fragments-deleted'),
    };
  } else {
    const baseIdx = argv.indexOf('--base');
    const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/main';
    try {
      facts = collect(base);
    } catch (err) {
      // 与红区扫描同一条原则:拿不到 diff = 无法判断 → fail-closed。
      console.error(`✗ 无法计算变更集(base=${base}):${String(err)}`);
      process.exit(1);
    }
  }

  const v = judgeChangelog(
    facts.changed,
    facts.unreleasedTouched,
    facts.versionBumped,
    facts.fragmentsDeleted,
  );
  if (v.ok) {
    console.log(`✓ changelog 形态检查通过(${v.reason})`);
    return;
  }

  const branch = (() => {
    try {
      return gitDiff(['rev-parse', '--abbrev-ref', 'HEAD']).trim().replace(/\//g, '-');
    } catch {
      return 'my-change';
    }
  })();

  console.error(`✗ ${v.reason}\n`);
  console.error('为什么拦:`## Unreleased` 是所有 PR 的**单一追加点**。直接改它,');
  console.error('两个 PR 同时在跑就必然冲突 —— 2026-07-28 通宵那 8 个 PR 全撞了这一处。\n');
  console.error('改法(把同一段内容挪进 fragment,格式完全一样):');
  console.error(`  1) 新建 changelog.d/${branch}.md,内容 = 你刚写进 ## Unreleased 的那几行`);
  console.error(`  2) 把 CHANGELOG.md 的 ## Unreleased 改动撤销:git checkout origin/main -- ${CHANGELOG}`);
  console.error('  3) 发版时由 `pnpm release:prepare` 一次性归并,不需要你手动合\n');
  console.error('详见 changelog.d/README.md。');
  process.exit(1);
}

if (require.main === module) main();

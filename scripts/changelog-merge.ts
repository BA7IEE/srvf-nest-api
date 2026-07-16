/**
 * changelog-merge.ts — changelog.d/ fragment 归并(Harness 2.0 T0 §1.4 / d4)
 *
 * lane 并行时 CHANGELOG `## Unreleased` 是单一追加点,任意两条并行 PR 必然文本冲突;
 * 改为每条 lane 写独立 fragment(changelog.d/<branch-or-topic>.md),bump 前由总控执行
 * 本脚本一次性归并进 `## Unreleased` 并删除 fragment。
 *
 * 行为:
 *   - changelog.d/ 不存在或无 fragment(README.md 不算)→ no-op,exit 0
 *   - CHANGELOG 已有 `## Unreleased` 段 → fragment 按文件名序追加到该段末尾
 *   - 无 `## Unreleased` 段 → 在首个 `## v` release 段之前新建
 *   - 归并成功后删除 fragment 文件
 *
 * 过渡期约定:单 lane 场景直接编辑 CHANGELOG 的旧路径不废除(process §5)。
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const FRAG_DIR = path.join(ROOT, 'changelog.d');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function main(): void {
  // 本脚本无参数;未知参数(如误传 --help)一律拒绝执行,防"冒烟即真跑"
  if (process.argv.length > 2) {
    process.stderr.write(`用法:pnpm changelog:merge(无参数;归并 changelog.d/*.md → CHANGELOG ## Unreleased)\n未知参数:${process.argv.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(FRAG_DIR)) {
    process.stdout.write('(changelog.d/ 不存在 — no-op)\n');
    return;
  }
  const frags = fs
    .readdirSync(FRAG_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
  if (frags.length === 0) {
    process.stdout.write('(changelog.d/ 无 fragment — no-op)\n');
    return;
  }

  const combined = frags
    .map((f) => fs.readFileSync(path.join(FRAG_DIR, f), 'utf-8').trim())
    .filter((s) => s.length > 0)
    .join('\n\n');

  const doc = fs.readFileSync(CHANGELOG, 'utf-8');
  const UNRELEASED = '\n## Unreleased\n';
  let next: string;

  if (doc.includes(UNRELEASED)) {
    const sectionStart = doc.indexOf(UNRELEASED) + UNRELEASED.length;
    const nextHeading = doc.indexOf('\n## ', sectionStart);
    const insertAt = nextHeading < 0 ? doc.length : nextHeading;
    next = `${doc.slice(0, insertAt).replace(/\n+$/, '')}\n\n${combined}\n${doc.slice(insertAt)}`;
  } else {
    const firstRelease = doc.indexOf('\n## v');
    if (firstRelease < 0) {
      throw new Error('CHANGELOG 结构异常:未找到 "## v" release 段,拒绝归并');
    }
    next = `${doc.slice(0, firstRelease)}\n## Unreleased\n\n${combined}\n${doc.slice(firstRelease)}`;
  }

  fs.writeFileSync(CHANGELOG, next);
  for (const f of frags) fs.unlinkSync(path.join(FRAG_DIR, f));
  process.stdout.write(`✓ 已归并 ${frags.length} 个 fragment → CHANGELOG ## Unreleased:${frags.join(', ')}\n`);
}

main();

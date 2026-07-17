/**
 * changelog-merge.ts — changelog.d/ fragment 归并(Harness 2.0 T0 §1.4 / d4)
 *
 * lane 并行时 CHANGELOG `## Unreleased` 是单一追加点,任意两条并行 PR 必然文本冲突;
 * 改为每条 lane 写独立 fragment(changelog.d/<branch-or-topic>.md),bump 前由总控执行
 * 本脚本一次性归并进 `## Unreleased` 并删除 fragment。
 *
 * 行为:
 *   - changelog.d/ 不存在或无 fragment(README.md 不算)→ no-op,exit 0
 *   - fragment 逐个校验(第五轮 review R5-03),任一未过 → 打印全部违规,exit 1,
 *     CHANGELOG 与 changelog.d/ 均不动:
 *       · 非 UTF-8 编码 → 拒(宽松解码的 U+FFFD 替换字符会污染 CHANGELOG)
 *       · 空 / 纯空白 → 拒(旧行为是静默跳过后仍删源,等于无痕丢弃)
 *       · 含一级 / 二级 heading(code fence 内不算)→ 拒(`##` 会成为新的顶级
 *         release 段,把后续条目撕出 Unreleased;fragment 只允许 `###` 及以下)
 *   - CHANGELOG 已有 `## Unreleased` 段 → fragment 按文件名序追加到该段末尾
 *   - 无 `## Unreleased` 段 → 在首个 `## v` release 段之前新建
 *   - **先写 CHANGELOG,写成功后才删 fragment**;写入抛错即中断,不删任何源;
 *     个别删除失败 → 显式报错并提示勿直接重跑(已归并 + 源仍在 = 重跑会重复归并)
 *
 * 校验样例回归:scripts/harness-guards.selftest.ts(`pnpm tsx scripts/harness-guards.selftest.ts`)。
 * 过渡期约定:单 lane 场景直接编辑 CHANGELOG 的旧路径不废除(process §5)。
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const FRAG_DIR = path.join(ROOT, 'changelog.d');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

export interface FragmentCheck {
  /** 严格 UTF-8 解码后的正文;编码失败时为 null */
  content: string | null;
  /** 违规清单(空数组 = 校验通过) */
  issues: string[];
}

// fragment 准入校验(导出供 selftest 喂合成样例;纯函数,不触 fs)
export function checkFragment(name: string, raw: Buffer): FragmentCheck {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { content: null, issues: [`${name}: 非 UTF-8 编码,拒绝归并`] };
  }
  if (content.trim().length === 0) {
    return { content, issues: [`${name}: 空 / 纯空白 fragment,拒绝归并(删除该文件或补内容)`] };
  }
  const issues: string[] = [];
  let inFence = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^ {0,3}#{1,2}(\s|$)/.test(line)) {
      issues.push(
        `${name}: 第 ${i + 1} 行含一级/二级 heading(「${line.trim()}」)——fragment 只允许 ### 及以下,否则会撕裂 CHANGELOG 分段`,
      );
    }
  }
  return { content, issues };
}

// 归并文本变换(导出供 selftest;纯函数,不触 fs)
export function mergeIntoChangelog(doc: string, combined: string): string {
  const UNRELEASED = '\n## Unreleased\n';
  if (doc.includes(UNRELEASED)) {
    const sectionStart = doc.indexOf(UNRELEASED) + UNRELEASED.length;
    const nextHeading = doc.indexOf('\n## ', sectionStart);
    const insertAt = nextHeading < 0 ? doc.length : nextHeading;
    return `${doc.slice(0, insertAt).replace(/\n+$/, '')}\n\n${combined}\n${doc.slice(insertAt)}`;
  }
  const firstRelease = doc.indexOf('\n## v');
  if (firstRelease < 0) {
    throw new Error('CHANGELOG 结构异常:未找到 "## v" release 段,拒绝归并');
  }
  return `${doc.slice(0, firstRelease)}\n## Unreleased\n\n${combined}\n${doc.slice(firstRelease)}`;
}

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

  const violations: string[] = [];
  const contents: string[] = [];
  for (const f of frags) {
    const check = checkFragment(f, fs.readFileSync(path.join(FRAG_DIR, f)));
    if (check.issues.length > 0) violations.push(...check.issues);
    else contents.push((check.content as string).trim());
  }
  if (violations.length > 0) {
    process.stderr.write('✗ fragment 校验未过,拒绝归并(CHANGELOG 与 changelog.d/ 均未改动):\n');
    for (const v of violations) process.stderr.write(`  - ${v}\n`);
    process.exit(1);
  }

  const combined = contents.join('\n\n');
  const doc = fs.readFileSync(CHANGELOG, 'utf-8');
  const next = mergeIntoChangelog(doc, combined);
  fs.writeFileSync(CHANGELOG, next);

  // 先写 CHANGELOG 成功后才删源(R5-03);上面任何一步抛错都不会走到这里
  const undeleted: string[] = [];
  for (const f of frags) {
    try {
      fs.unlinkSync(path.join(FRAG_DIR, f));
    } catch {
      undeleted.push(f);
    }
  }
  if (undeleted.length > 0) {
    process.stderr.write(
      `✗ CHANGELOG 已归并,但以下 fragment 删除失败:${undeleted.join(', ')}\n  勿直接重跑(源仍在会重复归并);请先手动删除上述文件\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`✓ 已归并 ${frags.length} 个 fragment → CHANGELOG ## Unreleased:${frags.join(', ')}\n`);
}

// 供 selftest 以 import 方式复用校验/归并;直跑(pnpm changelog:merge)才执行 main
if (require.main === module) main();

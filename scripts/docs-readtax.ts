/**
 * docs-readtax.ts — 恒读层体积预算守护(Harness 2.0 T0 §1.1 / d1)
 *
 * 恒读层 = 每个 AI 会话开工必读的文件。本守护把"瘦身"变成可执行约束:
 * 超预算 = 检查红,防止恒读层再次发胖(process §6 "无守护不留" 溯及自身)。
 *
 * 预算以字符数计(String.length,工具无关,不依赖特定 tokenizer);
 * 预算值 = T0 §1.1 拍板值,调整预算 = 改本文件 = 有 diff 可审。
 *
 * enforced=false 的文件只报告不拦截(report-only):
 *   PR2 全量 report-only(v1 文档尚未瘦身,直接硬判会红在过渡期);
 *   PR3 收口 current-state 后翻其 enforced=true;PR4 收口 AGENTS / CLAUDE 后翻余下两项。
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

// Harness 3.0 P3 起按重写后的实际形态重定预算(原值是 2.0 时代按当时体量定的魔法数)。
// 预算保留而非废除:2.0 时代的实证是散文**必然再生**(权威顺序长出 4 份变体、
// 「cron 恰 2 个」写了 4 处,全在有守护的条件下长出来的)。一行体积检查成本趋近于零。
// 留 ~25% 余量:预算顶格会逼出「为省字符牺牲清晰度」的压缩(#792 曾因此删掉既有事实)。
const BUDGETS: ReadonlyArray<{ file: string; maxChars: number; enforced: boolean }> = [
  { file: 'AGENTS.md', maxChars: 8_500, enforced: true }, // P3 重写后 ~6.8k
  { file: 'docs/current-state.md', maxChars: 4_500, enforced: true }, // P3 删机器可查事实后 ~4.45k
  { file: 'CLAUDE.md', maxChars: 2_000, enforced: true }, // P3 重写后 ~1.4k
];

function main(): void {
  let failed = false;
  for (const { file, maxChars, enforced } of BUDGETS) {
    const chars = fs.readFileSync(path.join(ROOT, file), 'utf-8').length;
    const over = chars > maxChars;
    let status = 'OK';
    if (over && enforced) {
      status = 'OVER(硬判)';
      failed = true;
    } else if (over) {
      status = 'OVER(report-only,收口后翻 enforced)';
    }
    process.stdout.write(`${file}: ${chars} / ${maxChars} 字符 — ${status}\n`);
  }
  if (failed) {
    process.stderr.write('✗ 恒读层超预算:瘦身或(经拍板)调预算,不得静默放行\n');
    process.exit(1);
  }
  process.stdout.write('✓ readtax 守护通过\n');
}

main();

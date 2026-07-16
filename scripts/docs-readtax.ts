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

const BUDGETS: ReadonlyArray<{ file: string; maxChars: number; enforced: boolean }> = [
  { file: 'AGENTS.md', maxChars: 18_000, enforced: false }, // PR4 收口后翻 true
  { file: 'docs/current-state.md', maxChars: 4_500, enforced: true }, // PR3 已收口(全指针化)
  { file: 'CLAUDE.md', maxChars: 2_500, enforced: false }, // PR4 收口后翻 true
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

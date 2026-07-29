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
//
// ⚠️ 校准记录(2026-07-29):P3 合并后复核发现 current-state 是 4,453/4,500 = **99%**,
// 而同批设的 AGENTS 是 80%、CLAUDE 是 70%。也就是说「留 25% 余量」这条我只对两个文件做到了 ——
// current-state 的预算实际是按它当时的体量顶格设的,再加一行事实就会红。
// 那正是本注释上一段警告的那个失败模式:**压力会转向删事实,而不是删冗余**。
// 现按同一口径重设为 ~5,600(当前占用 79%)。
//
// 定预算的规矩(为免下次再犯):**预算 = 当前体量 ÷ 0.75 向上取整到百位**,
// 不是「当前体量 + 一点」。顶格的预算不是严格,是把守护变成删事实的推手。
const BUDGETS: ReadonlyArray<{ file: string; maxChars: number; enforced: boolean }> = [
  { file: 'AGENTS.md', maxChars: 8_500, enforced: true }, // P3 重写后 ~6.8k(80%)
  { file: 'docs/current-state.md', maxChars: 5_600, enforced: true }, // P3 后 ~4.45k(79%)
  { file: 'CLAUDE.md', maxChars: 2_000, enforced: true }, // P3 重写后 ~1.4k(70%)
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
    const pct = Math.round((chars / maxChars) * 100);
    process.stdout.write(`${file}: ${chars} / ${maxChars} 字符(${pct}%)— ${status}\n`);

    // 预警带:**不拦**,只把决策摆到台面上。
    // 顶格预算的真实危害不是「红」,而是红之前那一刻 —— 人会去删一句既有事实来腾位置,
    // 因为那比「重设预算」看起来省事(#792 就是这么丢掉事实的)。
    // 所以在还没红的时候就明说:这里有两个选项,而且删事实不是默认那个。
    if (!over && pct >= 85) {
      process.stdout.write(
        `  ⚠️ 已用 ${pct}% —— 两条路,别默认选第一条:\n` +
          `     ① 精简冗余(重复表述 / 机器可查的事实 / 已归档的历史)\n` +
          `     ② 重设预算(本文件 BUDGETS,规矩:当前体量 ÷ 0.75 向上取百位),PR 里说明为什么\n` +
          `     ❌ 不要为腾位置删掉一条**既有事实** —— 那是这道守护最不想造成的结果\n`,
      );
    }
  }
  if (failed) {
    process.stderr.write('✗ 恒读层超预算:瘦身或(经拍板)调预算,不得静默放行\n');
    process.exit(1);
  }
  process.stdout.write('✓ readtax 守护通过\n');
}

main();

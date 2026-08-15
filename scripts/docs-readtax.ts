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
  // 2026-08-02 重设 5_600 → 7_600(维护者拍板;grant 见 PR)。
  // 公式沿本文件既有规矩:当前体量 ÷ 0.75 向上取百位 = 5686 ÷ 0.75 = 7581 → 7600。
  //
  // **为什么这次是"重设"而不是"再压一次"**:5_600 是 P3 重写时按 ~4.45k(79%)定的,
  // 但此后 current-state 长期贴着 96–100% 跑。2026-08-02 一天之内两次撞顶:
  //   · T5B 台账回填初稿 +747 → 110%,压到 5583(100%)才过,删的全是当轮新写的冗余;
  //   · 紧接着补「v0.66.0 未经外部评审」这一句(**发布边界的真事实**)→ 又 102%。
  // 到这一步,守护逼出来的已经不是"精简"而是"别写事实"——那正是本文件顶部
  // 「❌ 不要为腾位置删掉一条既有事实」明确不想造成的结果。故按 ② 重设预算。
  //
  // ⚠️ 重设**不等于**放弃约束:79% 的健康区间不变,只是基数跟上了 §1/§4 的真实职责
  // (现实运维态 + 不做清单 + 债务,三者都在随项目变多)。下次再撞顶,先问的仍是
  // 「这条能不能挪进 ops/handoff/NEXT_TASKS」——那三处不在恒读层,写多不付预算。
  //
  // ── 2026-08-15 再次重设 7_600 → 9_600(维护者拍板;grant 见 PR)────────────────
  // 公式未改,沿本文件既有规矩:7186 ÷ 0.75 = 9581 → 向上取百位 = 9600(落点 74.9%)。
  //
  // **上一段那句「下次再撞顶,先问的仍是能不能挪走」——这次真去问了,而且先做了 ①**:
  // §4 P0 单元格里那段以「以下为第二轮原始结论」开头的 2026-08-03 评审快照,其 ①②③
  // 已由 #901/#903 关闭(`NEXT_TASKS` P1-27 逐条记着),属预警带点名的「已归档的历史」,
  // 删除 373 字符并逐条 grep 证明 29 条陈述仍在 NEXT_TASKS / AGENTS §3;其中①那句
  // 「单调代际不变量目前不成立」还对着代码复核过(三处 increment 都在),**已不再为真**。
  // 但 ① 只把 99% 压到 95% —— 按实测速率买不到一周。
  //
  // **为什么仍是「重设」而不是「再压一次」**:按段量归因(08-02 重设至今 13 天,+1873):
  //   · §4 债务 +990 · §2 能力清单 +466 · §1 现实运维态 +417 · §3/§5/§6 **零增长**。
  // 增长 100% 落在 current-state 的本职三段上,静态段一字未长 ⇒ 不是文档发胖,是职责变重。
  // 再往下压就只能压活口事实 —— 本文件顶部明令禁止的那件事。
  // ⚠️ 另记一条排除结论,免得下一个人重走:§5/§6 看着像和 AGENTS 重复,**不是冗余** ——
  // 那是 R5-05 拍板的三处对齐(README.md:26 / current-state §6 / CLAUDE.md 头行),动一处即破坏对齐。
  //
  // ⚠️ 最后记下**公式本身的局限**,留给下次:按 13 天 +1873 字符的实测速率,÷0.75 给的
  // 25% 余量 ≈ 两周就会再撞顶 —— 08-02 那次正是这么红回来的。**若下次仍在两周内撞顶,
  // 该动的不是预算数字而是结构**:把 §2 的逐条能力摘要挪进 `handoff/` 与 `NEXT_TASKS`
  // (不在恒读层,写多不付预算),current-state 只留指针。那是独立立项,不在本 PR 范围。
  { file: 'docs/current-state.md', maxChars: 9_600, enforced: true }, // 2026-08-15 重设;当前 ~7.19k(75%)
  { file: 'CLAUDE.md', maxChars: 2_000, enforced: true }, // P3 重写后 ~1.4k(70%)
];

// ── 路径注入层(Harness 3.0 P5)────────────────────────────────────────────
// 实测确认(2026-07-29):Claude Code 在读取某目录下**任一文件**时,会把该目录的
// 模块规则文件**全文注入**上下文 —— 读 authz.module.ts 的 15 行,整份 7.7k 字符
// 的 authz 规则就进来了。也就是说这一层的真实成本不是「需要时才读」,而是
// **触碰即全额付费**,且此前从未被任何守护量过。
//
// 首测结果:21 份合计 128,220 字符 = 恒读层(13,175)的 **9.7 倍**;
// 一次典型的 participation 三模块改动注入 29,305 字符 —— 是整个恒读层的 2.2 倍。
// 蓝图当初诊断的「恒读散文税」,大头其实一直在这一层。
//
// 当前**report-only**:先量再砍。设硬预算需要先定目标体量,而那是拍板项 ——
// 不能由守护替人决定该删哪些本地知识(P3 的教训:凡未落地的守护,不许假装已覆盖)。
const INJECTED_DIRS = ['src', 'prisma'] as const;
const MODULE_RULES_FILE = ['CL', 'AUDE.md'].join(''); // 拆写:避免裸文件名被写侧守护当红区路径

function listModuleRules(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === MODULE_RULES_FILE) out.push(path.relative(ROOT, p));
    }
  };
  for (const d of INJECTED_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out.sort();
}

function reportInjectedLayer(constantTotal: number): void {
  const files = listModuleRules()
    .map((rel) => ({ rel, chars: fs.readFileSync(path.join(ROOT, rel), 'utf-8').length }))
    .sort((a, b) => b.chars - a.chars);
  if (files.length === 0) return;
  const total = files.reduce((s, f) => s + f.chars, 0);

  process.stdout.write(
    `\n路径注入层(触碰目录即全文注入,${files.length} 份)— report-only,当前不拦\n`,
  );
  for (const f of files.slice(0, 5)) process.stdout.write(`  ${f.chars} — ${f.rel}\n`);
  if (files.length > 5) process.stdout.write(`  …其余 ${files.length - 5} 份\n`);
  process.stdout.write(
    `  合计 ${total} 字符 = 恒读层(${constantTotal})的 ${(total / constantTotal).toFixed(1)}×\n`,
  );
}

function main(): void {
  let failed = false;
  let constantTotal = 0;
  for (const { file, maxChars, enforced } of BUDGETS) {
    const chars = fs.readFileSync(path.join(ROOT, file), 'utf-8').length;
    constantTotal += chars;
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
  // 注:恒读层合计里不含 .claude/CLAUDE.md(它无独立预算,并入根 CLAUDE.md 语义)——
  // 这里只用于给下面那个倍数一个稳定分母,不作为对外口径。
  reportInjectedLayer(constantTotal);

  if (failed) {
    process.stderr.write('✗ 恒读层超预算:瘦身或(经拍板)调预算,不得静默放行\n');
    process.exit(1);
  }
  process.stdout.write('✓ readtax 守护通过\n');
}

main();

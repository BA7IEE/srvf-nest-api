#!/usr/bin/env node
// ============================================================================
// redzone-trusted-judge.mjs —— **base 分支上的**红区裁判(Harness 3.0 F3)
//
// ⚠️⚠️ 本文件由 redzone-trusted.yml 在 `pull_request_target` 下执行,能看到仓库
//      secrets。它**永远只在 base 分支的版本上运行**,PR 改不动它。
//      三条禁令(与 workflow 顶部逐条对应,自测锁死):
//        ① 不 checkout PR 代码  ② 不安装 PR 依赖  ③ 不执行 PR 内任何脚本
//      本文件只用 Node 内置能力 + runner 自带的 `gh`,**不 require 任何
//      node_modules** —— 因为「装依赖」本身就是执行 PR 提供的 lifecycle script。
//
// 它解决的问题(2026-07-29 跨模型评审 finding 2):
//   ci.yml 里的 `Diff guards` 走 actions/checkout(PR 合并引用)→ pnpm install
//   (PR 的锁文件)→ tsx scripts/check-redzone.ts(**PR 自己提供的裁判**)。
//   PR 只要让 main() 输出 touched=false,红区审批就被跳过;而 judge() 不动,
//   parity 自测照样全绿。自考自评的门,不是门。
//
// 本裁判的三个不变式:
//   · 判据(harness/redzone.json)来自 base —— PR 删条目不影响本次裁决
//   · 变更清单来自 GitHub API —— 不信任 PR 的 git 历史
//   · 任何异常一律 fail-closed(要求审批),「查不出来」永远不等于「没触碰」
// ============================================================================

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 无法完成判定时的统一出口:要求审批 + 非零退出,绝不静默放行。 */
function failClosed(reason) {
  console.error(`✗ 裁判无法完成判定:${reason}`);
  console.error('  按 INC-07 的教训,「无法验证」不等于「通过」—— 本次强制要求维护者审批。');
  emit('required', 'true');
  process.exit(1);
}

function emit(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${value}\n`);
}

// ── ① 无条件要求审批的清单:**硬编码**,不从 redzone.json 读 ──────────────────
// 理由:这几条是「裁判自身 + 判据本身 + CI 配置」。即使某次 registry 被读坏、
// 被清空、或将来有人把条目挪走,碰这几个路径也必须惊动维护者。
export const ALWAYS_REQUIRE_APPROVAL = [
  '.github/workflows/**', // 含本裁判与 redzone-trusted.yml 自身
  'harness/redzone.json',
  'harness/incidents.json',
];

/** 把 registry 摊平成带 kind 的条目表(纯函数,供自测复用)。 */
export function flattenRegistry(reg) {
  return [
    ...reg.redzone.map((e) => ({ ...e, kind: 'redzone' })),
    ...reg.selfGuard.map((e) => ({ ...e, kind: 'selfGuard' })),
  ];
}

/**
 * 单条路径的裁决(纯函数)。
 *
 * path.matchesGlob 是 Node 22.5+ 的内置能力。选它而不是 minimatch,是因为本裁判
 * **不允许装依赖** —— 而 glob 语义又必须与仓内其它消费者逐字一致(否则又变成
 * 「两把刻错的尺子」)。一致性由 harness-guards.selftest 的期望值表逐条钉死。
 */
export function judgePath(rel, added, entries) {
  for (const g of ALWAYS_REQUIRE_APPROVAL) {
    if (path.matchesGlob(rel, g)) {
      return { kind: 'always', id: 'always-require-approval', why: '裁判自身 / 红区判据 / CI 配置' };
    }
  }
  for (const e of entries) {
    for (const g of e.globs) {
      if (path.matchesGlob(rel, g)) {
        if (e.allowCreate === true && added) return null;
        return { kind: e.kind, id: e.id, why: e.why };
      }
    }
  }
  return null;
}

/**
 * 对 API 返回的文件清单逐条裁决(纯函数,自测直接喂合成清单)。
 *
 * rename:**新旧两条路径都判**。只判新路径的话,
 * `git mv 受保护文件 非保护路径` 就能把文件挪出保护区而不触发审批
 * (2026-07-29 跨模型评审 finding 4)。
 */
export function collectHits(files, entries) {
  const hits = [];
  for (const f of files) {
    const candidates = [{ rel: f.filename, added: f.status === 'added' }];
    if (f.previous_filename) candidates.push({ rel: f.previous_filename, added: false });
    for (const c of candidates) {
      const hit = judgePath(c.rel, c.added, entries);
      if (hit) hits.push({ ...hit, file: c.rel, status: f.status });
    }
  }
  return hits;
}

function main() {
  if (typeof path.matchesGlob !== 'function') {
    failClosed(
      `当前 Node(${process.version})没有 path.matchesGlob —— 需要 ≥22.5。` +
        'workflow 里的 setup-node 步骤被改坏了?',
    );
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!repo || !prNumber) failClosed('缺少 GITHUB_REPOSITORY / PR_NUMBER 环境变量');

  const gh = (args) => {
    try {
      return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      failClosed(`gh api 调用失败:${String(err)}`);
    }
  };

  // ── ② 判据:base 分支上的 redzone.json ────────────────────────────────────
  let entries;
  try {
    entries = flattenRegistry(JSON.parse(readFileSync('harness/redzone.json', 'utf-8')));
  } catch (err) {
    failClosed(`读不出 base 分支的 harness/redzone.json:${String(err)}`);
  }

  // ── ③ 变更清单:GitHub API,必须翻页,不接受静默截断 ──────────────────────
  const meta = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}`]));
  const expectedCount = meta.changed_files;

  // `--jq '.[] | @json'` 让每个元素独占一行的紧凑 JSON:文件名里的空格 / 中文 /
  // 引号 / 甚至换行都被 JSON 转义,不会破坏逐行解析(本仓有中文文件名)。
  const raw = gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${prNumber}/files`,
    '--jq',
    '.[] | @json',
  ]);
  const files = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  // GitHub 的 pulls/files 端点最多返回 3000 个文件,超出**静默截断**。
  // 拿 PR 元数据里的 changed_files 对账:少一个都不接受。
  if (files.length !== expectedCount) {
    failClosed(
      `变更清单不完整:API 返回 ${files.length} 个文件,PR 元数据称有 ${expectedCount} 个。` +
        '(GitHub 的 pulls/files 端点上限 3000,超出会静默截断)',
    );
  }

  const hits = collectHits(files, entries);

  // ── ④ 报告 ───────────────────────────────────────────────────────────────
  console.log(`裁判:base=${meta.base.ref} · PR #${prNumber} · 变更 ${files.length} 个文件`);
  console.log('(判据与本脚本均取自 base 分支;未 checkout PR 代码、未安装 PR 依赖)\n');

  if (hits.length === 0) {
    console.log('✓ 未触碰红区或执法层');
    emit('required', 'false');
    return;
  }

  console.log(`⚠️ 触碰受保护路径 ${hits.length} 处 —— 需要维护者审批\n`);
  for (const h of hits) {
    const brief = h.why.length > 110 ? `${h.why.slice(0, 110)}…` : h.why;
    console.log(`  ${h.file}  [${h.status}]`);
    console.log(`    命中 ${h.id} — ${brief}`);
    console.log(`::warning file=${h.file}::受保护路径(${h.id}):${brief}`);
  }
  emit('required', 'true');
  emit('count', String(hits.length));
}

// 只在被直接执行时跑主流程;被 import 时只暴露纯函数(自测据此喂合成清单)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

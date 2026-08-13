#!/usr/bin/env node
// ============================================================================
// contract-trusted-judge.mjs —— R11 契约语义门的 **base-trusted** 接线(Phase 5 刀 5-2)
//
// ⚠️⚠️ 与 redzone / authz 两个裁判同处一个 `pull_request_target` job,受同样的三条禁令
//      (① 不 checkout PR 代码 ② 不装 PR 依赖 ③ 不执行 PR 内脚本),由
//      scripts/harness-guards.selftest.ts 的 F3 组逐条锁死(剥注释后判)。
//
// 本文件同样**只有管道、没有语义**:breaking 判定表在
// scripts/contract-semantic-diff.ts,这里只负责取件、落盘、用 base 版比较器判、翻译结论。
// 两级结构与 R14 逐字相同:申报完整性是硬闸(审批盖不掉)、Environment 审批是第二道闸。
//
// ── 为什么契约不能走 contents API(与 authz 裁判的关键差异)──────────────────
// docs/handoff/openapi.json 约 3.8MB。GitHub **contents** API 对超过 1MB 的文件返回
// 空 content —— authz 裁判里那句「判据文件不该有这么大」对 manifest 成立,对契约不成立。
// 所以这里改用变更清单里 API **自己给出的** `raw_url`(同样不是自己拼的 URL,fork PR 的
// head 仓库不同这一条依然成立)。取回的内容**只 JSON.parse,永不 import、永不执行**。
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT = 'docs/handoff/openapi.json';
const COMPARATOR = 'scripts/contract-semantic-diff.ts';
const FRAGMENT_PREFIX = 'changelog.d/';
const OUTPUT_KEY = 'contractRequired';

function emit(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${value}\n`);
}

function failClosed(reason) {
  console.error(`✗ 契约语义裁判无法完成判定:${reason}`);
  console.error('  「无法验证」不等于「通过」—— 本次强制要求维护者审批。');
  emit(OUTPUT_KEY, 'true');
  process.exit(1);
}

function failHard(title, lines) {
  console.error(`✗ ${title}`);
  for (const l of lines) console.error(`  ${l}`);
  console.error(`::error::${title}`);
  emit(OUTPUT_KEY, 'true');
  process.exit(1);
}

export function supportsTypeStripping(version) {
  const m = /^v(\d+)\.(\d+)\./.exec(version);
  if (!m) return false;
  return Number(m[1]) > 22 || (Number(m[1]) === 22 && Number(m[2]) >= 6);
}

/** 挑出需要取 head 版本的文件(纯函数,自测可直接喂合成清单)。 */
export function planFetch(files) {
  const touched = files.find((f) => f.filename === CONTRACT);
  const movedAway = files.find((f) => f.previous_filename === CONTRACT && f.filename !== CONTRACT);
  return {
    contractTouched: touched ?? null,
    contractMovedAway: movedAway ?? null,
    contractRemoved: touched?.status === 'removed',
    fragments: files.filter(
      (f) =>
        f.status !== 'removed' &&
        f.filename.startsWith(FRAGMENT_PREFIX) &&
        f.filename.endsWith('.md') &&
        !f.filename.endsWith('README.md'),
    ),
  };
}

function main() {
  if (!supportsTypeStripping(process.version)) {
    failClosed(`当前 Node(${process.version})不支持 --experimental-strip-types —— 需要 ≥22.6`);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!repo || !prNumber) failClosed('缺少 GITHUB_REPOSITORY / PR_NUMBER 环境变量');

  const gh = (args) => {
    try {
      return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      failClosed(`gh api 调用失败:${String(err)}`);
    }
  };

  const meta = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}`]));
  const files = gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${prNumber}/files`,
    '--jq',
    '.[] | @json',
  ])
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  const expectedCount = meta.changed_files;
  if (files.length !== expectedCount) {
    failClosed(
      `变更清单不完整:API 返回 ${files.length} 个文件,PR 元数据称有 ${expectedCount} 个。`,
    );
  }

  const plan = planFetch(files);
  if (plan.contractMovedAway) {
    failClosed(`${CONTRACT} 被改名到 ${plan.contractMovedAway.filename} —— 比对对象消失`);
  }
  if (plan.contractRemoved) {
    failClosed(`${CONTRACT} 在本 PR 中被删除 —— 比对对象消失,不能当成「契约没变」`);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'contract-trusted-'));

  /** 大文件走 raw_url(API 给的),小文件走 contents_url —— 两者都不是自己拼的。 */
  const headTextOf = (entry) => {
    const rawUrl = entry.raw_url;
    if (typeof rawUrl === 'string' && rawUrl !== '') {
      try {
        return execFileSync('gh', ['api', '--method', 'GET', rawUrl], {
          encoding: 'utf-8',
          maxBuffer: 256 * 1024 * 1024,
        });
      } catch {
        // 落到 contents_url 再试一次;两条都取不到才 fail-closed。
      }
    }
    const url = entry.contents_url;
    if (typeof url !== 'string' || url === '') {
      failClosed(`变更清单里 ${entry.filename} 既无 raw_url 也无 contents_url`);
    }
    let payload;
    try {
      payload = JSON.parse(gh(['api', url]));
    } catch (err) {
      failClosed(`取 head 的 ${entry.filename} 失败:${String(err)}`);
    }
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string' || payload.content === '') {
      failClosed(
        `head 的 ${entry.filename} 内容取不到(encoding=${String(payload.encoding)});` +
          'contents API 对 >1MB 文件返回空 content,而 raw_url 那条路也失败了',
      );
    }
    return Buffer.from(payload.content, 'base64').toString('utf-8');
  };

  let headContractPath = CONTRACT; // 未改动 ⇒ head == base
  let source = '未改动(HEAD == BASE)';
  if (plan.contractTouched) {
    headContractPath = path.join(workDir, 'head-openapi.json');
    const text = headTextOf(plan.contractTouched);
    try {
      JSON.parse(text); // 只 parse 做完整性确认,绝不 import / 执行
    } catch (err) {
      failClosed(`head 的 ${CONTRACT} 不是合法 JSON(可能被截断):${String(err)}`);
    }
    writeFileSync(headContractPath, text, 'utf-8');
    source = `head@${String(meta.head?.sha ?? '?').slice(0, 8)}(${text.length} 字节)`;
  }

  const fragmentArgs = [];
  for (const fragment of plan.fragments) {
    const dest = path.join(workDir, fragment.filename.replace(/[/\\]/g, '__'));
    writeFileSync(dest, headTextOf(fragment), 'utf-8');
    fragmentArgs.push('--fragment-file', dest);
  }

  console.log(`契约语义裁判:base=${meta.base.ref} · PR #${prNumber}`);
  console.log(`  契约来源:${source}`);
  console.log(`  本 PR 改动的 changelog fragment:${plan.fragments.length} 份`);
  console.log('  (比较器取自 base checkout;未装依赖、未执行 PR 内脚本)\n');

  const jsonPath = path.join(workDir, 'verdict.json');
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      COMPARATOR,
      '--base-contract',
      CONTRACT,
      '--head-contract',
      headContractPath,
      '--json',
      jsonPath,
      ...fragmentArgs,
    ],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.stdout) console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  if (run.error) failClosed(`比较器无法启动:${String(run.error)}`);

  let verdict;
  try {
    verdict = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch (err) {
    failClosed(`比较器未产出可读裁决(exit=${run.status}):${String(err)}`);
  }

  if (verdict.blocking === true) {
    failHard('契约语义门:存在破坏性契约变更却没有完整申报', [
      '判据:docs/handoff/openapi.json 的 base↔head 语义分类(判定表见 scripts/contract-semantic-diff.ts 头注)',
      ...verdict.problems.map((p) => `    [${p.rule}] ${p.location} — ${p.fact}`),
      '',
      '处置:在 changelog.d/ 的 fragment 里补 contract-breaking 申报块',
      '(operation / reason / impact / migration / rollback 五行)。',
      '',
      '⚠️ rollback 填的是**真回滚手段**(revert / feature gate / 兼容层)——',
      '   changelog 文件本身不是回滚,也不构成批准(DECISIONS 第 10 条)。',
      '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
    ]);
  }
  if (verdict.approvalRequired === true) {
    console.log('⚠️ 本 PR 含破坏性契约变更,申报已齐全 —— 需要维护者在 harness-review 环境点批');
    console.log('::warning::契约发生破坏性变更,需维护者审批');
    emit(OUTPUT_KEY, 'true');
    return;
  }
  if (verdict.approvalRequired === false) {
    console.log('✓ 无破坏性契约变更(additive 变更已列在上方报告里)');
    emit(OUTPUT_KEY, 'false');
    return;
  }
  failClosed(`比较器给出的 approvalRequired 不是布尔值:${String(verdict.approvalRequired)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

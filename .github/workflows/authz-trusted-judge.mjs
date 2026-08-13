#!/usr/bin/env node
// ============================================================================
// authz-trusted-judge.mjs —— R14 授权语义门的 **base-trusted** 接线(架构治理 Phase 5)
//
// ⚠️⚠️ 与 redzone-trusted-judge.mjs 同处一个 `pull_request_target` job,受同样的
//      三条禁令约束(① 不 checkout PR 代码 ② 不装 PR 依赖 ③ 不执行 PR 内脚本),
//      由 scripts/harness-guards.selftest.ts 的 F3 组逐条锁死(剥注释后判)。
//
// ── 本文件只有「管道」,没有「语义」──────────────────────────────────────────
// 判定 EQUIVALENT / NARROWER / BROADER / INCOMPARABLE 的那套规则**不在这里**,
// 在 scripts/authz-semantic-diff.ts。本文件只做四件搬运工的事:
//   ① 从 GitHub API 取 head 的 ROUTE_AUTHZ manifest 与本 PR 改动的 changelog fragment
//   ② 落到临时文件(**只写盘、只解码,永不执行、永不 import**)
//   ③ 用 **base checkout 里的**比较器去判(node --experimental-strip-types,零依赖)
//   ④ 把结论翻译成 job output 与退出码
//
// 为什么不在这里再写一份比较器:那就有了两份语义,而 `parity≠correctness` 是本仓
// 已记录的教训 —— 两把尺子迟早刻得不一样,而且是**沉默地**不一样。比较器写成
// 「tsx 与裸 node 都能跑」正是为了让这个 job 能直接用同一份判据。
//
// 为什么 graph / rbac-map 也取自 base:它们是判据的一部分。PR 若能顺手往
// harness/authz-implication-graph.json 里加一条 `A ⇒ B`,就能把自己的换码洗成
// 「收紧」。取 base 版 ⇒ PR 改不动裁判的判据。(改那个文件本身受 harness/** 红区
// 保护,会被 redzone 裁判要求审批 —— 双重。)
//
// 两种失败语义,出口不同:
//   · failClosed —— 查不出来(API 挂了 / 取不到 head 内容)⇒ 要求审批 + 非零退出
//   · failHard   —— 查清楚了且违规(降级但没申报)⇒ 非零退出,**审批盖不掉**
//     (scan 失败 ⇒ approval job 被 skip ⇒ 根本没有可点的按钮,与棘轮硬闸同构)
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'docs/ai-harness/ROUTE_AUTHZ.md';
const COMPARATOR = 'scripts/authz-semantic-diff.ts';
const GRAPH = 'harness/authz-implication-graph.json';
const RBAC_MAP = 'docs/ai-harness/RBAC_MAP.md';
const FRAGMENT_PREFIX = 'changelog.d/';
const OUTPUT_KEY = 'authzRequired';

function emit(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${value}\n`);
}

/** 查不出来 ⇒ 要求审批。「无法验证」永远不等于「通过」(INC-07)。 */
function failClosed(reason) {
  console.error(`✗ 授权语义裁判无法完成判定:${reason}`);
  console.error('  「无法验证」不等于「通过」—— 本次强制要求维护者审批。');
  emit(OUTPUT_KEY, 'true');
  process.exit(1);
}

/** 已查清且违规 ⇒ 硬失败。scan 失败会让 approval job 被跳过,点头也盖不掉。 */
function failHard(title, lines) {
  console.error(`✗ ${title}`);
  for (const l of lines) console.error(`  ${l}`);
  console.error(`::error::${title}`);
  emit(OUTPUT_KEY, 'true');
  process.exit(1);
}

/**
 * `node --experimental-strip-types` 需要 Node ≥ 22.6。
 * 显式检查而不是等它抛 SyntaxError —— 后者会被读成「比较器坏了」而不是「运行时太老」。
 */
export function supportsTypeStripping(version) {
  const m = /^v(\d+)\.(\d+)\./.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || (major === 22 && minor >= 6);
}

/**
 * 从变更清单里挑出需要取 head 版本的文件(纯函数,自测直接喂合成清单)。
 *
 * · manifest 被删 / 改名走away ⇒ 调用方 failClosed:它是本门的比对对象,
 *   「消失了」不能当成「没变化」。
 * · manifest 未被改动 ⇒ head == base,直接用 base checkout 的那份,少跑一次 API。
 * · fragment 只取本 PR 动过的(changelog.d 在发版前会攒历史 fragment,
 *   全目录去判会把上一刀的申报在这一刀变成「落空申报」的假红)。
 */
export function planFetch(files) {
  const manifestTouched = files.find((f) => f.filename === MANIFEST);
  const manifestMovedAway = files.find(
    (f) => f.previous_filename === MANIFEST && f.filename !== MANIFEST,
  );
  const fragments = files.filter(
    (f) =>
      f.status !== 'removed' &&
      f.filename.startsWith(FRAGMENT_PREFIX) &&
      f.filename.endsWith('.md') &&
      !f.filename.endsWith('README.md'),
  );
  return {
    manifestTouched: manifestTouched ?? null,
    manifestMovedAway: manifestMovedAway ?? null,
    manifestRemoved: manifestTouched?.status === 'removed',
    fragments,
  };
}

function main() {
  if (!supportsTypeStripping(process.version)) {
    failClosed(
      `当前 Node(${process.version})不支持 --experimental-strip-types —— 需要 ≥22.6。` +
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

  const meta = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}`]));
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
  const expectedCount = meta.changed_files;
  // pulls/files 上限 3000 且**静默**截断 —— 不对账就会在超大 PR 上漏判。
  if (files.length !== expectedCount) {
    failClosed(
      `变更清单不完整:API 返回 ${files.length} 个文件,PR 元数据称有 ${expectedCount} 个。`,
    );
  }

  const plan = planFetch(files);
  if (plan.manifestMovedAway) {
    failClosed(`${MANIFEST} 在本 PR 中被改名到 ${plan.manifestMovedAway.filename} —— 比对对象消失`);
  }
  if (plan.manifestRemoved) {
    failClosed(`${MANIFEST} 在本 PR 中被删除 —— 比对对象消失,不能当成「没有语义变化」`);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'authz-trusted-'));

  /**
   * 取一个文件在 head 上的全文。
   *
   * 用 API **自己给出的** contents_url,不自己拼 —— fork PR 的 head 仓库不同,
   * 拼错就会取到 base 的内容,判据静默变成「自己和自己比」,永远通过。
   * 拿到的内容**只做 base64 解码 + 写盘**,绝不 import、绝不执行。
   */
  const headTextOf = (entry) => {
    const url = entry.contents_url;
    if (typeof url !== 'string' || url === '') {
      failClosed(`变更清单里 ${entry.filename} 没有 contents_url,取不到 head 版本`);
    }
    let payload;
    try {
      payload = JSON.parse(gh(['api', url]));
    } catch (err) {
      failClosed(`取 head 的 ${entry.filename} 失败:${String(err)}`);
    }
    if (
      payload.encoding !== 'base64' ||
      typeof payload.content !== 'string' ||
      payload.content === ''
    ) {
      failClosed(
        `head 的 ${entry.filename} 内容取不到(encoding=${String(payload.encoding)})。` +
          'GitHub contents API 对超过 1MB 的文件返回空 content。',
      );
    }
    return Buffer.from(payload.content, 'base64').toString('utf-8');
  };

  let headManifestPath = MANIFEST; // 未改动 ⇒ head == base,直接用 base checkout 的那份
  let manifestSource = '未改动(HEAD == BASE)';
  if (plan.manifestTouched) {
    headManifestPath = path.join(workDir, 'head-ROUTE_AUTHZ.md');
    writeFileSync(headManifestPath, headTextOf(plan.manifestTouched), 'utf-8');
    manifestSource = `head@${String(meta.head?.sha ?? '?').slice(0, 8)}`;
  }

  const fragmentArgs = [];
  for (const fragment of plan.fragments) {
    const dest = path.join(workDir, fragment.filename.replace(/[/\\]/g, '__'));
    writeFileSync(dest, headTextOf(fragment), 'utf-8');
    fragmentArgs.push('--fragment-file', dest);
  }

  console.log(`授权语义裁判:base=${meta.base.ref} · PR #${prNumber}`);
  console.log(`  manifest 来源:${manifestSource}`);
  console.log(`  本 PR 改动的 changelog fragment:${plan.fragments.length} 份`);
  console.log('  (比较器、蕴含图、权限码全集**均取自 base checkout**;未装依赖、未执行 PR 内脚本)\n');

  const jsonPath = path.join(workDir, 'verdict.json');
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      COMPARATOR,
      '--base-manifest',
      MANIFEST,
      '--head-manifest',
      headManifestPath,
      '--graph',
      GRAPH,
      '--rbac-map',
      RBAC_MAP,
      '--json',
      jsonPath,
      ...fragmentArgs,
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.stdout) console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  if (run.error) failClosed(`比较器无法启动:${String(run.error)}`);

  let verdict;
  try {
    verdict = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch (err) {
    // 比较器非零退出**且**没写出 JSON ⇒ 它自己炸了(解析失败 / schema 不匹配),
    // 那是「查不出来」,不是「没有降级」。
    failClosed(`比较器未产出可读裁决(exit=${run.status}):${String(err)}`);
  }

  if (verdict.blocking === true) {
    failHard('授权语义门:存在降级 / 不可比端点却没有完整申报', [
      '判据:ROUTE_AUTHZ manifest 的 base↔head 四态比对(规则见 scripts/authz-semantic-diff.ts 头注)',
      ...verdict.findings.map((f) => `    [${f.rule}] ${f.location} — ${f.fact}`),
      '',
      '处置:在 changelog.d/ 的 fragment 里补 authz-downgrade 申报块',
      '(route / reason / impact / migration 四行,route 须与 manifest 的 routeKey 逐字一致)。',
      '',
      '⚠️ 申报只是**记录载体,不构成批准**(DECISIONS 第 10 条)—— 补齐申报之后,',
      '   仍必须由维护者在 harness-review 环境点批。',
      '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
    ]);
  }

  if (verdict.approvalRequired === true) {
    console.log('⚠️ 本 PR 含授权降级 / 不可比端点,申报已齐全 —— 需要维护者在 harness-review 环境点批');
    console.log('::warning::授权保护等级发生降级或不可比变更,需维护者审批');
    emit(OUTPUT_KEY, 'true');
    return;
  }
  if (verdict.approvalRequired === false) {
    console.log('✓ 无授权降级 / 不可比端点(收紧与新增已列在上方全量迁移清单里)');
    emit(OUTPUT_KEY, 'false');
    return;
  }
  failClosed(`比较器给出的 approvalRequired 不是布尔值:${String(verdict.approvalRequired)}`);
}

// 只在被直接执行时跑主流程;被 import 时只暴露纯函数(自测据此喂合成清单)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

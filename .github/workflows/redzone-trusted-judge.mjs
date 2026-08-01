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

/**
 * **已经查清楚了,而且它是违规** —— 与 failClosed(查不出来)语义不同,出口相同。
 *
 * 为什么同样 exit 1 就够、不必改 workflow:redzone-trusted.yml 的 verdict job
 * 第一句判的就是 `needs.scan.result != 'success'` → 直接 error 退出;而 approval job
 * `needs: scan`,scan 失败时它被 skip,**根本不存在可以点的审批按钮**。
 * 于是本出口天然独立于 harness-review 审批,点头也盖不掉 —— 这正是第五轮评审
 * L2 要求的「不可被审批覆盖的硬失败」。反过来说,改 workflow 会动到 required
 * context 名(改名 = 全仓 PR 永久卡死),不动才是对的。
 */
function failHard(title, lines) {
  console.error(`✗ ${title}`);
  for (const l of lines) console.error(`  ${l}`);
  console.error(`::error::${title}`);
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
  'harness/ratchet-registry.json', // 「有哪些棘轮」的唯一真相源,与 redzone.json 同级
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

// ── 棘轮单调性:**全部**基线只减不增(第五轮 J2·L2 起;M4 2026-08-01 改注册表驱动)──
//
// 它补的是前两道执行位都拦不住的那一种绕过:
//   `pnpm lint` 读的是 **PR 自己的**基线,`harness:selftest` 也是。
//   于是「新增一个违规字段 + 同一个 PR 里顺手把它加进基线」两边都全绿 ——
//   棘轮只在「不改基线」的前提下成立,而基线本身是 PR 可以改的。
//   「A 换 B」(修好一条、加进一条,**总数不变**)同理:任何看总数的判据都看不见。
//
// 唯一能判的位置是**站在 base 上**比较 base 与 head 两份清单。本裁判正好是
// 全仓唯一一个「代码取自 base、只读 PR 数据」的执行体,所以判据落在这里。
//
// 判据按 **(file, symbol) 集合**判,不看总数:HEAD ⊆ BASE。可删、不可增、不可 A 换 B。
//
// ⚠️ 接受的代价(写在明处,不留软路径):
//    一次**合法的 revert**,如果把之前删掉的基线行重新加回来,会被本条硬拦。
//    那种场景维护者必须临时授权改本裁判自身 —— 双重人闸,刻意昂贵。
//    之所以不给「特殊情况放行」的开关:任何这样的开关都会成为绕过本条的入口,
//    而本条要防的正是「PR 自己给自己发许可」。宁可让罕见的合法操作变贵。
//
// ⚠️ M4 的三条改动,每一条都对应一个此前**真实存在**的绕过:
//   ① **不再硬编码单一路径**。上一版把「那一份基线」的路径写死在本文件里,于是
//      第二条棘轮(存量裸 `@Param('id')`)一落地就天然不在裁决范围内 —— 判据只
//      覆盖了当初写它的那一条。现在遍历 harness/ratchet-registry.json。
//   ② **删掉 / 改名基线 = 硬失败**。上一版把「head 没有这份文件」判成
//      「HEAD = ∅ ⊆ BASE,成立」,理由是「lint 侧加载会失败」。但 lint 跑在 PR
//      自己的树上,同一个 PR 完全可以顺手改掉加载它的地方 —— 于是「删掉判据」
//      与「判据通过」在门禁看来一模一样。清零也必须留一个 entries: [] 的空 JSON。
//   ③ **注册表自身只可增不可删**。否则「先把自己从注册表摘掉,再随便改基线」
//      是一条完整的绕过路径 —— 判据的判据同样得有人看。
//
// ⚠️ R1(2026-08-01 整批评审 ①)又补两条,各对应一条 M4 之后**仍然存在**的绕过:
//   ④ **既有 id 的四元组逐字冻结**(baseline / rule / symbolShape)。M4 只冻结 id,
//      于是「同 id 换载体」全绿:新增一份洗过的 `<旧名>-v2.json`、把 baseline 指过去、
//      **旧文件一个字不动** —— 裁判读 base 注册表拿旧路径,旧路径没改动 ⇒ HEAD == BASE ⇒ 放行,
//      而 lint 侧读 head 注册表吃 v2。判据从此守着一份没人读的文件。
//      (改名有 ② 兜着,但**拷贝一份再改指向**不涉及 rename,②③ 都看不见。)
//   ⑤ **同一条 rule 的豁免并集只减不增**。④ 明确允许新增全新 id —— 必须允许,否则
//      以后没人能再落地新棘轮。但那条合法通道自己能洗豁免:新增一条 id、rule 写成
//      既有的 `srvf/no-nullable-is-optional`、baseline 指向一份全新文件塞满新豁免。
//      ④ 管不到(新 id)、逐基线单调性也管不到(base 注册表里没有它,裁判不会去读),
//      而 lint 侧照样遍历 head 注册表生成豁免块。判据只好落在真正的受害者「rule」上。
const RATCHET_REGISTRY_REL_PATH = 'harness/ratchet-registry.json';

/**
 * 一条棘轮登记的**四元组**:id 是身份,其余三个是「这条棘轮实际由什么在执行」。
 *
 * 为什么必须是四元组而不只是 id(2026-08-01 整批评审 ①,主会话已复现):
 * 上一版只比 id,于是**同一个 id 换掉载体**完全合法 —— PR 新增一份
 * `harness/is-optional-null-baseline-v2.json`(洗过的副本、多几条豁免),
 * 把注册表那条的 `baseline` 指过去,**旧文件原样不动**。裁判读 base 注册表拿到旧路径,
 * 旧路径未改动 ⇒ HEAD == BASE ⇒ 全绿;而 eslint 侧读的是 head 注册表,吃的是 v2。
 * 判据守着一份**已经没人读**的文件。(改名会被「基线不得删除/改名」拦下,
 * 但**拷贝一份再改指向**不涉及 rename,上一版对它完全失明。)
 */
const RATCHET_IDENTITY_FIELDS = ['baseline', 'rule', 'symbolShape'];

/**
 * 解析注册表(**只 parse,永不执行** —— 正是当初把基线从 .mjs 抽成 JSON 的同一条理由)。
 *
 * @param {string} text
 * @param {string} which
 * @returns {Array<{ id: string, baseline: string, rule: string, symbolShape: string }>}
 */
export function parseRatchetRegistryDoc(text, which) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${which} 的 ${RATCHET_REGISTRY_REL_PATH} 不是合法 JSON:${String(err)}`);
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.ratchets)) {
    throw new Error(`${which} 的 ${RATCHET_REGISTRY_REL_PATH} 结构不对(缺 ratchets 数组)`);
  }
  const out = [];
  const seen = new Set();
  for (const r of doc.ratchets) {
    if (r === null || typeof r !== 'object' || typeof r.id !== 'string' || r.id === '') {
      throw new Error(`${which} 的 ${RATCHET_REGISTRY_REL_PATH} 有条目缺 id`);
    }
    for (const field of RATCHET_IDENTITY_FIELDS) {
      if (typeof r[field] !== 'string' || r[field] === '') {
        throw new Error(
          `${which} 的 ${RATCHET_REGISTRY_REL_PATH} 条目 ${r.id} 缺 ${field}` +
            '(四元组 id/baseline/rule/symbolShape 缺一不可 —— 缺了就没法判「载体有没有被换掉」)',
        );
      }
    }
    // 重复 id 会让「按 id 取那一条」变成「取到哪条看运气」,身份映射当场失去意义。
    if (seen.has(r.id)) {
      throw new Error(`${which} 的 ${RATCHET_REGISTRY_REL_PATH} 有重复 id:${r.id}`);
    }
    seen.add(r.id);
    out.push({ id: r.id, baseline: r.baseline, rule: r.rule, symbolShape: r.symbolShape });
  }
  return out;
}

/**
 * 注册表裁决(纯函数,自测直接喂两份文档)。两件事一起判:
 *
 *   ① **登记只可增不可删** —— 摘掉条目 = 「先把自己摘掉、再随便改基线」的完整绕过路径。
 *   ② **既有 id 的四元组逐字冻结** —— 同 id 换 `baseline` / `rule` / `symbolShape` 一律硬失败。
 *
 * 允许:新增全新 id。协议要迁移(比如给棘轮加第五个字段、或真要换载体)——
 * 只能改**本裁判自身**,那是红区 + 环境审批的双重人闸,刻意昂贵。
 *
 * @param {string} baseText
 * @param {string|null} headText head 上的注册表全文;null = PR 把它删了 / 改名了
 * @returns {{ ok: boolean, removed: string[], deleted: boolean,
 *            mutated: Array<{ id: string, field: string, base: string, head: string }> }}
 */
export function judgeRegistryMonotonicity(baseText, headText) {
  const base = parseRatchetRegistryDoc(baseText, 'base');
  if (headText === null) {
    return { ok: false, removed: base.map((r) => r.id), deleted: true, mutated: [] };
  }
  const head = new Map(parseRatchetRegistryDoc(headText, 'head').map((r) => [r.id, r]));
  const removed = [];
  const mutated = [];
  for (const b of base) {
    const h = head.get(b.id);
    if (!h) {
      removed.push(b.id);
      continue;
    }
    for (const field of RATCHET_IDENTITY_FIELDS) {
      if (h[field] !== b[field]) {
        mutated.push({ id: b.id, field, base: b[field], head: h[field] });
      }
    }
  }
  return { ok: removed.length === 0 && mutated.length === 0, removed, deleted: false, mutated };
}

/**
 * 「同一条 rule 的豁免**并集**只减不增」(R1 顺带关闭的平行绕过)。
 *
 * 为什么光冻结四元组还不够:上面明确**允许新增全新 id** —— 那是必须允许的,
 * 否则以后没人能再落地一条新棘轮(新棘轮天生带着一份存量债的基线)。
 * 但「新增 id」这条合法通道自己就能洗豁免:
 *
 *   新增 `{ id: "evil", baseline: "harness/evil.json", rule: "srvf/no-nullable-is-optional", … }`,
 *   evil.json 里塞几条**新**豁免。四元组冻结管不到它(它是新 id),
 *   逐基线单调性也管不到它(base 的注册表里没有这一条,裁判根本不会去看)。
 *   而 eslint 侧按 head 注册表**遍历**生成豁免块 —— 新豁免当场生效。
 *
 * 所以判据必须落在「rule」这个真正的受害者上,而不是落在「哪份文件」上:
 *   · base 注册表里出现过的每条 rule:head 侧该 rule 的豁免并集 ⊆ base 侧的并集;
 *   · base 里没出现过的 rule:**不设限** —— 那正是「落地一条全新棘轮」的合法形状,
 *     它冻结的是自己那条规则的存量债,不碰任何既有规则的豁免面。
 *
 * @param {Map<string, Set<string>>} baseUnions rule → base 侧全部基线键的并集
 * @param {Map<string, Set<string>>} headUnions rule → head 侧同名 rule 的并集
 * @returns {{ ok: boolean, added: Array<{ rule: string, key: string }> }}
 */
export function judgeRuleUnionMonotonicity(baseUnions, headUnions) {
  const added = [];
  for (const [rule, baseKeys] of baseUnions) {
    for (const key of headUnions.get(rule) ?? new Set()) {
      if (!baseKeys.has(key)) added.push({ rule, key: key.replace('\u0000', '  ') });
    }
  }
  added.sort((a, b) => (a.rule + a.key < b.rule + b.key ? -1 : 1));
  return { ok: added.length === 0, added };
}

/** 把基线文档摊平成 `file\u0000symbol` 的集合(**只 parse,永不执行**)。 */
export function baselineKeySet(text, which, relPath = '<baseline>') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${which} 的 ${relPath}不是合法 JSON:${String(err)}`);
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    throw new Error(`${which} 的 ${relPath}结构不对(缺 entries 数组)`);
  }
  const keys = new Set();
  for (const e of doc.entries) {
    if (e === null || typeof e !== 'object' || typeof e.file !== 'string' || typeof e.symbol !== 'string') {
      throw new Error(`${which} 的 ${relPath}有条目缺 file / symbol`);
    }
    keys.add(`${e.file}\u0000${e.symbol}`);
  }
  return keys;
}

/**
 * 单调性裁决(纯函数,自测直接喂两份合成文档)。
 *
 * ⚠️ `headText === null`(基线被删 / 被改名)**判失败**,不再判「HEAD = ∅ ⊆ BASE 成立」。
 * 上一版那么判的理由是「eslint 侧加载器读不到文件会抛,lint 当场红」—— 但 lint 跑在
 * **PR 自己的树**上,同一个 PR 完全可以顺手把加载它的那几行一起改掉。于是「删掉判据」
 * 与「判据通过」在门禁看来一模一样,而那正是本裁判存在的理由所反对的。
 * 真要清空,留一个 `{"version":1,"entries":[]}` 的空文件 —— 那是可见的、可 review 的零。
 *
 * @param {string} baseText base 分支上的基线全文
 * @param {string|null} headText PR head 上的基线全文;null = PR 把该文件删了 / 改名了
 * @param {string} [relPath] 出错时报给人看的路径
 * @returns {{ ok: boolean, added: string[], removedFile: boolean }}
 */
export function judgeBaselineMonotonicity(baseText, headText, relPath = '<baseline>') {
  const base = baselineKeySet(baseText, 'base', relPath);
  if (headText === null) {
    return { ok: false, added: [], removedFile: true };
  }
  const head = baselineKeySet(headText, 'head', relPath);
  const added = [...head]
    .filter((k) => !base.has(k))
    .map((k) => k.replace('\u0000', '  '))
    .sort();
  return { ok: added.length === 0, added, removedFile: false };
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

  // ── ④ 棘轮单调性:HEAD ⊆ BASE(**独立硬闸,审批盖不掉**)────────────────────
  console.log(`裁判:base=${meta.base.ref} · PR #${prNumber} · 变更 ${files.length} 个文件`);
  console.log('(判据与本脚本均取自 base 分支;未 checkout PR 代码、未安装 PR 依赖)\n');

  {
    /**
     * 取某个 base 路径在 **head** 上的全文。
     * 返回 `null` 表示 PR 把它删了 / 改名了 —— 调用方一律按硬失败处理。
     */
    const headTextOf = (relPath, baseText) => {
      const touched = files.find((f) => f.filename === relPath);
      const movedAway = files.find(
        (f) => f.previous_filename === relPath && f.filename !== relPath,
      );
      // 没动 ⇒ HEAD == BASE,天然成立,不必多跑一次 API。
      // baseText === null 表示「base 上根本没有这个文件」(head 注册表新增条目指向的新基线):
      // 那种情况下「没动」意味着它在 head 上也不存在 —— 必须报成取不到,不能当成空内容。
      if (!touched && !movedAway) {
        return baseText === null
          ? { text: null, source: '既不在 base、也未在本 PR 中新增(取不到)' }
          : { text: baseText, source: '未改动(HEAD == BASE)' };
      }
      if (movedAway || touched?.status === 'removed') {
        return { text: null, source: movedAway ? `被改名到 ${movedAway.filename}` : '被删除' };
      }
      // 用 API **自己给出的** contents_url,不自己拼 —— fork PR 的 head 仓库不同,
      // 拼错就会取到 base 的内容,判据静默变成「自己和自己比」,永远通过。
      const url = touched.contents_url;
      if (typeof url !== 'string' || url === '') {
        failClosed(`变更清单里 ${relPath} 没有 contents_url,取不到 head 版本`);
      }
      let payload;
      try {
        payload = JSON.parse(gh(['api', url]));
      } catch (err) {
        failClosed(`取 head 的 ${relPath} 失败:${String(err)}`);
      }
      if (
        payload.encoding !== 'base64' ||
        typeof payload.content !== 'string' ||
        payload.content === ''
      ) {
        failClosed(
          `head 的 ${relPath} 内容取不到(encoding=${String(payload.encoding)})。` +
            'GitHub contents API 对超过 1MB 的文件返回空 content —— 判据文件不该有这么大。',
        );
      }
      // **只解码 + JSON.parse,永不执行**。这正是把判据从 .mjs 抽成 JSON 的原因。
      return {
        text: Buffer.from(payload.content, 'base64').toString('utf-8'),
        source: `head@${String(meta.head?.sha ?? '?').slice(0, 8)}`,
      };
    };

    // ④-a 判据的判据:注册表本身只可增不可删。
    let registryBaseText;
    try {
      registryBaseText = readFileSync(RATCHET_REGISTRY_REL_PATH, 'utf-8');
    } catch (err) {
      failClosed(
        `读不出 base 分支的 ${RATCHET_REGISTRY_REL_PATH}:${String(err)}。` +
          '它登记着全仓有哪些棘轮,base 上没有它 = 所有棘轮都没人裁。',
      );
    }
    const registryHead = headTextOf(RATCHET_REGISTRY_REL_PATH, registryBaseText);
    let registryVerdict;
    try {
      registryVerdict = judgeRegistryMonotonicity(registryBaseText, registryHead.text);
    } catch (err) {
      failClosed(`棘轮注册表无法判定:${String(err)}`);
    }
    if (!registryVerdict.ok) {
      failHard('棘轮注册表被削减:登记只可增不可删', [
        `判据:${RATCHET_REGISTRY_REL_PATH}(base 的 ratchets[].id 必须全部仍在 head)`,
        registryVerdict.deleted
          ? `head 上整份注册表${registryHead.source} —— 等于全仓棘轮集体退保`
          : `head 少了 ${registryVerdict.removed.length} 条:${registryVerdict.removed.join(', ')}`,
        '',
        '为什么这也要硬拦:注册表决定「有哪些棘轮受单调性保护」。允许摘条目,',
        '「先把自己摘掉、再随便改基线」就是一条完整的绕过路径 —— 判据的判据同样得有人看。',
        '',
        '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
      ]);
    }
    if (registryVerdict.mutated.length > 0) {
      failHard('棘轮登记被换了载体:既有 id 的 baseline / rule / symbolShape 逐字冻结', [
        `判据:${RATCHET_REGISTRY_REL_PATH}(base 里每个 id 的四元组必须在 head 上逐字不变)`,
        `本 PR 改动了 ${registryVerdict.mutated.length} 处:`,
        ...registryVerdict.mutated.map(
          (m) => `    ${m.id}.${m.field}:  base=${m.base}  →  head=${m.head}`,
        ),
        '',
        '这道闸拦的是「id 没变、执行它的东西全换了」:',
        '  新增一份 harness/<旧名>-v2.json(洗过的副本、多几条豁免),把 baseline 指过去,',
        '  **旧文件原样不动** —— 裁判读 base 注册表拿到旧路径,旧路径没改动 ⇒ 判成 HEAD == BASE ⇒ 全绿;',
        '  而 lint 侧读的是 head 注册表,吃的是 v2。判据从此守着一份已经没人读的文件。',
        '  (改名会被「基线不得删除 / 改名」拦下,但**拷贝一份再改指向**不涉及 rename。)',
        '',
        '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
        '正确做法:棘轮的载体不迁移。确需迁移协议 —— 只能改本裁判自身(红区 + 环境审批,双重人闸)。',
      ]);
    }

    // ④-b 遍历 **base 上登记的**每一条棘轮,逐条判 HEAD ⊆ BASE。
    //     用 base 的注册表而不是 head 的:否则 PR 只要把自己那条改个 id 就绕过了。
    const ratchets = parseRatchetRegistryDoc(registryBaseText, 'base');
    /** rule → 该规则在 base / head 侧的豁免键并集(供 ④-c 判「并集只减不增」)。 */
    const baseUnions = new Map();
    const headUnions = new Map();
    const unite = (map, rule, keys) => {
      const set = map.get(rule) ?? new Set();
      for (const k of keys) set.add(k);
      map.set(rule, set);
    };
    for (const ratchet of ratchets) {
      let baseText;
      try {
        baseText = readFileSync(ratchet.baseline, 'utf-8');
      } catch (err) {
        failClosed(
          `读不出 base 分支的 ${ratchet.baseline}:${String(err)}。` +
            `它是棘轮 ${ratchet.id} 的判据,base 上没有它 = 该棘轮已经不成立。`,
        );
      }
      const head = headTextOf(ratchet.baseline, baseText);

      let verdict;
      try {
        verdict = judgeBaselineMonotonicity(baseText, head.text, ratchet.baseline);
      } catch (err) {
        failClosed(`棘轮 ${ratchet.id} 单调性无法判定:${String(err)}`);
      }

      if (verdict.removedFile) {
        failHard(`棘轮 ${ratchet.id} 的判据被移走:基线文件不得删除 / 改名`, [
          `判据:${ratchet.baseline} —— head 上它${head.source}`,
          '',
          '为什么不能判成「HEAD = ∅ ⊆ BASE,成立」:那个理由曾经是「lint 侧加载不到会抛」,',
          '但 lint 跑在 **PR 自己的树**上,同一个 PR 完全可以顺手改掉加载它的地方 ——',
          '于是「删掉判据」和「判据通过」在门禁看来一模一样。',
          '',
          `真要清零:留一个 {"version":1,"entries":[]} 的空 ${ratchet.baseline},`,
          '那是可见的、可 review 的零,而不是一个消失的文件。',
          '',
          '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
        ]);
      }
      if (!verdict.ok) {
        failHard(`棘轮 ${ratchet.id} 被破坏:基线只减不增,本 PR 却新增了条目`, [
          `判据:${ratchet.baseline}(base 与 head 按 (file, symbol) 集合比,不看总数)`,
          `新增 ${verdict.added.length} 条:`,
          ...verdict.added.slice(0, 20).map((a) => `    + ${a}`),
          ...(verdict.added.length > 20 ? [`    …另有 ${verdict.added.length - 20} 条`] : []),
          '',
          '这道闸专门拦两种 lint 与 selftest 都拦不住的形状:',
          '  ① 新增一个违规 + 同一个 PR 里顺手把它加进基线;',
          '  ② 修好 A、加进 B(总数不变)—— 任何看总数的判据都看不见。',
          '两者在 PR 自己的树上都全绿,因为它们改的正是判据本身。',
          '',
          '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
          '正确做法:把新违规真的改掉,不要加基线行。',
          '若确属合法 revert 需要加回旧基线行 —— 那需要维护者临时授权改本裁判自身(双重人闸,刻意昂贵)。',
        ]);
      }
      const baseKeys = baselineKeySet(baseText, 'base', ratchet.baseline);
      unite(baseUnions, ratchet.rule, baseKeys);
      unite(headUnions, ratchet.rule, baselineKeySet(head.text, 'head', ratchet.baseline));
      console.log(
        `✓ 棘轮 ${ratchet.id} 单调性:HEAD ⊆ BASE(${head.source};base ${baseKeys.size} 条)`,
      );
    }
    console.log(
      `✓ 棘轮注册表:${ratchets.length} 条全部在册、四元组逐字未变(${registryHead.source})`,
    );

    // ④-c 「同一条 rule 的豁免**并集**只减不增」——把 ④-a/④-b 都够不着的那条路堵上。
    //
    // ④-a 明确**允许新增全新 id**(不允许的话,以后没人能再落地一条新棘轮 ——
    // 新棘轮天生带着一份存量债的基线)。但这条合法通道自己就能洗豁免:
    //   新增 `{ id:"evil", baseline:"harness/evil.json", rule:"srvf/no-nullable-is-optional" }`,
    //   evil.json 里塞几条**新**豁免。④-a 管不到(它是新 id),④-b 也管不到
    //   (base 注册表里没有它,裁判压根不会去看那份文件)——
    //   而 lint 侧按 head 注册表**遍历**生成豁免块,新豁免当场生效。
    // 判据因此必须落在真正的受害者「rule」上,而不是落在「哪份文件」上。
    const baseIds = new Set(ratchets.map((r) => r.id));
    let headRatchets;
    try {
      headRatchets = parseRatchetRegistryDoc(registryHead.text, 'head');
    } catch (err) {
      failClosed(`head 的棘轮注册表无法解析:${String(err)}`);
    }
    for (const r of headRatchets) {
      if (baseIds.has(r.id)) continue; // 既有 id 的 head 版本已在 ④-b 算进并集
      // 全新 rule ⇒ 不设限:那正是「落地一条全新棘轮」的合法形状,
      // 它冻结的是自己那条规则的存量债,不碰任何既有规则的豁免面。
      if (!baseUnions.has(r.rule)) continue;
      // 新条目**也可能**指向一份 base 上已经存在的基线(重复登记同一份文件)。
      // 那种情况下「PR 没碰它」意味着 HEAD == BASE,不是「取不到」——
      // 先探一下 base 磁盘,拿不到才按「base 上没有」传 null。
      let existingBaseText = null;
      try {
        existingBaseText = readFileSync(r.baseline, 'utf-8');
      } catch {
        existingBaseText = null;
      }
      const extra = headTextOf(r.baseline, existingBaseText);
      if (extra.text === null) {
        failHard(`head 新增的棘轮 ${r.id} 指向一份取不到的基线`, [
          `判据:${r.baseline} —— ${extra.source}`,
          '注册表登记了它,却拿不到内容 ⇒ 无法判定它给 ' + r.rule + ' 加了哪些豁免。',
          '',
          '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
        ]);
      }
      try {
        unite(headUnions, r.rule, baselineKeySet(extra.text, 'head', r.baseline));
      } catch (err) {
        failClosed(`head 新增的棘轮 ${r.id} 基线无法解析:${String(err)}`);
      }
    }
    const unionVerdict = judgeRuleUnionMonotonicity(baseUnions, headUnions);
    if (!unionVerdict.ok) {
      failHard('豁免并集被撑大:同一条 rule 的豁免只减不增', [
        '判据:base 注册表里出现过的每条 rule,head 侧**全部**基线的 (file, symbol) 并集 ⊆ base 侧并集',
        `新增 ${unionVerdict.added.length} 条:`,
        ...unionVerdict.added.slice(0, 20).map((a) => `    + [${a.rule}] ${a.key}`),
        ...(unionVerdict.added.length > 20
          ? [`    …另有 ${unionVerdict.added.length - 20} 条`]
          : []),
        '',
        '这道闸拦的是「借新增棘轮之名给既有规则加豁免」:',
        '  逐基线单调性只看 base 登记过的那几份文件,新增一份它根本不会去读;',
        '  而 lint 侧按 head 注册表遍历生成豁免块 —— 新文件里的豁免当场生效。',
        '',
        '⚠️ 落地**全新规则**的新棘轮不受本条限制(它的 rule 在 base 并集里不存在)。',
        '⚠️ 本失败**不能由 harness-review 审批覆盖**(scan 失败 ⇒ 审批 job 直接被跳过)。',
      ]);
    }
    console.log(
      `✓ 豁免并集单调性:${baseUnions.size} 条 rule 逐条 HEAD ⊆ BASE(含 head 新增登记)`,
    );
  }

  // ── ⑤ 报告 ───────────────────────────────────────────────────────────────
  if (hits.length === 0) {
    console.log('\n✓ 未触碰红区或执法层');
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

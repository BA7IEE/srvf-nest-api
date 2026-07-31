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
const RATCHET_REGISTRY_REL_PATH = 'harness/ratchet-registry.json';

/**
 * 解析注册表(**只 parse,永不执行** —— 正是当初把基线从 .mjs 抽成 JSON 的同一条理由)。
 *
 * @param {string} text
 * @param {string} which
 * @returns {Array<{ id: string, baseline: string }>}
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
  for (const r of doc.ratchets) {
    if (
      r === null ||
      typeof r !== 'object' ||
      typeof r.id !== 'string' ||
      typeof r.baseline !== 'string'
    ) {
      throw new Error(`${which} 的 ${RATCHET_REGISTRY_REL_PATH} 有条目缺 id / baseline`);
    }
    out.push({ id: r.id, baseline: r.baseline });
  }
  return out;
}

/**
 * 注册表单调性:base 登记过的棘轮,head 里一条都不许少(纯函数,自测直接喂两份文档)。
 *
 * @param {string} baseText
 * @param {string|null} headText head 上的注册表全文;null = PR 把它删了 / 改名了
 * @returns {{ ok: boolean, removed: string[], deleted: boolean }}
 */
export function judgeRegistryMonotonicity(baseText, headText) {
  const base = parseRatchetRegistryDoc(baseText, 'base');
  if (headText === null) {
    return { ok: false, removed: base.map((r) => r.id), deleted: true };
  }
  const headIds = new Set(parseRatchetRegistryDoc(headText, 'head').map((r) => r.id));
  const removed = base.map((r) => r.id).filter((id) => !headIds.has(id));
  return { ok: removed.length === 0, removed, deleted: false };
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
      if (!touched && !movedAway) return { text: baseText, source: '未改动(HEAD == BASE)' };
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

    // ④-b 遍历 **base 上登记的**每一条棘轮,逐条判 HEAD ⊆ BASE。
    //     用 base 的注册表而不是 head 的:否则 PR 只要把自己那条改个 id 就绕过了。
    const ratchets = parseRatchetRegistryDoc(registryBaseText, 'base');
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
      console.log(
        `✓ 棘轮 ${ratchet.id} 单调性:HEAD ⊆ BASE` +
          `(${head.source};base ${baselineKeySet(baseText, 'base', ratchet.baseline).size} 条)`,
      );
    }
    console.log(
      `✓ 棘轮注册表:${ratchets.length} 条全部在册且逐条裁过(${registryHead.source})`,
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

/**
 * 冻结稿落地台账 —— 读数与分类扫描的**唯一实现**。
 *
 * 立项动机(2026-08-22 实测):仓内有 8 份冻结稿仍有未落地内容,但"落地度"此前
 * 不在任何一处被维护 —— 要回答"还欠多少",得跑五条机器命令再读三屏散文。
 * 而 `docs/README.md` 里那句「已冻结但尚未实施的 T0 评审稿……当前两份」已经漂了:
 * `rbac-permission-catalog-t0-review.md` 与整个 `activity-business-overhaul-v1.1/`
 * 都没登记。**漏登记不产生任何坏链接**,所以既有守护一次都没响过 ——
 * 与 `docs/ai-harness/README.md` 当年漂成"恰 4 文件"是同一类缺陷。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    ⭐ 它原名 `scripts/frozen-drafts-ledger.ts` —— **放在 `scripts/` 下但名字不匹配任何
 *    selfGuard glob,实测 `harness:needs` = 0 需授权**,即零保护。selfGuard 的 glob 钉在
 *    **文件名**上(`check-*` / `generate-*` / `replay-*` / `*.selftest.*`),所以「搬进
 *    `scripts/`」这句话本身是不够的,必须是「搬成 `check-*.ts`」。改名即为收编。
 *
 * 本文件提供**计算与判定**,`src/frozen-drafts-ledger.criteria.spec.ts` 只做薄运行器
 * (跑在 CI Fast 的 unit job)。
 *
 * ⚠️ 三条设计约束,改本文件前先读:
 *
 *  1. **读数里不得含时间戳 / git SHA**(架构治理 v4 勘误①)。派生生成物一旦带这两样,
 *     字节比对新鲜度恒假红且自引用。本文件的输出只由被扫描文件的内容决定。
 *  2. **扫描面不得写死名单**。分类表的对照集来自 `readdirSync`,新增一份归档评审稿
 *     会让判据当场红(缺分类),这正是本闸存在的理由。关键词扫描("头部含冻结/FROZEN")
 *     是**试过并否决**的方案 —— 实测漏掉 `activity-responsibility-workflow-v2-review.md`
 *     (头部写的是"业务已定版"),而那份恰恰是代码已落、闸未开的欠账项。
 *  3. **跨台账对照(判据 6)治的是「沉默」,不是「不一致」** —— 存在刻意不同的合法情形,
 *     逃生门必须留,但必须是**固定机器标记**且**不能把闸整体关掉**。详见下方判据 6 的段注。
 *
 * ⚠️ **接线**(2026-08-24 订正):本文件由 `.github/workflows/ci.yml` 的 `Diff guards`
 *    (`redzone-scan`)job 直接跑,**不随 docs-only 短路**;`src/frozen-drafts-ledger.criteria.spec.ts`
 *    在 unit 轮同跑一遍。⭐ 在此之前**唯一**入口是那个 spec,而 fast job 的 `Run unit tests`
 *    带 `if: docs_only != 'true'` —— 改台账的 PR 几乎全是 docs-only ⇒ **本文件的全部判据
 *    恰好在最该拦的那批 PR 上一条都不跑**,而台账 §4 当时还写着"不随 docs-only 短路"。
 *    自称有执法而实际没有,比没写更危险。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  LEDGER_PATH as NEXT_TASKS_PATH,
  parseEntries as parseNextTasksEntries,
  parseStatus as parseNextTasksStatus,
  STATUS_KINDS,
  type Entry as NextTasksEntry,
  type StatusKind,
} from './check-next-tasks-state';
import { extractSeedFactsPermissionCodesAst, readSeedFactsClosure } from './docs-counts';

/** 仓库根。本文件搬进 `scripts/` 后是上一级。 */
const ROOT = resolve(__dirname, '..');

export const LEDGER_PATH = 'docs/ai-harness/FROZEN_DRAFTS.md';
export const ARCHIVE_DIRS = ['docs/archive/reviews', 'docs/archive/plans'] as const;

export const BLOCK_BEGIN = '<!-- frozen-drafts:readings:begin -->';
export const BLOCK_END = '<!-- frozen-drafts:readings:end -->';

/** 分类闭集。open 必须带台账编号;其余三类不带。 */
export const CATEGORIES = ['open', 'landed', 'report', 'superseded'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  readonly path: string;
  readonly category: Category;
  readonly ledgerId?: string;
}

export interface Reading {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly source: string;
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** 归档评审稿 / 计划全集(扫描面,不是名单)。 */
export function scanArchivedDocs(root: string): string[] {
  return ARCHIVE_DIRS.flatMap((dir) => walk(root, dir)).sort();
}

/**
 * 解析台账 §3 分类表。
 * 行形如:`| \`docs/archive/...md\` | open · P1-30 | 说明 |`
 */
export function parseClassifications(markdown: string): Classification[] {
  const found: Classification[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*`(docs\/archive\/[^`]+\.md)`\s*\|\s*([a-z]+)\s*(?:·\s*([A-Za-z0-9-]+))?\s*\|/.exec(
      line,
    );
    if (!match) continue;
    const category = match[2] as Category;
    found.push({
      path: match[1],
      category,
      ...(match[3] === undefined ? {} : { ledgerId: match[3] }),
    });
  }
  return found;
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function srcFiles(root: string, dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(root, rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

/** 活动 v1.1 验收编号覆盖度 —— 与 `pnpm test activity-business-overhaul-acceptance` 的 todo 读数同源。 */
export function activityAcceptanceCoverage(root: string): {
  defined: number;
  bound: number;
  todo: number;
} {
  const plan = readFileSync(
    join(
      root,
      'docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务全流程修正方案_正式版_v1.1.md',
    ),
    'utf8',
  );
  const defined = new Set<string>();
  for (const match of plan.matchAll(/^- \*\*((?:AC|ADV)-\d{3})\*\*/gm)) defined.add(match[1]);

  // 登记表把「已绑真实证据」放在 *_DESTINATIONS 表,「只有卡点说明」放在 *_BLOCKERS 表。
  // 只有前者算已落地 —— 后者在 jest 里仍是 it.todo。
  const registry = readFileSync(
    join(root, 'src/modules/activities/activity-business-overhaul-acceptance.spec.ts'),
    'utf8',
  );
  const bound = new Set<string>();
  let table: string | null = null;
  for (const line of registry.split('\n')) {
    const opened = /^const ([A-Z0-9_]+)(?::|\s*=)/.exec(line);
    if (opened) table = opened[1];
    if (/^\};/.test(line)) table = null;
    const key = /^ {2}'((?:AC|ADV)-\d{3})':/.exec(line);
    if (key && table !== null && table.includes('DESTINATIONS')) bound.add(key[1]);
  }
  return { defined: defined.size, bound: bound.size, todo: defined.size - bound.size };
}

export function computeReadings(root: string): Reading[] {
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  const json = (rel: string): Record<string, unknown> =>
    JSON.parse(read(rel)) as Record<string, unknown>;

  const schema = read('prisma/schema.prisma');
  const integrationSurfaceHits = srcFiles(root).filter((file) =>
    read(file).includes('integration/v1'),
  ).length;

  const catalogRuntimeFiles = readdirSync(join(root, 'src/modules/permissions')).filter(
    (name) => name.startsWith('permission-catalog') && !name.endsWith('.spec.ts'),
  ).length;
  // 锚在**共享谓词**上,不锚私有 helper 的名字。
  // ⚠️ 教训:这里原本写死 `assertNoControlPlaneCodesOrThrow`。P1-32 PR 3a 把它改名成
  //    `assertControlPlaneCodesOrThrow`(加 direction 参数),闸一行没少,这条读数却当场
  //    翻成「未接」—— 名字锚点会把**纯重构**报成执法位消失。谓词 `isControlPlanePermissionCode`
  //    是 role-delegation.policy.ts 的单一真相,换掉它才是真的另造判定。
  //    「两条写路径是否都到得了这道闸」由 role-permissions-control-plane-gate.spec.ts
  //    按调用闭包强制,本条只是台账上的状态读数,不是执法位。
  const revokeGate = /isControlPlanePermissionCode/.test(
    read('src/modules/permissions/role-permissions.service.ts'),
  );

  const acceptance = activityAcceptanceCoverage(root);

  const debt = json('harness/architecture-debt.json');
  const debtEntries = (debt.entries as unknown[]).length;

  const machines = json('harness/state-machines.json');
  const machineEntries = machines.entries as { governanceStatus?: string }[];
  const governed = machineEntries.filter((e) => e.governanceStatus === 'governed').length;

  const sizeBaseline = json('harness/service-size-baseline.json');
  const sizeEntries = (sizeBaseline.entries as unknown[]).length;

  const guardMode = /AUTHZ_DECLARATION_MODE: AuthzDeclarationMode = '(\w+)'/.exec(
    read('src/common/guards/authz-declaration.guard.ts'),
  )?.[1];
  const journeys = readdirSync(join(root, 'test/journeys')).filter((f) =>
    f.endsWith('.e2e-spec.ts'),
  ).length;

  const appConfig = read('src/config/app.config.ts');
  const opsGates = [
    'INSURANCE_ENFORCEMENT_ENABLED',
    'ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED',
    'ACTIVITY_V11_WORKFLOW_ENABLED',
  ].filter((gate) => appConfig.includes(gate));

  const permissionCodes = extractSeedFactsPermissionCodesAst(readSeedFactsClosure()).size;

  return [
    {
      id: 'if-schema-models',
      label: 'IF v1:ServicePrincipal / DelegationGrant 建表数',
      value: String(
        countMatches(schema, /^model (?:ServicePrincipal|ServicePrincipalCredential|DelegationGrant)\b/gm),
      ),
      source: 'prisma/schema.prisma',
    },
    {
      id: 'if-surface-hits',
      label: 'IF v1:第六 surface `integration/v1` 在 src 的命中文件数',
      value: String(integrationSurfaceHits),
      source: 'src/**/*.ts(不含 .spec.ts)',
    },
    {
      id: 'catalog-runtime-files',
      label: 'P1-32 PR1:`permission-catalog*` 运行时文件数',
      value: String(catalogRuntimeFiles),
      source: 'src/modules/permissions/',
    },
    {
      id: 'catalog-revoke-gate',
      label: 'P1-32:授码 / 撤码两侧是否复用控制面闸谓词',
      value: revokeGate ? '已接' : '未接',
      source: 'src/modules/permissions/role-permissions.service.ts',
    },
    {
      id: 'permission-codes',
      label: '权限码总数(冻结件写 236,PR0 要逐条分类的就是这张表)',
      value: String(permissionCodes),
      source: 'scripts/docs-counts.ts 的 typed-AST 闭包',
    },
    {
      id: 'activity-acceptance',
      label: '活动 v1.1 验收编号:已绑真实证据 / 合同定义',
      value: `${acceptance.bound} / ${acceptance.defined}(${acceptance.todo} 条仍 it.todo)`,
      source: '合同正式版 + activity-business-overhaul-acceptance.spec.ts',
    },
    {
      id: 'governance-debt',
      label: '治理 Phase 7:债务身份证待清偿条数',
      value: String(debtEntries),
      source: 'harness/architecture-debt.json',
    },
    {
      id: 'governance-state-machines',
      label: '治理 Phase 4:状态列 governed / 登记总数',
      value: `${governed} / ${machineEntries.length}`,
      source: 'harness/state-machines.json',
    },
    {
      id: 'governance-service-size',
      label: '治理 Phase 6-B:尺寸基线在册文件数(仍超 700 NCLOC)',
      value: String(sizeEntries),
      source: 'harness/service-size-baseline.json',
    },
    {
      id: 'governance-authz-guard',
      label: '治理 Phase 1D:声明 Guard 模式',
      value: guardMode ?? '解析失败',
      source: 'src/common/guards/authz-declaration.guard.ts',
    },
    {
      id: 'governance-journeys',
      label: '治理 Phase 1J:跨域金路径 journey 数',
      value: String(journeys),
      source: 'test/journeys/',
    },
    {
      id: 'ops-gates-present',
      label: '三条"代码已落、闸未开"的开关在配置里的数量',
      value: `${opsGates.length} / 3`,
      source: 'src/config/app.config.ts',
    },
  ];
}

export function renderReadings(readings: readonly Reading[]): string {
  const lines = [
    BLOCK_BEGIN,
    '<!-- 由 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` 生成;禁止手改。',
    '     判据 `src/frozen-drafts-ledger.criteria.spec.ts` 逐字节比对,手改即红。 -->',
    '',
    '| 读数 | 值 | 取自 |',
    '|---|---|---|',
    ...readings.map((r) => `| ${r.label} | **${r.value}** | \`${r.source}\` |`),
    '',
    BLOCK_END,
  ];
  return lines.join('\n');
}

export function replaceReadingsBlock(markdown: string, rendered: string): string {
  const begin = markdown.indexOf(BLOCK_BEGIN);
  const end = markdown.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${LEDGER_PATH} 缺少读数块锚点 ${BLOCK_BEGIN} / ${BLOCK_END}`);
  }
  return markdown.slice(0, begin) + rendered + markdown.slice(end + BLOCK_END.length);
}

export function extractReadingsBlock(markdown: string): string {
  const begin = markdown.indexOf(BLOCK_BEGIN);
  const end = markdown.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${LEDGER_PATH} 缺少读数块锚点 ${BLOCK_BEGIN} / ${BLOCK_END}`);
  }
  return markdown.slice(begin, end + BLOCK_END.length);
}

function main(): void {
  const root = ROOT;
  const rendered = renderReadings(computeReadings(root));
  const path = join(root, LEDGER_PATH);
  const markdown = readFileSync(path, 'utf8');

  if (process.argv.includes('--write')) {
    const next = replaceReadingsBlock(markdown, rendered);
    if (next === markdown) {
      console.log('读数块已是最新,未改动。');
      return;
    }
    writeFileSync(path, next, 'utf8');
    console.log(`已刷新 ${LEDGER_PATH} 的读数块。`);
    return;
  }

  if (extractReadingsBlock(markdown) === rendered) {
    console.log('读数块与真源一致。');
    return;
  }
  console.error(
    '读数块已过期。跑 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` 刷新。',
  );
  console.error('\n应为:\n');
  console.error(rendered);
  process.exitCode = 1;
}

// 入口在文件末尾统一分发(见 `if (require.main === module)`)。

// ============================================================================
// 判定侧 —— 原先整段写在 `src/frozen-drafts-ledger.criteria.spec.ts` 里
//
// 那个文件不在 selfGuard,任何 PR 都能顺手把地板从 80 改成 0、把双向集合相等
// 改成单向、或者把「读数逐字节比对」整条删掉,零授权零痕迹。搬进来。
// ============================================================================

/** 归档目录的地板:低于它说明扫描面塌了(读错目录 / 过滤写错),不是"仓库真的只剩这么几份"。 */
export const ARCHIVED_DOCS_FLOOR = 80;

/** 读数条数地板:computeReadings 被删空时判据必须红。 */
export const READINGS_FLOOR = 10;

/** 活动验收编号的定义数地板。 */
export const ACTIVITY_ACCEPTANCE_DEFINED_FLOOR = 90;

/** §1 欠账表的行形状:`| 序号 | … | 台账编号 | …`。 */
const SUMMARY_ROW = /^\|\s*\d+\s*\|[^|]+\|\s*([^|]+?)\s*\|/;

/** 台账编号形状 `P<数字>-<数字>`;`—` 表示这项没有 NEXT_TASKS 编号。 */
const LEDGER_ID = /^P\d+-\d+$/;

/** 读数块里不许出现的两样东西 —— 带了它们,字节比对会恒假红且自引用。 */
const TIMESTAMP_SHAPE = /\b20\d{2}-\d{2}-\d{2}\b/;
const GIT_SHA_SHAPE = /\b[0-9a-f]{7,40}\b/;

/** 台账三个锚点 —— 缺任一个,后面的解析都是空对空。 */
export const LEDGER_ANCHORS = [
  '## 1. 还有欠账的冻结稿',
  '## 3. 归档评审稿 / 计划全量分类',
];

export function readLedger(root: string = ROOT): string {
  return readFileSync(resolve(root, LEDGER_PATH), 'utf8');
}

/** §1 欠账表里的台账编号(第三列)。 */
export function ledgerIdsInSummaryTable(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of markdown.split('\n')) {
    const row = SUMMARY_ROW.exec(line);
    if (!row) continue;
    const cell = row[1];
    if (LEDGER_ID.test(cell)) ids.add(cell);
  }
  return ids;
}

// ============================================================================
// 判据 6 —— 跨台账落地度对照(`FROZEN_DRAFTS` §1 ↔ `NEXT_TASKS` 状态行)
//
// **要防的缺陷类**:两份台账对**同一件事**的说法直接矛盾,而没有任何机器发现。
// 实测立项证据(2026-08-24,`22d2449e`):§1 行 2 写 `**1 / 9 PR**` 且「卡在维护者
// 逐条分类权限码(PR 0)」,而 `NEXT_TASKS` 的 P1-32 状态行同时写着
// `进行中(5/8;PR 0/1/3a/3b/4a 已合 …)` —— PR 0 早已于 `#1145` 合入。
// 两份都是权威源,**没有任何判据在对照它们**。
//
// ─── 🔴 「两边数字必须相等」是错的判据,别做成那样 ─────────────────────────
// §1.1 ③ 的标题逐字写着「活动业务 v1.1 合同 —— **两根尺子读数不同,别混用**」
// ⇒ **存在刻意不同的合法情形**,而那恰恰是台账里最用心写的一条。
// 本闸沿 `check-next-tasks-state.ts` 同一路子:**治的是「沉默」,不是「不一致」。**
//   · 两边一致                      ⇒ 绿
//   · 不一致**但显式声明了另一把尺子** ⇒ 绿(逃生门,见 `另尺(…)`)
//   · 不一致**且无任何声明**          ⇒ 红,并**同时打印两边原文**
// ⚠️ 逃生门必须是**固定机器标记**。做成「正文出现『尺子』二字就放行」的关键词判据,
//    随便一句话就能绕过 —— 那正是 §4 记着「关键词扫描面试过并当场否决」的同一教训。
//
// ─── 本刀能成立,靠的是一个刚变的前提 ────────────────────────────────────
// §4 原本写着「不守 §1 那些散文描述是否与冻结稿正文一致 —— 那要人读」,
// **那句话在当时是对的**:那时 `NEXT_TASKS.md` 没有任何机器可读的状态。
// 但 `22d2449e`(#1166)已给 25 条条目各加了一行 `**状态**:` 白名单值
// ⇒ 「落地度」从散文变成了可对照的数据。本判据接上这条对照。
//
// ─── ⚠️ 已知缺口(逐条登记,别当它们不存在)─────────────────────────────
// 1. **无编号行对照不到。** §1 行 8「活动责任闭环 v2」台账列是 `—`,`NEXT_TASKS`
//    里没有对应条目 ⇒ 它只能走 `↔无台账`,本判据对它**全程失明**。要纳管得先给它
//    一个台账编号;**本刀不擅自编号**,登记在此。
// 2. **不守「落地度数字本身是不是真的对」。** 只守两份台账不许**沉默地**互相矛盾。
//    **两边一起写错仍然全绿。闸绿 ≠ 台账准。**
// 3. **`↔另尺(…)` 的说明只能机器判「有没有实质内容」,判不了「说的是不是真话」。**
//    说明是否真的描述了另一把尺子,要人读。地板见 `OTHER_RULER_REASON_FLOOR`。
// 4. **分数只在 `NEXT_TASKS` 侧把它写在括号开头时才对照。** 台账图例本就是这个约定
//    (「8 个 PR 合了 5 个 ⇒ `进行中(5/8,…)`」);写在别处的数字本判据看不见。
// ============================================================================

/**
 * §1 欠账表**整行**:`| 序号 | 冻结稿 | 台账 | 落地度 | 卡在谁 |`。
 * 与上面只取第三列的 `SUMMARY_ROW` 是两个用途 —— 那条喂判据 3(与 §3 互证),
 * 本条喂判据 6(要读第四列的对照标记),刻意不合并:合并后任一方改列都会连坐另一方。
 */
const SUMMARY_FULL_ROW =
  /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/;

/** §1 区段的起止锚点 —— 解析面**只在这一节内**,免得 §4 那张 `| # | 判据 | … |` 被误吃。 */
const SUMMARY_SECTION_ANCHOR = '## 1. 还有欠账的冻结稿';

/** 对照标记:落地度单元格**开头**的反引号块,形如 `` `↔进行中 3/9` ``。 */
const CROSS_MARKER = /^`↔([^`]+)`/;

/** 逃生门:`另尺(<说明>)`。ASCII 圆括号,与 `NEXT_TASKS` 状态行同一形态。 */
const OTHER_RULER = /^另尺\((.+)\)$/s;

/** 台账列是 `—`(没有 `NEXT_TASKS` 编号)时唯一允许的标记。 */
const NO_LEDGER_MARKER = '无台账';

/** 同尺标记里的可选进度分数:`<状态种类> a/b`。 */
const MARKER_FRACTION = /^(\d+)\s*\/\s*(\d+)$/;

/**
 * `NEXT_TASKS` 侧的进度分数 —— **只认状态括号内容的开头**。
 * 刻意不做「全文找第一个 `a/b`」:`进行中(3/9 …;已合 5 刀 PR 0/1/3a/3b/4a …)`
 * 的括号里还有 `0/1/3a` 这种**不是分数**的斜杠,全文扫会抓错并造出假红。
 */
const NEXT_FRACTION = /^(\d+)\s*\/\s*(\d+)(?![0-9/])/;

/**
 * 逃生门说明的**实质性地板**。非空还不够 —— `另尺(3/9)` 那种「把数字再写一遍」
 * 同样是沉默,而且它会让逃生门退化成一句空话。
 * 判据:剥掉数字 / 斜杠 / 空白 / 常见标点后仍剩 ≥ 本地板个字符。
 */
export const OTHER_RULER_REASON_FLOOR = 8;

/** §1 表行数地板:低于它说明表被删空或列数变了 ——「判据失去输入 ≠ 通过」。 */
export const SUMMARY_ROWS_FLOOR = 6;

/** `NEXT_TASKS` 条目数地板:那边解析塌了的话,本判据每一行都会红在「找不到条目」上。 */
export const NEXT_TASKS_ENTRIES_FLOOR = 20;

/**
 * **真正做过对照**的行数地板。没有它,把每一行都改成 `↔另尺(随便写点什么)`
 * 就能零授权地把整条判据关掉,而且全绿 —— 逃生门不得能够停掉它自己的闸。
 */
export const CROSS_COMPARED_FLOOR = 4;

export function isSubstantiveReason(reason: string): boolean {
  return reason.replace(/[\s\d/#%·、,,.。:;:;()()–—-]/g, '').length >= OTHER_RULER_REASON_FLOOR;
}

export type CrossMarker =
  | {
      readonly kind: 'same-ruler';
      readonly status: StatusKind;
      readonly fraction?: readonly [number, number];
    }
  | { readonly kind: 'other-ruler'; readonly reason: string }
  | { readonly kind: 'no-ledger' };

/** 解析对照标记内容(不含首尾反引号与 `↔`)。形态不合一律返回 `null` ⇒ 调用方判红。 */
export function parseCrossMarker(payload: string): CrossMarker | null {
  const trimmed = payload.trim();
  if (trimmed === NO_LEDGER_MARKER) return { kind: 'no-ledger' };

  const other = OTHER_RULER.exec(trimmed);
  if (other) {
    const reason = other[1].trim();
    return isSubstantiveReason(reason) ? { kind: 'other-ruler', reason } : null;
  }

  // 白名单**直接来自** check-next-tasks-state 的 STATUS_KINDS —— 不在这里抄一份。
  // 抄一份的话两处会各自漂移,而漂移时「一边认一边不认」没有任何症状。
  for (const status of STATUS_KINDS) {
    if (trimmed === status) return { kind: 'same-ruler', status };
    if (!trimmed.startsWith(`${status} `)) continue;
    const fraction = MARKER_FRACTION.exec(trimmed.slice(status.length + 1).trim());
    if (!fraction) return null;
    return { kind: 'same-ruler', status, fraction: [Number(fraction[1]), Number(fraction[2])] };
  }
  return null;
}

export interface SummaryRow {
  /** 1-based 行号(全文,不是区段内)。 */
  readonly line: number;
  readonly raw: string;
  readonly ledgerCell: string;
  readonly progressCell: string;
  readonly markerRaw: string | null;
  readonly marker: CrossMarker | null;
}

/** 解析 §1 欠账表的每一行(动态发现面,**不写死 8 项**)。 */
export function parseSummaryRows(markdown: string): SummaryRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(SUMMARY_SECTION_ANCHOR));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }

  const rows: SummaryRow[] = [];
  for (let i = start; i < end; i += 1) {
    const cells = SUMMARY_FULL_ROW.exec(lines[i]);
    if (!cells) continue;
    const progressCell = cells[4];
    const marker = CROSS_MARKER.exec(progressCell);
    rows.push({
      line: i + 1,
      raw: lines[i],
      ledgerCell: cells[3],
      progressCell,
      markerRaw: marker === null ? null : marker[1],
      marker: marker === null ? null : parseCrossMarker(marker[1]),
    });
  }
  return rows;
}

export interface CrossLedgerReport {
  readonly failures: readonly string[];
  readonly summaryRows: number;
  readonly nextTasksEntries: number;
  /** 真正做过「同尺」对照的行数。 */
  readonly compared: number;
  /** 声明了另一把尺子的行数。 */
  readonly otherRuler: number;
  /** 台账列为 `—`、对照不到的行数(射程外)。 */
  readonly noLedger: number;
}

export function crossLedgerCheck(root: string, ledger: string): CrossLedgerReport {
  const failures: string[] = [];
  const rows = parseSummaryRows(ledger);

  const nextTasks = readFileSync(resolve(root, NEXT_TASKS_PATH), 'utf8');
  const entries = parseNextTasksEntries(nextTasks);
  const byId = new Map<string, NextTasksEntry>(entries.map((entry) => [entry.id, entry]));

  let compared = 0;
  let otherRuler = 0;
  let noLedger = 0;

  for (const row of rows) {
    const where = `${LEDGER_PATH}:${row.line}`;
    const hasLedgerId = LEDGER_ID.test(row.ledgerCell);

    if (row.marker === null) {
      failures.push(
        `${where} 落地度单元格缺少跨台账对照标记,或标记形态不合法` +
          `(读到:\`${row.markerRaw ?? row.progressCell}\`)。` +
          '本闸治的是「沉默」—— §1 每一行都必须对 `NEXT_TASKS` 的状态显式表态。' +
          '取值与写法见 FROZEN_DRAFTS §4 的标记表。',
      );
      continue;
    }

    if (row.marker.kind === 'no-ledger') {
      if (hasLedgerId) {
        failures.push(
          `${where} 标记 \`↔${NO_LEDGER_MARKER}\` 与台账列 \`${row.ledgerCell}\` 自相矛盾 —— ` +
            '有台账编号的行不许走这条「射程外」通道。',
        );
        continue;
      }
      noLedger += 1;
      continue;
    }

    if (!hasLedgerId) {
      failures.push(
        `${where} 台账列是 \`${row.ledgerCell}\`(没有 \`Pn-m\` 编号),` +
          `只能标 \`↔${NO_LEDGER_MARKER}\`;当前标的是 \`↔${row.markerRaw}\`。`,
      );
      continue;
    }

    if (row.marker.kind === 'other-ruler') {
      otherRuler += 1;
      continue;
    }

    const entry = byId.get(row.ledgerCell);
    if (entry === undefined) {
      failures.push(
        `${where} 声明与 ${NEXT_TASKS_PATH} 同尺,但那边找不到 \`### ${row.ledgerCell}\` 条目。`,
      );
      continue;
    }
    if (entry.statusLines.length !== 1) {
      failures.push(
        `${where} 对照不了 ${row.ledgerCell}:${NEXT_TASKS_PATH} 那条有 ` +
          `${entry.statusLines.length} 行状态(要恰一行)。先修那边 —— 见 check-next-tasks-state 判据 A。`,
      );
      continue;
    }
    const status = entry.statusLines[0];
    const parsed = parseNextTasksStatus(status.value);
    if (parsed === null) {
      failures.push(
        `${where} 对照不了 ${row.ledgerCell}:${NEXT_TASKS_PATH}:${status.line} 的状态取值 ` +
          `\`${status.value}\` 不在白名单内。先修那边 —— 见 check-next-tasks-state 判据 A。`,
      );
      continue;
    }

    compared += 1;
    const bothSides =
      `      ${where}\n        ${row.raw.trim()}\n` +
      `      ${NEXT_TASKS_PATH}:${status.line}\n        **状态**:${status.value}`;
    const howToFix =
      '\n    ⇒ 两边都是权威源:**先查清哪个对再改**,别只改一边;' +
      '若本行是刻意用另一把尺子,把标记改成 `↔另尺(<说清另一把尺子量的是什么>)`。';

    if (parsed.kind !== row.marker.status) {
      failures.push(
        `跨台账落地度矛盾(${row.ledgerCell}):FROZEN_DRAFTS 标 \`${row.marker.status}\`,` +
          `NEXT_TASKS 写 \`${parsed.kind}\`。\n${bothSides}${howToFix}`,
      );
      continue;
    }

    const nextFraction = NEXT_FRACTION.exec(parsed.detail);
    if (nextFraction === null) continue;
    if (row.marker.fraction === undefined) {
      failures.push(
        `跨台账落地度沉默(${row.ledgerCell}):NEXT_TASKS 给出了进度分数 ` +
          `\`${nextFraction[1]}/${nextFraction[2]}\`,而 §1 这一行没有对照它。\n${bothSides}${howToFix}`,
      );
      continue;
    }
    const [numerator, denominator] = row.marker.fraction;
    if (numerator !== Number(nextFraction[1]) || denominator !== Number(nextFraction[2])) {
      failures.push(
        `跨台账落地度矛盾(${row.ledgerCell}):FROZEN_DRAFTS 标 ` +
          `\`${numerator}/${denominator}\`,NEXT_TASKS 写 ` +
          `\`${nextFraction[1]}/${nextFraction[2]}\`。\n${bothSides}${howToFix}`,
      );
    }
  }

  return {
    failures,
    summaryRows: rows.length,
    nextTasksEntries: entries.length,
    compared,
    otherRuler,
    noLedger,
  };
}

/** 尺子自己的边界用例。判据在报数之前先证明自己没刻错 —— 返回空数组 = 通过。 */
export function crossLedgerSelfCheck(cross: CrossLedgerReport): string[] {
  const problems: string[] = [];

  if (cross.summaryRows < SUMMARY_ROWS_FLOOR) {
    problems.push(
      `§1 欠账表只解析出 ${cross.summaryRows} 行(地板 ${SUMMARY_ROWS_FLOOR})—— ` +
        '表被删空、列数变了或区段标题被改。「判据失去输入 ≠ 通过」。',
    );
  }
  if (cross.nextTasksEntries < NEXT_TASKS_ENTRIES_FLOOR) {
    problems.push(
      `${NEXT_TASKS_PATH} 只解析出 ${cross.nextTasksEntries} 条条目` +
        `(地板 ${NEXT_TASKS_ENTRIES_FLOOR})—— 对照面塌了。`,
    );
  }
  if (cross.compared < CROSS_COMPARED_FLOOR) {
    problems.push(
      `真正做过对照的只有 ${cross.compared} 行(地板 ${CROSS_COMPARED_FLOOR})—— ` +
        '逃生门 `↔另尺(…)` 不得把整条判据关掉。',
    );
  }
  if (STATUS_KINDS.length < 5) {
    problems.push(`状态白名单只剩 ${STATUS_KINDS.length} 个取值 —— 上游 STATUS_KINDS 塌了。`);
  }

  // ── 尺子的边界用例:每一条都是踩过或差点踩到的形状。
  if (parseCrossMarker('另尺(3/9)') !== null) {
    problems.push('逃生门说明的实质性地板失效:`另尺(3/9)` 这种「把数字再写一遍」被放行了。');
  }
  if (parseCrossMarker('另尺(NEXT_TASKS 那条只覆盖 Phase 0)') === null) {
    problems.push('逃生门把**合法**说明判成了不合法 —— 地板调得太高,会逼人把两把尺子强行统一。');
  }
  const bare = parseCrossMarker('进行中');
  if (bare === null || bare.kind !== 'same-ruler' || bare.fraction !== undefined) {
    problems.push('裸状态标记 `↔进行中` 解析失败。');
  }
  const withFraction = parseCrossMarker('进行中 3/9');
  if (
    withFraction === null ||
    withFraction.kind !== 'same-ruler' ||
    withFraction.fraction?.[0] !== 3 ||
    withFraction.fraction?.[1] !== 9
  ) {
    problems.push('带分数的标记 `↔进行中 3/9` 解析失败。');
  }
  if (parseCrossMarker('进行中3/9') !== null) {
    problems.push('标记解析把 `进行中3/9`(缺分隔空格)当成了合法形态。');
  }
  if (parseCrossMarker('施工中') !== null) {
    problems.push('标记解析放行了白名单外的取值。');
  }
  // 分数只认括号内容开头 —— `PR 0/1/3a` 那种斜杠不许被当成分数。
  const leading = NEXT_FRACTION.exec('3/9 完整落地 + PR 4 半;已合 5 刀 PR 0/1/3a/3b/4a');
  if (leading === null || leading[1] !== '3' || leading[2] !== '9') {
    problems.push('NEXT_TASKS 侧分数解析:开头的 `3/9` 没解析出来。');
  }
  if (NEXT_FRACTION.exec('已合 5 刀 PR 0/1/3a/3b/4a') !== null) {
    problems.push('NEXT_TASKS 侧分数解析越界:把 `PR 0/1/3a` 里的斜杠当成了分数。');
  }
  if (NEXT_FRACTION.exec('0/1/3a 已合') !== null) {
    problems.push('NEXT_TASKS 侧分数解析越界:`0/1/3a` 被当成了分数 `0/1`。');
  }
  return problems;
}

export interface LedgerReport {
  /** 归档目录里实际存在的 .md(相对路径)。 */
  actual: string[];
  /** §3 分类表里登记的路径。 */
  declaredPaths: string[];
  /** 分类取值不在闭集内的条目。 */
  badCategories: string[];
  /** `open` 却没带台账编号的条目。 */
  openWithoutLedgerId: string[];
  /** 归档目录有、§3 没登记(新增文件未登记)。 */
  missingFromLedger: string[];
  /** §3 登记了、归档目录已没有(登记了已删除的文件)。 */
  staleInLedger: string[];
  /** 同一份文件登记了两次(又一份"第二真相")。 */
  duplicateDeclarations: string[];
  /** §3 的 open 行有、§1 欠账表没有。 */
  openNotInSummary: string[];
  /** §1 欠账表有、§3 的 open 行没有。 */
  summaryNotInOpen: string[];
  /** 读数块与现算结果不一致(空串 = 一致)。 */
  readingsDrift: string;
  activityAcceptance: { defined: number; bound: number; todo: number };
  readingsCount: number;
  archivedCount: number;
  /** 判据 6:§1 落地度 ↔ NEXT_TASKS 状态行的跨台账对照。 */
  crossLedger: CrossLedgerReport;
}

export function analyzeLedger(root: string = ROOT): LedgerReport {
  const ledger = readLedger(root);
  const actual = scanArchivedDocs(root);
  const declared = parseClassifications(ledger);
  const declaredPaths = declared.map((c) => c.path);

  const openIds = new Set(
    declared
      .filter((c) => c.category === 'open')
      .map((c) => c.ledgerId)
      .filter((id): id is string => id !== undefined && id !== '-'),
  );
  const summaryIds = ledgerIdsInSummaryTable(ledger);

  const rendered = renderReadings(computeReadings(root));
  const extracted = extractReadingsBlock(ledger);

  return {
    actual,
    declaredPaths,
    badCategories: declared
      .filter((entry) => !CATEGORIES.includes(entry.category))
      .map((entry) => `${entry.path}(分类 ${entry.category} 不在闭集内)`),
    openWithoutLedgerId: declared
      .filter((entry) => entry.category === 'open' && entry.ledgerId === undefined)
      .map((entry) => entry.path),
    missingFromLedger: actual.filter((f) => !declaredPaths.includes(f)),
    staleInLedger: declaredPaths.filter((f) => !actual.includes(f)),
    duplicateDeclarations:
      declaredPaths.length === new Set(declaredPaths).size
        ? []
        : declaredPaths.filter((p, i) => declaredPaths.indexOf(p) !== i),
    openNotInSummary: [...openIds].filter((id) => !summaryIds.has(id)),
    summaryNotInOpen: [...summaryIds].filter((id) => !openIds.has(id)),
    readingsDrift: extracted === rendered ? '' : rendered,
    activityAcceptance: activityAcceptanceCoverage(root),
    readingsCount: computeReadings(root).length,
    archivedCount: actual.length,
    crossLedger: crossLedgerCheck(root, ledger),
  };
}

/** 自证:仪器没瞎才报数。返回空数组 = 自证通过。 */
export function selfCheck(report: LedgerReport, root: string = ROOT): string[] {
  const problems: string[] = [];
  const ledger = readLedger(root);

  if (report.archivedCount < ARCHIVED_DOCS_FLOOR) {
    problems.push(
      `扫描面塌了:只扫到 ${report.archivedCount} 份归档 .md,地板是 ${ARCHIVED_DOCS_FLOOR}。` +
        '「判据失去输入 ≠ 通过」。',
    );
  }
  if (!report.actual.every((d) => d.startsWith('docs/archive/') && d.endsWith('.md'))) {
    problems.push('扫描面越界:出现了不在 docs/archive/ 下的条目。');
  }
  for (const anchor of LEDGER_ANCHORS) {
    if (!ledger.includes(anchor)) problems.push(`台账缺锚点:${anchor}`);
  }
  if (ledgerIdsInSummaryTable(ledger).size === 0) {
    problems.push('§1 欠账表解析不出任何台账编号 —— 表格形状变了,后面的互证是空对空。');
  }
  if (report.declaredPaths.length < ARCHIVED_DOCS_FLOOR) {
    problems.push(`§3 分类表只解析出 ${report.declaredPaths.length} 条,地板是 ${ARCHIVED_DOCS_FLOOR}。`);
  }
  if (report.readingsCount < READINGS_FLOOR) {
    problems.push(`读数只有 ${report.readingsCount} 条,地板是 ${READINGS_FLOOR}。`);
  }

  const coverage = report.activityAcceptance;
  if (coverage.defined < ACTIVITY_ACCEPTANCE_DEFINED_FLOOR) {
    problems.push(
      `活动验收编号只解析出 ${coverage.defined} 条,地板是 ${ACTIVITY_ACCEPTANCE_DEFINED_FLOOR}。`,
    );
  }
  if (coverage.bound <= 0) problems.push('活动验收编号 bound = 0 —— 解析塌了。');
  if (coverage.bound + coverage.todo !== coverage.defined) {
    problems.push(
      `活动验收编号不自洽:bound(${coverage.bound}) + todo(${coverage.todo}) ≠ defined(${coverage.defined})。`,
    );
  }

  // 读数块不含时间戳与 git SHA,否则字节比对恒假红且自引用。
  const block = renderReadings(computeReadings(root));
  if (TIMESTAMP_SHAPE.test(block)) problems.push('读数块含时间戳 ⇒ 字节比对会恒假红且自引用。');
  if (GIT_SHA_SHAPE.test(block)) problems.push('读数块含 git SHA ⇒ 字节比对会恒假红且自引用。');

  problems.push(...crossLedgerSelfCheck(report.crossLedger));

  return problems;
}

function check(): void {
  const report = analyzeLedger();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  for (const f of report.missingFromLedger) console.error(`🔴 归档目录新增但 §3 未登记:${f}`);
  for (const f of report.staleInLedger) console.error(`🔴 §3 登记了已不存在的文件:${f}`);
  for (const f of report.duplicateDeclarations) console.error(`🔴 同一份文件登记了两次:${f}`);
  for (const f of report.badCategories) console.error(`🔴 ${f}`);
  for (const f of report.openWithoutLedgerId) console.error(`🔴 open 却没带台账编号:${f}`);
  for (const id of report.openNotInSummary) console.error(`🔴 §3 的 open 行有、§1 欠账表没有:${id}`);
  for (const id of report.summaryNotInOpen) console.error(`🔴 §1 欠账表有、§3 的 open 行没有:${id}`);
  if (report.readingsDrift !== '') {
    console.error('🔴 读数块已过期。跑 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` 刷新。');
  }
  for (const failure of report.crossLedger.failures) console.error(`🔴 ${failure}`);

  const broken =
    problems.length +
    report.missingFromLedger.length +
    report.staleInLedger.length +
    report.duplicateDeclarations.length +
    report.badCategories.length +
    report.openWithoutLedgerId.length +
    report.openNotInSummary.length +
    report.summaryNotInOpen.length +
    (report.readingsDrift === '' ? 0 : 1) +
    report.crossLedger.failures.length;

  const cross = report.crossLedger;
  console.log(
    `跨台账对照:§1 ${cross.summaryRows} 行 / NEXT_TASKS ${cross.nextTasksEntries} 条条目 ⇒ ` +
      `同尺对照 ${cross.compared} · 声明另尺 ${cross.otherRuler} · 无台账编号 ${cross.noLedger}`,
  );
  if (broken === 0) {
    console.log(`✓ 冻结稿台账分类完整、读数新鲜(${report.archivedCount} 份归档 .md)。`);
    console.log(
      '⚠️ 射程限制:本闸只守「两份台账不许**沉默地**互相矛盾」,' +
        '**不守落地度数字本身是不是真的对** —— 两边一起写错仍然全绿。闸绿 ≠ 台账准。' +
        '台账列为 `—` 的行(无 NEXT_TASKS 编号)对照不到,见本文件头注「已知缺口」。',
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

// 直接执行时跑 CLI;被 spec import 时不跑。
//
// ⚠️ 原判别式是 `process.argv[1].endsWith('frozen-drafts-ledger.ts')` —— 改名成
//    `check-frozen-drafts-ledger.ts` 后它**仍然匹配**(后缀恰好包含旧名),
//    但那是巧合而不是设计。换成 `require.main` 与仓内其余裁判一致。
//
//   --write  刷新台账里的读数块
//   (默认)  跑全部判据:分类完整性 + 互证 + 读数新鲜度 + 自证
if (require.main === module) {
  if (process.argv.includes('--write')) main();
  else check();
}

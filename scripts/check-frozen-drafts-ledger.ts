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
 * ⚠️ 两条设计约束,改本文件前先读:
 *
 *  1. **读数里不得含时间戳 / git SHA**(架构治理 v4 勘误①)。派生生成物一旦带这两样,
 *     字节比对新鲜度恒假红且自引用。本文件的输出只由被扫描文件的内容决定。
 *  2. **扫描面不得写死名单**。分类表的对照集来自 `readdirSync`,新增一份归档评审稿
 *     会让判据当场红(缺分类),这正是本闸存在的理由。关键词扫描("头部含冻结/FROZEN")
 *     是**试过并否决**的方案 —— 实测漏掉 `activity-responsibility-workflow-v2-review.md`
 *     (头部写的是"业务已定版"),而那份恰恰是代码已落、闸未开的欠账项。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

  const broken =
    problems.length +
    report.missingFromLedger.length +
    report.staleInLedger.length +
    report.duplicateDeclarations.length +
    report.badCategories.length +
    report.openWithoutLedgerId.length +
    report.openNotInSummary.length +
    report.summaryNotInOpen.length +
    (report.readingsDrift === '' ? 0 : 1);

  if (broken === 0) {
    console.log(`✓ 冻结稿台账分类完整、读数新鲜(${report.archivedCount} 份归档 .md)。`);
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

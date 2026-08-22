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
 * 本文件只提供**计算**,判据在 `src/frozen-drafts-ledger.criteria.spec.ts`(跑在 CI Fast 的 unit job)。
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
import { join } from 'node:path';

import { extractSeedFactsPermissionCodesAst, readSeedFactsClosure } from './docs-counts';

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
  const revokeGate = /assertNoControlPlaneCodesOrThrow/.test(
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
      label: 'P1-32 PR3 已抽出的那半边:撤码是否复用控制面闸',
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
    '<!-- 由 `pnpm exec tsx scripts/frozen-drafts-ledger.ts --write` 生成;禁止手改。',
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
  const root = process.cwd();
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
  console.error('读数块已过期。跑 `pnpm exec tsx scripts/frozen-drafts-ledger.ts --write` 刷新。');
  console.error('\n应为:\n');
  console.error(rendered);
  process.exitCode = 1;
}

// 直接执行时跑 CLI;被 spec import 时不跑。
if (process.argv[1] !== undefined && process.argv[1].endsWith('frozen-drafts-ledger.ts')) {
  main();
}

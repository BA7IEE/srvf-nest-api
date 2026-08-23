/**
 * check-permission-catalog-metadata.ts —— 权限元数据决策锁的执行位(P1-32 PR 0)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/permissions/permission-catalog-metadata.criteria.spec.ts`)。
 *
 * ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
 * 冻结稿把 PR 0 定性为「设计/文档,不改运行行为」。照字面做出来的产物是一份 237 条的
 * markdown 目录 —— 而**纯文档的决策记录会漂**:新增一条权限码不会让任何文档变红,
 * 三个月后目录里就少了它,没有任何症状。等 PR 3 把权限元数据变成 Catalog-owned、
 * 禁运行时增删改,那条没人填过元数据的码才会以「后台显示空白 / 风险提示缺失」的形态爆出来。
 *
 * 所以本闸的职责**不是**当期快照(「今天这 237 条都填了」),而是:
 *   🔴 **将来任何一条新码,不填元数据就进不了主干。**
 * 这也是判据从**目录全集动态发现**、不写死 237 / 不写死任何清单的原因 ——
 * Integration Foundation v1 的 PR2 会 +9 条控制面码,写死的判据那天会静默漏掉它们。
 *
 * ─── 全集取哪一份 ──────────────────────────────────────────────────────────
 * 恒取 **seed 事实闭包的 typed-AST 提取**(与 `docs:counts` / `docs:rbacmap` 同源)。
 *
 * ⚠️ **不要改用 `RBAC_SEED_CATALOG.permissions.*` 当全集** —— 那四个桶是**具名子集不是闭包**
 * (实测并集 224 < 闭包 237),差的那批里恰有 flag-gated 与动态拼接的码。
 * 用它当全集 = 给判据装一个会静默饿死自己的过滤器,而「该进的没进」是没有症状的。
 * 这一层同 `permission-code-holders.spec.ts` 的教训,复用同一个提取器,不新造第四份正则。
 *
 * ─── 与既有判据的分工(不重复执法)────────────────────────────────────────
 * - 「码必须有持有人」+「保留码确实零持有」 → `permission-code-holders.spec.ts`
 * - 「各桶并集 == 权限码全集」 → `permission-catalog-closure.spec.ts`
 * - 「运行时 DB 行 == 清单」 → `test/e2e/seed-permission-catalog-runtime.e2e-spec.ts`
 */
import {
  CRITICAL_RISK_TAGS,
  IDENTITY_ISSUANCE_PERMISSION_CODES,
  PERMISSION_CATALOG_GROUPS,
  PERMISSION_CATALOG_METADATA,
  PERMISSION_CATALOG_SECTIONS,
  PERMISSION_CATALOG_STATUSES,
  PERMISSION_GRANT_POLICIES,
  PERMISSION_RISK_LEVELS,
  PERMISSION_RISK_TAGS,
  PERMISSION_UI_VISIBILITIES,
} from '../src/modules/permissions/permission-catalog';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET } from '../src/modules/permissions/reserved-super-admin-permission-codes';
import {
  SEED_FACTS_CLOSURE,
  extractSeedFactsPermissionCodesAst,
  readSeedFactsClosure,
} from './docs-counts';

type MetadataEntry = (typeof PERMISSION_CATALOG_METADATA)[string];
type Entry = readonly [string, MetadataEntry];

/**
 * 地板锚点。**刻意不写「恰 237 条」** —— 那会让每次新增权限码都要改判据,
 * 而「改判据才能过」正是判据失效的起点。地板只负责回答「扫描面塌没塌」。
 */
export const UNIVERSE_FLOOR = 200;

/** 权限码形状锚点:3-4 段小写。用来证明全集里装的确实是权限码而不是别的什么。 */
const PERMISSION_CODE_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/;

/**
 * 扫描面锚点 —— 这两类最容易被过滤器吃掉,是「具名子集冒充闭包」的第一批牺牲者。
 *   · 动态拼的:`attachment.delete.${ownerType}` 在 src 里 grep 字面量为 0;
 *   · flag-gated 且零持有的:具名子集当全集时第一个消失的就是它。
 */
export const UNIVERSE_ANCHOR_CODES = [
  'attachment.delete.member.other',
  'activity-responsibility.override.record',
];

/** ⑤ 旧 Permission 写 CRUD 仍须 ACTIVE(退役由 PR 8 前提触发,不定死日期)。 */
export const LEGACY_PERMISSION_CRUD_CODES = [
  'rbac.permission.create',
  'rbac.permission.update',
  'rbac.permission.delete',
];

/** 权限码全集 = seed 事实闭包的 typed-AST 提取。动态发现,不写死条数。 */
export function permissionUniverse(): ReadonlySet<string> {
  return extractSeedFactsPermissionCodesAst(readSeedFactsClosure(SEED_FACTS_CLOSURE));
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** 失败信息恒点名到具体权限码;`expect([]).toEqual([])` 的 diff 会把码打出来。 */
function offenders(entries: readonly Entry[], isBad: (meta: MetadataEntry) => boolean): string[] {
  return entries
    .filter(([, meta]) => isBad(meta))
    .map(([code]) => code)
    .sort();
}

export interface CatalogMetadataReport {
  universeSize: number;
  metadataCount: number;
  activeCount: number;
  sectionCount: number;
  groupCount: number;
  criticalTagCount: number;
  identityIssuanceCount: number;

  // ── 自证 ──────────────────────────────────────────────────────────────
  malformedUniverseCodes: string[];
  missingUniverseAnchors: string[];
  orphanGroups: string[];
  unknownCriticalRiskTags: string[];
  staleIdentityIssuanceCodes: string[];

  // ── 覆盖完整性(双向集合相等)────────────────────────────────────────
  missingMetadata: string[];
  orphanMetadata: string[];

  // ── 每条 ACTIVE 的字段完整且取值合法 ────────────────────────────────
  blankDisplayName: string[];
  blankBusinessDescription: string[];
  unknownSection: string[];
  unknownGroup: string[];
  sectionGroupMismatch: string[];
  badSortOrder: string[];
  unknownRiskLevel: string[];
  unknownGrantPolicy: string[];
  unknownUiVisibility: string[];
  emptyRiskTags: string[];
  duplicateRiskTags: string[];
  unknownRiskTags: string[];
  badReadWriteExclusivity: string[];
  unknownStatus: string[];

  // ── 维护者 2026-08-22 拍板结论的执行位 ──────────────────────────────
  criticalUnderstated: string[];
  criticalOverstated: string[];
  controlPlaneOnReadCode: string[];
  declaredSuperAdminOnly: string[];
  reservedSuperAdminOnly: string[];
  visibleReservedCodes: string[];
  leakedScopeProfile: string[];
  legacyCrudNotActive: string[];
}

export function analyzeCatalogMetadata(): CatalogMetadataReport {
  const universe = permissionUniverse();
  const sectionCodes = new Set(PERMISSION_CATALOG_SECTIONS.map((s) => s.code));
  const groupByCode = new Map(PERMISSION_CATALOG_GROUPS.map((g) => [g.code, g]));

  const metadataEntries = Object.entries(PERMISSION_CATALOG_METADATA) as Entry[];
  const activeEntries = metadataEntries.filter(([, meta]) => meta.status === 'ACTIVE');

  const shouldBeCritical = (code: string, tags: readonly string[]): boolean =>
    tags.some((t) => (CRITICAL_RISK_TAGS as readonly string[]).includes(t)) ||
    IDENTITY_ISSUANCE_PERMISSION_CODES.includes(code);

  const anchors = [...UNIVERSE_ANCHOR_CODES, ...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET];

  return {
    universeSize: universe.size,
    metadataCount: metadataEntries.length,
    activeCount: activeEntries.length,
    sectionCount: PERMISSION_CATALOG_SECTIONS.length,
    groupCount: PERMISSION_CATALOG_GROUPS.length,
    criticalTagCount: CRITICAL_RISK_TAGS.length,
    identityIssuanceCount: IDENTITY_ISSUANCE_PERMISSION_CODES.length,

    malformedUniverseCodes: [...universe].filter((code) => !PERMISSION_CODE_SHAPE.test(code)).sort(),
    missingUniverseAnchors: anchors.filter((code) => !universe.has(code)).sort(),
    orphanGroups: PERMISSION_CATALOG_GROUPS.filter((g) => !sectionCodes.has(g.sectionCode))
      .map((g) => g.code)
      .sort(),
    // 标签族必须是冻结稿枚举里的值,不能是拼错的字符串(拼错 ⇒ 恒不命中 ⇒ 判据静默失效)。
    unknownCriticalRiskTags: CRITICAL_RISK_TAGS.filter(
      (t) => !(PERMISSION_RISK_TAGS as readonly string[]).includes(t),
    )
      .map(String)
      .sort(),
    // 身份签发清单不得留过期条目(码被改名 / 删掉后仍挂在这里 ⇒ 它守着一条不存在的码)。
    staleIdentityIssuanceCodes: IDENTITY_ISSUANCE_PERMISSION_CODES.filter(
      (c) => !universe.has(c),
    ).sort(),

    missingMetadata: [...universe].filter((code) => !(code in PERMISSION_CATALOG_METADATA)).sort(),
    orphanMetadata: metadataEntries
      .map(([code]) => code)
      .filter((code) => !universe.has(code))
      .sort(),

    // ⚠️ 完整性只管 ACTIVE:退役码(DEPRECATED / INTERNAL)不受本组判据管辖,
    //    否则「想退役一条码」会变成「先把它的元数据补全」,退役码就永远删不掉了。
    //    但**存在性**对所有状态都要求(上一组),所以退役码不会从视野里消失。
    blankDisplayName: offenders(activeEntries, (m) => isBlank(m.displayName)),
    blankBusinessDescription: offenders(activeEntries, (m) => isBlank(m.businessDescription)),
    unknownSection: offenders(activeEntries, (m) => !sectionCodes.has(m.sectionCode)),
    unknownGroup: offenders(activeEntries, (m) => !groupByCode.has(m.groupCode)),
    // 分组自己声明的 sectionCode 必须与条目上写的一致 —— 否则条目会在 UI 上挂错分区,
    // 而两个字段各自都「合法」,单看任一个都发现不了。
    sectionGroupMismatch: offenders(
      activeEntries,
      (m) => groupByCode.get(m.groupCode)?.sectionCode !== m.sectionCode,
    ),
    // 0 会被消费方的 `if (!sortOrder)` 当成缺值。
    badSortOrder: offenders(
      activeEntries,
      (m) => !Number.isInteger(m.sortOrder) || m.sortOrder <= 0,
    ),
    unknownRiskLevel: offenders(
      activeEntries,
      (m) => !(PERMISSION_RISK_LEVELS as readonly string[]).includes(m.riskLevel),
    ),
    unknownGrantPolicy: offenders(
      activeEntries,
      (m) => !(PERMISSION_GRANT_POLICIES as readonly string[]).includes(m.grantPolicy),
    ),
    unknownUiVisibility: offenders(
      activeEntries,
      (m) => !(PERMISSION_UI_VISIBILITIES as readonly string[]).includes(m.uiVisibility),
    ),
    emptyRiskTags: offenders(activeEntries, (m) => m.riskTags.length === 0),
    duplicateRiskTags: offenders(
      activeEntries,
      (m) => new Set(m.riskTags).size !== m.riskTags.length,
    ),
    unknownRiskTags: offenders(activeEntries, (m) =>
      m.riskTags.some((t) => !(PERMISSION_RISK_TAGS as readonly string[]).includes(t)),
    ),
    // 每条恰好带 READ 或 WRITE 之一(读写性质不许留空,也不许自相矛盾)。
    badReadWriteExclusivity: offenders(
      activeEntries,
      (m) => m.riskTags.filter((t) => t === 'READ' || t === 'WRITE').length !== 1,
    ),
    // 所有状态取值合法(含退役码 —— 它们不做完整性检查,但状态本身必须能被认出来)。
    unknownStatus: offenders(
      metadataEntries,
      (m) => !(PERMISSION_CATALOG_STATUSES as readonly string[]).includes(m.status),
    ),

    // ① CRITICAL 恰好等于「五族」:带 CRITICAL 标签族之一,或在身份签发清单里。
    criticalUnderstated: activeEntries
      .filter(([code, m]) => shouldBeCritical(code, m.riskTags) && m.riskLevel !== 'CRITICAL')
      .map(([code]) => code)
      .sort(),
    criticalOverstated: activeEntries
      .filter(([code, m]) => m.riskLevel === 'CRITICAL' && !shouldBeCritical(code, m.riskTags))
      .map(([code]) => code)
      .sort(),
    // ① CONTROL_PLANE 只贴给写侧(贴到只读码上会把「查看谁有什么角色」升成最高危)。
    controlPlaneOnReadCode: offenders(
      activeEntries,
      (m) => m.riskTags.includes('CONTROL_PLANE') && m.riskTags.includes('READ'),
    ),
    // ② 授予策略 SUPER_ADMIN_ONLY 的集合,恰等于正在执法的 SA-only 保留码集合。
    // 🔴 复用权威集合,不抄第二份清单 —— 抄一份就是造第二个事实源,两份可以各自漂移。
    declaredSuperAdminOnly: metadataEntries
      .filter(([, m]) => m.grantPolicy === 'SUPER_ADMIN_ONLY')
      .map(([code]) => code)
      .sort(),
    reservedSuperAdminOnly: [...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET].sort(),
    // ② 保留码在角色编辑器里不露面(HIDDEN)—— 露面就等于邀请人去授它。
    visibleReservedCodes: metadataEntries
      .filter(
        ([code, m]) =>
          RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code) && m.uiVisibility !== 'HIDDEN',
      )
      .map(([code]) => code)
      .sort(),
    // ③ 本期不出 scopeProfile 字段(Scope 首版只提示;字段在就会被当成强校验依据)。
    leakedScopeProfile: metadataEntries
      .filter(([, m]) => 'scopeProfile' in (m as unknown as Record<string, unknown>))
      .map(([code]) => code)
      .sort(),
    legacyCrudNotActive: LEGACY_PERMISSION_CRUD_CODES.filter(
      (code) => PERMISSION_CATALOG_METADATA[code]?.status !== 'ACTIVE',
    ).sort(),
  };
}

/**
 * 自证:全集扫不到东西 / 元数据表被清空时,判据必须当场红,
 * 而不是「没有可检查的项 ⇒ 全过」。「判据失去输入 ≠ 通过」。
 */
export function selfCheck(report: CatalogMetadataReport): string[] {
  const problems: string[] = [];

  if (report.universeSize < UNIVERSE_FLOOR) {
    problems.push(`权限码全集只有 ${report.universeSize} 条,地板是 ${UNIVERSE_FLOOR} —— 扫描面塌了。`);
  }
  if (report.metadataCount < UNIVERSE_FLOOR) {
    problems.push(`元数据表只有 ${report.metadataCount} 条,地板是 ${UNIVERSE_FLOOR}。`);
  }
  if (report.activeCount < UNIVERSE_FLOOR) {
    problems.push(`ACTIVE 条目只有 ${report.activeCount} 条,地板是 ${UNIVERSE_FLOOR}。`);
  }
  if (report.sectionCount <= 0) problems.push('业务区注册表为空。');
  if (report.groupCount <= 0) problems.push('分组注册表为空。');
  if (report.criticalTagCount <= 0) problems.push('CRITICAL 标签族为空 ⇒ ① 判据恒不命中。');
  if (report.identityIssuanceCount <= 0) problems.push('身份签发清单为空 ⇒ ① 判据少一半输入。');

  if (report.malformedUniverseCodes.length > 0) {
    problems.push(`全集里混进了不是权限码的东西:${report.malformedUniverseCodes.join(' ')}`);
  }
  if (report.missingUniverseAnchors.length > 0) {
    problems.push(
      `扫描面锚点丢失:${report.missingUniverseAnchors.join(' ')} —— ` +
        '全集被换成了具名子集(动态拼接码 / flag-gated 码 / 保留码是第一批牺牲者)。',
    );
  }
  if (report.orphanGroups.length > 0) {
    problems.push(`分组挂在未声明的业务区下:${report.orphanGroups.join(' ')}`);
  }
  if (report.unknownCriticalRiskTags.length > 0) {
    problems.push(
      `CRITICAL 标签族里有拼错的值:${report.unknownCriticalRiskTags.join(' ')}(恒不命中 ⇒ 判据静默失效)。`,
    );
  }
  if (report.staleIdentityIssuanceCodes.length > 0) {
    problems.push(`身份签发清单里有已不存在的码:${report.staleIdentityIssuanceCodes.join(' ')}`);
  }

  return problems;
}

function main(): void {
  const report = analyzeCatalogMetadata();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  const buckets: [string, string[]][] = [
    ['全集里的码没有元数据条目(新增码不填元数据)', report.missingMetadata],
    ['元数据表里有全集之外的孤儿条目', report.orphanMetadata],
    ['中文名为空', report.blankDisplayName],
    ['人话说明为空', report.blankBusinessDescription],
    ['sectionCode 未登记', report.unknownSection],
    ['groupCode 未登记', report.unknownGroup],
    ['分组与条目的 sectionCode 不一致', report.sectionGroupMismatch],
    ['sortOrder 不是正整数', report.badSortOrder],
    ['风险等级不在枚举内', report.unknownRiskLevel],
    ['授予策略不在枚举内', report.unknownGrantPolicy],
    ['可见性不在枚举内', report.unknownUiVisibility],
    ['风险标签为空', report.emptyRiskTags],
    ['风险标签有重复', report.duplicateRiskTags],
    ['风险标签不在枚举内', report.unknownRiskTags],
    ['未恰好带 READ / WRITE 之一', report.badReadWriteExclusivity],
    ['状态取值不合法', report.unknownStatus],
    ['该是 CRITICAL 却没标', report.criticalUnderstated],
    ['标了 CRITICAL 却不属于五族', report.criticalOverstated],
    ['CONTROL_PLANE 贴到了只读码上', report.controlPlaneOnReadCode],
    ['保留码在角色编辑器里露面(应为 HIDDEN)', report.visibleReservedCodes],
    ['本期不该出现的 scopeProfile 字段', report.leakedScopeProfile],
    ['旧 Permission 写 CRUD 不再是 ACTIVE', report.legacyCrudNotActive],
  ];

  let broken = problems.length;
  for (const [label, codes] of buckets) {
    if (codes.length === 0) continue;
    broken += codes.length;
    console.error(`🔴 ${label}:${codes.join(' ')}`);
  }

  const declared = report.declaredSuperAdminOnly.join(' ');
  const reserved = report.reservedSuperAdminOnly.join(' ');
  if (declared !== reserved) {
    broken += 1;
    console.error(`🔴 SUPER_ADMIN_ONLY 集合与保留码集合不等:\n  元数据侧:${declared}\n  保留码侧:${reserved}`);
  }

  if (broken === 0) {
    console.log(
      `✓ 权限元数据完整(全集 ${report.universeSize} 条 / ACTIVE ${report.activeCount} 条)。`,
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();

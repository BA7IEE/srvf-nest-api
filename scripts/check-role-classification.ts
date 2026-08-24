/**
 * check-role-classification.ts —— 角色分类三字段与权限目录只读投影的执行位(P1-32 PR 2)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:`src/**\/*.spec.ts` 不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(`src/modules/permissions/role-classification.criteria.spec.ts`),
 *    这条现在由 `scripts/check-criteria-spec-purity.ts` 机器执法。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这条闸修的是哪一类缺陷
 *
 * PR 2 把「这个角色能不能改」做成了**响应字段**(`kind` / `permissionManagementMode` /
 * `bindingManagementMode`),给前端把权限编辑器置灰用。危险的形状不是「今天填错了」,
 * 而是**展示口径与执法口径分家**:
 *
 *   · 后台显示「可改」而接口拒(30107 / 30108)⇒ 用户点了才知道,像 bug;
 *   · 后台显示「只读」而接口放行 ⇒ **更糟**,系统角色被改掉却没人拦。
 *
 * 两种都**没有任何症状**:分类是派生的,漂了不会有编译错误、不会有测试红。
 * ⇒ 本闸把「派生结果 == 正在执法的谓词」钉成不变量,并且**两向**都钉
 * (该只读的全只读 / 不该只读的没被标成只读)。单向的「至少一处」型判据在
 * 第二个采纳者之后会失明,本仓已记录过那个形状。
 *
 * 同理目录侧:DoD 是「目录中文可用」。判据不验「今天这 237 条都有说明」,
 * 而验**响应体本身**(直接跑 `buildPermissionCatalog()`)——
 * 把说明字段从投影里删掉、把扫描面改塌,都当场红并点名。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 地板不写「恰 N」
 *
 * 内建角色 ≥15、目录条目 ≥200、系统托管角色 ≥3。写死「恰 237」会让每次新增权限码
 * 都要改判据,而「改判据才能过」正是判据失效的起点;地板只负责回答「扫描面塌没塌」,
 * 同时是一条**删除棘轮**(把清单删空 ⇒ 当场红,而不是「没有违规所以全绿」)。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import * as catalogModule from '../src/modules/permissions/permission-catalog';
import {
  PERMISSION_CATALOG_GROUPS,
  PERMISSION_CATALOG_METADATA,
  PERMISSION_CATALOG_SECTIONS,
} from '../src/modules/permissions/permission-catalog';
import {
  buildPermissionCatalog,
  permissionSeedIndex,
} from '../src/modules/permissions/permission-catalog.presenter';
import { PROTECTED_ROLE_CODES } from '../src/modules/permissions/protected-role-codes';
import { classifyRole } from '../src/modules/permissions/role-classification';
import { SYSTEM_MANAGED_ROLE_CODES } from '../src/modules/permissions/system-managed-role-codes';

const ROOT = path.resolve(__dirname, '..');

/** 内建角色地板。冻结稿 §6.2 说的是「所有 `PROTECTED_ROLE_CODES`」,今天是 15 个。 */
export const BUILTIN_ROLE_FLOOR = 15;

/** 系统托管(只能由活动责任投影器写)角色地板。冻结稿 §6.2 点名三个。 */
export const SYSTEM_MANAGED_ROLE_FLOOR = 3;

/** 目录条目地板。与 `check-permission-catalog-metadata.ts` 的 `UNIVERSE_FLOOR` 同值同理由。 */
export const CATALOG_ITEM_FLOOR = 200;

/**
 * 反向对照探针 —— **不是**内建角色的 code。
 *
 * 🔴 没有它,整条判据可以被一行「恒返回 SYSTEM / RELEASE_MANAGED」骗过:
 *    正向断言(内建角色都只读)会全绿,而所有自定义角色也被标成了只读。
 *    反向样本必须在**被测那一维上**单独不同,这是本仓记录过的教训。
 *
 * 刻意用合成名而不是仓内某个真实自定义角色:真角色可能哪天被收编进内建清单,
 * 那时判据会以「探针失效」的形态红在一个与本次改动无关的地方。
 */
export const CUSTOM_ROLE_PROBES = ['harness-probe-custom-role', 'harness-probe-another-role'];

/** 分类派生处 —— 本闸对它做「不许出现角色 code 字面量」的 AST 扫描。 */
export const CLASSIFICATION_SOURCE = 'src/modules/permissions/role-classification.ts';

/** 目录条目里**必须非空**的字段。删掉任一个都会被点名。 */
export const REQUIRED_ITEM_FIELDS = [
  'code',
  'displayName',
  'businessDescription',
  'module',
  'action',
  'resourceType',
  'sectionCode',
  'groupCode',
  'riskLevel',
  'grantPolicy',
  'status',
  'uiVisibility',
];

export interface RoleClassificationReport {
  // ── 读数(自证用)──────────────────────────────────────────────────────
  builtinRoleCount: number;
  systemManagedRoleCount: number;
  catalogItemCount: number;
  declaredTotalItems: number;
  sectionCount: number;
  groupCount: number;
  seedIndexSize: number;

  // ── 自证 ────────────────────────────────────────────────────────────────
  systemManagedOutsideBuiltin: string[];
  customProbeMisclassified: string[];
  classificationSourceUnreadable: string[];

  // ── 分类 == 正在执法的谓词(两向)────────────────────────────────────
  builtinNotSystemKind: string[];
  builtinNotReleaseManaged: string[];
  customMarkedSystemKind: string[];
  customMarkedReleaseManaged: string[];
  systemManagedNotSystemOnly: string[];
  nonSystemManagedMarkedSystemOnly: string[];

  /** 分类文件里出现了内建角色 code 字面量 ⇒ 造了第二份清单。 */
  hardcodedRoleCodeLiterals: string[];

  // ── 目录只读投影(直接跑响应体)────────────────────────────────────
  /** `<code>#<field>` 形态:响应条目缺字段或字段为空。 */
  itemFieldsMissingOrBlank: string[];
  duplicateItemCodes: string[];
  itemsMissingFromMetadata: string[];
  metadataMissingFromItems: string[];
  seedIndexMissingFromMetadata: string[];
  metadataMissingFromSeedIndex: string[];
  inconsistentSeedDefinitions: string[];
  moduleNotFirstSegment: string[];
  emptyGroups: string[];
  itemInWrongGroup: string[];
  totalItemsMismatch: string[];
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** 扫 `role-classification.ts` 的字符串字面量,看有没有抄进角色 code。 */
function scanHardcodedRoleCodes(): { offenders: string[]; unreadable: string[] } {
  const abs = path.join(ROOT, CLASSIFICATION_SOURCE);
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    // fail-closed:文件被改名 / 搬走 ⇒ 判据失去被测对象,当场红而不是「没有违规」。
    return { offenders: [], unreadable: [CLASSIFICATION_SOURCE] };
  }
  const banned = new Set<string>([...PROTECTED_ROLE_CODES, ...SYSTEM_MANAGED_ROLE_CODES]);
  const file = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);
  const offenders = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (banned.has(node.text)) offenders.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return { offenders: sorted(offenders), unreadable: [] };
}

export function analyzeRoleClassification(): RoleClassificationReport {
  const builtin = [...PROTECTED_ROLE_CODES];
  const systemManaged = [...SYSTEM_MANAGED_ROLE_CODES];
  const builtinSet = new Set<string>(builtin);
  const systemManagedSet = new Set<string>(systemManaged);

  const builtinNotSystemKind: string[] = [];
  const builtinNotReleaseManaged: string[] = [];
  const systemManagedNotSystemOnly: string[] = [];
  const nonSystemManagedMarkedSystemOnly: string[] = [];
  const customMarkedSystemKind: string[] = [];
  const customMarkedReleaseManaged: string[] = [];
  const customProbeMisclassified: string[] = [];

  for (const code of builtin) {
    const cls = classifyRole(code);
    if (cls.kind !== 'SYSTEM') builtinNotSystemKind.push(code);
    if (cls.permissionManagementMode !== 'RELEASE_MANAGED') builtinNotReleaseManaged.push(code);
    if (!systemManagedSet.has(code) && cls.bindingManagementMode === 'SYSTEM_ONLY') {
      nonSystemManagedMarkedSystemOnly.push(code);
    }
  }

  for (const code of systemManaged) {
    if (classifyRole(code).bindingManagementMode !== 'SYSTEM_ONLY') {
      systemManagedNotSystemOnly.push(code);
    }
  }

  for (const code of CUSTOM_ROLE_PROBES) {
    const cls = classifyRole(code);
    if (cls.kind === 'SYSTEM') customMarkedSystemKind.push(code);
    if (cls.permissionManagementMode === 'RELEASE_MANAGED') customMarkedReleaseManaged.push(code);
    if (cls.bindingManagementMode === 'SYSTEM_ONLY') nonSystemManagedMarkedSystemOnly.push(code);
    if (
      cls.kind !== 'CUSTOM' ||
      cls.permissionManagementMode !== 'ADMIN_EDITABLE' ||
      cls.bindingManagementMode !== 'MANUAL_ALLOWED'
    ) {
      customProbeMisclassified.push(
        `${code} → ${cls.kind}/${cls.permissionManagementMode}/${cls.bindingManagementMode}`,
      );
    }
  }

  const hardcoded = scanHardcodedRoleCodes();

  // ── 目录只读投影:跑真响应体 ────────────────────────────────────────
  const catalog = buildPermissionCatalog();
  const groupSectionByCode = new Map(PERMISSION_CATALOG_GROUPS.map((g) => [g.code, g.sectionCode]));

  const itemFieldsMissingOrBlank: string[] = [];
  const duplicateItemCodes: string[] = [];
  const itemInWrongGroup: string[] = [];
  const emptyGroups: string[] = [];
  const seenCodes = new Set<string>();
  let catalogItemCount = 0;

  for (const section of catalog.sections) {
    for (const group of section.groups) {
      if (group.items.length === 0) emptyGroups.push(`${section.code}/${group.code}`);
      if (groupSectionByCode.get(group.code) !== section.code) {
        itemInWrongGroup.push(`group:${group.code}@${section.code}`);
      }
      for (const item of group.items) {
        catalogItemCount += 1;
        const bag = item as unknown as Record<string, unknown>;
        const code = typeof bag.code === 'string' ? bag.code : '<no-code>';
        for (const field of REQUIRED_ITEM_FIELDS) {
          if (isBlank(bag[field])) itemFieldsMissingOrBlank.push(`${code}#${field}`);
        }
        if (!Array.isArray(bag.riskTags) || (bag.riskTags as unknown[]).length === 0) {
          itemFieldsMissingOrBlank.push(`${code}#riskTags`);
        }
        if (typeof bag.sortOrder !== 'number' || !Number.isInteger(bag.sortOrder)) {
          itemFieldsMissingOrBlank.push(`${code}#sortOrder`);
        }
        if (seenCodes.has(code)) duplicateItemCodes.push(code);
        seenCodes.add(code);
        if (bag.groupCode !== group.code || bag.sectionCode !== section.code) {
          itemInWrongGroup.push(`${code}@${section.code}/${group.code}`);
        }
      }
    }
  }

  const metadataCodes = new Set(Object.keys(PERMISSION_CATALOG_METADATA));
  const seedIndex = permissionSeedIndex();

  // 同一个 code 在两个数组里被写成了不同的定义 —— 聚合数组是对子数组的 spread,
  // 正常情况下重复项指向同一个对象;出现两份不同的三元组就是有人另抄了一份。
  //
  // 🔴 **刻意只比「同码是否自相矛盾」,不按点分段拆 code 反推 action / resourceType。**
  //    `rbac.*` 族的 action 与 resourceType 相对第 2/3 段是**反序**的
  //    (`rbac.permission.read` → action=`read` / resourceType=`permission`),
  //    `user.phone.clear` 同理(action=`clear` / resourceType=`phone`)。
  //    起草本闸时照 D2 v1.2 的 `<module>.<action>.<resource_type>` 字面推,当场误判 18 条。
  //    唯一稳的一维是 `module` == 第一段(实测 237/237 成立),下面单独守它。
  const definitionsByCode = new Map<string, Set<string>>();
  const moduleNotFirstSegment: string[] = [];
  for (const [exportName, exported] of Object.entries(catalogModule)) {
    if (!exportName.endsWith('_PERMISSION_SEED')) continue;
    if (!Array.isArray(exported)) continue;
    for (const entry of exported as ReadonlyArray<{
      code: string;
      module: string;
      action: string;
      resourceType: string;
    }>) {
      const shape = `${entry.module}|${entry.action}|${entry.resourceType}`;
      const bucket = definitionsByCode.get(entry.code);
      if (bucket === undefined) definitionsByCode.set(entry.code, new Set([shape]));
      else bucket.add(shape);
    }
  }
  const inconsistentSeedDefinitions: string[] = [];
  for (const [code, shapes] of definitionsByCode) {
    if (shapes.size > 1) inconsistentSeedDefinitions.push(`${code}(${[...shapes].join(' vs ')})`);
  }
  for (const [code, seed] of seedIndex) {
    if (seed.module !== code.split('.')[0]) {
      moduleNotFirstSegment.push(`${code}(module=${seed.module})`);
    }
  }

  const totalItemsMismatch: string[] =
    catalog.totalItems === catalogItemCount
      ? []
      : [`totalItems=${catalog.totalItems} 与实际条目 ${catalogItemCount} 不符`];

  return {
    builtinRoleCount: builtin.length,
    systemManagedRoleCount: systemManaged.length,
    catalogItemCount,
    declaredTotalItems: catalog.totalItems,
    sectionCount: PERMISSION_CATALOG_SECTIONS.length,
    groupCount: PERMISSION_CATALOG_GROUPS.length,
    seedIndexSize: seedIndex.size,

    systemManagedOutsideBuiltin: sorted(systemManaged.filter((c) => !builtinSet.has(c))),
    customProbeMisclassified: sorted(customProbeMisclassified),
    classificationSourceUnreadable: hardcoded.unreadable,

    builtinNotSystemKind: sorted(builtinNotSystemKind),
    builtinNotReleaseManaged: sorted(builtinNotReleaseManaged),
    customMarkedSystemKind: sorted(customMarkedSystemKind),
    customMarkedReleaseManaged: sorted(customMarkedReleaseManaged),
    systemManagedNotSystemOnly: sorted(systemManagedNotSystemOnly),
    nonSystemManagedMarkedSystemOnly: sorted(new Set(nonSystemManagedMarkedSystemOnly)),
    hardcodedRoleCodeLiterals: hardcoded.offenders,

    itemFieldsMissingOrBlank: sorted(itemFieldsMissingOrBlank),
    duplicateItemCodes: sorted(duplicateItemCodes),
    itemsMissingFromMetadata: sorted([...seenCodes].filter((c) => !metadataCodes.has(c))),
    metadataMissingFromItems: sorted([...metadataCodes].filter((c) => !seenCodes.has(c))),
    seedIndexMissingFromMetadata: sorted([...seedIndex.keys()].filter((c) => !metadataCodes.has(c))),
    metadataMissingFromSeedIndex: sorted([...metadataCodes].filter((c) => !seedIndex.has(c))),
    inconsistentSeedDefinitions: sorted(inconsistentSeedDefinitions),
    moduleNotFirstSegment: sorted(moduleNotFirstSegment),
    emptyGroups: sorted(emptyGroups),
    itemInWrongGroup: sorted(itemInWrongGroup),
    totalItemsMismatch,
  };
}

/**
 * 自证 —— 先证明仪器没瞎,再报数。
 *
 * 「判据失去输入 ≠ 通过」:清单被删空 / 目录扫描面塌了 / 反向探针被收编成内建角色 /
 * 分类文件被搬走,四种形态都会让下面的正向断言**全部变成空集比空集**(全绿而毫无保障)。
 */
export function selfCheck(report: RoleClassificationReport): string[] {
  const problems: string[] = [];

  if (report.builtinRoleCount < BUILTIN_ROLE_FLOOR) {
    problems.push(
      `内建角色清单只有 ${report.builtinRoleCount} 条,地板是 ${BUILTIN_ROLE_FLOOR} —— 扫描面塌了。`,
    );
  }
  if (report.systemManagedRoleCount < SYSTEM_MANAGED_ROLE_FLOOR) {
    problems.push(
      `系统托管角色只有 ${report.systemManagedRoleCount} 条,地板是 ${SYSTEM_MANAGED_ROLE_FLOOR}。`,
    );
  }
  if (report.catalogItemCount < CATALOG_ITEM_FLOOR) {
    problems.push(
      `目录只投影出 ${report.catalogItemCount} 条,地板是 ${CATALOG_ITEM_FLOOR} —— 目录扫描面塌了。`,
    );
  }
  if (report.seedIndexSize < CATALOG_ITEM_FLOOR) {
    problems.push(
      `权限码定义索引只有 ${report.seedIndexSize} 条,地板是 ${CATALOG_ITEM_FLOOR} —— ` +
        '按导出名后缀反射取并集的那一步塌了(具名子集冒充闭包)。',
    );
  }
  if (report.sectionCount <= 0) problems.push('业务区注册表为空。');
  if (report.groupCount <= 0) problems.push('分组注册表为空。');
  if (CUSTOM_ROLE_PROBES.length <= 0) problems.push('反向对照探针为空 ⇒ 反向断言恒不命中。');

  if (report.systemManagedOutsideBuiltin.length > 0) {
    problems.push(
      `系统托管角色不在内建清单里:${report.systemManagedOutsideBuiltin.join(' ')} —— ` +
        '两份清单已经开始各自漂移。',
    );
  }
  if (report.customProbeMisclassified.length > 0) {
    problems.push(
      `反向探针没有被判成自定义角色:${report.customProbeMisclassified.join(' ')} —— ` +
        '分类可能被改成了「恒返回 SYSTEM」,正向断言会全绿而毫无意义。',
    );
  }
  if (report.classificationSourceUnreadable.length > 0) {
    problems.push(
      `分类派生处读不到:${report.classificationSourceUnreadable.join(' ')} —— ` +
        '文件被改名或搬走,「不许抄清单」那条扫描已失去被测对象。',
    );
  }

  return problems;
}

function main(): void {
  const report = analyzeRoleClassification();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  const buckets: [string, string[]][] = [
    ['内建角色的 kind 不是 SYSTEM', report.builtinNotSystemKind],
    [
      '内建角色的权限集被标成可改(与 30108 闸相反)',
      report.builtinNotReleaseManaged,
    ],
    ['自定义角色被标成 SYSTEM', report.customMarkedSystemKind],
    ['自定义角色的权限集被标成只读', report.customMarkedReleaseManaged],
    ['系统托管角色的绑定没被标成 SYSTEM_ONLY', report.systemManagedNotSystemOnly],
    ['非系统托管角色被标成 SYSTEM_ONLY', report.nonSystemManagedMarkedSystemOnly],
    ['分类文件里抄了角色 code 字面量(第二份清单)', report.hardcodedRoleCodeLiterals],
    ['目录条目缺字段或字段为空', report.itemFieldsMissingOrBlank],
    ['目录里有重复权限码', report.duplicateItemCodes],
    ['目录条目不在元数据表里', report.itemsMissingFromMetadata],
    ['元数据表里的码没进目录响应', report.metadataMissingFromItems],
    ['权限码定义有而元数据没有', report.seedIndexMissingFromMetadata],
    ['元数据有而权限码定义没有', report.metadataMissingFromSeedIndex],
    ['同一权限码有两份互相矛盾的定义', report.inconsistentSeedDefinitions],
    ['权限码定义的 module 与码的第一段不符', report.moduleNotFirstSegment],
    ['注册了却没有任何条目的分组', report.emptyGroups],
    ['条目挂错分组 / 业务区', report.itemInWrongGroup],
    ['totalItems 与实际条目数不符', report.totalItemsMismatch],
  ];

  let broken = problems.length;
  for (const [label, offenders] of buckets) {
    if (offenders.length === 0) continue;
    broken += offenders.length;
    console.error(`🔴 ${label}:${offenders.join(' ')}`);
  }

  if (broken === 0) {
    console.log(
      `✓ 角色分类与权限目录一致(内建角色 ${report.builtinRoleCount} 个 / 目录 ${report.catalogItemCount} 条)。`,
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();

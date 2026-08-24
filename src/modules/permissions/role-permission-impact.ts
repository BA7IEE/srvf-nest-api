/**
 * 角色权限集变更的**影响汇总** —— 纯函数,零 DB,零判定(P1-32 PR 5;冻结稿 §11)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 这个文件回答的是「这次变更会波及多少条授予」,**不回答「这次变更能不能过」**
 *
 * 「能不能过」只有一个答案来源:`RolePermissionsService.runReplaceSet()`(4b 落地的同源判定)。
 * 本文件是**投影**:把「当前有多少条授予指向这个角色」按 `authz.service.collectGrants()`
 * 的三源口径数出来。它一条判定都不做,也**不参与** step-up 是否必需
 * (冻结稿 §12.1 最后一条「按绑定数量强制 step-up」需业务拍板阈值,本刀刻意不做 ——
 *  见 `role-permission-step-up.policy.ts` 头注)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **本期只出「授予数」,不出「受影响账号数」** —— 这是架构切法,不是省事
 *
 * 冻结稿 §9.3 / §11.4 的示例里有 `estimatedAffectedUserCount`。**本刀刻意不出它**,理由:
 *
 * 「谁被授予了这个角色」是 **platform-access 自己的事实**(`RoleBinding` /
 * `OrganizationPositionRolePolicy` 都归本域);
 * 「那条授予对应哪个账号、账号还活着没有」是 **identity-org 的事实**
 * (`OrganizationPositionAssignment` / `User`)。
 * 而 `harness/domain-map.json` 的 `allowedEdges` 里 **`platform-access → identity-org`
 * 一条都没有**(方向恒为 identity-org → platform-access):本域直读那些模型是架构反向,
 * 会当场触 `docs:boundaries:newdebt:check` 的「禁新增代码债」棘轮。
 *
 * ⇒ 与其越过边界拿一个数,不如**只报本域能证明的事实**。冻结稿 §11.4 逐字:
 *   「**不要为了显示一个好看的数字而把不确定结果写成事实。**」
 *
 * ⭐ 顺带把 exact/partial 那一格**变强了**:三源的授予数全部来自 `count()` / `groupBy()`,
 *   不依赖任何扫描上限、不需要把行取回来 ⇒ **结构上永不 PARTIAL**。
 *   (原设计要展开主体到账号,那才需要扫描上限,才会出现「下界」。)
 *
 * ⚠️ 前端要拿人数,只能等把它做成 identity-org 侧的能力(由那一域自己数,再顺着允许边给出来)。
 *   那是独立一刀,不在本刀范围内。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 三源各自为什么能标 EXACT(依据会过期,判据不会 —— 三条都由
 *    `scripts/check-role-permission-impact.ts` 钉住)
 *
 * ① **direct(`RoleBinding`,platform-access 自有)**:`roleId` 是这张表的一等列,
 *    当前有效性谓词就是 `effectiveRoleBindingWhere()`(与判权链共用的那一个)。
 *    数行 = 一次 `count`;scope / principal 分布 = 两次 `groupBy`。**全精确**。
 *
 * ② **position(`OrganizationPositionRolePolicy`,platform-access 自有)**:
 *    数的是**当前有效、指向本角色、且无 `conditionJson` 的策略条数**。
 *    ⚠️ `conditionJson !== null` 的策略被**保守跳过**,与 authz 3b 逐字同口径
 *    (fail-close,条件评估器未落地);跳过的那部分 authz 也不会为它产出 grant,不是缩水。
 *    ⚠️ **它数的是「策略条数」不是「人数」** —— 一条策略会随该职务的在任人数放大,
 *    而在任人数属 identity-org。DTO 描述里逐字写明了这一点,别把它读成人数。
 *
 * ③ **supervision(分管推导)**:⭐ **对一切可编辑角色恒为 0,且这个 0 是精确的。**
 *    分管推导在 `authz.service.ts` 里**恒定只推出一个固定角色**
 *    (`SUPERVISOR_ROLE_CODE`,见下方 `SUPERVISION_DERIVED_ROLE_CODE` 与判据的钉法),
 *    与目标 roleId 无关;而那个角色在 `PROTECTED_ROLE_CODES` 里 ⇒ 权限集 `RELEASE_MANAGED`
 *    ⇒ 任何编辑先被 30108 拦下,根本走不到影响预览。
 *    ⇒ 「supervision 源对本次变更的影响是 0」是**结构性事实**,不是「没查到」。
 *    ⚠️ 万一哪天它真的可编辑了:分管行本身归 identity-org,本域数不了 ⇒ 那时如实标
 *    `PARTIAL` + `CROSS_DOMAIN_NOT_OBSERVABLE`(见 `unobservableSource()`),
 *    **不会**悄悄继续报 0。
 */
import { BindingScopeType, PrincipalType } from '@prisma/client';

/**
 * 分管源恒定推导出的角色 code —— `authz.service.ts` 里 `SUPERVISOR_ROLE_CODE` 的 src 侧副本。
 *
 * 🔴 **为什么是副本而不是 import**:那个常量是 `authz.service.ts` 的**文件级私有** const,
 *    而 `src/modules/authz/**` 在红区(`authz-core`),给它加一个 `export` 属红区改动。
 *    本仓对这种情形的既有做法是「留 src 侧副本 + 判据钉死」。
 *    执行位:`scripts/check-role-permission-impact.ts` 用 typed-AST 从 `authz.service.ts`
 *    现取那个字面量并与本常量逐字比对,漂了当场红并点名。
 */
export const SUPERVISION_DERIVED_ROLE_CODE = 'org-supervisor';

/**
 * 精确性标注。**首版就声明全集**(契约语义门 B6:响应枚举加值算 breaking)。
 * 取值恒等于冻结稿 §11.4 的 `impactCompleteness: EXACT | PARTIAL`,一个字都不许改。
 */
export const IMPACT_COMPLETENESS_VALUES = ['EXACT', 'PARTIAL'] as const;
export type ImpactCompleteness = (typeof IMPACT_COMPLETENESS_VALUES)[number];

/**
 * `PARTIAL` 的原因码。**刻意声明成 `string | null` 而不是枚举** ——
 * 沿 `RolePermissionSetEditPolicyDto.readOnlyReason` 的既有形态(4b):
 * 单值枚举将来加值即 B6 破坏,而原因码本来就会随场景增加。
 *
 * 当前唯一取值:某一源的事实**不归本域**,本域数不出来。今天不可达
 * (唯一会命中它的角色是内建角色,编辑先返 30108),留着是为了让「哪天可达了」
 * 如实标 PARTIAL 而不是悄悄继续报 0。
 */
export const IMPACT_PARTIAL_REASON_CROSS_DOMAIN = 'CROSS_DOMAIN_NOT_OBSERVABLE';

/** 一个源的已解析事实(由查询层给出;本文件只汇总,不查库)。 */
export interface RolePermissionImpactSourceFacts {
  /**
   * 本源当前有效、指向本角色的授予数。
   * 🔴 恒来自 `count()` / `groupBy()` —— 不需要把行取回来,所以不存在扫描上限,也就没有下界。
   */
  readonly grantCount: number;
  /**
   * 本源的事实是不是**本域可观测**的。
   * `false` ⇒ 上面那个数不是真值(今天只可能出现在 supervision 那一源、且不可达)。
   */
  readonly observable: boolean;
}

/** 查询层交给本文件的全部原料。 */
export interface RolePermissionImpactFacts {
  readonly roleBinding: RolePermissionImpactSourceFacts;
  readonly positionPolicy: RolePermissionImpactSourceFacts;
  readonly supervision: RolePermissionImpactSourceFacts;
  /** 仅 direct 源的 scope 分布(`groupBy`,恒精确)。 */
  readonly scopeCounts: Readonly<Record<BindingScopeType, number>>;
  /** 仅 direct 源的主体类型分布(`groupBy`,恒精确)。 */
  readonly principalCounts: Readonly<Record<PrincipalType, number>>;
}

/** 一个源的汇总读数。 */
export interface RolePermissionImpactSourceSummary {
  readonly grantCount: number;
  readonly completeness: ImpactCompleteness;
  readonly partialReason: string | null;
}

/** 三源汇总。 */
export interface RolePermissionImpactSummary {
  readonly completeness: ImpactCompleteness;
  readonly partialReason: string | null;
  readonly totalGrantCount: number;
  readonly sources: {
    readonly roleBinding: RolePermissionImpactSourceSummary;
    readonly positionPolicy: RolePermissionImpactSourceSummary;
    readonly supervision: RolePermissionImpactSourceSummary;
  };
  readonly scopeBreakdown: Readonly<Record<BindingScopeType, number>>;
  readonly principalBreakdown: Readonly<Record<PrincipalType, number>>;
}

/** 全 0 的 scope 分布骨架 —— 键集恒为 `BindingScopeType` 全集(缺键会让前端读到 undefined)。 */
export function emptyScopeCounts(): Record<BindingScopeType, number> {
  const out = {} as Record<BindingScopeType, number>;
  for (const value of Object.values(BindingScopeType)) out[value] = 0;
  return out;
}

/** 全 0 的主体类型分布骨架 —— 键集恒为 `PrincipalType` 全集。 */
export function emptyPrincipalCounts(): Record<PrincipalType, number> {
  const out = {} as Record<PrincipalType, number>;
  for (const value of Object.values(PrincipalType)) out[value] = 0;
  return out;
}

/** 本域可观测、且数出来是精确值的源。 */
export function observedSource(grantCount: number): RolePermissionImpactSourceFacts {
  return { grantCount, observable: true };
}

/**
 * 本域**观测不到**的源 —— 报 0 但如实标不精确。
 * 🔴 别把它改成「报 0 + EXACT」:那就是拿一个数不出来的东西冒充精确事实。
 */
export function unobservableSource(): RolePermissionImpactSourceFacts {
  return { grantCount: 0, observable: false };
}

function summarizeSource(
  facts: RolePermissionImpactSourceFacts,
): RolePermissionImpactSourceSummary {
  return {
    grantCount: facts.grantCount,
    completeness: facts.observable ? 'EXACT' : 'PARTIAL',
    partialReason: facts.observable ? null : IMPACT_PARTIAL_REASON_CROSS_DOMAIN,
  };
}

/**
 * 三源事实 → 影响汇总。**纯函数**。
 *
 * 🔴 唯一的精确性规则:**任一源本域观测不到 ⇒ 整体 PARTIAL**。
 *    反过来,三源都可观测时 `totalGrantCount` 就是三源之和的**精确**值 ——
 *    这条「标 EXACT 必须真精确」由 `scripts/check-role-permission-impact.ts`
 *    在事实矩阵上逐个反算真值比对,不靠人读代码确认。
 */
export function summarizeRolePermissionImpact(
  facts: RolePermissionImpactFacts,
): RolePermissionImpactSummary {
  const sources = {
    roleBinding: summarizeSource(facts.roleBinding),
    positionPolicy: summarizeSource(facts.positionPolicy),
    supervision: summarizeSource(facts.supervision),
  };
  const observable =
    facts.roleBinding.observable && facts.positionPolicy.observable && facts.supervision.observable;
  return {
    completeness: observable ? 'EXACT' : 'PARTIAL',
    partialReason: observable ? null : IMPACT_PARTIAL_REASON_CROSS_DOMAIN,
    totalGrantCount:
      facts.roleBinding.grantCount + facts.positionPolicy.grantCount + facts.supervision.grantCount,
    sources,
    scopeBreakdown: facts.scopeCounts,
    principalBreakdown: facts.principalCounts,
  };
}

/**
 * 角色分类 —— `kind` / `permissionManagementMode` / `bindingManagementMode` 的唯一派生处
 * (P1-32 PR 2)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 为什么是**派生**而不是 DB 列
 *
 * 冻结稿 [`rbac-permission-catalog-t0-review.md`](../../../docs/archive/reviews/rbac-permission-catalog-t0-review.md)
 * §6.3 的标题逐字就是「**不必立即给 Role 表增加 kind 字段**」,并给了派生示例
 * (`kind = roleDefinition ? 'SYSTEM' : 'CUSTOM'`),理由三条:
 *   · 不需要为分类多开一次 migration;
 *   · **不会出现 DB 字段被改成 CUSTOM 逃逸保护**(存库的分类是可写的,而它守的正是「不可写」);
 *   · 系统角色名单仍是代码真相。
 *
 * 第三条是决定性的:本文件回答的是「这个角色能不能改」,而**正在执法的谓词就在代码里**
 * (`isProtectedRoleCode` / `SYSTEM_MANAGED_ROLE_CODE_SET`)。派生 ⇒ 展示口径与执法口径
 * 结构上不可能分家;存库 ⇒ 立刻多出一份可以自己漂移的真相,而「后台显示可改、接口却拒」
 * 或反过来,都**没有任何症状**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 本文件里**不许出现任何角色 code 字面量**
 *
 * 三个字段全部由既有权威谓词算出,一条清单都不抄:
 *   · `isProtectedRoleCode()` —— 15 个内建角色的唯一清单(PR 3a 的执行位,四道闸共用);
 *   · `SYSTEM_MANAGED_ROLE_CODE_SET` —— 只能由活动责任投影器维护的那批
 *     (`RoleDelegationPolicy.assertRoleIsNotSystemManaged` 的锚点)。
 *
 * 抄一份清单进来 = 造第二个事实源。判据 `scripts/check-role-classification.ts` 用 AST
 * 扫本文件的字符串字面量,出现任一内建角色 code 即当场红。
 */
import { isProtectedRoleCode } from './protected-role-codes';
import { SYSTEM_MANAGED_ROLE_CODE_SET } from './system-managed-role-codes';

/** 角色类型。取值恒等于冻结稿 §6.1 的 `RoleKind`,一个字都不许改。 */
export const ROLE_KINDS = ['SYSTEM', 'CUSTOM'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/**
 * 权限集由谁管。取值恒等于冻结稿 §6.1 的 `PermissionManagementMode`。
 *
 * · `RELEASE_MANAGED` —— 权限集随版本发布走 seed,运行时任何人(**含 SUPER_ADMIN**)都改不动。
 *   这不是「展示上的建议」,而是 PR 3a 已经在执法的事实:加权限 / 撤权限一律 `30108`。
 * · `ADMIN_EDITABLE` —— 管理员可以在后台改这个角色的权限集。
 */
export const PERMISSION_MANAGEMENT_MODES = ['RELEASE_MANAGED', 'ADMIN_EDITABLE'] as const;
export type PermissionManagementMode = (typeof PERMISSION_MANAGEMENT_MODES)[number];

/**
 * 角色绑定(谁持有这个角色)由谁管。取值恒等于冻结稿 §6.1 的 `BindingManagementMode`。
 *
 * · `SYSTEM_ONLY`    —— 只能由系统投影器写,人工入口全拒(含 SUPER_ADMIN)。
 * · `MANUAL_ALLOWED` —— 允许人工授予 / 撤销。
 * · `POLICY_DERIVED` —— 由职务策略(`OrganizationPositionRolePolicy`)派生。
 *
 * ⚠️ **本期不产出 `POLICY_DERIVED`**,枚举里保留它是刻意的,理由两条:
 *   ① 冻结稿 §6.2 对非活动责任的系统角色写的是「`MANUAL_ALLOWED` / `POLICY_DERIVED`
 *      **或二者并存**」—— 而单值枚举表达不了「并存」。今天所有非 SYSTEM_ONLY 的角色
 *      **都允许人工绑定**,所以按「这个角色现在能不能人工绑」这一个口径,答案恒为
 *      `MANUAL_ALLOWED`;硬填 `POLICY_DERIVED` 会让前端以为人工入口关着,与实际相反。
 *   ② 「有没有职务策略映射」是 `organization_position_role_policies` 表里的**数据事实**、
 *      逐行会变,不是代码可派生的分类。真要出它得先拍板「并存时报哪个」并改成查库。
 *   枚举先声明满三值是为了**将来加值不破坏老客户端**(契约语义门 B6:
 *   响应枚举加值算 breaking,而首版就声明全集则不算)。
 */
export const BINDING_MANAGEMENT_MODES = [
  'SYSTEM_ONLY',
  'MANUAL_ALLOWED',
  'POLICY_DERIVED',
] as const;
export type BindingManagementMode = (typeof BINDING_MANAGEMENT_MODES)[number];

export interface RoleClassification {
  readonly kind: RoleKind;
  readonly permissionManagementMode: PermissionManagementMode;
  readonly bindingManagementMode: BindingManagementMode;
}

/**
 * 按角色 code 算出三个分类字段。
 *
 * 入参只要 code:分类**不看 DB 里的任何列**,这正是「DB 字段被改成 CUSTOM 逃逸保护」
 * 结构上不可能发生的原因。
 */
export function classifyRole(code: string): RoleClassification {
  return classifyRoleImpl(code);
}

/**
 * 把三个分类字段**贴到**一条角色响应上 —— 所有对外返回角色的路径共用这一个出口。
 *
 * 刻意做成 helper 而不是让各处自己 spread `classifyRole(role.code)`:
 * 角色 DTO 今天有 6 个产出点(rbac-roles 的 list / findOne / create / update / softDelete
 * 与 role-permissions 的 buildDetailResponse)。散写等于「新增第 7 个产出点时漏贴,
 * 而 TS 会在返回类型上直接报错」—— 前半句是真风险,后半句是这个 helper 换来的保障:
 * 返回类型必须是 `T & RoleClassification`,不经本函数就凑不出来。
 */
export function withRoleClassification<T extends { code: string }>(
  role: T,
): T & RoleClassification {
  return { ...role, ...classifyRoleImpl(role.code) };
}

/**
 * `readOnlyReason` 的唯一取值 —— 取自冻结稿 §9.2 的系统角色示例,**逐字**。
 *
 * 做成常量而不是散写字面量:它是前端要 switch 的机器可读原因码,
 * 两处各写一遍就会在某次改文案时静默分家。
 */
export const ROLE_PERMISSION_SET_RELEASE_MANAGED_REASON =
  'SYSTEM_ROLE_PERMISSION_SET_RELEASE_MANAGED';

/** 权限集编辑策略(冻结稿 §9.2 的 `editPolicy`)。 */
export interface RolePermissionEditPolicy {
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
}

/**
 * `editPolicy` —— **`permissionManagementMode` 的渲染,不是第二次判定**(P1-32 PR 4b)。
 *
 * 🔴 刻意住在本文件而不是 `role-permissions` 那边:本文件的头注写着它是三个分类字段的
 *    **唯一派生处**,而 `canEdit` 问的就是 `permissionManagementMode` 那个问题的是非题形态。
 *    放到别处 = 同一个问题有两处答案,而「后台显示可改、接口却拒」没有任何症状 ——
 *    那正是这三个字段选「派生不存库」要消灭的形状。
 *
 * ⚠️ **它回答的是「这个角色的权限集本身能不能被运行时改」,不回答「你能不能改」。**
 *    调用者自身的判权(`rbac.role-permission.*`)与控制面分级闸(30103 / 30109)
 *    都在写路径里,与本函数无关;冻结稿 §9.2 里那两个 per-code 字段
 *    (`addBlocked` / `removeBlocked`)属 PR 5,本期不出(见 controller 头注)。
 */
export function rolePermissionEditPolicy(code: string): RolePermissionEditPolicy {
  return classifyRoleImpl(code).permissionManagementMode === 'ADMIN_EDITABLE'
    ? { canEdit: true, readOnlyReason: null }
    : { canEdit: false, readOnlyReason: ROLE_PERMISSION_SET_RELEASE_MANAGED_REASON };
}

function classifyRoleImpl(code: string): RoleClassification {
  const isBuiltin = isProtectedRoleCode(code);
  return {
    kind: isBuiltin ? 'SYSTEM' : 'CUSTOM',
    // 与 PR 3a 的 30108 闸同一个谓词:内建 ⇒ 权限集运行时只读。
    permissionManagementMode: isBuiltin ? 'RELEASE_MANAGED' : 'ADMIN_EDITABLE',
    // 与 RoleDelegationPolicy.assertRoleIsNotSystemManaged 同一个集合。
    bindingManagementMode: SYSTEM_MANAGED_ROLE_CODE_SET.has(code)
      ? 'SYSTEM_ONLY'
      : 'MANUAL_ALLOWED',
  };
}

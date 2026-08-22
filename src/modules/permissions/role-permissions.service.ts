import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { writeConfigAudit } from './config-audit.util';
import { permissionSelect } from './permissions.select';
import { isProtectedRoleCode } from './protected-role-codes';
import { RbacService } from './rbac.service';
import { RbacRoleDetailResponseDto } from './rbac-roles.dto';
import { rbacRoleSelect } from './rbac-roles.select';
import { AssignRolePermissionsDto } from './role-permissions.dto';
import {
  isControlPlanePermissionCode,
  isReservedSuperAdminOnlyPermissionCode,
} from './role-delegation.policy';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表业务逻辑。
// 沿 D7 v1.1 §5.1 端点 10-11 + §6.1 + 用户拍板。
//
// 2 个端点:
//   POST   /api/system/v1/roles/:id/permissions       批量授权(幂等;入参 permissionCodes[])
//   DELETE /api/system/v1/roles/:id/permissions/:permissionId  撤权(精确;路径 permissionId)
//
// 出参统一返 RbacRoleDetailResponseDto(沿 PR #3 rbac-roles 详情接口):
// - 调用者一次拿到该角色当前完整 permissions 列表,前端"保存当前选中"语义友好
// - 与 GET /api/system/v1/roles/:id 形成一致的 detail 输出契约
//
// **30003 vs 30005**(沿 PR #3 RbacRole 范式):
// - role 不存在 → 30003
// - role 已软删 → 30005(GET-like 操作披露)
//   注:授权 / 撤权属于写操作,
//      严格按 docs/reference/soft-delete-transactions.md §10 信息泄漏防御应统一 30003;
//        但 D7 §6.1 决议"运营管理员管 role_permissions",意味着调用者本来就掌握角色明细;
//        披露"角色已软删"无信息泄漏风险(管理者已知角色 id 存在),沿 detail 接口语义返 30005,
//        让前端能精确提示"该角色已删除,请先恢复或重建"。
//
// **30001 / 30011 区分**:
// - permission code / id 不存在 → 30001 PERMISSION_NOT_FOUND
// - (roleId, permissionId) 关系不存在(撤权时)→ 30011 ROLE_PERMISSION_NOT_FOUND

@Injectable()
export class RolePermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-1:RBAC 元接口判权(沿 attachments F5 v1.0 范本)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 第一档安全收口 D2:role-permission 分级闸 —— 控制面权限码
  // (7 条 SA-only 保留码 + rbac.* + role-binding.*)的角色映射不得被随意改动。
  //
  // 这组保留码在 seed 中有意不绑 biz-admin / ops-admin;
  // assign() 原先只判 `rbac.role-permission.create`,未阻止持 ops-admin 者把保留码
  // 自授给某角色再绑到自己身上,间接获得 SA-only 能力(授权越权洞)。
  //
  // 🔴 **本方法是授、撤两侧共用的唯一闸**(第六轮评审 E-B2,2026-08-21)。
  //    E-B2 前 revoke() 一个控制面判定都没有:非 SA 授不了控制面码,却可以**撤** ——
  //    包括把某个角色的 rbac.* / role-binding.* 权限撤空。damage 方向相反但同属
  //    「控制面权限映射被非 SA 改动」,和授码是同一条不变量的两条腿。
  //    这与刚修完的 E-B1(#1115)同属一个缺陷家族:**一侧有闸、另一侧没有**。
  //    机器执法见同目录 role-permissions-control-plane-gate.spec.ts —— 该判据动态现取
  //    本类所有会改写 rolePermission 映射的公开方法,逐个要求能到达本闸,漏一个即红。
  //    (共用 ≠ 两侧判定全等:保留码在授侧对 SUPER_ADMIN 也拒,见下面第 2 层。)
  //
  // 🔴 **两层口径,别混成一层**(P1-32 PR 3a,2026-08-23):
  //
  //   第 1 层 · 非 SUPER_ADMIN → 控制面码一律拒(`30103`)。授、撤两侧同口径,
  //     语义**一字未变**(E-B2 收口后就是这样)。
  //
  //   第 2 层 · 那 7 条 SA-only 保留码,**授码侧连 SUPER_ADMIN 也拒**(`30109`)。
  //     沿维护者 2026-08-22 拍板②「一条都不该进任何角色」:把保留码写进某角色的
  //     role_permissions,就是让**持有该角色的非 SA** 永久拥有 SA-only 能力 ——
  //     由谁按下按钮不改变结果。SA 依然能用 SA 身份直接做那些操作(走身份短路,
  //     根本不查 role_permissions),所以关掉的是「沉淀成角色常驻权限」这条路,
  //     **不是削 SA 的权**。
  //
  //   ⚠️ **第 2 层只覆盖保留码,不覆盖 `rbac.*` / `role-binding.*` 前缀族。**
  //      前缀族里有 `rbac.permission.read`、`role-binding.read.record` 这类纯只读码,
  //      拍板②说的是「7 条保留码」,没说过要禁掉它们;把 SA 也拦住会当场取消
  //      「SUPER_ADMIN 建一个 RBAC 只读观察员角色」这个能力,并打掉
  //      rbac-multi-instance-consistency e2e 赖以证明「权限解析直读 DB」的那条授权。
  //      (起草本刀时我把两者当成一回事,CI 上那条 e2e 是发现它的唯一信号。)
  //
  //   ⚠️ **撤码侧刻意没有第 2 层**:seed 出来的角色本就不含保留码
  //      (P1-32 PR 0 实测交集为 0),保留 SA 可撤是给**历史脏数据**留唯一清理路。
  //      两侧不同**不是漏改** —— 收死之后最后一条清理入口就没了。
  //
  // 设计:在权限码(已去重)字符串层面拦截;命中即整批拒绝(不部分写入),
  // 与 30001 整批拒绝语义一致。assign() 收 codes,故能**早于** Permission 存在性查询
  // 拦下 —— 即便保留码尚未 seed,也拿拒绝码(fail-close,不退化成 30001 泄漏存在性)。
  private assertControlPlaneCodesOrThrow(
    user: CurrentUserPayload,
    uniqueCodes: string[],
    direction: 'grant' | 'revoke',
  ): void {
    // 第 1 层:非 SA 碰控制面码即拒(两侧同口径,行为未变)。
    if (user.role !== Role.SUPER_ADMIN) {
      if (uniqueCodes.some(isControlPlanePermissionCode)) {
        throw new BizException(BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);
      }
      return;
    }
    // 第 2 层:SA 也不得把保留码沉淀成角色常驻权限(仅授码侧)。
    if (direction === 'grant' && uniqueCodes.some(isReservedSuperAdminOnlyPermissionCode)) {
      throw new BizException(BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE);
    }
  }

  // 沿 PR #3 rbac-roles 范式:区分不存在(30003)vs 已软删(30005);
  // 写操作(授权/撤权)沿 D7 §6.1 决议管理者已知角色明细 → 披露 30005 不构成信息泄漏。
  //
  // P1-32 PR 3a(2026-08-23)起本 helper 还是**系统内置角色只读**闸的落点:
  // 内置角色的权限映射由 seed 定义(org-readonly / group-readonly 更是从正职角色**派生**的),
  // 运行时增删要么被下次 seed 覆盖,要么造出与派生链打架的第二份真相 ⇒ 一律 30108,
  // **SUPER_ADMIN 也拒**(与角色删除保护 30104 同语义)。
  //
  // 闸放在这里而不是 assign()/revoke() 各写一遍:两条写路径本来就都要先取这一行,
  // 收在同一个 helper 里,新增写方法只要照抄这一句就同时拿到三件事(存在 / 未软删 / 可改)。
  private async assertRoleMutableOrThrow(roleId: string): Promise<void> {
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: { id: true, code: true, deletedAt: true },
    });
    if (!raw) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (raw.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    if (isProtectedRoleCode(raw.code)) {
      throw new BizException(BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN);
    }
  }

  // 查角色详情(含 permissions 数组),复用 rbac-roles.service 同形态;
  // 但这里不抛 30005(已通过 assertRoleMutableOrThrow 拦掉),只查活跃角色。
  private async buildDetailResponse(roleId: string): Promise<RbacRoleDetailResponseDto> {
    const role = await this.prisma.rbacRole.findFirst({
      where: notDeletedWhere({ id: roleId }),
      select: rbacRoleSelect,
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: permissionSelect } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...role,
      permissions: rolePermissions.map((rp) => rp.permission),
    };
  }

  // ============ 2 端点 ============

  async assign(
    user: CurrentUserPayload,
    roleId: string,
    dto: AssignRolePermissionsDto,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    //    去重处理:即使 DTO 重复传同一 code 也能正常工作
    const uniqueCodes = Array.from(new Set(dto.permissionCodes));

    // 2. D2 分级闸:控制面权限码不得沉淀成任何角色的常驻权限(SUPER_ADMIN 也拒;
    //    早于 Permission 存在性查询;命中即整批拒绝)
    this.assertControlPlaneCodesOrThrow(user, uniqueCodes, 'grant');

    // 3. 按 codes 查 permissions;**任一 code 不存在 → 30001**(整批拒绝,不部分成功)
    const perms = await this.prisma.permission.findMany({
      where: { code: { in: uniqueCodes } },
      select: { id: true, code: true },
    });
    if (perms.length !== uniqueCodes.length) {
      // 至少一个 code 在 DB 中不存在 → 拒绝整批,沿 v1 错误传播范式
      throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    }

    // 4. 幂等批量写入 + audit(单事务原子;第三轮 review §F&A-2:授权配置写面留痕)。
    //    Prisma createMany skipDuplicates 利用 schema unique([roleId, permissionId]),已存在的关系静默跳过。
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      });
      await writeConfigAudit(tx, {
        event: 'role-permission.grant',
        actor: user,
        resourceType: 'role_permission',
        resourceId: roleId,
        meta,
        extra: {
          operation: 'grant',
          permissionCodes: uniqueCodes,
          requestedCount: uniqueCodes.length,
        },
      });
    });

    // 5. 返回该角色当前完整 detail(含最新 permissions)
    return this.buildDetailResponse(roleId);
  }

  async revoke(
    user: CurrentUserPayload,
    roleId: string,
    permissionId: string,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    // 2. permission 必须存在(顺带取 code —— 分级闸判的是码,不是 id)
    const perm = await this.prisma.permission.findUnique({
      where: { id: permissionId },
      select: { id: true, code: true },
    });
    if (!perm) throw new BizException(BizCode.PERMISSION_NOT_FOUND);

    // 3. D2 分级闸:非 SUPER_ADMIN 不得撤销控制面权限码;SA 仍可撤(清理历史脏数据)。
    //    与 assign() 复用**同一个** assertControlPlaneCodesOrThrow,不另造判定;
    //    差别只在 direction —— 见该 helper 头部对「为什么两侧不对称」的说明。
    //    ⚠️ 与 assign 的唯一次序差:assign 的入参本来就是 codes,可在存在性查询前拦;
    //    revoke 的路径参数是 permissionId,不查库拿不到 code,只能先查后判。这不是漏拦 ——
    //    permissionId 不存在时本就无绑定可撤,先返 30001 不缩小闸的覆盖面。
    this.assertControlPlaneCodesOrThrow(user, [perm.code], 'revoke');

    // 4. 撤权 + audit(单事务原子)。先查存在性(不存在 → 30011),再删 + 留痕。
    //    用先查再删范式避免 prisma delete P2025;沿现有项目"先查再操作"范式更可读。
    const existing = await this.prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId, permissionId } },
      select: { id: true },
    });
    if (!existing) {
      throw new BizException(BizCode.ROLE_PERMISSION_NOT_FOUND);
    }
    await this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line no-restricted-syntax -- 角色-权限关联表(纯连接表),解绑即物理删除
      await tx.rolePermission.delete({
        where: { roleId_permissionId: { roleId, permissionId } },
      });
      await writeConfigAudit(tx, {
        event: 'role-permission.revoke',
        actor: user,
        resourceType: 'role_permission',
        resourceId: roleId,
        meta,
        extra: { operation: 'revoke', permissionId },
      });
    });

    // 5. 返回该角色当前完整 detail(含最新 permissions)
    return this.buildDetailResponse(roleId);
  }
}

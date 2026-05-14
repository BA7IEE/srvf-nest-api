import { Injectable } from '@nestjs/common';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { permissionSelect } from './permissions.select';
import { RbacCacheService } from './rbac-cache.service';
import { RbacRoleDetailResponseDto } from './rbac-roles.dto';
import { rbacRoleSelect } from './rbac-roles.select';
import { AssignRolePermissionsDto } from './role-permissions.dto';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表业务逻辑。
// 沿 D7 v1.1 §5.1 端点 10-11 + §6.1 + §9.4 缓存失效 + 用户拍板。
//
// 2 个端点:
//   POST   /api/v2/roles/:id/permissions       批量授权(幂等;入参 permissionCodes[])
//   DELETE /api/v2/roles/:id/permissions/:permissionId  撤权(精确;路径 permissionId)
//
// 出参统一返 RbacRoleDetailResponseDto(沿 PR #3 rbac-roles 详情接口):
// - 调用者一次拿到该角色当前完整 permissions 列表,前端"保存当前选中"语义友好
// - 与 GET /api/v2/roles/:id 形成一致的 detail 输出契约
//
// **30003 vs 30005**(沿 PR #3 RbacRole 范式):
// - role 不存在 → 30003
// - role 已软删 → 30005(GET-like 操作披露)
//   注:授权 / 撤权属于写操作,严格按 v1 §10 信息泄漏防御应统一 30003;
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
    private readonly cache: RbacCacheService,
  ) {}

  // ============ helpers ============

  // 沿 PR #3 rbac-roles 范式:区分不存在(30003)vs 已软删(30005);
  // 写操作(授权/撤权)沿 D7 §6.1 决议管理者已知角色明细 → 披露 30005 不构成信息泄漏。
  private async assertRoleAccessibleOrThrow(roleId: string): Promise<void> {
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: { id: true, deletedAt: true },
    });
    if (!raw) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (raw.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
  }

  // 查角色详情(含 permissions 数组),复用 rbac-roles.service 同形态;
  // 但这里不抛 30005(已通过 assertRoleAccessibleOrThrow 拦掉),只查活跃角色。
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

  async assign(roleId: string, dto: AssignRolePermissionsDto): Promise<RbacRoleDetailResponseDto> {
    // 1. role 必须存在 + 未软删
    await this.assertRoleAccessibleOrThrow(roleId);

    // 2. 按 codes 查 permissions;**任一 code 不存在 → 30001**(整批拒绝,不部分成功)
    //    去重处理:即使 DTO 重复传同一 code 也能正常工作
    const uniqueCodes = Array.from(new Set(dto.permissionCodes));
    const perms = await this.prisma.permission.findMany({
      where: { code: { in: uniqueCodes } },
      select: { id: true, code: true },
    });
    if (perms.length !== uniqueCodes.length) {
      // 至少一个 code 在 DB 中不存在 → 拒绝整批,沿 v1 错误传播范式
      throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    }

    // 3. 幂等批量写入(沿用户拍板;Prisma createMany skipDuplicates 利用
    //    schema unique([roleId, permissionId]),已存在的关系静默跳过)
    await this.prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId, permissionId: p.id })),
      skipDuplicates: true,
    });

    // 4. 缓存失效(沿 D7 §9.4):所有持有该角色的 user cache 清掉。
    //    失败仅 logger.warn(在 RbacCacheService 内),不阻断业务返回。
    await this.cache.invalidateAllUsersWithRole(roleId);

    // 5. 返回该角色当前完整 detail(含最新 permissions)
    return this.buildDetailResponse(roleId);
  }

  async revoke(roleId: string, permissionId: string): Promise<RbacRoleDetailResponseDto> {
    // 1. role 必须存在 + 未软删
    await this.assertRoleAccessibleOrThrow(roleId);

    // 2. permission 必须存在
    const perm = await this.prisma.permission.findUnique({
      where: { id: permissionId },
      select: { id: true },
    });
    if (!perm) throw new BizException(BizCode.PERMISSION_NOT_FOUND);

    // 3. 撤权(deleteMany;不存在的关系返 count=0,据此抛 30011)
    //    用 deleteMany 而非 delete 避免 P2025 异常(prisma delete 不存在抛错);
    //    沿现有项目"先查再操作"范式更可读。
    const existing = await this.prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId, permissionId } },
      select: { id: true },
    });
    if (!existing) {
      throw new BizException(BizCode.ROLE_PERMISSION_NOT_FOUND);
    }
    await this.prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId, permissionId } },
    });

    // 4. 缓存失效(沿 D7 §9.4)
    await this.cache.invalidateAllUsersWithRole(roleId);

    // 5. 返回该角色当前完整 detail(含最新 permissions)
    return this.buildDetailResponse(roleId);
  }
}

import { Injectable } from '@nestjs/common';
import { MemberStatus, OrganizationStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { MemberDepartmentResponseDto, SetMemberDepartmentDto } from './member-departments.dto';

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
const memberDepartmentSelect = {
  id: true,
  memberId: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberDepartmentSelect;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class MemberDepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-2A(2026-05-18):RBAC 判权(沿 PR-1 attachments F5 v1.0 范本)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 校验 member 存在且未软删(返回 status 用于 INACTIVE 校验)。
  private async findMemberOrThrow(
    memberId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: MemberStatus }> {
    const client = tx ?? this.prisma;
    const member = await client.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true, status: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return member;
  }

  // 校验 organization 存在且未软删(返回 status 用于 INACTIVE 校验)。
  private async findOrganizationOrThrow(
    organizationId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: OrganizationStatus }> {
    const client = tx ?? this.prisma;
    const org = await client.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, status: true },
    });
    if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return org;
  }

  // P2002 兜底:partial unique index "MemberDepartment_memberId_active_key" 是 Step 1
  // migration.sql 末尾手动追加,Prisma 客户端的 P2002 meta.target 不可靠(可能是
  // 索引名而非字段数组)。决策 8 修订:**任何 P2002 直接抛 ALREADY_EXISTS**,不解析 target。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.MEMBER_DEPARTMENT_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // ============ GET /api/admin/v1/members/:memberId/department ============

  // 决策 4:member 存在但无归属返 null(不抛 NOT_FOUND);member 不存在抛 MEMBER_NOT_FOUND。
  async findCurrent(
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<MemberDepartmentResponseDto | null> {
    await this.assertCanOrThrow(user, 'member-department.read.current');
    await this.findMemberOrThrow(memberId);
    const current = await this.prisma.memberDepartment.findFirst({
      where: { memberId, deletedAt: null },
      select: memberDepartmentSelect,
    });
    return current;
  }

  // ============ PUT /api/admin/v1/members/:memberId/department ============

  // 幂等设置语义(对应 contract §5.2):
  //   1. 校验 memberId 存在 + status=ACTIVE
  //   2. 校验 organizationId 存在 + status=ACTIVE
  //   3. 查 member 当前 active 归属:
  //      - 不存在 → 创建新归属
  //      - 已存在且 organizationId 相同 → 直接返回(决策 5:无副作用,不更新时间)
  //      - 已存在但 organizationId 不同 → 软删旧 + 创建新(单事务原子)
  //   4. P2002 兜底转 MEMBER_DEPARTMENT_ALREADY_EXISTS(并发场景)
  async set(
    user: CurrentUserPayload,
    memberId: string,
    dto: SetMemberDepartmentDto,
  ): Promise<MemberDepartmentResponseDto> {
    await this.assertCanOrThrow(user, 'member-department.set.current');
    return this.prisma.$transaction(async (tx) => {
      // 1. member 校验
      const member = await this.findMemberOrThrow(memberId, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      // 2. organization 校验
      const org = await this.findOrganizationOrThrow(dto.organizationId, tx);
      if (org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }

      // 3. 查当前 active 归属
      const current = await tx.memberDepartment.findFirst({
        where: { memberId, deletedAt: null },
        select: memberDepartmentSelect,
      });

      if (current) {
        if (current.organizationId === dto.organizationId) {
          // 幂等:同 organizationId 直接返回现归属(无副作用)
          return current;
        }
        // 软删旧归属(避免撞 partial unique index)
        await tx.memberDepartment.update({
          where: { id: current.id },
          data: { deletedAt: new Date() },
        });
      }

      // 4. 创建新归属(P2002 兜底防并发)
      return this.runWithUniqueConstraintGuard(() =>
        tx.memberDepartment.create({
          data: {
            memberId,
            organizationId: dto.organizationId,
          },
          select: memberDepartmentSelect,
        }),
      );
    });
  }

  // ============ DELETE /api/admin/v1/members/:memberId/department ============

  // 解除当前 active 归属(软删中间表行)。
  // 若 member 无 active 归属 → MEMBER_DEPARTMENT_NOT_FOUND。
  async remove(user: CurrentUserPayload, memberId: string): Promise<MemberDepartmentResponseDto> {
    await this.assertCanOrThrow(user, 'member-department.clear.current');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);

      const current = await tx.memberDepartment.findFirst({
        where: { memberId, deletedAt: null },
        select: memberDepartmentSelect,
      });
      if (!current) throw new BizException(BizCode.MEMBER_DEPARTMENT_NOT_FOUND);

      // 软删 = update({ deletedAt: now });不物理删除(baseline §10)
      return tx.memberDepartment.update({
        where: { id: current.id },
        data: { deletedAt: new Date() },
        select: memberDepartmentSelect,
      });
    });
  }
}

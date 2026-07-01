import { Injectable } from '@nestjs/common';
import { MemberStatus, MembershipStatus, OrganizationStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { CreateMembershipDto, MembershipResponseDto, UpdateMembershipDto } from './memberships.dto';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):组织归属(memberships)管理面。
// 沿队员轴嵌套 admin/v1/members/:memberId/memberships;判权单轨 service 层 rbac.can(0 @Roles)。
// **本表只建 + 回填 + CRUD,绝不被任何模块读作授权**(AuthzService 是 PR8)。
//
// 与旧单部门(member-departments)面的关系:旧面重指向到 PRIMARY 行做兼容;本面是终态全归属面,
// 显式承载 type / 任期 / status(PRIMARY 唯一由 partial unique 兜底,SECONDARY/TEMPORARY/SUPPORT 可并存)。

// 集中定义对外 select(全字段;永不含 deletedAt 软删内部状态)。
const membershipSelect = {
  id: true,
  memberId: true,
  organizationId: true,
  membershipType: true,
  status: true,
  startedAt: true,
  endedAt: true,
  reason: true,
  createdByUserId: true,
  endedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberOrganizationMembershipSelect;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers(自包含;沿 member-departments 范式,不抽共享类)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

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

  // P2002 兜底:两条 partial unique index(primary_active_unique / active_unique)由 migration.sql
  // 末尾手动追加,P2002 meta.target 不可靠 → 任何 P2002 直接抛 MEMBERSHIP_ALREADY_EXISTS(17004,本面新码)。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.MEMBERSHIP_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // ============ GET /api/admin/v1/members/:memberId/memberships ============

  // 列某队员全部归属(主/兼/临时/支援 + 任期;含 ENDED/SUSPENDED 历史,不含软删行)。
  async list(user: CurrentUserPayload, memberId: string): Promise<MembershipResponseDto[]> {
    await this.assertCanOrThrow(user, 'membership.list.record');
    await this.findMemberOrThrow(memberId);
    return this.prisma.memberOrganizationMembership.findMany({
      where: { memberId, deletedAt: null },
      select: membershipSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // ============ POST /api/admin/v1/members/:memberId/memberships ============

  // 新增归属(指定 membershipType)。校验 member/org 存在且 ACTIVE(沿 member-departments set 语义)。
  // PRIMARY 撞唯一 / (member,org,type) 撞唯一 → P2002 → MEMBERSHIP_ALREADY_EXISTS。
  async create(
    user: CurrentUserPayload,
    memberId: string,
    dto: CreateMembershipDto,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.set.record');
    return this.prisma.$transaction(async (tx) => {
      const member = await this.findMemberOrThrow(memberId, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }
      const org = await this.findOrganizationOrThrow(dto.organizationId, tx);
      if (org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }
      return this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.create({
          data: {
            memberId,
            organizationId: dto.organizationId,
            membershipType: dto.membershipType,
            status: MembershipStatus.ACTIVE,
            reason: dto.reason ?? null,
            createdByUserId: user.id,
          },
          select: membershipSelect,
        }),
      );
    });
  }

  // ============ PATCH /api/admin/v1/members/:memberId/memberships/:id ============

  // 改类型 / 任期 / 原因(全可选)。不改 status(结束走 DELETE)、不改 memberId/organizationId。
  // 找不到该 member 名下未软删归属 → MEMBERSHIP_NOT_FOUND;改类型可能撞唯一 → MEMBERSHIP_ALREADY_EXISTS。
  async update(
    user: CurrentUserPayload,
    memberId: string,
    id: string,
    dto: UpdateMembershipDto,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.set.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.memberOrganizationMembership.findFirst({
        where: { id, memberId, deletedAt: null },
        select: { id: true },
      });
      if (!current) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);

      const data: Prisma.MemberOrganizationMembershipUpdateInput = {};
      if (dto.membershipType !== undefined) data.membershipType = dto.membershipType;
      if (dto.startedAt !== undefined) data.startedAt = new Date(dto.startedAt);
      if (dto.endedAt !== undefined) data.endedAt = new Date(dto.endedAt);
      if (dto.reason !== undefined) data.reason = dto.reason;

      return this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.update({
          where: { id },
          data,
          select: membershipSelect,
        }),
      );
    });
  }

  // ============ DELETE /api/admin/v1/members/:memberId/memberships/:id ============

  // 结束归属:status=ENDED + endedAt=now + endedByUserId(逻辑结束,保留行做历史留痕,不软删)。
  // 仅可结束该 member 名下 active 归属;否则 MEMBERSHIP_NOT_FOUND。
  async end(
    user: CurrentUserPayload,
    memberId: string,
    id: string,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.end.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.memberOrganizationMembership.findFirst({
        where: { id, memberId, deletedAt: null, status: MembershipStatus.ACTIVE },
        select: { id: true },
      });
      if (!current) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);

      return tx.memberOrganizationMembership.update({
        where: { id },
        data: {
          status: MembershipStatus.ENDED,
          endedAt: new Date(),
          endedByUserId: user.id,
        },
        select: membershipSelect,
      });
    });
  }
}

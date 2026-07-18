import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  Prisma,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { lockMemberLifecycle } from '../members/member-lifecycle-lock';
import { RbacService } from '../permissions/rbac.service';
import { MemberDepartmentResponseDto, SetMemberDepartmentDto } from './member-departments.dto';
import { MembershipTermStateMachine } from './membership-term-state-machine';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §8.1 行为锁核心):本 service 由旧 `MemberDepartment` 表
// **重指向**到 `member_organization_memberships` 的 **PRIMARY** 行(旧"单部门"语义 = 主归属)。
// 旧 3 端点 GET/PUT/DELETE .../department 与 3 码 member-department.{read,set,clear}.current **保留一版
// (deprecated)、行为逐字不变**;旧 MemberDepartment 表已 DROP(冻结表 cleanup,第 39 migration,2026-07-03)。
// 单归属唯一由新 partial unique `member_org_membership_primary_active_unique`(仅约束 PRIMARY)兜底;
// 旧端点 P2002 仍抛 MEMBER_DEPARTMENT_ALREADY_EXISTS(17002)= 契约不变(新 memberships 面才用 17004)。
// **本表绝不被任何模块读作授权**(AuthzService 是 PR8)。
//
// 审计留痕批(2026-07-03;review #484 G5):set / remove 写 audit(inline-in-transaction,复用
// memberships.service 同一 AuditLogEvent 联合;resourceType='membership';extra.viaPath='department'
// 区分新 memberships 入口)。set 的幂等分支(同 organizationId,无 DB 写)**不写 audit**(无状态变更)。
//
// 参与域生命周期收口⑥(v0.40.0):`remove` + `set`(换部门分支)两个写点由**软删**(deletedAt=now)收敛为
// **status=ENDED + endedAt + endedByUserId**(对齐新面 `end`;镜像 transfer「先 end 后 create 释放 PRIMARY
// 唯一槽位」)。旧面**不再产生软删痕**——ENDED 历史行 deletedAt=null 留在表内,新面 memberships 列表可见
// (本刀存在的理由)。对外契约逐字不变:primaryMembershipSelect 不含 status/deletedAt/endedAt;
// activePrimaryWhere 同查 deletedAt=null AND status=ACTIVE(ENDED 不匹配)故 DELETE 后 GET 仍 null;
// partial unique 仅约束 ACTIVE 故槽位释放正常。remove 的 audit `after` 载荷相应由 deletedAt 翻面为
// {status, endedAt, endedByUserId}(set audit before/after 仅 id/memberId/organizationId,不受影响)。

const AUDIT_RESOURCE_TYPE = 'membership';

// 集中定义对外 select(承接旧 memberDepartmentSelect;返回 shape 与旧端点逐字一致)。
// 永不包含 deletedAt / membershipType / status / startedAt 等新列(旧端点响应 DTO 不变)。
const primaryMembershipSelect = {
  id: true,
  memberId: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberOrganizationMembershipSelect;

type PrismaTx = Prisma.TransactionClient;

// 旧"单部门"= active PRIMARY membership 的 where 片段(重指向唯一入口)。
const activePrimaryWhere = (memberId: string): Prisma.MemberOrganizationMembershipWhereInput => ({
  ...MembershipTermStateMachine.effectiveWhere(new Date()),
  memberId,
  membershipType: MembershipType.PRIMARY,
});

@Injectable()
export class MemberDepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
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

  // P2002 兜底:partial unique index "member_org_membership_primary_active_unique" 是 migration.sql
  // 末尾手动追加,Prisma 客户端的 P2002 meta.target 不可靠(可能是索引名而非字段数组)。
  // **任何 P2002 直接抛 MEMBER_DEPARTMENT_ALREADY_EXISTS**(旧端点契约不变,不用新 17004)。
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
  // 重指向:读 active PRIMARY membership(= 旧单部门)。
  async findCurrent(
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<MemberDepartmentResponseDto | null> {
    await this.assertCanOrThrow(user, 'member-department.read.current');
    await this.findMemberOrThrow(memberId);
    const current = await this.prisma.memberOrganizationMembership.findFirst({
      where: activePrimaryWhere(memberId),
      select: primaryMembershipSelect,
    });
    return current;
  }

  // ============ PUT /api/admin/v1/members/:memberId/department ============

  // 幂等设置语义(对应 contract §5.2;重指向到 PRIMARY membership,语义逐字不变):
  //   1. 校验 memberId 存在 + status=ACTIVE
  //   2. 校验 organizationId 存在 + status=ACTIVE
  //   3. 查 member 当前 active PRIMARY 归属:
  //      - 不存在 → 创建新 PRIMARY 归属
  //      - 已存在且 organizationId 相同 → 直接返回(决策 5:无副作用,不更新时间)
  //      - 已存在但 organizationId 不同 → 软删旧 PRIMARY + 创建新 PRIMARY(单事务原子)
  //   4. P2002 兜底转 MEMBER_DEPARTMENT_ALREADY_EXISTS(并发场景)
  async set(
    user: CurrentUserPayload,
    memberId: string,
    dto: SetMemberDepartmentDto,
    meta: AuditMeta,
  ): Promise<MemberDepartmentResponseDto> {
    await this.assertCanOrThrow(user, 'member-department.set.current');
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, memberId);
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

      // 3. 查当前 active PRIMARY 归属
      const current = await tx.memberOrganizationMembership.findFirst({
        where: activePrimaryWhere(memberId),
        select: primaryMembershipSelect,
      });

      if (current) {
        if (current.organizationId === dto.organizationId) {
          // 幂等:同 organizationId 直接返回现归属(无副作用,无状态变更 → 不写 audit)
          return current;
        }
        // 参与域生命周期收口⑥(v0.40.0):结束旧 PRIMARY 归属 —— status=ENDED + endedAt + endedByUserId
        // (镜像新面 transfer「先 end 后 create 释放 PRIMARY 唯一槽位」;partial unique 仅约束 ACTIVE,
        // ENDED 行不占槽故新 PRIMARY 可建)。**不再软删**:旧行留在 memberships 表做 ENDED 历史,
        // 新面 GET members/:id/memberships 可见;旧面对外契约不变(primaryMembershipSelect 不含
        // status/deletedAt/endedAt;activePrimaryWhere 同查 deletedAt=null AND status=ACTIVE,ENDED 行不匹配)。
        const currentTerm = await tx.memberOrganizationMembership.findUniqueOrThrow({
          where: { id: current.id },
          select: { status: true, startedAt: true, endedAt: true },
        });
        const ended = MembershipTermStateMachine.end(currentTerm, new Date());
        await tx.memberOrganizationMembership.update({
          where: { id: current.id },
          data: {
            status: ended.status,
            endedAt: ended.endedAt,
            endedByUserId: user.id,
          },
        });
      }

      // 4. 创建新 PRIMARY 归属(P2002 兜底防并发)
      const startedAt = new Date();
      MembershipTermStateMachine.assertValid(
        {
          status: MembershipStatus.ACTIVE,
          startedAt,
          endedAt: null,
        },
        startedAt,
      );
      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.create({
          data: {
            memberId,
            organizationId: dto.organizationId,
            membershipType: MembershipType.PRIMARY,
            status: MembershipStatus.ACTIVE,
            startedAt,
          },
          select: primaryMembershipSelect,
        }),
      );

      // 5. 写 audit(仅真实发生状态变更的两分支:首次建 / 换部门;before=旧 PRIMARY 行快照〔换部门场景〕)
      await this.auditLogs.log({
        event: 'membership.set',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        before: current
          ? { id: current.id, memberId: current.memberId, organizationId: current.organizationId }
          : undefined,
        after: {
          id: created.id,
          memberId: created.memberId,
          organizationId: created.organizationId,
        },
        extra: { viaPath: 'department', operation: 'set', targetMemberId: memberId },
        tx,
      });

      return created;
    });
  }

  // ============ DELETE /api/admin/v1/members/:memberId/department ============

  // 解除当前 active PRIMARY 归属(软删中间表行)。
  // 若 member 无 active PRIMARY 归属 → MEMBER_DEPARTMENT_NOT_FOUND。
  async remove(
    user: CurrentUserPayload,
    memberId: string,
    meta: AuditMeta,
  ): Promise<MemberDepartmentResponseDto> {
    await this.assertCanOrThrow(user, 'member-department.clear.current');
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, memberId);
      await this.findMemberOrThrow(memberId, tx);

      const current = await tx.memberOrganizationMembership.findFirst({
        where: activePrimaryWhere(memberId),
        select: primaryMembershipSelect,
      });
      if (!current) throw new BizException(BizCode.MEMBER_DEPARTMENT_NOT_FOUND);

      // 参与域生命周期收口⑥(v0.40.0):结束归属 —— status=ENDED + endedAt + endedByUserId(对齐新面
      // end;逻辑结束、保留行做历史留痕,**不再软删**)。旧面对外契约不变:primaryMembershipSelect 不含
      // status/deletedAt/endedAt;DELETE 后 GET 仍 NOT_FOUND(activePrimaryWhere 同查 deletedAt=null AND
      // status=ACTIVE,ENDED 行不匹配);partial unique 仅约束 ACTIVE 故槽位释放。新面 GET
      // members/:id/memberships 可见该 ENDED 历史行(本刀存在的理由)。
      const currentTerm = await tx.memberOrganizationMembership.findUniqueOrThrow({
        where: { id: current.id },
        select: { status: true, startedAt: true, endedAt: true },
      });
      const ended = MembershipTermStateMachine.end(currentTerm, new Date());
      const endedAt = ended.endedAt as Date;
      const updated = await tx.memberOrganizationMembership.update({
        where: { id: current.id },
        data: {
          status: ended.status,
          endedAt,
          endedByUserId: user.id,
        },
        select: primaryMembershipSelect,
      });

      await this.auditLogs.log({
        event: 'membership.end',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: {
          id: current.id,
          memberId: current.memberId,
          organizationId: current.organizationId,
        },
        after: {
          id: updated.id,
          memberId: updated.memberId,
          organizationId: updated.organizationId,
          status: MembershipStatus.ENDED,
          endedAt,
          endedByUserId: user.id,
        },
        extra: { viaPath: 'department', operation: 'remove', targetMemberId: memberId },
        tx,
      });

      return updated;
    });
  }
}

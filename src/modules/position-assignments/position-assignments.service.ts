import { Injectable } from '@nestjs/common';
import { AssignmentStatus, PolicyStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { CreatePositionAssignmentDto } from './position-assignments.dto';
import {
  positionAssignmentSafeSelect,
  type SafePositionAssignment,
} from './position-assignments.select';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3 / §4.3 / R2):任职(position-assignments)管理面 service。
// 判权单轨 service 层 rbac.can(0 @Roles;沿 memberships / positions 范式)。任命 / 撤销写 audit(inline,
// 沿 content 范式;resourceType='position_assignment')。
//
// **本表 = 数据 + 任命校验:绝不被任何 rbac.can / AuthzService 判权路径读**(判权是 PR8;RoleBinding 是 PR6)。
// 任命校验(create)读 organization_closure(求 O 的祖先集)+ member_organization_memberships(active 判定)
// **纯属任命业务合法性(requireMembership),绝非判权** —— closure 不进 rbac.can/AuthzService。

const AUDIT_RESOURCE_TYPE = 'position_assignment';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class PositionAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers(自包含;沿 memberships / positions 范式,不抽共享类)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private toResponseDto(row: SafePositionAssignment) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      positionId: row.positionId,
      memberId: row.memberId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      appointedByUserId: row.appointedByUserId,
      revokedByUserId: row.revokedByUserId,
      appointmentSource: row.appointmentSource,
      isConcurrent: row.isConcurrent,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findMemberOrThrow(memberId: string, tx: PrismaTx): Promise<{ id: string }> {
    const member = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return member;
  }

  private async findOrganizationOrThrow(
    organizationId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; nodeTypeCode: string }> {
    const org = await tx.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, nodeTypeCode: true },
    });
    if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return org;
  }

  private async findPositionOrThrow(
    positionId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; allowMultiple: boolean; allowConcurrent: boolean }> {
    const position = await tx.organizationPosition.findFirst({
      where: notDeletedWhere({ id: positionId }),
      select: { id: true, allowMultiple: true, allowConcurrent: true },
    });
    if (!position) throw new BizException(BizCode.POSITION_NOT_FOUND);
    return position;
  }

  // ============ GET /api/admin/v1/organizations/:orgId/position-assignments ============

  // 组织轴:列某组织当前"在任"职务(status=ACTIVE;不含历史)。
  async listByOrganization(user: CurrentUserPayload, organizationId: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    await this.findOrganizationOrThrow(organizationId, this.prisma);
    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: { organizationId, status: AssignmentStatus.ACTIVE, deletedAt: null },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ GET /api/admin/v1/members/:memberId/position-assignments ============

  // 队员轴:列某队员全部任职(含 ENDED / REVOKED 历史;不含软删行)。
  async listByMember(user: CurrentUserPayload, memberId: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    await this.findMemberOrThrow(memberId, this.prisma);
    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: { memberId, deletedAt: null },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ POST /api/admin/v1/organizations/:orgId/position-assignments ============

  // 任命。校验顺序(各自独立 BizCode,便于精确定位失败):
  //   0. 存在性:org / position / member(NOT_FOUND)
  //   1. 任期:endedAt 有值须 > startedAt(TENURE_INVALID)
  //   2. 职务适配:org.nodeType × position 须有 active OrganizationPositionRule(RULE_NOT_MATCHED)
  //   3. requireMembership(匹配规则要求时):member 须在本组织 O 或其任一祖先有 active membership(MEMBERSHIP_REQUIRED)
  //   4. 兼任:position.allowConcurrent=false 时,member 不得已有其它 active 任职(CONCURRENT_FORBIDDEN)
  //   5. 防重:同人同组织同职务已有 active(ALREADY_EXISTS;partial unique 兜底)
  //   6. 单人独占:position.allowMultiple=false 时,(org,position) 已有 active 在任者(SINGLE_HOLDER)
  async create(
    user: CurrentUserPayload,
    organizationId: string,
    dto: CreatePositionAssignmentDto,
    meta: AuditMeta,
  ) {
    await this.assertCanOrThrow(user, 'position-assignment.create.record');

    // 任期校验(纯输入,不触库先做)。
    const startedAt = new Date(dto.startedAt);
    const endedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : null;
    if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
      throw new BizException(BizCode.POSITION_ASSIGNMENT_TENURE_INVALID);
    }

    return this.prisma.$transaction(async (tx) => {
      const org = await this.findOrganizationOrThrow(organizationId, tx);
      const position = await this.findPositionOrThrow(dto.positionId, tx);
      await this.findMemberOrThrow(dto.memberId, tx);

      // 2. 职务适配 + 取 requireMembership(同一条规则)。(nodeTypeCode, positionId) 普通唯一 → 至多 1 active。
      const rule = await tx.organizationPositionRule.findFirst({
        where: {
          nodeTypeCode: org.nodeTypeCode,
          positionId: position.id,
          status: PolicyStatus.ACTIVE,
          deletedAt: null,
        },
        select: { requireMembership: true },
      });
      if (!rule) throw new BizException(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED);

      // 3. requireMembership(冻结稿 R8 + goal「重要说明」BD-4 解读:本组织 O 或其任一祖先有 active membership)。
      //    读 organization_closure(descendantId=O → 祖先集,含 depth-0 自身)+ memberships active 判定。
      //    **纯任命业务合法性,绝非判权;closure 不进 rbac.can / AuthzService**。
      if (rule.requireMembership) {
        const ancestorRows = await tx.organizationClosure.findMany({
          where: { descendantId: organizationId },
          select: { ancestorId: true },
        });
        const scopeOrgIds = ancestorRows.map((r) => r.ancestorId);
        const membership = await tx.memberOrganizationMembership.findFirst({
          where: {
            memberId: dto.memberId,
            status: 'ACTIVE',
            deletedAt: null,
            organizationId: { in: scopeOrgIds },
          },
          select: { id: true },
        });
        if (!membership) throw new BizException(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED);
      }

      // 4. 兼任:position.allowConcurrent=false → member 不得已有其它 active 任职(多数职务 true,允许兼任如赵强)。
      if (!position.allowConcurrent) {
        const otherActive = await tx.organizationPositionAssignment.count({
          where: { memberId: dto.memberId, status: AssignmentStatus.ACTIVE, deletedAt: null },
        });
        if (otherActive > 0) {
          throw new BizException(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
        }
      }

      // 5. 防重:同人同组织同职务已有 active(service 预检 + partial unique 兜底)。
      const dup = await tx.organizationPositionAssignment.count({
        where: {
          organizationId,
          positionId: position.id,
          memberId: dto.memberId,
          status: AssignmentStatus.ACTIVE,
          deletedAt: null,
        },
      });
      if (dup > 0) throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);

      // 6. 单人独占:position.allowMultiple=false → (org,position) 不得有第二条 active(此人已在步骤 5 排除)。
      if (!position.allowMultiple) {
        const holders = await tx.organizationPositionAssignment.count({
          where: {
            organizationId,
            positionId: position.id,
            status: AssignmentStatus.ACTIVE,
            deletedAt: null,
          },
        });
        if (holders > 0) throw new BizException(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
      }

      const created = await this.runWithUniqueGuard(() =>
        tx.organizationPositionAssignment.create({
          data: {
            organizationId,
            positionId: position.id,
            memberId: dto.memberId,
            status: AssignmentStatus.ACTIVE,
            startedAt,
            endedAt,
            appointedByUserId: user.id,
            appointmentSource: dto.appointmentSource ?? null,
            isConcurrent: dto.isConcurrent ?? false,
            note: dto.note ?? null,
          },
          select: positionAssignmentSafeSelect,
        }),
      );

      await this.auditLogs.log({
        event: 'position-assignment.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: {
          organizationId: created.organizationId,
          positionId: created.positionId,
          memberId: created.memberId,
          status: created.status,
          startedAt: created.startedAt,
          endedAt: created.endedAt,
          isConcurrent: created.isConcurrent,
        },
        extra: {
          operation: 'create',
          organizationId: created.organizationId,
          targetMemberId: created.memberId,
        },
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ POST /api/admin/v1/position-assignments/:id/revoke ============

  // 撤销:仅可撤 active 任职 → status=REVOKED + revokedByUserId + endedAt=now(保留行做历史,不软删)。
  async revoke(user: CurrentUserPayload, id: string, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'position-assignment.revoke.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organizationPositionAssignment.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, status: true, memberId: true },
      });
      if (!current) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
      if (current.status !== AssignmentStatus.ACTIVE) {
        throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_ENDED);
      }

      const updated = await tx.organizationPositionAssignment.update({
        where: { id },
        data: {
          status: AssignmentStatus.REVOKED,
          revokedByUserId: user.id,
          endedAt: new Date(),
        },
        select: positionAssignmentSafeSelect,
      });

      await this.auditLogs.log({
        event: 'position-assignment.revoke',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: current.status },
        after: {
          status: updated.status,
          endedAt: updated.endedAt,
          revokedByUserId: updated.revokedByUserId,
        },
        extra: { operation: 'revoke', targetMemberId: updated.memberId },
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ GET /api/admin/v1/position-assignments/:id/history ============

  // 任职变更/历史链:以 :id 锚定 (org, position, member) 三元组,返回其全部非软删行(ACTIVE / ENDED / REVOKED),
  // 按任期起排序 —— 该"人-坑"上的历次任命succession(撤销后仍可查)。
  async history(user: CurrentUserPayload, id: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.history');
    const anchor = await this.prisma.organizationPositionAssignment.findFirst({
      where: notDeletedWhere({ id }),
      select: { organizationId: true, positionId: true, memberId: true },
    });
    if (!anchor) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);

    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: {
        organizationId: anchor.organizationId,
        positionId: anchor.positionId,
        memberId: anchor.memberId,
        deletedAt: null,
      },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ P2002 兜底 ============

  // partial unique organization_position_assignments_active_unique 由 migration.sql 末尾手写,
  // P2002 meta.target 不可靠 → 任何 P2002 直接抛 ALREADY_EXISTS(32021;并发下防重底线)。
  private async runWithUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);
      }
      throw err;
    }
  }
}

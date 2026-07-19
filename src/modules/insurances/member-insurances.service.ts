import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { MemberInsuranceAdminResponseDto, ReviewMemberInsuranceDto } from './insurances.dto';

// 保险模块 T2:admin 查队员自购保险 service(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 14 / E-15。
//
// 仅 1 个读端点:GET admin/v1/members/:memberId/insurances,返数组无分页
// (镜像 admin certificates list 范式;每队员保险记录量小)。
// 判权:rbac.can('member-insurance.read.other')(App 本人侧 self-scope 无码)。
// audit:查询完成后 fail-closed 落 member-insurance.read.other;extra 只记 operation/count,
// 不记录保单号、保险公司或 id 列表。

const adminSelect = {
  id: true,
  memberId: true,
  insurerName: true,
  policyNumber: true,
  coverageStart: true,
  coverageEnd: true,
  createdAt: true,
  updatedAt: true,
  reviewStatusCode: true,
  version: true,
  reviewedAt: true,
} as const satisfies Prisma.MemberInsuranceSelect;

type LockedReviewInsuranceRow = {
  id: string;
  memberId: string;
  reviewStatusCode: string;
  version: number;
};

@Injectable()
export class MemberInsurancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  private isNowaitConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
      return false;
    }
    const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
    const metaCode = typeof meta?.code === 'string' ? meta.code : '';
    const metaMessage = typeof meta?.message === 'string' ? meta.message : '';
    return (
      metaCode === '55P03' ||
      metaMessage.includes('55P03') ||
      error.message.includes('could not obtain lock on row')
    );
  }

  async listForMember(
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberInsuranceAdminResponseDto[]> {
    const action = 'member-insurance.read.other';
    const decision = await this.authz.explain(currentUser, action, {
      type: 'member',
      id: memberId,
    });
    if (
      !decision.allow &&
      !(decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action)))
    ) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const items = await this.prisma.memberInsurance.findMany({
      where: notDeletedWhere({ memberId }),
      select: adminSelect,
      orderBy: { coverageEnd: 'desc' },
    });

    await this.auditLogs.log({
      event: 'member-insurance.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: { operation: 'list', count: items.length },
    });

    return items;
  }

  async reviewForMember(
    memberId: string,
    insuranceId: string,
    dto: ReviewMemberInsuranceDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberInsuranceAdminResponseDto> {
    const action = 'member-insurance.review.record';

    // 冻结锁序第 1 步:判权必须在任何目标存在性查询之前，且新入口只走 rbac.can 单轨。
    if (!(await this.rbac.can(currentUser, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 冻结锁序第 2 步:先锁 Member aggregate；不存在/软删统一 26001。
        const members = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "Member"
          WHERE "id" = ${memberId} AND "deletedAt" IS NULL
          FOR UPDATE
        `);
        if (!members[0]) {
          throw new BizException(BizCode.MEMBER_INSURANCE_NOT_FOUND);
        }

        // 冻结锁序第 3 步:保险行 NOWAIT。归属不匹配/不存在/软删统一 26001；
        // 已被并发写者持锁则快速失败并映射 26011，不等待形成反向锁边。
        const rows = await tx.$queryRaw<LockedReviewInsuranceRow[]>(Prisma.sql`
          SELECT "id", "memberId", "reviewStatusCode", "version"
          FROM "member_insurances"
          WHERE "id" = ${insuranceId}
            AND "memberId" = ${memberId}
            AND "deletedAt" IS NULL
          FOR UPDATE NOWAIT
        `);
        const before = rows[0];
        if (!before) {
          throw new BizException(BizCode.MEMBER_INSURANCE_NOT_FOUND);
        }

        // stale 优先于状态冲突，客户端始终先刷新再判断下一步。
        if (dto.expectedVersion !== before.version) {
          throw new BizException(BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
        }
        if (before.reviewStatusCode !== 'pending') {
          throw new BizException(BizCode.MEMBER_INSURANCE_REVIEW_STATE_INVALID);
        }

        const reviewedAt = new Date();
        const updated = await tx.memberInsurance.update({
          where: { id: before.id },
          data: {
            reviewStatusCode: dto.decision,
            version: { increment: 1 },
            reviewedByUserId: currentUser.id,
            reviewedAt,
          },
          select: adminSelect,
        });

        // 冻结锁序第 4 步:mutation 后同事务 audit；失败必须让业务写整体回滚。
        // context 严格最小化，禁止保单号、保险公司、备注、图片/key/url 或任意自由文本。
        await this.auditLogs.log({
          event: 'member-insurance.review',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: 'member-insurance',
          resourceId: before.id,
          meta: auditMeta,
          before: {
            reviewStatusCode: before.reviewStatusCode,
            version: before.version,
          },
          after: {
            reviewStatusCode: updated.reviewStatusCode,
            version: updated.version,
          },
          extra: {
            memberId,
            insuranceId,
            decision: dto.decision,
          },
          tx,
        });

        return updated;
      });
    } catch (error) {
      if (this.isNowaitConflict(error)) {
        throw new BizException(BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
      }
      throw error;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { AppMyInsuranceDto } from './dto/app/app-my-insurance.dto';
import { CreateAppMeInsuranceDto } from './dto/app/create-app-me-insurance.dto';
import { ListAppMeInsurancesQueryDto } from './dto/app/list-app-me-insurances-query.dto';
import { UpdateAppMeInsuranceDto } from './dto/app/update-app-me-insurance.dto';

// 保险模块 T2:App 自助自购保险 service(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 1-4 / E-14 / D-INS-3。
//
// self-scope 铁律(防 IDOR;沿 app-my-certificates / cancelMy 范式):
//   1. 准入:AppIdentityResolver.resolve + canUseApp=false → FORBIDDEN 40300
//      (memberId=null / member 软删 / member.status!=ACTIVE / Admin 无 member 统一 403);
//   2. where 永远锁 memberId = access.member.id(本人)+ deletedAt: null;
//      **禁止** role 短路 / 接收 body/query memberId(DTO 严格白名单已挡);
//   3. update/delete 按 id + 本人 memberId 查;他人 / 不存在 / 已删统一
//      MEMBER_INSURANCE_NOT_FOUND=26001 防侧信道(E-14)。
// 不接 RBAC(goal §1 拍板;入口仅全局 JwtAuthGuard)。
// PR2 已开放审核/CAS compatibility，但 consumer 仍沿「任意 live self」旧语义；
// 写操作进 audit_logs(member-insurance.{create,update,delete}.self,E-9)，读不写 audit(D-P2-7-16)。
// 日期:normalizeDateOnly 归一北京日;coverageStart > coverageEnd → 26010(E-18)。

const appSelect = {
  id: true,
  insurerName: true,
  policyNumber: true,
  coverageStart: true,
  coverageEnd: true,
  createdAt: true,
  reviewStatusCode: true,
  version: true,
  reviewedAt: true,
} as const satisfies Prisma.MemberInsuranceSelect;

type AppInsuranceRow = Prisma.MemberInsuranceGetPayload<{ select: typeof appSelect }>;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class AppMeInsurancesService {
  private readonly logger = new Logger(AppMeInsurancesService.name);

  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers ============

  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<string> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member.id;
  }

  // 本人 + 未软删行锁查找;他人 / 不存在 / 已删统一 26001(防侧信道,E-14)。
  private async lockMyInsuranceOrThrow(
    id: string,
    memberId: string,
    tx: PrismaTx,
  ): Promise<AppInsuranceRow> {
    const rows = await tx.$queryRaw<AppInsuranceRow[]>(Prisma.sql`
      SELECT
        "id",
        "insurerName",
        "policyNumber",
        "coverageStart",
        "coverageEnd",
        "createdAt",
        "reviewStatusCode",
        "version",
        "reviewedAt"
      FROM "member_insurances"
      WHERE "id" = ${id}
        AND "memberId" = ${memberId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (!rows[0]) throw new BizException(BizCode.MEMBER_INSURANCE_NOT_FOUND);
    return rows[0];
  }

  private recordExpectedVersionUsage(
    expectedVersion: number | undefined,
    operation: 'update' | 'delete',
  ): void {
    this.logger.log({
      event:
        expectedVersion === undefined
          ? 'insurance_expected_version_missing'
          : 'insurance_expected_version_present',
      surface: 'app',
      operation,
    });
  }

  private assertExpectedVersionMatches(
    expectedVersion: number | undefined,
    actualVersion: number,
  ): void {
    if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
      throw new BizException(BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
    }
  }

  private assertCoverageRangeValid(coverageStart: Date | null, coverageEnd: Date): void {
    if (coverageStart !== null && coverageStart.getTime() > coverageEnd.getTime()) {
      throw new BizException(BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);
    }
  }

  // audit snapshot(沿 certificates 范式;Date → toISOString;中敏感不打码,评审稿 E-9)。
  private toSnapshot(row: AppInsuranceRow): Record<string, unknown> {
    return {
      insurerName: row.insurerName,
      policyNumber: row.policyNumber,
      coverageStart: row.coverageStart ? row.coverageStart.toISOString() : null,
      coverageEnd: row.coverageEnd.toISOString(),
    };
  }

  private toAppDto(row: AppInsuranceRow): AppMyInsuranceDto {
    return {
      id: row.id,
      insurerName: row.insurerName,
      policyNumber: row.policyNumber,
      coverageStart: row.coverageStart,
      coverageEnd: row.coverageEnd,
      createdAt: row.createdAt,
      reviewStatusCode: row.reviewStatusCode,
      version: row.version,
      reviewedAt: row.reviewedAt,
    };
  }

  // ============ GET /api/app/v1/me/insurances ============

  async listMy(
    query: ListAppMeInsurancesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyInsuranceDto>> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);

    const where: Prisma.MemberInsuranceWhereInput = { memberId, deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.memberInsurance.findMany({
        where,
        select: appSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.memberInsurance.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toAppDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ POST /api/app/v1/me/insurances ============

  async createMy(
    dto: CreateAppMeInsuranceDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppMyInsuranceDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);

    const coverageStart =
      dto.coverageStart !== undefined ? normalizeDateOnly(dto.coverageStart) : null;
    const coverageEnd = normalizeDateOnly(dto.coverageEnd);
    this.assertCoverageRangeValid(coverageStart, coverageEnd);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.memberInsurance.create({
        data: {
          memberId,
          insurerName: dto.insurerName,
          policyNumber: dto.policyNumber,
          ...(coverageStart !== null ? { coverageStart } : {}),
          coverageEnd,
        },
        select: appSelect,
      });

      await this.auditLogs.log({
        event: 'member-insurance.create.self',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member-insurance',
        resourceId: created.id,
        meta: auditMeta,
        after: this.toSnapshot(created),
        extra: { memberId },
        tx,
      });

      return this.toAppDto(created);
    });
  }

  // ============ PATCH /api/app/v1/me/insurances/:id ============

  async updateMy(
    id: string,
    dto: UpdateAppMeInsuranceDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppMyInsuranceDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);
    this.recordExpectedVersionUsage(dto.expectedVersion, 'update');

    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockMyInsuranceOrThrow(id, memberId, tx);
      this.assertExpectedVersionMatches(dto.expectedVersion, before.version);

      // 合并后的终态日期参与跨字段校验(只改其一也不能造成 start > end)。
      const nextStart =
        dto.coverageStart !== undefined
          ? normalizeDateOnly(dto.coverageStart)
          : before.coverageStart;
      const nextEnd =
        dto.coverageEnd !== undefined ? normalizeDateOnly(dto.coverageEnd) : before.coverageEnd;
      this.assertCoverageRangeValid(nextStart, nextEnd);

      const data: Prisma.MemberInsuranceUncheckedUpdateInput = {};
      if (dto.insurerName !== undefined && dto.insurerName.trim() !== before.insurerName.trim()) {
        data.insurerName = dto.insurerName;
      }
      if (
        dto.policyNumber !== undefined &&
        dto.policyNumber.trim() !== before.policyNumber.trim()
      ) {
        data.policyNumber = dto.policyNumber;
      }
      if (
        dto.coverageStart !== undefined &&
        nextStart?.getTime() !== before.coverageStart?.getTime()
      ) {
        data.coverageStart = nextStart;
      }
      if (dto.coverageEnd !== undefined && nextEnd.getTime() !== before.coverageEnd.getTime()) {
        data.coverageEnd = nextEnd;
      }

      // expectedVersion 自身、trim 等值字符串、北京 date-only 等值日期都不构成实质变更。
      // 真 no-op 必须保持 version/status/updatedAt/audit 全部不动。
      if (Object.keys(data).length === 0) {
        return this.toAppDto(before);
      }

      data.version = { increment: 1 };
      data.reviewStatusCode = 'pending';
      data.reviewedByUserId = null;
      data.reviewedAt = null;

      const updated = await tx.memberInsurance.update({
        where: { id: before.id },
        data,
        select: appSelect,
      });

      await this.auditLogs.log({
        event: 'member-insurance.update.self',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member-insurance',
        resourceId: updated.id,
        meta: auditMeta,
        before: this.toSnapshot(before),
        after: this.toSnapshot(updated),
        extra: { memberId },
        tx,
      });

      return this.toAppDto(updated);
    });
  }

  // ============ DELETE /api/app/v1/me/insurances/:id(软删)============

  async softDeleteMy(
    id: string,
    expectedVersion: number | undefined,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppMyInsuranceDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);
    this.recordExpectedVersionUsage(expectedVersion, 'delete');

    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockMyInsuranceOrThrow(id, memberId, tx);
      this.assertExpectedVersionMatches(expectedVersion, before.version);

      const deleted = await tx.memberInsurance.update({
        where: { id: before.id },
        // 软删只推进 version；原审核状态 / reviewer / reviewedAt 必须保留。
        data: { deletedAt: new Date(), version: { increment: 1 } },
        select: appSelect,
      });

      await this.auditLogs.log({
        event: 'member-insurance.delete.self',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member-insurance',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toSnapshot(before),
        extra: { memberId },
        tx,
      });

      return this.toAppDto(deleted);
    });
  }
}

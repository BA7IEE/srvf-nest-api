import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  AddAllActiveCoverageResultDto,
  AddTeamInsuranceCoverageDto,
  CreateTeamInsurancePolicyDto,
  ListTeamInsuranceCoverageQueryDto,
  ListTeamInsurancePoliciesQueryDto,
  TeamInsuranceCoverageResponseDto,
  TeamInsurancePolicyResponseDto,
  UpdateTeamInsurancePolicyDto,
} from './insurances.dto';

// 保险模块 T2:队统一保单 + 覆盖名单 service(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 5-13 / §3.5 / E-4~E-17。
//
// 判权:入口仅 JwtAuthGuard,每个 public 方法第一条语句 rbac.can()(沿 Slow-4 业务面单轨;
//   read 共用 team-insurance-policy.read.record,覆盖名单读同 read;add/remove 独立两码)。
// 软删:保单软删**不级联**覆盖行(E-4;门槛查询 join p.deletedAt IS NULL 自然失效);
//   覆盖行软删 = 名单移除,partial unique 允许重新加入。
// audit(DB,评审稿 §3.5):policy create/update/delete + coverage add/remove;
//   读不写 audit(团队台账非个人敏感,沿 contribution-rules 先例)。
// 日期:入参 normalizeDateOnly 归一北京日 UTC 午夜;coverageStart > coverageEnd → 26010(E-18)。
// P2002 兜底:覆盖单加撞 partial unique → 26004(镜像 activity-registrations 21002 范式)。

const policySafeSelect = {
  id: true,
  insurerName: true,
  policyNumber: true,
  coverageStart: true,
  coverageEnd: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TeamInsurancePolicySelect;

type SafePolicy = Prisma.TeamInsurancePolicyGetPayload<{ select: typeof policySafeSelect }>;

const coverageWithMemberSelect = {
  id: true,
  policyId: true,
  memberId: true,
  createdAt: true,
  member: { select: { memberNo: true, displayName: true } },
} as const satisfies Prisma.TeamInsuranceCoverageSelect;

type CoverageWithMember = Prisma.TeamInsuranceCoverageGetPayload<{
  select: typeof coverageWithMemberSelect;
}>;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class TeamInsurancePoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findPolicyOrThrow(policyId: string, tx?: PrismaTx): Promise<SafePolicy> {
    const client = tx ?? this.prisma;
    const policy = await client.teamInsurancePolicy.findFirst({
      where: notDeletedWhere({ id: policyId }),
      select: policySafeSelect,
    });
    if (!policy) throw new BizException(BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND);
    return policy;
  }

  // 跨字段日期校验(E-18):起保 > 到期 → 26010;自购与队保单共用语义。
  private assertCoverageRangeValid(coverageStart: Date, coverageEnd: Date): void {
    if (coverageStart.getTime() > coverageEnd.getTime()) {
      throw new BizException(BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);
    }
  }

  // audit snapshot(沿 certificates toCertSnapshot 范式;Date → toISOString,JSON-safe;
  // 保单号/保险公司中敏感非 L3,沿 certificates certNumber 全量不打码,评审稿 E-9)。
  private toPolicySnapshot(p: SafePolicy): Record<string, unknown> {
    return {
      insurerName: p.insurerName,
      policyNumber: p.policyNumber,
      coverageStart: p.coverageStart.toISOString(),
      coverageEnd: p.coverageEnd.toISOString(),
      note: p.note,
    };
  }

  private toCoverageDto(row: CoverageWithMember): TeamInsuranceCoverageResponseDto {
    return {
      id: row.id,
      policyId: row.policyId,
      memberId: row.memberId,
      memberNo: row.member.memberNo,
      memberDisplayName: row.member.displayName,
      createdAt: row.createdAt,
    };
  }

  // ============ 保单 list ============

  async list(
    query: ListTeamInsurancePoliciesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<TeamInsurancePolicyResponseDto>> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.read.record');

    const where = notDeletedWhere({});
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamInsurancePolicy.findMany({
        where,
        select: policySafeSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamInsurancePolicy.count({ where }),
    ]);

    return { items: rows, total, page: query.page, pageSize: query.pageSize };
  }

  // ============ 保单 findOne ============

  async findOne(
    policyId: string,
    currentUser: CurrentUserPayload,
  ): Promise<TeamInsurancePolicyResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.read.record');
    return this.findPolicyOrThrow(policyId);
  }

  // ============ 保单 create ============

  async create(
    dto: CreateTeamInsurancePolicyDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<TeamInsurancePolicyResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.create.record');

    const coverageStart = normalizeDateOnly(dto.coverageStart);
    const coverageEnd = normalizeDateOnly(dto.coverageEnd);
    this.assertCoverageRangeValid(coverageStart, coverageEnd);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.teamInsurancePolicy.create({
        data: {
          insurerName: dto.insurerName,
          policyNumber: dto.policyNumber,
          coverageStart,
          coverageEnd,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
        select: policySafeSelect,
      });

      await this.auditLogs.log({
        event: 'team-insurance-policy.create',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: created.id,
        meta: auditMeta,
        after: this.toPolicySnapshot(created),
        tx,
      });

      return created;
    });
  }

  // ============ 保单 update ============

  async update(
    policyId: string,
    dto: UpdateTeamInsurancePolicyDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<TeamInsurancePolicyResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.update.record');

    return this.prisma.$transaction(async (tx) => {
      const before = await this.findPolicyOrThrow(policyId, tx);

      // 合并后的终态日期参与跨字段校验(只改其一也不能造成 start > end)。
      const nextStart =
        dto.coverageStart !== undefined
          ? normalizeDateOnly(dto.coverageStart)
          : before.coverageStart;
      const nextEnd =
        dto.coverageEnd !== undefined ? normalizeDateOnly(dto.coverageEnd) : before.coverageEnd;
      this.assertCoverageRangeValid(nextStart, nextEnd);

      const data: Prisma.TeamInsurancePolicyUpdateInput = {};
      if (dto.insurerName !== undefined) data.insurerName = dto.insurerName;
      if (dto.policyNumber !== undefined) data.policyNumber = dto.policyNumber;
      if (dto.coverageStart !== undefined) data.coverageStart = nextStart;
      if (dto.coverageEnd !== undefined) data.coverageEnd = nextEnd;
      if (dto.note !== undefined) data.note = dto.note === '' ? null : dto.note;

      const updated = await tx.teamInsurancePolicy.update({
        where: { id: before.id },
        data,
        select: policySafeSelect,
      });

      await this.auditLogs.log({
        event: 'team-insurance-policy.update',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: updated.id,
        meta: auditMeta,
        before: this.toPolicySnapshot(before),
        after: this.toPolicySnapshot(updated),
        tx,
      });

      return updated;
    });
  }

  // ============ 保单 softDelete ============

  async softDelete(
    policyId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<TeamInsurancePolicyResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.delete.record');

    return this.prisma.$transaction(async (tx) => {
      const before = await this.findPolicyOrThrow(policyId, tx);

      // E-4:不级联软删覆盖行——门槛查询 join p.deletedAt IS NULL,被删保单下覆盖行自然失效。
      const deleted = await tx.teamInsurancePolicy.update({
        where: { id: before.id },
        data: { deletedAt: new Date() },
        select: policySafeSelect,
      });

      await this.auditLogs.log({
        event: 'team-insurance-policy.delete',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toPolicySnapshot(before),
        tx,
      });

      return deleted;
    });
  }

  // ============ 覆盖名单 list ============

  async listCoverage(
    policyId: string,
    query: ListTeamInsuranceCoverageQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<TeamInsuranceCoverageResponseDto>> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.read.record');
    await this.findPolicyOrThrow(policyId);

    const where = notDeletedWhere({ policyId });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamInsuranceCoverage.findMany({
        where,
        select: coverageWithMemberSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamInsuranceCoverage.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toCoverageDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ 覆盖名单单加 ============

  async addMember(
    policyId: string,
    dto: AddTeamInsuranceCoverageDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<TeamInsuranceCoverageResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.add.member');

    return this.prisma.$transaction(async (tx) => {
      await this.findPolicyOrThrow(policyId, tx);

      // 单加要求 member 存在且未软删(status 不限,管理员显式意图;评审稿 E-17)。
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id: dto.memberId }),
        select: { id: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

      // 串行预检查(活跃行重复 → 26004);并发兜底由 partial unique P2002 同码(E-16)。
      const existing = await tx.teamInsuranceCoverage.findFirst({
        where: notDeletedWhere({ policyId, memberId: dto.memberId }),
        select: { id: true },
      });
      if (existing) throw new BizException(BizCode.TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS);

      let created: CoverageWithMember;
      try {
        created = await tx.teamInsuranceCoverage.create({
          data: { policyId, memberId: dto.memberId },
          select: coverageWithMemberSelect,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS);
        }
        throw err;
      }

      await this.auditLogs.log({
        event: 'team-insurance-coverage.add',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: policyId,
        meta: auditMeta,
        extra: { mode: 'single', memberId: dto.memberId },
        tx,
      });

      return this.toCoverageDto(created);
    });
  }

  // ============ 覆盖名单全体在册一键加(幂等;仅 ACTIVE 未软删队员)============

  async addAllActiveMembers(
    policyId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AddAllActiveCoverageResultDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.add.member');

    return this.prisma.$transaction(async (tx) => {
      await this.findPolicyOrThrow(policyId, tx);

      // 选取:Member ACTIVE + 未软删,且当前不在本保单活跃覆盖中(幂等核心,D-INS-6)。
      const candidates = await tx.member.findMany({
        where: {
          deletedAt: null,
          status: MemberStatus.ACTIVE,
          teamInsuranceCoverages: { none: { policyId, deletedAt: null } },
        },
        select: { id: true },
      });

      if (candidates.length > 0) {
        // createMany + skipDuplicates:partial unique 兜底并发(重复行静默跳过,保持幂等)。
        await tx.teamInsuranceCoverage.createMany({
          data: candidates.map((m) => ({ policyId, memberId: m.id })),
          skipDuplicates: true,
        });
      }

      // 幂等语义:二跑 addedCount=0 也写 audit(操作本身发生过;镜像 auth.logout extra.found 范式)。
      await this.auditLogs.log({
        event: 'team-insurance-coverage.add',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: policyId,
        meta: auditMeta,
        extra: { mode: 'all-active', addedCount: candidates.length },
        tx,
      });

      return { addedCount: candidates.length };
    });
  }

  // ============ 覆盖名单移除(软删覆盖行;partial unique 允许重新加入)============

  async removeMember(
    policyId: string,
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<TeamInsuranceCoverageResponseDto> {
    await this.assertCanOrThrow(currentUser, 'team-insurance-policy.remove.member');

    return this.prisma.$transaction(async (tx) => {
      await this.findPolicyOrThrow(policyId, tx);

      const coverage = await tx.teamInsuranceCoverage.findFirst({
        where: notDeletedWhere({ policyId, memberId }),
        select: coverageWithMemberSelect,
      });
      if (!coverage) throw new BizException(BizCode.TEAM_INSURANCE_COVERAGE_NOT_FOUND);

      const removed = await tx.teamInsuranceCoverage.update({
        where: { id: coverage.id },
        data: { deletedAt: new Date() },
        select: coverageWithMemberSelect,
      });

      await this.auditLogs.log({
        event: 'team-insurance-coverage.remove',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'team-insurance-policy',
        resourceId: policyId,
        meta: auditMeta,
        extra: { memberId },
        tx,
      });

      return this.toCoverageDto(removed);
    });
  }
}

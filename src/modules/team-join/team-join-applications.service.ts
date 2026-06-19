import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_APPROVED,
  APP_STATUS_JOINING,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_REJECTED,
  ELIM_STAGE_EVALUATION,
  ELIM_STAGE_GATE_TIMEOUT,
  type GateCode,
  type GateMark,
  type GateMarks,
  allGeneralGatesSatisfied,
  isExtendableGate,
} from './team-join.constants';
import {
  type ContributionResult,
  buildGateStatus,
  computeContribution,
} from './team-join-progress';
import type {
  EvaluateTeamJoinApplicationDto,
  MarkGateDto,
  TeamJoinApplicationAdminDto,
} from './team-join.dto';

// 招新三期(入队)T2(2026-06-19):入队申请 admin surface 逻辑(评审稿 §3.2 / §4)。
// 标 gate(幂等;末次全过 + 贡献值≥5 自动推进 pending_evaluation)/ 综合评估(单一人工闸)/
// list+detail / 贡献值只读汇总(approved sheet,checkInAt < cutoff)。一键入队(joined)在 T4。

const AUDIT_RESOURCE_TYPE = 'team_join_application';

// 行查询统一带 cycle(openedAt/year 算 gate 有效期 + 贡献值 cutoff)+ member(展示编号/称呼)。
const APPLICATION_INCLUDE = {
  cycle: { select: { openedAt: true, year: true } },
  member: { select: { memberNo: true, displayName: true } },
} as const;

type ApplicationRow = Prisma.TeamJoinApplicationGetPayload<{ include: typeof APPLICATION_INCLUDE }>;

@Injectable()
export class TeamJoinApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findOrThrow(
    id: string,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<ApplicationRow> {
    const row = await client.teamJoinApplication.findFirst({
      where: { id, deletedAt: null },
      include: APPLICATION_INCLUDE,
    });
    if (!row) {
      throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    }
    return row;
  }

  // ============ admin 列表(可按 cycleId / statusCode 过滤;贡献值列表不算 = null)============
  async listForAdmin(
    query: PaginationQueryDto,
    filters: { cycleId?: string; statusCode?: string },
    user: CurrentUserPayload,
  ): Promise<PageResultDto<TeamJoinApplicationAdminDto>> {
    await this.assertCanOrThrow(user, 'team-join-application.read.record');
    const where: Prisma.TeamJoinApplicationWhereInput = { deletedAt: null };
    if (filters.cycleId !== undefined) where.cycleId = filters.cycleId;
    if (filters.statusCode !== undefined) where.statusCode = filters.statusCode;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamJoinApplication.findMany({
        where,
        include: APPLICATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamJoinApplication.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toAdminDto(r, null, new Date())),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ admin 详情(含实时贡献值汇总)============
  async detailForAdmin(id: string, user: CurrentUserPayload): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    const contribution = await computeContribution(this.prisma, row.memberId, row.cycle.year);
    return this.toAdminDto(row, contribution, new Date());
  }

  // ============ 标 gate(幂等;仅 joining/pending_evaluation 态;末次自动推进)============
  async markGate(
    id: string,
    dto: MarkGateDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.mark.gate');
    return this.prisma.$transaction(async (tx) => {
      const row = await this.findOrThrow(id, tx);
      // 仅 joining / pending_evaluation 可标(approved/joined/rejected 后门槛锁死)
      if (
        row.statusCode !== APP_STATUS_JOINING &&
        row.statusCode !== APP_STATUS_PENDING_EVALUATION
      ) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }
      const code = dto.gateCode as GateCode; // DTO @IsIn 已校验 ∈ ALL_GATE_CODES
      const marks: GateMarks = { ...((row.gateMarks as GateMarks | null) ?? {}) };
      const mark: GateMark = {
        at: now.toISOString(),
        by: user.id,
        passed: dto.passed,
        completionDate: new Date(dto.completionDate).toISOString(),
      };
      // 延长期仅 dept-assessment 可设;非可延 gate 传则忽略(评审稿 §4.2)
      if (dto.extendedUntil !== undefined && isExtendableGate(code)) {
        mark.extendedUntil = new Date(dto.extendedUntil).toISOString();
      }
      marks[code] = mark;

      // 单一真相源自动推进:8 通用全满足 + 贡献值≥5 → pending_evaluation;否则回退 joining
      const generalSatisfied = allGeneralGatesSatisfied(marks, row.cycle.openedAt, now);
      const contribution = await computeContribution(tx, row.memberId, row.cycle.year);
      const nextStatus =
        generalSatisfied && contribution.satisfied
          ? APP_STATUS_PENDING_EVALUATION
          : APP_STATUS_JOINING;

      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data: { gateMarks: marks as Prisma.InputJsonValue, statusCode: nextStatus },
        include: APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.mark-gate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: {
          gateCode: code,
          passed: dto.passed,
          generalGatesSatisfied: generalSatisfied,
          contributionSatisfied: contribution.satisfied,
        },
        tx,
      });
      return this.toAdminDto(updated, contribution, now);
    });
  }

  // ============ 综合评估 / 淘汰(单一人工闸;评审稿 §4.5)============
  // pending_evaluation:approved→approved(待入队)/ 否→rejected(evaluation);
  // joining:仅 approved=false 淘汰(gate-timeout);approved=true→28240(门槛未齐);其余态→28240。
  async evaluate(
    id: string,
    dto: EvaluateTeamJoinApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.evaluate.assessment');
    return this.prisma.$transaction(async (tx) => {
      const row = await this.findOrThrow(id, tx);
      let nextStatus: string;
      let eliminationStage: string | null = null;
      if (row.statusCode === APP_STATUS_PENDING_EVALUATION) {
        if (dto.approved) {
          // 重校验(bug MED 修复,2026-06-19 元核验;沿 phase-2 FM-A 精神):pending_evaluation
          // 期间 years gate(军训 2年/初级救援 3年)或 dept-assessment 延长期可能过期,不可信旧
          // statusCode 放过过期项 → 重跑 8 通用门槛 + 贡献值,不再满足则拒(28240),不写 approved;
          // 旧 pending 态保留,admin 重标 gate 时 mark-gate 自动重算回退 joining(单一真相源自愈)。
          const marks = (row.gateMarks as GateMarks | null) ?? null;
          const generalSatisfied = allGeneralGatesSatisfied(marks, row.cycle.openedAt, now);
          const contribution = await computeContribution(tx, row.memberId, row.cycle.year);
          if (!generalSatisfied || !contribution.satisfied) {
            throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
          }
          nextStatus = APP_STATUS_APPROVED;
        } else {
          nextStatus = APP_STATUS_REJECTED;
          eliminationStage = ELIM_STAGE_EVALUATION;
        }
      } else if (row.statusCode === APP_STATUS_JOINING) {
        if (dto.approved) {
          // 门槛未齐不可直接过评估(必须先全完成 + 贡献值≥5 自动到 pending_evaluation)
          throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
        }
        nextStatus = APP_STATUS_REJECTED;
        eliminationStage = ELIM_STAGE_GATE_TIMEOUT;
      } else {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }

      const data: Prisma.TeamJoinApplicationUpdateInput = {
        statusCode: nextStatus,
        evaluatedByUserId: user.id,
        evaluatedAt: now,
      };
      if (dto.note !== undefined) data.evaluationNote = dto.note;
      if (eliminationStage) data.eliminationStage = eliminationStage;
      // 综合评估延长期仅 approve 时记(approved 态跨轮入队仍认;评审稿 §4.2)
      if (nextStatus === APP_STATUS_APPROVED && dto.evaluationExtendedUntil !== undefined) {
        data.evaluationExtendedUntil = new Date(dto.evaluationExtendedUntil);
      }

      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data,
        include: APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.evaluate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: { approved: dto.approved, eliminationStage },
        tx,
      });
      return this.toAdminDto(updated, null, now);
    });
  }

  private toAdminDto(
    row: ApplicationRow,
    contribution: ContributionResult | null,
    now: Date,
  ): TeamJoinApplicationAdminDto {
    const marks = (row.gateMarks as GateMarks | null) ?? null;
    return {
      id: row.id,
      cycleId: row.cycleId,
      memberId: row.memberId,
      memberNo: row.member.memberNo,
      memberDisplayName: row.member.displayName,
      statusCode: row.statusCode,
      targetOrganizationIds: (row.targetOrganizationIds as string[] | null) ?? [],
      selectedOrganizationId: row.selectedOrganizationId,
      gates: buildGateStatus(marks, row.cycle.openedAt, now),
      generalGatesSatisfied: allGeneralGatesSatisfied(marks, row.cycle.openedAt, now),
      contributionPoints: contribution ? contribution.points.toString() : null,
      contributionSatisfied: contribution ? contribution.satisfied : null,
      evaluationNote: row.evaluationNote,
      evaluatedAt: row.evaluatedAt,
      evaluationExtendedUntil: row.evaluationExtendedUntil,
      eliminationStage: row.eliminationStage,
      joinedAt: row.joinedAt,
      createdAt: row.createdAt,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  CreateAppTeamJoinApplicationDto,
  AppTeamJoinApplicationDto,
  UpdateAppTeamJoinTargetsDto,
} from './dto/app/app-team-join.dto';
import {
  APP_STATUS_JOINING,
  CYCLE_STATUS_OPEN,
  type GateMarks,
  allGeneralGatesSatisfied,
} from './team-join.constants';
import {
  type ContributionResult,
  buildGateStatus,
  computeContribution,
} from './team-join-progress';

// 招新三期(入队)T3(2026-06-19):App 自助面逻辑(评审稿 §3.2 / E-J-5)。
// 准入 = AppIdentityResolver(canUseApp=false → 403);self-scope 锁 currentUser.memberId、不接 path/body memberId;
// 发起入队申请(选候选部门)/ 查进度 / 改候选部门。一键入队(joined)走 admin T4。

const AUDIT_RESOURCE_TYPE = 'team_join_application';

type PrismaTx = Prisma.TransactionClient;

const APP_CYCLE_SELECT = { name: true, year: true, openedAt: true } as const;
const APP_APPLICATION_INCLUDE = { cycle: { select: APP_CYCLE_SELECT } } as const;
type AppApplicationRow = Prisma.TeamJoinApplicationGetPayload<{
  include: typeof APP_APPLICATION_INCLUDE;
}>;

@Injectable()
export class AppMeTeamJoinService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // 准入:canUseApp=false（memberId=null / member 软删 / member 非 ACTIVE）→ 403。返回本人 memberId。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<string> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member.id;
  }

  // 已入队拦截:member 已有级别(gradeCode)或 active 部门归属 → 28210(非新志愿者)。
  private async assertNotEnrolledOrThrow(memberId: string, tx: PrismaTx): Promise<void> {
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    if (member?.gradeCode != null) {
      throw new BizException(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
    }
    const dept = await tx.memberDepartment.findFirst({
      where: { memberId, deletedAt: null },
      select: { id: true },
    });
    if (dept) {
      throw new BizException(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
    }
  }

  // 当前唯一 open 入队轮;无 → 28230。
  private async findOpenCycleOrThrow(tx: PrismaTx): Promise<{ id: string }> {
    const cycle = await tx.teamJoinCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      select: { id: true },
    });
    if (!cycle) {
      throw new BizException(BizCode.TEAM_JOIN_CYCLE_NOT_OPEN);
    }
    return cycle;
  }

  // 候选部门校验(维护者点名 T3):去重后每个 org 须存在 + ACTIVE(targetOrganizationIds 无 FK,
  // selectedOrganizationId 才 FK RESTRICT 兜底)。返回去重后的列表。
  private async validateTargetOrgsOrThrow(orgIds: string[], tx: PrismaTx): Promise<string[]> {
    const unique = [...new Set(orgIds)];
    for (const orgId of unique) {
      const org = await tx.organization.findFirst({
        where: { id: orgId, deletedAt: null },
        select: { status: true },
      });
      if (!org) {
        throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
      }
      if (org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }
    }
    return unique;
  }

  // ============ POST /api/app/v1/me/team-join/applications(发起入队申请)============
  async submit(
    dto: CreateAppTeamJoinApplicationDto,
    currentUser: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<AppTeamJoinApplicationDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);
    return this.prisma.$transaction(async (tx) => {
      await this.assertNotEnrolledOrThrow(memberId, tx);
      const cycle = await this.findOpenCycleOrThrow(tx);
      const targets = await this.validateTargetOrgsOrThrow(dto.targetOrganizationIds, tx);

      let created: AppApplicationRow;
      try {
        created = await tx.teamJoinApplication.create({
          data: {
            cycleId: cycle.id,
            memberId,
            statusCode: APP_STATUS_JOINING,
            targetOrganizationIds: targets,
          },
          include: APP_APPLICATION_INCLUDE,
        });
      } catch (err) {
        // 同轮同人已有活跃申请(partial unique P2002 兜底)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.TEAM_JOIN_DUPLICATE_APPLICATION);
        }
        throw err;
      }

      await this.auditLogs.log({
        event: 'team-join-application.submit',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: { statusCode: created.statusCode, cycleId: cycle.id, targetCount: targets.length },
        tx,
      });
      const contribution = await computeContribution(tx, memberId, created.cycle.year);
      return this.toSelfDto(created, contribution, now);
    });
  }

  // ============ GET /api/app/v1/me/team-join/applications/current(查进度)============
  // self-scope:本人最近一条未软删入队申请 + 实时 gate 实况 + 贡献值汇总;无 → 404。
  async getCurrent(currentUser: CurrentUserPayload): Promise<AppTeamJoinApplicationDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);
    const row = await this.prisma.teamJoinApplication.findFirst({
      where: { memberId, deletedAt: null },
      include: APP_APPLICATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    }
    const contribution = await computeContribution(this.prisma, memberId, row.cycle.year);
    return this.toSelfDto(row, contribution, new Date());
  }

  // ============ PATCH /api/app/v1/me/team-join/applications/:id/targets(改候选部门)============
  // self-scope:按 (id, memberId) 锁本人;他人/不存在统一 404;仅 joining 态可改。
  async updateTargets(
    id: string,
    dto: UpdateAppTeamJoinTargetsDto,
    currentUser: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<AppTeamJoinApplicationDto> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.teamJoinApplication.findFirst({
        where: { id, memberId, deletedAt: null },
        include: APP_APPLICATION_INCLUDE,
      });
      if (!row) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
      }
      if (row.statusCode !== APP_STATUS_JOINING) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }
      const targets = await this.validateTargetOrgsOrThrow(dto.targetOrganizationIds, tx);
      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data: { targetOrganizationIds: targets },
        include: APP_APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.submit',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { targetCount: (row.targetOrganizationIds as string[] | null)?.length ?? 0 },
        after: { targetCount: targets.length },
        tx,
      });
      const contribution = await computeContribution(tx, memberId, updated.cycle.year);
      return this.toSelfDto(updated, contribution, now);
    });
  }

  private toSelfDto(
    row: AppApplicationRow,
    contribution: ContributionResult,
    now: Date,
  ): AppTeamJoinApplicationDto {
    const marks = (row.gateMarks as GateMarks | null) ?? null;
    return {
      id: row.id,
      cycleId: row.cycleId,
      cycleName: row.cycle.name,
      cycleYear: row.cycle.year,
      statusCode: row.statusCode,
      targetOrganizationIds: (row.targetOrganizationIds as string[] | null) ?? [],
      selectedOrganizationId: row.selectedOrganizationId,
      gates: buildGateStatus(marks, row.cycle.openedAt, now),
      generalGatesSatisfied: allGeneralGatesSatisfied(marks, row.cycle.openedAt, now),
      contributionPoints: contribution.points.toString(),
      contributionSatisfied: contribution.satisfied,
      evaluationNote: row.evaluationNote,
      eliminationStage: row.eliminationStage,
      createdAt: row.createdAt,
    };
  }
}

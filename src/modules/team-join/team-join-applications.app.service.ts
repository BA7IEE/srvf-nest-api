import { Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  CreateAppTeamJoinApplicationDto,
  AppTeamJoinApplicationDto,
  UpdateAppTeamJoinTargetsDto,
} from './dto/app/app-team-join.dto';
import {
  APP_STATUS_JOINING,
  CYCLE_STATUS_OPEN,
  TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS,
  TEAM_JOIN_MAX_TARGET_ORGS,
  type GateMarks,
  allGeneralGatesSatisfied,
  isUnenrolledVolunteer,
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

const APP_CYCLE_SELECT = {
  name: true,
  year: true,
  openedAt: true,
  openOrganizationIds: true,
  maxTargetOrgs: true,
} as const;
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

  // 已入队拦截(招新闭环优化 S5;评审稿 §5.2b):仅「未入队志愿者」可发起 ——
  // 新口径(gradeCode='volunteer' + 仅一条 VOL active 部门)/ legacy 口径(gradeCode=null + 零部门);
  // 其余(已设 level-* 级别 / 已有非 VOL 部门)→ 28210。判定走共享纯函数 isUnenrolledVolunteer(两处门禁零漂移)。
  private async assertNotEnrolledOrThrow(memberId: string, tx: PrismaTx): Promise<void> {
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门)。
    const activeDepts = await tx.memberOrganizationMembership.findMany({
      where: {
        ...MembershipTermStateMachine.effectiveWhere(new Date()),
        memberId,
        membershipType: 'PRIMARY',
      },
      select: { organization: { select: { code: true } } },
    });
    if (!isUnenrolledVolunteer({ gradeCode: member?.gradeCode ?? null }, activeDepts)) {
      throw new BizException(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
    }
  }

  // 当前唯一 open 入队轮;无 → 28230。
  // 十项收口刀B:补 orderBy——此前无排序,若历史上曾并发穿透出双 open 轮,选轮非确定
  // (partial unique 落地后至多一行,此排序为防御性确定化,镜像 recruitment 侧口径)。
  private async findOpenCycleOrThrow(tx: PrismaTx) {
    const cycle = await tx.teamJoinCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, openOrganizationIds: true, maxTargetOrgs: true },
    });
    if (!cycle) {
      throw new BizException(BizCode.TEAM_JOIN_CYCLE_NOT_OPEN);
    }
    return cycle;
  }

  // 候选部门校验(维护者点名 T3):去重后每个 org 须存在 + ACTIVE(targetOrganizationIds 无 FK,
  // selectedOrganizationId 才 FK RESTRICT 兜底)。返回去重后的列表。
  private async validateTargetOrgsOrThrow(
    orgIds: string[],
    cycle: { openOrganizationIds: unknown; maxTargetOrgs: number | null },
    tx: PrismaTx,
  ): Promise<string[]> {
    const unique = [...new Set(orgIds)];
    // 旧轮可能存有 > 当前硬上限的历史配置;不订正存量行,所有新写校验按有效上限钳制。
    const maxTargetOrgs = Math.min(
      cycle.maxTargetOrgs ?? TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS,
      TEAM_JOIN_MAX_TARGET_ORGS,
    );
    if (unique.length > maxTargetOrgs) {
      throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
    }
    const orgs = await tx.organization.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, status: true },
    });
    if (orgs.length !== unique.length) {
      throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    }
    if (orgs.some((org) => org.status !== OrganizationStatus.ACTIVE)) {
      throw new BizException(BizCode.ORGANIZATION_INACTIVE);
    }
    const openOrganizationIds = Array.isArray(cycle.openOrganizationIds)
      ? (cycle.openOrganizationIds as string[])
      : [];
    if (
      openOrganizationIds.length > 0 &&
      unique.some((orgId) => !openOrganizationIds.includes(orgId))
    ) {
      throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
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
      const targets = await this.validateTargetOrgsOrThrow(dto.targetOrganizationIds, cycle, tx);

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
      await claimAtStatus(tx, {
        target: 'teamJoinApplication',
        id: row.id,
        expectedStatus: APP_STATUS_JOINING,
        invalidStatusBiz: BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE,
      });
      const lockedRow = await tx.teamJoinApplication.findFirst({
        where: { id, memberId, deletedAt: null },
        include: APP_APPLICATION_INCLUDE,
      });
      if (!lockedRow) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
      }
      if (lockedRow.statusCode !== APP_STATUS_JOINING) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }
      const targets = await this.validateTargetOrgsOrThrow(
        dto.targetOrganizationIds,
        lockedRow.cycle,
        tx,
      );
      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data: { targetOrganizationIds: targets },
        include: APP_APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.update-targets',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: {
          targetCount: (lockedRow.targetOrganizationIds as string[] | null)?.length ?? 0,
        },
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
      openOrganizationIds: Array.isArray(row.cycle.openOrganizationIds)
        ? (row.cycle.openOrganizationIds as string[])
        : [],
      // 与写侧校验保持同一有效口径;旧轮原值不改,App 只回显硬上限内的有效值。
      maxTargetOrgs: Math.min(
        row.cycle.maxTargetOrgs ?? TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS,
        TEAM_JOIN_MAX_TARGET_ORGS,
      ),
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

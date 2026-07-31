import { Injectable } from '@nestjs/common';
import {
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  Prisma,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import {
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../common/prisma/member-advisory-lock.util';
import { lockLinkedUserLifecycle, lockMemberLifecycle } from '../members/member-lifecycle-lock';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_RECRUITMENT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_APPROVED,
  APP_STATUS_JOINED,
  APP_STATUS_REJECTED,
  ELIM_STAGE_ALREADY_ENROLLED,
  type GateMarks,
  JOIN_GRADE_CODE,
  LIVE_APPLICATION_STATUS_CODES,
  MEMBER_GRADE_DICT_CODE,
  VOL_ORG_CODE,
  allGeneralGatesSatisfied,
  isGateSatisfied,
  isUnenrolledVolunteer,
  professionalGateForNodeType,
} from './team-join.constants';
import {
  TEAM_JOIN_APPLICATION_INCLUDE,
  buildAdminDto,
  computeContribution,
} from './team-join-progress';
import type { JoinTeamJoinApplicationDto, TeamJoinApplicationAdminDto } from './team-join.dto';

// 招新三期(入队)T4(2026-06-19):一键入队 = 志愿者 → 队员(评审稿 §4.5;最重一刀)。
// 综合评估 approved → admin 选定**单一**部门 → 单事务原子「设部门 + 级别 level-1 → joined」。
// **直连 prisma、不复用 member-departments/members service**(Prisma 嵌套交互事务不支持 + 防环,沿
// phase-2 promote 铁律)。守住:原子(全或无)/ 幂等(joined 离 approved 重跑 28240 + member_departments
// partial unique 兜底)/ 两层身份转换(此刻才赋部门 + 级别)/ 专业队资格 /
// 兜底重校验(8 通用门槛 + 贡献值仍满足)。
// ⚠️ 并发审计 S5 收口(2026-07-31):这里原写「综合评估本轮有效(延长期消费)」,
// 与运行时和 canonical 都不符 —— **approved 资格不随轮关闭失效**
// (步骤 2 的代码注释与 `docs/handoff/admin-web.md:528` 一致),final join 不消费评估延长期。

const AUDIT_RESOURCE_TYPE = 'team_join_application';
type PrismaTx = Prisma.TransactionClient;

interface LockedTeamJoinApplicationRow {
  id: string;
  cycleId: string;
  memberId: string;
}

interface LockedTeamJoinCycleRow {
  id: string;
  requiresInsurance: boolean;
}

@Injectable()
export class TeamJoinEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly notificationOutbox: NotificationOutboxService,
    private readonly insuranceRequirement: InsuranceRequirementService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 复刻 members.assertGradeCodeValid(直连 prisma 防环):level-1 须存在 + ACTIVE(seed 已保证)。
  private async assertGradeCodeValidTx(tx: PrismaTx, gradeCode: string): Promise<void> {
    const item = await tx.dictItem.findFirst({
      where: {
        code: gradeCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: { code: MEMBER_GRADE_DICT_CODE, status: DictTypeStatus.ACTIVE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.MEMBER_GRADE_CODE_INVALID);
  }

  // ============ POST /api/admin/v1/team-join/applications/:id/join ============
  async join(
    id: string,
    dto: JoinTeamJoinApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.join.member');
    // 业务写与 durable notification intent 同一事务；任一失败均全部回滚。
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    const result = await runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // 0. member 线性化键(并发审计 B-F4/B-F5)。必须在**任何 Application 行锁之前**取:
      //    同一队员可以同时存在两条 approved 申请(旧轮 + 新轮),两个终审各锁一条再反向
      //    争 Member,加上第 9 步的同人级联,就是标准的 40P01。先在队员维度串行,
      //    下面 Application→Cycle→source→Member 的行锁图**逐字不变**。
      //    memberId 是不可变列(全仓无改写入口),因此锁前读它是安全的;仍在锁后复核一次。
      const preview = await tx.teamJoinApplication.findFirst({
        where: { id, deletedAt: null },
        select: { memberId: true },
      });
      if (!preview) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
      await lockMembersForWrite(tx, [preview.memberId]);

      // 1. 申请存在 + approved(否则 28240;幂等:joined 重跑命中此闸,不重复设部门/级别)
      const applicationRows = await tx.$queryRaw<LockedTeamJoinApplicationRow[]>(Prisma.sql`
        SELECT "id", "cycleId", "memberId"
        FROM "team_join_applications"
        WHERE "id" = ${id}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `);
      const lockedApplication = applicationRows[0];
      if (!lockedApplication) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
      // fail-closed:锁前拿的 memberId 与锁后行不一致 ⇒ 上面那把线性化键锁错了人,不能继续。
      if (lockedApplication.memberId !== preview.memberId) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }

      const cycleRows = await tx.$queryRaw<LockedTeamJoinCycleRow[]>(Prisma.sql`
        SELECT "id", "requiresInsurance"
        FROM "team_join_cycles"
        WHERE "id" = ${lockedApplication.cycleId}
          AND "deletedAt" IS NULL
        FOR SHARE
      `);
      const lockedCycle = cycleRows[0];
      if (!lockedCycle) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);

      const app = await tx.teamJoinApplication.findFirst({
        where: { id, deletedAt: null },
        include: TEAM_JOIN_APPLICATION_INCLUDE,
      });
      if (!app) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
      if (app.statusCode !== APP_STATUS_APPROVED) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }
      const insuranceEligibility = lockedCycle.requiresInsurance
        ? await this.insuranceRequirement.requireForTeamJoin(app.memberId, now, tx)
        : null;
      await lockMemberLifecycle(tx, app.memberId);
      await lockLinkedUserLifecycle(tx, app.memberId);

      // 2. approved 资格不随轮关闭失效;有效期类 gate 与贡献值仍在后续步骤兜底重校验。

      // 3. 选定部门 ∈ 候选 + 存在 + ACTIVE(否则 28242)
      const candidates = (app.targetOrganizationIds as string[] | null) ?? [];
      if (!candidates.includes(dto.organizationId)) {
        throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
      }
      const org = await tx.organization.findFirst({
        where: { id: dto.organizationId, deletedAt: null },
        select: { status: true, nodeTypeCode: true, name: true }, // name:S3 入队通知 payload(部门名)
      });
      if (!org || org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
      }
      const openOrganizationIds = Array.isArray(app.cycle.openOrganizationIds)
        ? (app.cycle.openOrganizationIds as string[])
        : [];
      if (openOrganizationIds.length > 0 && !openOrganizationIds.includes(dto.organizationId)) {
        throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
      }

      const marks = (app.gateMarks as GateMarks | null) ?? null;

      // 4. 专业队资格(评审稿 §4.4;maintainer T4 ①):选专业队 → 对应 team-* gate 须满足;非专业队跳过
      const requiredGate = professionalGateForNodeType(org.nodeTypeCode);
      if (
        requiredGate !== null &&
        !isGateSatisfied(requiredGate, marks?.[requiredGate], app.cycle.openedAt, now)
      ) {
        throw new BizException(BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
      }

      // 5. 兜底重校验:8 通用门槛 + 贡献值仍满足(防 approved 后过期;否则 28241)
      const generalSatisfied = allGeneralGatesSatisfied(marks, app.cycle.openedAt, now);
      const contribution = await computeContribution(tx, app.memberId, app.cycle.year);
      if (!generalSatisfied || !contribution.satisfied) {
        throw new BizException(BizCode.TEAM_JOIN_GATES_NOT_SATISFIED);
      }

      // 6. member 仍 ACTIVE + 仍是「未入队志愿者」(招新闭环优化 S5;§5.2b:新口径 volunteer+VOL /
      //    legacy null+零部门;判定走共享 isUnenrolledVolunteer 与自助门禁零漂移)。activeDepts 含 org.code,
      //    供步骤 8 定位并结束 VOL 任期(单部门 partial unique:绝不与目标部门同时 active)。
      const member = await tx.member.findFirst({
        where: { id: app.memberId, deletedAt: null },
        select: { status: true, gradeCode: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) throw new BizException(BizCode.MEMBER_INACTIVE);
      // 终态 scoped-authz PR2:重指向 member_organization_memberships 的 active PRIMARY 行(= 旧单部门)。
      const activeDepts = await tx.memberOrganizationMembership.findMany({
        where: {
          ...MembershipTermStateMachine.effectiveWhere(now),
          memberId: app.memberId,
          membershipType: 'PRIMARY',
        },
        select: {
          id: true,
          status: true,
          startedAt: true,
          endedAt: true,
          organization: { select: { code: true } },
        },
      });
      if (!isUnenrolledVolunteer({ gradeCode: member.gradeCode }, activeDepts)) {
        throw new BizException(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
      }

      // 7. 级别校验(level-1 存在 + ACTIVE)
      await this.assertGradeCodeValidTx(tx, JOIN_GRADE_CODE);

      // 8. 单事务原子写(招新闭环优化 S5;§5.2c):守 PRIMARY 单主归属 primary_active_unique ——
      //    新志愿者先结束 VOL 归口 PRIMARY 任期(绝不与目标部门同时 active),legacy(零部门)无 VOL 可结束;
      //    再 create 目标部门 PRIMARY → 设级别 level-1 → 状态 joined(全或无;失败回滚 → member 仍未入队)。
      const volDept = activeDepts.find((d) => d.organization.code === VOL_ORG_CODE);
      if (volDept) {
        const ended = MembershipTermStateMachine.end(volDept, now);
        await tx.memberOrganizationMembership.update({
          where: { id: volDept.id },
          data: { status: ended.status, endedAt: ended.endedAt, endedByUserId: user.id },
        });
      }
      MembershipTermStateMachine.assertValid(
        {
          status: MembershipStatus.ACTIVE,
          startedAt: now,
          endedAt: null,
        },
        now,
      );
      try {
        await tx.memberOrganizationMembership.create({
          data: {
            memberId: app.memberId,
            organizationId: dto.organizationId,
            membershipType: MembershipType.PRIMARY,
            status: MembershipStatus.ACTIVE,
            startedAt: now,
            endedAt: null,
          },
        });
      } catch (err) {
        // primary_active_unique (memberId) WHERE deletedAt IS NULL AND status=ACTIVE AND type=PRIMARY 兜底并发重复入队
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
        }
        throw err;
      }
      await tx.member.update({ where: { id: app.memberId }, data: { gradeCode: JOIN_GRADE_CODE } });
      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data: {
          statusCode: APP_STATUS_JOINED,
          selectedOrganizationId: dto.organizationId,
          joinedAt: now,
        },
        include: TEAM_JOIN_APPLICATION_INCLUDE,
      });

      // 9. 终态级联(并发审计 B-F5):人已经入队了,他名下其它 live 申请必须在同一事务收尾。
      //    不做这一步它们会 frozen —— evaluate 还能把它们推到 approved,而 final join
      //    此后永远 28210,这些行再没有任何现存终态通路,只能人工拆。
      //    ⚠️ 终结的依据是「这个人已经是队员了」,**不是**「所在轮关闭了」;
      //    关轮不使 approved 资格失效那条契约(handoff/admin-web.md:528)不受本刀影响。
      //    按 `id ASC` 稳定序取行锁,与 cycle update 的取锁顺序同向;队员维度已由步骤 0 串行。
      const supersededSiblings = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(
        Prisma.sql`
          SELECT "id", "statusCode"
          FROM "team_join_applications"
          WHERE "memberId" = ${lockedApplication.memberId}
            AND "id" <> ${id}
            AND "deletedAt" IS NULL
            AND "statusCode" IN (${Prisma.join([...LIVE_APPLICATION_STATUS_CODES])})
          ORDER BY "id" ASC
          FOR UPDATE
        `,
      );
      for (const sibling of supersededSiblings) {
        // 刻意不写 evaluatedByUserId / evaluatedAt:没有人评估过这一条,它是被入队事实顶掉的。
        // 谁在什么时候顶掉的,由下面这条 audit 承载。
        await tx.teamJoinApplication.update({
          where: { id: sibling.id },
          data: {
            statusCode: APP_STATUS_REJECTED,
            eliminationStage: ELIM_STAGE_ALREADY_ENROLLED,
          },
        });
        await this.auditLogs.log({
          event: 'team-join-application.supersede',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: sibling.id,
          meta,
          before: { statusCode: sibling.statusCode },
          after: { statusCode: APP_STATUS_REJECTED },
          extra: {
            eliminationStage: ELIM_STAGE_ALREADY_ENROLLED,
            supersededByApplicationId: id,
            memberId: lockedApplication.memberId,
          },
          tx,
        });
      }

      await this.insuranceRequirement.createTeamJoinApplicationEvidence(
        id,
        app.memberId,
        insuranceEligibility,
        tx,
      );

      await this.auditLogs.log({
        event: 'team-join-application.join',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: app.statusCode },
        after: { statusCode: APP_STATUS_JOINED },
        extra: {
          organizationId: dto.organizationId,
          gradeCode: JOIN_GRADE_CODE,
          memberId: app.memberId,
        },
        tx,
      });
      await this.notificationOutbox.enqueue(
        {
          eventKey: `team-join-enrollment:${id}`,
          eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
          payloadVersion: OUTBOX_PAYLOAD_VERSION,
          payload: {
            recipientMemberId: app.memberId,
            notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
            title: '入队成功',
            body: `恭喜!您的入队申请已通过,现已加入「${org.name}」,正式成为队员。`,
            channels: [NOTIFICATION_CHANNEL_IN_APP],
          },
          aggregateType: 'team_join_application',
          aggregateId: id,
          destinationType: 'member',
          destinationRef: app.memberId,
        },
        tx,
      );
      return buildAdminDto(updated, contribution, now);
    });

    return result;
  }
}

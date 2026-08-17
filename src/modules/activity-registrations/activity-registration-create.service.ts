import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import { hasActivityCapacity } from '../activities/activity-capacity';
import {
  InsuranceRequirementService,
  type InsuranceEligibilityDecision,
} from '../insurances/insurance-requirement.service';
import { assertActiveMemberLifecycle } from '../members/member-lifecycle-lock';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import {
  ActivityQualificationEvaluatorService,
  type ActivityQualificationEvaluation,
} from './activity-qualification-evaluator.service';
import { ActivityRegistrationPresenter } from './activity-registration-presenter';
import {
  ActivityRegistrationResponseDto,
  CreateMyRegistrationDto,
  CreateRegistrationDto,
} from './activity-registrations.dto';
import {
  ActivityRegistrationAccessService,
  LockedLegacyRegistrationHead,
  PrismaTx,
  REGISTRATION_STATUS_CANCELLED,
  REGISTRATION_STATUS_PASS,
  REGISTRATION_STATUS_PENDING,
  REGISTRATION_STATUS_WAITLISTED,
  RegistrationFullRow,
} from './activity-registration-access.service';

/*
 * 报名**建单族**(Phase 6-B 第三域第二刀 stage2,§3.2)。
 *
 * 两个入口(管理端 create / 队员端 createMy)+ 八个只服务于它们的判定与落库助手。
 * 骨架同构:判权 → 取 Activity 聚合根锁 → 可报名性/流程/性别/岗位校验 →
 * 容量与状态裁决 → 锁 legacy 头 → 落库 → 追加资格快照。
 *
 * ⚠️ 判权仍在各自方法体内调用(this.access.*),不接受任何「上游已判过」的入参。
 * ⚠️ 锁序:本族是被调用方,「ActivityRegistrationsService」的薄委托是唯一入口;
 * Activity 聚合根锁必须在读 Registration 之前取 —— 顺序即锁序,挪动调用位置会静默破坏它。
 */
@Injectable()
export class ActivityRegistrationCreateService {
  constructor(
    private readonly prisma: PrismaService,
    // 多段共用的前置(判权 / managed 校验 / 聚合根锁 / 回读):判权调用仍在本类各方法体内。
    private readonly access: ActivityRegistrationAccessService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
    private readonly activityParticipationPolicy: ActivityParticipationPolicy,
    private readonly presenter: ActivityRegistrationPresenter,
  ) {}

  // 报名前的 Activity 状态 / 公开性 / 名额校验。
  private async assertActivityRegistrable(
    activityId: string,
    path: 'admin' | 'self',
    tx: PrismaTx,
  ): Promise<{
    id: string;
    capacity: number | null;
    requiresInsurance: boolean;
    startAt: Date;
    endAt: Date;
    genderRequirementCode: string | null;
  }> {
    const act = await this.access.findActivityOrThrow(activityId, tx);
    const decision =
      path === 'self'
        ? this.activityParticipationPolicy.canRegisterSelf(act)
        : this.activityParticipationPolicy.canRegisterByAdmin(act);
    if (!decision.allowed) throw new BizException(decision.biz);
    // 保险 T3:透传门槛三字段给 create()/createMy() 的 assertMemberInsuredForActivity(E-10)
    return {
      id: act.id,
      capacity: act.capacity,
      requiresInsurance: act.requiresInsurance,
      startAt: act.startAt,
      endAt: act.endAt,
      genderRequirementCode: act.genderRequirementCode,
    };
  }

  // v1.1 canonical command owns Form answers, permanent participation identities and final file
  // binding.  Legacy App/Admin creation remains byte-for-byte available for old activities, but it
  // must not create a bypass once either v1.1 runtime prerequisite is live.
  private async assertLegacyRegistrationFlowAllowed(
    activityId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const [liveSession, activeForm, activeScopedRuleSet] = await Promise.all([
      tx.activitySession.findFirst({
        where: { activityId, deletedAt: null, statusCode: 'scheduled' },
        select: { id: true },
      }),
      tx.registrationFormVersion.findFirst({
        where: { activityId, statusCode: 'active' },
        select: { id: true },
      }),
      tx.activityQualificationRuleSet.findFirst({
        where: {
          activityId,
          statusCode: 'active',
          OR: [{ sessionId: { not: null } }, { positionId: { not: null } }],
        },
        select: { id: true },
      }),
    ]);
    if (liveSession || activeForm || activeScopedRuleSet) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED);
    }
  }

  private async assertGenderRequirement(
    memberId: string,
    genderRequirementCode: string | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (genderRequirementCode === null || genderRequirementCode === 'any') return;
    const profile = await tx.memberProfile.findFirst({
      where: notDeletedWhere({ memberId }),
      select: { genderCode: true },
    });
    if (!profile || profile.genderCode !== genderRequirementCode) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    }
  }

  private async resolveActivityPositionForCreate(
    activityId: string,
    activityPositionId: string | undefined,
    tx: PrismaTx,
  ): Promise<{
    id: string;
    capacity: number | null;
    genderRequirementCode: string | null;
  } | null> {
    const activityPositions = await tx.activityPosition.findMany({
      where: { activityId, deletedAt: null },
      select: { id: true, capacity: true, genderRequirementCode: true },
    });
    if (activityPositions.length === 0) {
      if (activityPositionId !== undefined) {
        throw new BizException(BizCode.ACTIVITY_POSITION_NOT_FOUND);
      }
      return null;
    }
    if (activityPositionId === undefined) {
      throw new BizException(BizCode.ACTIVITY_POSITION_REQUIRED);
    }
    const activityPosition = activityPositions.find(
      (candidateActivityPosition) => candidateActivityPosition.id === activityPositionId,
    );
    if (activityPosition === undefined) {
      throw new BizException(BizCode.ACTIVITY_POSITION_NOT_FOUND);
    }
    return activityPosition;
  }

  // create 专用状态分流：全部既有报名闸通过后，按 passCount 与 capacity 决定 pending/waitlisted。
  // 刻意不复用 assertCapacityNotExceeded，确保 approve 的容量闸与 FOR UPDATE 调用逐字不动。
  private async resolveCreateStatusCode(
    activityId: string,
    activityPositionId: string | null,
    activityCapacity: number | null,
    activityPositionCapacity: number | null,
    tx: PrismaTx,
  ): Promise<typeof REGISTRATION_STATUS_PENDING | typeof REGISTRATION_STATUS_WAITLISTED> {
    if (activityCapacity === null && activityPositionCapacity === null) {
      return REGISTRATION_STATUS_PENDING;
    }
    const [activityPassCount, activityPositionPassCount] = await Promise.all([
      tx.activityRegistration.count({
        where: notDeletedWhere({ activityId, statusCode: REGISTRATION_STATUS_PASS }),
      }),
      tx.activityRegistration.count({
        where: notDeletedWhere({
          activityId,
          activityPositionId,
          statusCode: REGISTRATION_STATUS_PASS,
        }),
      }),
    ]);
    return hasActivityCapacity({
      activityCapacity,
      activityPassCount,
      activityPositionCapacity,
      activityPositionPassCount,
    })
      ? REGISTRATION_STATUS_PENDING
      : REGISTRATION_STATUS_WAITLISTED;
  }

  private async lockLegacyRegistrationHeadForCreate(
    activityId: string,
    memberId: string,
    tx: PrismaTx,
  ): Promise<LockedLegacyRegistrationHead | null> {
    const rows = await tx.$queryRaw<LockedLegacyRegistrationHead[]>(Prisma.sql`
      SELECT "id", "statusCode", "currentRevision", "deletedAt"
      FROM "ActivityRegistration"
      WHERE "activityId" = ${activityId} AND "memberId" = ${memberId}
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE
    `);
    if (rows.length > 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const existing = rows[0] ?? null;
    const identities = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${activityId} AND "memberId" = ${memberId}
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (existing === null) {
      if (identities.length > 0) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED);
      }
      return null;
    }
    if (
      existing.deletedAt !== null ||
      (existing.statusCode !== REGISTRATION_STATUS_CANCELLED && existing.statusCode !== 'reject')
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
    }
    if (identities.length > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED);
    }
    return existing;
  }

  private async persistLegacyRegistrationSubmission(input: {
    tx: PrismaTx;
    activityId: string;
    memberId: string;
    activityPositionId: string | null;
    statusCode: typeof REGISTRATION_STATUS_PENDING | typeof REGISTRATION_STATUS_WAITLISTED;
    extras: Record<string, unknown> | undefined;
    sourceCode: 'admin' | 'self';
    submittedByUserId: string;
    insuranceEligibility: InsuranceEligibilityDecision | null;
    reusableHead: LockedLegacyRegistrationHead | null;
  }): Promise<RegistrationFullRow> {
    const submittedAt = new Date();
    const header =
      input.reusableHead ??
      (await this.runWithUniqueConstraintGuard(() =>
        input.tx.activityRegistration.create({
          data: {
            activityId: input.activityId,
            activityPositionId: input.activityPositionId,
            memberId: input.memberId,
            statusCode: input.statusCode,
            currentRevision: 0,
            currentFormVersionId: null,
            statusSummaryCode: 'active',
            sourceCode: input.sourceCode,
            ...(input.extras !== undefined
              ? { extras: input.extras as Prisma.InputJsonValue }
              : {}),
          },
          select: { id: true, currentRevision: true },
        }),
      ));

    const previousRevision =
      header.currentRevision > 0
        ? await input.tx.activityRegistrationRevision.findFirst({
            where: { registrationId: header.id, revision: header.currentRevision },
            select: { id: true },
          })
        : null;
    if (header.currentRevision > 0 && previousRevision === null) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    const revisionNumber = header.currentRevision + 1;
    const revision = await input.tx.activityRegistrationRevision.create({
      data: {
        registrationId: header.id,
        revision: revisionNumber,
        formVersionId: null,
        answersHash: null,
        sourceCode: input.sourceCode,
        submittedByUserId: input.submittedByUserId,
        submittedAt,
        priorRevisionId: previousRevision?.id ?? null,
      },
      select: { id: true },
    });
    await this.insuranceRequirement.createActivityRegistrationEvidence(
      header.id,
      revision.id,
      input.memberId,
      input.insuranceEligibility,
      input.tx,
    );
    const updated = await input.tx.activityRegistration.updateMany({
      where: { id: header.id, currentRevision: header.currentRevision },
      data: {
        activityPositionId: input.activityPositionId,
        statusCode: input.statusCode,
        registeredAt: submittedAt,
        extras:
          input.extras === undefined ? Prisma.JsonNull : (input.extras as Prisma.InputJsonValue),
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        cancelledByUserId: null,
        cancelledAt: null,
        cancelReason: null,
        currentRevision: revisionNumber,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: input.sourceCode,
      },
    });
    if (updated.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return this.access.findRegistrationOrThrow(input.activityId, header.id, input.tx);
  }

  private async appendLegacyQualificationSnapshots(input: {
    tx: PrismaTx;
    registrationId: string;
    revision: number;
    evaluation: ActivityQualificationEvaluation;
  }): Promise<void> {
    if (input.evaluation.snapshotCandidates.length === 0) return;
    const registrationRevision = await input.tx.activityRegistrationRevision.findFirst({
      where: { registrationId: input.registrationId, revision: input.revision },
      select: { id: true },
    });
    if (registrationRevision === null) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    await this.qualificationEvaluator.appendSnapshots({
      evaluation: input.evaluation,
      phase: 'submit',
      registrationRevisionId: registrationRevision.id,
      tx: input.tx,
    });
  }

  async create(
    activityId: string,
    dto: CreateRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.create.record');
    return this.prisma.$transaction(async (tx) => {
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      await this.assertLegacyRegistrationFlowAllowed(activityId, tx);
      const act = await this.assertActivityRegistrable(activityId, 'admin', tx);
      await this.access.assertMemberActiveSnapshot(dto.memberId, tx);
      await this.assertGenderRequirement(dto.memberId, act.genderRequirementCode, tx);
      const activityPosition = await this.resolveActivityPositionForCreate(
        activityId,
        dto.activityPositionId,
        tx,
      );
      await this.assertGenderRequirement(
        dto.memberId,
        activityPosition?.genderRequirementCode ?? null,
        tx,
      );
      const reusableHead = await this.lockLegacyRegistrationHeadForCreate(
        activityId,
        dto.memberId,
        tx,
      );
      const qualification = await this.qualificationEvaluator.evaluate({
        activity: act,
        memberId: dto.memberId,
        tx,
      });
      this.qualificationEvaluator.assertNoBlock(qualification);
      // 保险 T3 报名门槛(admin 代报名同样拦截,C015 无旁路;requiresInsurance=false 零查询,
      // 既有断言零回归;评审稿 §4 / E-10:位于 assertNoActiveRegistration 之后、create 之前)
      const insuranceEligibility = await this.insuranceRequirement.requireForActivityRegistration(
        dto.memberId,
        act,
        tx,
      );
      await assertActiveMemberLifecycle(tx, dto.memberId);
      const initialStatusCode = await this.resolveCreateStatusCode(
        activityId,
        activityPosition?.id ?? null,
        act.capacity,
        activityPosition?.capacity ?? null,
        tx,
      );

      const created = await this.persistLegacyRegistrationSubmission({
        tx,
        activityId,
        memberId: dto.memberId,
        activityPositionId: activityPosition?.id ?? null,
        statusCode: initialStatusCode,
        extras: dto.extras,
        sourceCode: 'admin',
        submittedByUserId: currentUser.id,
        insuranceEligibility,
        reusableHead,
      });
      await this.appendLegacyQualificationSnapshots({
        tx,
        registrationId: created.id,
        revision: created.currentRevision,
        evaluation: qualification,
      });

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'admin',
        activityId,
        targetMemberId: dto.memberId,
        auditMeta,
        tx,
      });

      return this.presenter.toResponseDto(created);
    });
  }

  async createMy(
    activityId: string,
    dto: CreateMyRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.access.resolveUserMemberIdOrThrow(currentUser.id, tx);
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      await this.assertLegacyRegistrationFlowAllowed(activityId, tx);
      const act = await this.assertActivityRegistrable(activityId, 'self', tx);
      await this.access.assertMemberActiveSnapshot(memberId, tx);
      await this.assertGenderRequirement(memberId, act.genderRequirementCode, tx);
      const activityPosition = await this.resolveActivityPositionForCreate(
        activityId,
        dto.activityPositionId,
        tx,
      );
      await this.assertGenderRequirement(
        memberId,
        activityPosition?.genderRequirementCode ?? null,
        tx,
      );
      const reusableHead = await this.lockLegacyRegistrationHeadForCreate(activityId, memberId, tx);
      const qualification = await this.qualificationEvaluator.evaluate({
        activity: act,
        memberId,
        tx,
      });
      this.qualificationEvaluator.assertNoBlock(qualification);
      // 保险 T3 报名门槛(自助路径;App createMyForApp 薄壳经此同样拦截;评审稿 §4 / E-10)
      const insuranceEligibility = await this.insuranceRequirement.requireForActivityRegistration(
        memberId,
        act,
        tx,
      );
      await assertActiveMemberLifecycle(tx, memberId);
      const initialStatusCode = await this.resolveCreateStatusCode(
        activityId,
        activityPosition?.id ?? null,
        act.capacity,
        activityPosition?.capacity ?? null,
        tx,
      );

      const created = await this.persistLegacyRegistrationSubmission({
        tx,
        activityId,
        memberId,
        activityPositionId: activityPosition?.id ?? null,
        statusCode: initialStatusCode,
        extras: dto.extras,
        sourceCode: 'self',
        submittedByUserId: currentUser.id,
        insuranceEligibility,
        reusableHead,
      });
      await this.appendLegacyQualificationSnapshots({
        tx,
        registrationId: created.id,
        revision: created.currentRevision,
        evaluation: qualification,
      });

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'self',
        activityId,
        targetMemberId: memberId,
        auditMeta,
        tx,
      });

      return this.presenter.toResponseDto(created);
    });
  }

  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
      }
      throw err;
    }
  }
}

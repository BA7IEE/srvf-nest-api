import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { assertActiveMemberLifecycle } from '../members/member-lifecycle-lock';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import { ActivityQualificationEvaluatorService } from './activity-qualification-evaluator.service';
import { CapacityReservationService } from './capacity-reservation.service';
import type { CreateAppManagedActivityOnsiteParticipationDto } from './dto/app/app-onsite-participation.dto';
import {
  hashOnsiteParticipationRequest,
  type OnsiteParticipationRequestHashInput,
} from './onsite-participation-request-hash';
import { assertRegistrationCommandHeaderStatus } from './participation-revision-state-machine';
import { decideOnsiteParticipationPass } from './onsite-participation-state-machine';

type PrismaTx = Prisma.TransactionClient;

// The Activity root intentionally serializes onsite writes for one activity. Under a real
// 100-request last-seat convoy, Prisma's 2s/5s interactive-transaction defaults can expire before
// a loser reaches the capacity check and leak an infrastructure 500. Keep the wait finite, but
// give the established serialization enough room to return the truthful capacity business result.
const ONSITE_PARTICIPATION_TX_MAX_WAIT_MS = 10_000;
const ONSITE_PARTICIPATION_TX_TIMEOUT_MS = 15_000;

type LockedActivity = {
  id: string;
  statusCode: string;
  genderRequirementCode: string | null;
  requiresInsurance: boolean;
  startAt: Date;
  endAt: Date;
};

export type OnsiteLockedHeader = {
  id: string;
  statusCode: string;
  currentRevision: number;
  // Production rows always select this column.  Keeping it optional preserves the existing
  // pure selector fixture for corrupted historical double-head defensive coverage.
  deletedAt?: Date | null;
};

export type OnsiteLockedIdentity = {
  id: string;
  activityId: string;
  memberId: string;
  registrationId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  version: number;
};

type LockedPosition = {
  id: string;
  genderRequirementCode: string | null;
  qualificationRuleSetId: string | null;
};

type OnsiteReadClient = Pick<
  Prisma.TransactionClient,
  'activityRegistrationRevision' | 'activityParticipationRevision'
>;

export type OnsiteParticipationReceipt = {
  registrationId: string;
  registrationRevisionId: string;
  participationIdentityId: string;
  participationRevisionId: string;
  statusCode: 'pass';
  sourceCode: 'onsite';
  positionId: string | null;
  approvedAt: Date;
};

/**
 * The database enforces a permanent registration head. A live cancelled/rejected head is reused;
 * a soft-deleted head remains final and cannot fall through to create.
 */
export function selectOnsiteCanonicalHeader(
  headers: readonly OnsiteLockedHeader[],
  identities: readonly OnsiteLockedIdentity[],
): OnsiteLockedHeader | null {
  const reusableLiveHeaders = headers.filter((header) => (header.deletedAt ?? null) === null);
  if (reusableLiveHeaders.length > 1) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const reusableLiveHeader = reusableLiveHeaders[0] ?? null;
  if (reusableLiveHeader === null) {
    if (headers.length > 0 || identities.length > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    return null;
  }
  if (identities.some((identity) => identity.registrationId !== reusableLiveHeader.id)) {
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
  }
  return reusableLiveHeader;
}

@Injectable()
export class OnsiteParticipationCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly capacityReservations: CapacityReservationService,
    private readonly registrationLifecycle: ActivityRegistrationLifecycleService,
    private readonly registrationAudit: ActivityRegistrationAuditRecorder,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
  ) {}

  async create(
    activityId: string,
    dto: CreateAppManagedActivityOnsiteParticipationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteParticipationReceipt> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    await this.assertCreatePermission(currentUser, activityId);

    const reason = dto.reason.trim();
    const requestHashInput: OnsiteParticipationRequestHashInput = {
      actorUserId: currentUser.id,
      activityId,
      memberId: dto.memberId,
      sessionId: dto.sessionId,
      positionId: dto.positionId ?? null,
      reason,
    };
    const requestHash = hashOnsiteParticipationRequest(requestHashInput);

    try {
      return await this.prisma.$transaction(
        (tx) =>
          this.createInTransaction({
            tx,
            activityId,
            operationKey: dto.operationKey,
            targetMemberId: dto.memberId,
            sessionId: dto.sessionId,
            positionId: dto.positionId ?? null,
            reason,
            requestHash,
            currentUser,
            actorMemberId: access.member!.id,
            auditMeta,
          }),
        {
          maxWait: ONSITE_PARTICIPATION_TX_MAX_WAIT_MS,
          timeout: ONSITE_PARTICIPATION_TX_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // Only an exact successful receipt may turn a P2002 race into a replay. Every unmatched
      // P2002 is rethrown unchanged; historical-head handling is the explicit pre-create lock
      // below and must never be implemented as a broad unique-error translation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findExistingReceipt(this.prisma, dto.operationKey, requestHash);
        if (replay !== null) return replay;
      }
      throw error;
    }
  }

  private async createInTransaction(input: {
    tx: PrismaTx;
    activityId: string;
    operationKey: string;
    targetMemberId: string;
    sessionId: string;
    positionId: string | null;
    reason: string;
    requestHash: string;
    currentUser: CurrentUserPayload;
    actorMemberId: string;
    auditMeta: AuditMeta;
  }): Promise<OnsiteParticipationReceipt> {
    // After the Activity-root actor D-5/responsibility recheck, new-fact aggregate locks stay
    // Activity → heads → every member/activity permanent identity → session/position/requirements/
    // insurance → capacity → immutable revisions/pointers → population projection → audit. Exact
    // replays intentionally stop before every mutable activity-state gate.
    const activity = await this.lockActivity(input.tx, input.activityId);

    await this.assertAppAdmissionStillLive(input.tx, input.currentUser.id, input.actorMemberId);
    await this.assertManagedResponsibility(input.tx, input.activityId, input.actorMemberId);

    // An exact successful receipt survives every later mutable activity state, including completed,
    // natural end, posting, posted, and closure. It is still subject to the current actor D-5 and
    // responsibility recheck above, but never consumes capacity or appends any new fact.
    const replay = await this.findExistingReceipt(input.tx, input.operationKey, input.requestHash);
    if (replay !== null) return replay;

    if (activity.statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN);
    }

    // Activity is still FOR UPDATE here; formal posting and closure writers take that same root
    // lock before changing their facts. A new key therefore observes a serialized finality state.
    const now = new Date();
    await this.assertNewOnsiteParticipationIsStillOpen(input.tx, activity, now);

    const headers = await this.lockRegistrationHeaders(
      input.tx,
      input.activityId,
      input.targetMemberId,
    );
    const identities = await this.lockMemberActivityIdentities(
      input.tx,
      input.activityId,
      input.targetMemberId,
    );

    const selectedPosition = await this.lockSessionAndPosition(
      input.tx,
      input.activityId,
      input.sessionId,
      input.positionId,
    );
    await this.assertOnsiteRequirementsAvailable(input.tx, input.activityId);
    await this.assertActiveTargetMember(input.tx, input.targetMemberId);
    await this.assertGenderRequirement(
      input.tx,
      input.targetMemberId,
      activity.genderRequirementCode,
    );
    await this.assertGenderRequirement(
      input.tx,
      input.targetMemberId,
      selectedPosition?.genderRequirementCode ?? null,
    );
    const qualification = await this.qualificationEvaluator.evaluate({
      activity,
      memberId: input.targetMemberId,
      targets: [{ sessionId: input.sessionId, positionId: input.positionId }],
      tx: input.tx,
    });
    this.qualificationEvaluator.assertNoBlock(qualification);

    // Reuse the existing insurance source decision and snapshot writer.  The initial lifecycle
    // read is non-locking so this keeps the established Policy → Coverage → Member final-lock
    // sequence; assertActiveMemberLifecycle below is the definitive mutable-state recheck.
    const insuranceEligibility = await this.insuranceRequirement.requireForActivityRegistration(
      input.targetMemberId,
      activity,
      input.tx,
    );
    await assertActiveMemberLifecycle(input.tx, input.targetMemberId);

    const canonicalHeader = selectOnsiteCanonicalHeader(headers, identities);
    const targetIdentity =
      identities.find((identity) => identity.sessionId === input.sessionId) ?? null;
    await this.registrationLifecycle.assertCapacityPointersReconciledInTransactionTrusted(
      input.tx,
      identities,
      { activityId: input.activityId, memberId: input.targetMemberId },
    );
    await this.registrationLifecycle.assertParticipationRevisionsReconciledInTransactionTrusted(
      input.tx,
      identities,
    );
    if (
      identities.some(
        (identity) =>
          decideOnsiteParticipationPass(identity.currentStatusCode).allowed &&
          (identity.capacityReservationId !== null ||
            identity.currentPositionId !== null ||
            identity.populationIncluded),
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (
      targetIdentity !== null &&
      !decideOnsiteParticipationPass(targetIdentity.currentStatusCode).allowed
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    if (targetIdentity !== null && targetIdentity.capacityReservationId !== null) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (canonicalHeader !== null) {
      assertRegistrationCommandHeaderStatus(canonicalHeader.statusCode);
    }

    const previousRegistrationRevision =
      canonicalHeader !== null && canonicalHeader.currentRevision > 0
        ? await input.tx.activityRegistrationRevision.findFirst({
            where: {
              registrationId: canonicalHeader.id,
              revision: canonicalHeader.currentRevision,
            },
            select: { id: true },
          })
        : null;
    if (
      canonicalHeader !== null &&
      canonicalHeader.currentRevision > 0 &&
      previousRegistrationRevision === null
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    const header =
      canonicalHeader ??
      (await input.tx.activityRegistration.create({
        data: {
          activityId: input.activityId,
          memberId: input.targetMemberId,
          statusCode: 'pending',
          currentRevision: 0,
          currentFormVersionId: null,
          statusSummaryCode: 'active',
          sourceCode: 'onsite',
          // 同 activity-registration-create:与紧随的 updateMany 同源,不吃库时钟默认值。
          registeredAt: now,
        },
        select: { id: true, currentRevision: true },
      }));
    const identity =
      targetIdentity ??
      (await input.tx.activityParticipationIdentity.create({
        data: {
          activityId: input.activityId,
          sessionId: input.sessionId,
          registrationId: header.id,
          memberId: input.targetMemberId,
          currentRevision: 0,
          currentStatusCode: 'pending',
          currentPositionId: null,
          populationIncluded: false,
          version: 0,
        },
        select: {
          id: true,
          activityId: true,
          memberId: true,
          registrationId: true,
          sessionId: true,
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
          version: true,
        },
      }));

    const capacityResult = await this.capacityReservations.reserveInTransactionTrusted(input.tx, {
      activityId: input.activityId,
      memberId: input.targetMemberId,
      selections: [{ identityId: identity.id, positionId: input.positionId }],
    });
    if (capacityResult.outcome === 'capacity_unavailable') {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    }
    const reservedIdentity = capacityResult.identities.find(
      (reservation) => reservation.identityId === identity.id,
    );
    if (reservedIdentity === undefined) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }

    const registrationRevisionNumber = header.currentRevision + 1;
    const registrationRevision = await input.tx.activityRegistrationRevision.create({
      data: {
        registrationId: header.id,
        revision: registrationRevisionNumber,
        formVersionId: null,
        answersHash: null,
        sourceCode: 'onsite',
        submittedByUserId: input.currentUser.id,
        submittedAt: now,
        requestKey: input.operationKey,
        requestHash: input.requestHash,
        priorRevisionId: previousRegistrationRevision?.id ?? null,
        reason: input.reason,
      },
      select: { id: true },
    });
    await this.insuranceRequirement.createActivityRegistrationEvidence(
      header.id,
      registrationRevision.id,
      input.targetMemberId,
      insuranceEligibility,
      input.tx,
    );
    const participationRevision = await input.tx.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: identity.currentRevision + 1,
        statusCode: 'pass',
        positionId: input.positionId,
        reviewedByUserId: input.currentUser.id,
        reviewedAt: now,
        reviewNote: input.reason,
        effectiveAt: now,
        createdByUserId: input.currentUser.id,
        sourceCode: 'onsite',
        requestKey: input.operationKey,
        requestHash: input.requestHash,
      },
      select: { id: true },
    });

    const identityUpdate = await input.tx.activityParticipationIdentity.updateMany({
      where: {
        id: identity.id,
        currentRevision: identity.currentRevision,
        version: identity.version,
      },
      data: {
        currentRevision: identity.currentRevision + 1,
        currentStatusCode: 'pass',
        currentPositionId: input.positionId,
        capacityReservationId: reservedIdentity.sessionReservationId,
        populationIncluded: true,
        version: { increment: 1 },
      },
    });
    if (identityUpdate.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const headerUpdate = await input.tx.activityRegistration.updateMany({
      where: { id: header.id, currentRevision: header.currentRevision },
      data: {
        activityPositionId: null,
        statusCode: 'pending',
        registeredAt: now,
        extras: Prisma.JsonNull,
        currentRevision: registrationRevisionNumber,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: 'onsite',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        cancelledByUserId: null,
        cancelledAt: null,
        cancelReason: null,
      },
    });
    if (headerUpdate.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    await this.qualificationEvaluator.appendSnapshots({
      evaluation: qualification,
      phase: 'submit',
      registrationRevisionId: registrationRevision.id,
      identityIdBySession: new Map([[input.sessionId, identity.id]]),
      tx: input.tx,
    });

    await this.registrationLifecycle.incrementPopulationRevisionInTransactionTrusted(
      input.tx,
      input.activityId,
      now,
    );
    await this.registrationAudit.logOnsiteCreate({
      registrationId: header.id,
      registrationRevisionId: registrationRevision.id,
      participationIdentityId: identity.id,
      participationRevisionId: participationRevision.id,
      actorUserId: input.currentUser.id,
      actorRoleSnap: input.currentUser.role,
      requestHash: input.requestHash,
      auditMeta: input.auditMeta,
      tx: input.tx,
    });

    return {
      registrationId: header.id,
      registrationRevisionId: registrationRevision.id,
      participationIdentityId: identity.id,
      participationRevisionId: participationRevision.id,
      statusCode: 'pass',
      sourceCode: 'onsite',
      positionId: input.positionId,
      approvedAt: now,
    };
  }

  private async assertCreatePermission(
    currentUser: CurrentUserPayload,
    activityId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, 'activity-registration.create.record', {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (
      decision.reason === 'resource_not_found' &&
      (await this.rbac.can(currentUser, 'activity-registration.create.record'))
    ) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<LockedActivity[]>(Prisma.sql`
      SELECT
        "id",
        "statusCode",
        "genderRequirementCode",
        "requiresInsurance",
        "startAt",
        "endAt"
      FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const activity = rows[0];
    if (rows.length !== 1 || !activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async assertNewOnsiteParticipationIsStillOpen(
    tx: PrismaTx,
    activity: LockedActivity,
    now: Date,
  ): Promise<void> {
    if (now.getTime() > activity.endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    // The root Activity lock serializes all formal posting/closure writers.  These are reads,
    // not new locks: the onsite caller never writes settlement or closure facts, so taking their
    // rows would widen the caller's fixed lock sequence without strengthening the root protocol.
    const postedRun = await tx.attendanceSettlementRun.findUnique({
      where: { activityId: activity.id },
      select: { statusCode: true, currentPostedVersion: true },
    });
    if (
      postedRun !== null &&
      (postedRun.statusCode === 'posting' ||
        postedRun.statusCode === 'posted' ||
        postedRun.currentPostedVersion !== null)
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    const activeClosure = await tx.activitySettlementClosureRevision.findFirst({
      where: { activityId: activity.id, statusCode: 'active' },
      select: { id: true },
    });
    if (activeClosure !== null) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
  }

  private async lockRegistrationHeaders(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<OnsiteLockedHeader[]> {
    return tx.$queryRaw<OnsiteLockedHeader[]>(Prisma.sql`
      SELECT "id", "statusCode", "currentRevision", "deletedAt"
      FROM "ActivityRegistration"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE
    `);
  }

  private async lockMemberActivityIdentities(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<OnsiteLockedIdentity[]> {
    return tx.$queryRaw<OnsiteLockedIdentity[]>(Prisma.sql`
      SELECT
        "id",
        "activityId",
        "memberId",
        "registrationId",
        "sessionId",
        "currentRevision",
        "currentStatusCode",
        "currentPositionId",
        "capacityReservationId",
        "populationIncluded",
        "version"
      FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${activityId} AND "memberId" = ${memberId}
      ORDER BY "id" ASC
      FOR UPDATE
    `);
  }

  private async assertAppAdmissionStillLive(
    tx: PrismaTx,
    userId: string,
    memberId: string,
  ): Promise<void> {
    const members = await tx.$queryRaw<
      Array<{ id: string; status: MemberStatus; deletedAt: Date | null }>
    >(Prisma.sql`
      SELECT "id", "status", "deletedAt"
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR SHARE
    `);
    const users = await tx.$queryRaw<
      Array<{ id: string; status: UserStatus; deletedAt: Date | null }>
    >(Prisma.sql`
      SELECT "id", "status", "deletedAt"
      FROM "User"
      WHERE "id" = ${userId} AND "memberId" = ${memberId}
      FOR SHARE
    `);
    if (
      members.length !== 1 ||
      members[0]?.deletedAt !== null ||
      members[0]?.status !== MemberStatus.ACTIVE ||
      users.length !== 1 ||
      users[0]?.deletedAt !== null ||
      users[0]?.status !== UserStatus.ACTIVE
    ) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  private async assertManagedResponsibility(
    tx: PrismaTx,
    activityId: string,
    actorMemberId: string,
  ): Promise<void> {
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${actorMemberId}
        AND "status" = 'active'
        AND "canManageRegistrations" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    if (assignments.length === 0) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async lockSessionAndPosition(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    positionId: string | null,
  ): Promise<LockedPosition | null> {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ActivitySession"
      WHERE "id" = ${sessionId}
        AND "activityId" = ${activityId}
        AND "deletedAt" IS NULL
        AND "statusCode" = 'scheduled'
      FOR UPDATE
    `);
    if (sessions.length !== 1) throw new BizException(BizCode.BAD_REQUEST);

    const positions = await tx.$queryRaw<LockedPosition[]>(Prisma.sql`
      SELECT "id", "genderRequirementCode", "qualificationRuleSetId"
      FROM "ActivitySessionPosition"
      WHERE "activityId" = ${activityId}
        AND "sessionId" = ${sessionId}
        AND "deletedAt" IS NULL
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (positionId === null) {
      if (positions.length > 0) throw new BizException(BizCode.ACTIVITY_POSITION_REQUIRED);
      return null;
    }
    const selectedPosition = positions.find((position) => position.id === positionId) ?? null;
    if (selectedPosition === null) throw new BizException(BizCode.BAD_REQUEST);
    return selectedPosition;
  }

  private async assertOnsiteRequirementsAvailable(tx: PrismaTx, activityId: string): Promise<void> {
    const forms = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "RegistrationFormVersion"
      WHERE "activityId" = ${activityId} AND "statusCode" = 'active'
      ORDER BY "id" ASC
      FOR SHARE
    `);
    for (const form of forms) {
      const fields = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "RegistrationFormField"
        WHERE "formVersionId" = ${form.id}
        ORDER BY "id" ASC
        FOR SHARE
      `);
      if (fields.length > 0) {
        throw new BizException(BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE);
      }
    }
  }

  private async assertActiveTargetMember(tx: PrismaTx, memberId: string): Promise<void> {
    const member = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: { status: true },
    });
    if (member === null) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    if (member.status !== MemberStatus.ACTIVE) {
      throw new BizException(BizCode.MEMBER_INACTIVE);
    }
  }

  private async assertGenderRequirement(
    tx: PrismaTx,
    memberId: string,
    genderRequirementCode: string | null,
  ): Promise<void> {
    if (genderRequirementCode === null || genderRequirementCode === 'any') return;
    const profile = await tx.memberProfile.findFirst({
      where: { memberId, deletedAt: null },
      select: { genderCode: true },
    });
    if (profile === null || profile.genderCode !== genderRequirementCode) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    }
  }

  private async findExistingReceipt(
    client: OnsiteReadClient,
    operationKey: string,
    requestHash: string,
  ): Promise<OnsiteParticipationReceipt | null> {
    const registrationRevision = await client.activityRegistrationRevision.findFirst({
      where: { requestKey: operationKey },
      select: {
        id: true,
        registrationId: true,
        requestHash: true,
        sourceCode: true,
      },
    });
    if (registrationRevision === null) return null;
    if (
      registrationRevision.requestHash !== requestHash ||
      registrationRevision.sourceCode !== 'onsite'
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
    }
    const participationRevision = await client.activityParticipationRevision.findFirst({
      where: { requestKey: operationKey },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        identityId: true,
        statusCode: true,
        positionId: true,
        sourceCode: true,
        reviewedAt: true,
        identity: { select: { registrationId: true } },
      },
    });
    if (
      participationRevision === null ||
      participationRevision.identity.registrationId !== registrationRevision.registrationId ||
      participationRevision.statusCode !== 'pass' ||
      participationRevision.sourceCode !== 'onsite' ||
      participationRevision.reviewedAt === null
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    return {
      registrationId: registrationRevision.registrationId,
      registrationRevisionId: registrationRevision.id,
      participationIdentityId: participationRevision.identityId,
      participationRevisionId: participationRevision.id,
      statusCode: 'pass',
      sourceCode: 'onsite',
      positionId: participationRevision.positionId,
      approvedAt: participationRevision.reviewedAt,
    };
  }
}

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
import { CapacityReservationService } from './capacity-reservation.service';
import type { CreateAppManagedActivityOnsiteParticipationDto } from './dto/app/app-onsite-participation.dto';
import {
  hashOnsiteParticipationRequest,
  type OnsiteParticipationRequestHashInput,
} from './onsite-participation-request-hash';
import { decideOnsiteParticipationPass } from './onsite-participation-state-machine';

type PrismaTx = Prisma.TransactionClient;

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
};

export type OnsiteLockedIdentity = {
  id: string;
  registrationId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
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
 * The legacy registration head is intentionally not made permanently unique by this caller.
 * A permanent identity attached to another (historical) head would require a relink/revival
 * policy that this slice is not authorized to invent, so it fails closed with 21030.
 */
export function selectOnsiteCanonicalHeader(
  headers: readonly OnsiteLockedHeader[],
  identities: readonly OnsiteLockedIdentity[],
): OnsiteLockedHeader | null {
  const activeHeaders = headers.filter((header) => header.statusCode !== 'cancelled');
  if (activeHeaders.length > 1) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const activeHeader = activeHeaders[0] ?? null;
  if (activeHeader === null) {
    if (identities.length > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    return null;
  }
  if (identities.some((identity) => identity.registrationId !== activeHeader.id)) {
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
  }
  return activeHeader;
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
    private readonly registrationAudit: ActivityRegistrationAuditRecorder,
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
      return await this.prisma.$transaction((tx) =>
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
      );
    } catch (error) {
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
    await this.assertOnsiteRequirementsAvailable(
      input.tx,
      input.activityId,
      input.sessionId,
      selectedPosition,
    );
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
    if (
      targetIdentity !== null &&
      !decideOnsiteParticipationPass(targetIdentity.currentStatusCode).allowed
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
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
        },
        select: { id: true, currentRevision: true },
      }));
    if (canonicalHeader === null) {
      await this.insuranceRequirement.createActivityRegistrationEvidence(
        header.id,
        input.targetMemberId,
        insuranceEligibility,
        input.tx,
      );
    }

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
          registrationId: true,
          sessionId: true,
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
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

    // No capacityReservationId shortcut pointer is written here.  Reservation truth remains in
    // CapacityReservation and this projection changes only the authorized status fields.
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
        currentRevision: registrationRevisionNumber,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: 'onsite',
      },
    });
    if (headerUpdate.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }

    await this.incrementPopulationRevision(input.tx, input.activityId, now);
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
      SELECT "id", "statusCode", "currentRevision"
      FROM "ActivityRegistration"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
        AND "deletedAt" IS NULL
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
        "registrationId",
        "sessionId",
        "currentRevision",
        "currentStatusCode",
        "currentPositionId",
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

  private async assertOnsiteRequirementsAvailable(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    selectedPosition: LockedPosition | null,
  ): Promise<void> {
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

    const rules = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ActivityQualificationRuleSet"
      WHERE "activityId" = ${activityId}
        AND "statusCode" = 'active'
        AND (
          ("sessionId" IS NULL AND "positionId" IS NULL)
          OR ("sessionId" = ${sessionId} AND "positionId" IS NULL)
          OR "positionId" = ${selectedPosition?.id ?? null}
        )
      ORDER BY "id" ASC
      FOR SHARE
    `);
    if (
      rules.length > 0 ||
      (selectedPosition !== null && selectedPosition.qualificationRuleSetId !== null)
    ) {
      throw new BizException(BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE);
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

  private async incrementPopulationRevision(
    tx: PrismaTx,
    activityId: string,
    now: Date,
  ): Promise<void> {
    const states = await tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`
      SELECT "id", "version"
      FROM "ActivityEvidenceState"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (states.length > 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const state = states[0];
    if (!state) {
      await tx.activityEvidenceState.create({
        data: {
          activityId,
          populationRevision: 1,
          version: 1,
          lastPopulationAt: now,
        },
        select: { id: true },
      });
      return;
    }
    const updated = await tx.activityEvidenceState.updateMany({
      where: { id: state.id, version: state.version },
      data: {
        populationRevision: { increment: 1 },
        version: { increment: 1 },
        lastPopulationAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
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

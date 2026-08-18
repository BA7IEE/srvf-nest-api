import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import { ActivityQualificationEvaluatorService } from './activity-qualification-evaluator.service';
import {
  AttachmentsService,
  type RegistrationUploadSubmissionBinding,
} from '../attachments/attachments.service';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  validateRegistrationFormAnswers,
  type ValidatedRegistrationAnswer,
} from './activity-registration-answer-validator';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityAllocationService } from './activity-allocation.service';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import {
  AppActivityRegistrationCommandDto,
  type AppActivityRegistrationPreferenceCommandDto,
} from './dto/app/app-activity-registration-command.dto';
import {
  assertRegistrationCommandHeaderStatus,
  decideParticipationRevision,
} from './participation-revision-state-machine';
import { hashRegistrationAnswers, hashRegistrationCommand } from './registration-command-hash';

type PrismaTx = Prisma.TransactionClient;

export type RegistrationCommandReceipt = {
  registrationId: string;
  registrationRevisionId: string;
  revision: number;
  submittedAt: Date;
};

type RegistrationCommandSource = 'self' | 'invitation';

type LockedRegistration = {
  id: string;
  statusCode: string;
  currentRevision: number;
  deletedAt: Date | null;
};

type LockedIdentity = {
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

type ExistingIdentityPlan = {
  identity: LockedIdentity;
  statusCode: 'pending' | 'cancelled';
};

type NormalizedPreferences = Map<string, string[]>;

function invalidPreference(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

@Injectable()
export class RegistrationCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly participationPolicy: ActivityParticipationPolicy,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly attachments: AttachmentsService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly registrationLifecycle: ActivityRegistrationLifecycleService,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
    private readonly allocations: ActivityAllocationService,
  ) {}

  async submit(
    activityId: string,
    dto: AppActivityRegistrationCommandDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<RegistrationCommandReceipt> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);

    const requestHash = hashRegistrationCommand({
      actorUserId: currentUser.id,
      memberId: access.member.id,
      activityId,
      source: 'self',
      formVersion: dto.formVersion,
      answers: dto.answers,
      preferences: dto.preferences,
    });

    try {
      return await this.prisma.$transaction((tx) =>
        this.submitInTransaction({
          tx,
          activityId,
          dto,
          currentUser,
          memberId: access.member!.id,
          requestHash,
          auditMeta,
          source: 'self',
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveUniqueRace(dto.operationKey, requestHash);
      }
      throw error;
    }
  }

  async submitInTransaction(input: {
    tx: PrismaTx;
    activityId: string;
    dto: AppActivityRegistrationCommandDto;
    currentUser: CurrentUserPayload;
    memberId: string;
    requestHash: string;
    auditMeta: AuditMeta;
    source: RegistrationCommandSource;
  }): Promise<RegistrationCommandReceipt> {
    // 1. Activity root lock.  Every later runtime fact is reread under this aggregate lock.
    const activityRows = await input.tx.$queryRaw<
      Array<{
        id: string;
        statusCode: string;
        isPublicRegistration: boolean;
        registrationDeadline: Date | null;
        genderRequirementCode: string | null;
        requiresInsurance: boolean;
        allocationModeCode: string;
        title: string;
        startAt: Date;
        endAt: Date;
      }>
    >(Prisma.sql`
      SELECT
        "id",
        "statusCode",
        "isPublicRegistration",
        "registrationDeadline",
        "genderRequirementCode",
        "requiresInsurance",
        "allocationModeCode",
        "title",
        "startAt",
        "endAt"
      FROM "Activity"
      WHERE "id" = ${input.activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const activity = activityRows[0];
    if (activityRows.length !== 1 || !activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    // `acceptedAt` for first_come is fixed only after the aggregate root has admitted this command.
    // That makes capacity consumption and the persisted server acceptance order the same serialization.
    const now = new Date();

    // 2. Lock the permanent header including cancelled/rejected/soft-deleted history. Exact replay
    // below wins first; a new request may reuse only a live resumable head.
    const headerRows = await input.tx.$queryRaw<LockedRegistration[]>(Prisma.sql`
      SELECT "id", "statusCode", "currentRevision", "deletedAt"
      FROM "ActivityRegistration"
      WHERE "activityId" = ${input.activityId}
        AND "memberId" = ${input.memberId}
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `);
    const lockedHeader = headerRows[0] ?? null;

    // 3. Existing permanent identities are locked in id order before their state is inspected.
    const identities = await input.tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
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
      WHERE "activityId" = ${input.activityId} AND "memberId" = ${input.memberId}
      ORDER BY "id" ASC
      FOR UPDATE
    `);

    // Authorization is mutable state too.  A safe retry may bypass Form/finality checks, but it
    // must never replay after the app admission facts changed while waiting on the Activity lock.
    await this.assertAppAdmissionStillLive(input.tx, input.currentUser.id, input.memberId);

    // Idempotency must win before any Form/upload session validation, so a safe retry remains
    // replayable after the first request has consumed its one-time sessions.
    const existingByKey = await input.tx.activityRegistrationRevision.findFirst({
      where: { requestKey: input.dto.operationKey },
      select: {
        registrationId: true,
        id: true,
        revision: true,
        submittedAt: true,
        requestHash: true,
      },
    });
    if (existingByKey) {
      if (existingByKey.requestHash !== input.requestHash) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
      }
      return {
        registrationId: existingByKey.registrationId,
        registrationRevisionId: existingByKey.id,
        revision: existingByKey.revision,
        submittedAt: existingByKey.submittedAt,
      };
    }

    if (lockedHeader !== null && lockedHeader.deletedAt !== null) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
    }
    if (
      identities.some(
        (identity) => lockedHeader === null || identity.registrationId !== lockedHeader.id,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    await this.registrationLifecycle.assertCapacityPointersReconciledInTransactionTrusted(
      input.tx,
      identities,
      { activityId: input.activityId, memberId: input.memberId },
    );
    await this.registrationLifecycle.assertParticipationRevisionsReconciledInTransactionTrusted(
      input.tx,
      identities,
    );

    if (lockedHeader) {
      assertRegistrationCommandHeaderStatus(lockedHeader.statusCode);
      if (
        identities.some(
          (identity) =>
            (identity.currentStatusCode === 'pending' ||
              identity.currentStatusCode === 'waitlisted' ||
              identity.currentStatusCode === 'cancelled' ||
              identity.currentStatusCode === 'rejected') &&
            (identity.capacityReservationId !== null ||
              identity.currentPositionId !== null ||
              identity.populationIncluded),
        )
      ) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
      const [legacyAttendance, legacyCheckIn, punchedIdentity] = await Promise.all([
        input.tx.attendanceRecord.findFirst({
          where: { registrationId: lockedHeader.id, deletedAt: null },
          select: { id: true },
        }),
        input.tx.activityCheckIn.findFirst({
          where: { registrationId: lockedHeader.id, deletedAt: null },
          select: { id: true },
        }),
        identities.length > 0
          ? input.tx.attendancePunchEvent.findFirst({
              where: { participationIdentityId: { in: identities.map((identity) => identity.id) } },
              select: { id: true },
            })
          : null,
      ]);
      if (legacyAttendance || legacyCheckIn || punchedIdentity) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
      }
    }

    // An invitation still uses the published/time policy, but is the existing explicit exception
    // to public-registration visibility. Form, qualification, insurance, identity, capacity and
    // allocation all continue through this one canonical command.
    const participationDecision =
      input.source === 'invitation'
        ? this.participationPolicy.canRegisterByAdmin(activity, now)
        : this.participationPolicy.canRegisterSelf(activity, now);
    if (!participationDecision.allowed) throw new BizException(participationDecision.biz);

    // The canonical v1.1 chain retains the legacy activity-level gender hard gate.  A missing
    // live profile and a mismatched value intentionally collapse to the same 21034 response.
    await this.assertGenderRequirement(input.tx, input.memberId, activity.genderRequirementCode);

    // 4. Form recheck and the one answer validator for all eight types.
    const activeForm = await input.tx.registrationFormVersion.findFirst({
      where: { activityId: input.activityId, statusCode: 'active' },
      select: {
        id: true,
        version: true,
        fields: {
          select: {
            id: true,
            fieldCode: true,
            typeCode: true,
            required: true,
            minValue: true,
            maxValue: true,
            minLength: true,
            maxLength: true,
            maxSelections: true,
            optionsJson: true,
          },
          orderBy: [{ sortOrder: 'asc' }, { fieldCode: 'asc' }],
        },
      },
    });
    if (!activeForm) {
      if (input.dto.formVersion !== null || input.dto.answers.length !== 0) {
        throw new BizException(BizCode.REGISTRATION_FORM_VERSION_INVALID);
      }
    } else if (input.dto.formVersion !== activeForm.version) {
      throw new BizException(BizCode.REGISTRATION_FORM_VERSION_INVALID);
    }
    const answers: ValidatedRegistrationAnswer[] = activeForm
      ? validateRegistrationFormAnswers(activeForm.fields, input.dto.answers)
      : [];

    // 5. Session and position reread/lock.  `positionIds` order is preserved only here, where it
    // deterministically becomes 1-based preferenceOrder; no client-supplied order reaches storage.
    const preferences = this.normalizePreferences(input.dto.preferences);
    const selectedSessionIds = [...preferences.keys()].sort();
    await this.assertSessionsAndPositions(input.tx, input.activityId, preferences);
    const qualification = await this.qualificationEvaluator.evaluate({
      activity,
      memberId: input.memberId,
      targets: selectedSessionIds.flatMap((sessionId) => [
        { sessionId, positionId: null },
        ...(preferences.get(sessionId) ?? []).map((positionId) => ({ sessionId, positionId })),
      ]),
      tx: input.tx,
    });
    this.qualificationEvaluator.assertNoBlock(qualification);
    const identityPlans = this.planExistingIdentityRevisions(
      identities,
      new Set(selectedSessionIds),
    );

    // 6. Upload session/attachment/AVAILABLE-ledger reread.  This is after Form/session/position
    // validation but before every revision/answer write, and returns no externally visible file ID.
    const fileSessionIds = answers
      .flatMap((answer) => (answer.uploadSessionId ? [answer.uploadSessionId] : []))
      .sort();
    const uploadBindings = activeForm
      ? await this.attachments.inspectRegistrationUploadsForSubmissionInTransactionTrusted(
          input.tx,
          {
            activityId: input.activityId,
            memberId: input.memberId,
            formVersionId: activeForm.id,
            sessionIds: fileSessionIds,
            now,
          },
        )
      : [];
    const uploadBySession = new Map(uploadBindings.map((binding) => [binding.sessionId, binding]));

    // Do not fork the insurance decision: the established service locks/rereads the same source
    // and preserves its 26030 anti-enumeration result.  It follows all Form/session/upload
    // rereads but still precedes every command write, so an ineligible first submission leaves
    // no header, revision, identity or audit.
    const insuranceEligibility = await this.insuranceRequirement.requireForActivityRegistration(
      input.memberId,
      activity,
      input.tx,
    );

    // 7. Append-only registration/participation revisions, answers and preferences.  A new header
    // is intentionally created only after all no-write validation succeeds.
    const previousRevision =
      lockedHeader && lockedHeader.currentRevision > 0
        ? await input.tx.activityRegistrationRevision.findFirst({
            where: { registrationId: lockedHeader.id, revision: lockedHeader.currentRevision },
            select: { id: true },
          })
        : null;
    if (lockedHeader && lockedHeader.currentRevision > 0 && !previousRevision) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    const header =
      lockedHeader ??
      (await input.tx.activityRegistration.create({
        data: {
          activityId: input.activityId,
          memberId: input.memberId,
          statusCode: 'pending',
          currentRevision: 0,
          currentFormVersionId: null,
          statusSummaryCode: 'active',
          sourceCode: input.source,
          // 同 activity-registration-create:与紧随的 updateMany 同源,不吃库时钟默认值。
          registeredAt: now,
        },
        select: { id: true, currentRevision: true },
      }));
    const revisionNumber = header.currentRevision + 1;
    const registrationRevision = await input.tx.activityRegistrationRevision.create({
      data: {
        registrationId: header.id,
        revision: revisionNumber,
        formVersionId: activeForm?.id ?? null,
        answersHash: hashRegistrationAnswers(answers),
        sourceCode: input.source,
        submittedByUserId: input.currentUser.id,
        submittedAt: now,
        requestKey: input.dto.operationKey,
        requestHash: input.requestHash,
        priorRevisionId: previousRevision?.id ?? null,
      },
      select: { id: true, submittedAt: true },
    });

    await this.insuranceRequirement.createActivityRegistrationEvidence(
      header.id,
      registrationRevision.id,
      input.memberId,
      insuranceEligibility,
      input.tx,
    );

    const answerRows = await this.createAnswers(
      input.tx,
      registrationRevision.id,
      answers,
      uploadBySession,
    );
    await this.createPreferences(input.tx, registrationRevision.id, preferences);
    const identityPointerUpdates = await this.appendParticipationRevisions({
      tx: input.tx,
      activityId: input.activityId,
      registrationId: header.id,
      memberId: input.memberId,
      currentUserId: input.currentUser.id,
      selectedSessionIds: new Set(selectedSessionIds),
      preferences,
      existingPlans: identityPlans,
      now,
      requestKey: input.dto.operationKey,
      requestHash: input.requestHash,
      sourceCode: input.source,
    });

    // 8. Final attachment transfer and session consumption remain inside the aggregate tx.
    const answerByFileSession = new Map(
      answerRows
        .filter((row) => row.uploadSessionId)
        .map((row) => [
          row.uploadSessionId!,
          { answerId: row.id, attachmentId: row.attachmentId! },
        ]),
    );
    await this.attachments.consumeRegistrationUploadsForFormAnswersInTransactionTrusted(input.tx, {
      activityId: input.activityId,
      memberId: input.memberId,
      formVersionId: activeForm?.id ?? '',
      bindings: uploadBindings.map((binding) => {
        const answer = answerByFileSession.get(binding.sessionId);
        if (!answer || answer.attachmentId !== binding.attachmentId) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }
        return { ...binding, answerId: answer.answerId };
      }),
      now,
    });

    // 9. Only after all immutable rows and file transfer succeed do current pointers move.
    for (const update of identityPointerUpdates) {
      const pointerUpdate = await input.tx.activityParticipationIdentity.updateMany({
        where: {
          id: update.id,
          currentRevision: update.expectedCurrentRevision,
          version: update.expectedVersion,
        },
        data: {
          currentRevision: update.revision,
          currentStatusCode: update.statusCode,
          currentPositionId: null,
          capacityReservationId: null,
          populationIncluded: false,
          version: { increment: 1 },
        },
      });
      if (pointerUpdate.count !== 1) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
    }
    const headerUpdate = await input.tx.activityRegistration.updateMany({
      where: { id: header.id, currentRevision: header.currentRevision },
      data: {
        activityPositionId: null,
        statusCode: 'pending',
        registeredAt: now,
        extras: Prisma.JsonNull,
        currentRevision: revisionNumber,
        currentFormVersionId: activeForm?.id ?? null,
        statusSummaryCode: 'active',
        sourceCode: input.source,
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

    const identityIdBySession = new Map<string, string>(
      identities.map((identity) => [identity.sessionId, identity.id]),
    );
    for (const update of identityPointerUpdates) {
      identityIdBySession.set(update.sessionId, update.id);
    }
    await this.qualificationEvaluator.appendSnapshots({
      evaluation: qualification,
      phase: 'submit',
      registrationRevisionId: registrationRevision.id,
      identityIdBySession,
      tx: input.tx,
    });

    if (
      activity.allocationModeCode === 'first_come' &&
      (await this.allocations.hasInitializedCapacityTopologyInTransactionTrusted(
        input.tx,
        input.activityId,
      ))
    ) {
      await this.allocations.applyFirstComeAfterSubmissionInTransactionTrusted(input.tx, {
        activity,
        memberId: input.memberId,
        identities: identityPointerUpdates
          .filter((update) => update.statusCode === 'pending')
          .map((update) => ({ id: update.id, sessionId: update.sessionId })),
        currentUser: input.currentUser,
        sourceCode: input.source,
        requestKey: input.dto.operationKey,
        requestHash: input.requestHash,
        occurredAt: now,
        auditMeta: input.auditMeta,
      });
    }

    // 10. Safe audit last, in the same transaction.  The recorder accepts no raw answer/file
    // material, storage locator, attachment ID, token, key or URL.
    await this.registrationAuditRecorder.logCommandCreate({
      registrationId: header.id,
      actorUserId: input.currentUser.id,
      actorRoleSnap: input.currentUser.role,
      revision: revisionNumber,
      source: input.source,
      answerCount: answers.length,
      preferenceCount: [...preferences.values()].reduce(
        (count, positions) => count + positions.length,
        0,
      ),
      requestHash: input.requestHash,
      auditMeta: input.auditMeta,
      tx: input.tx,
    });

    return {
      registrationId: header.id,
      registrationRevisionId: registrationRevision.id,
      revision: revisionNumber,
      submittedAt: registrationRevision.submittedAt,
    };
  }

  private async resolveUniqueRace(
    operationKey: string,
    requestHash: string,
  ): Promise<RegistrationCommandReceipt> {
    const winner = await this.prisma.activityRegistrationRevision.findFirst({
      where: { requestKey: operationKey },
      select: {
        registrationId: true,
        id: true,
        revision: true,
        submittedAt: true,
        requestHash: true,
      },
    });
    if (winner && winner.requestHash === requestHash) {
      return {
        registrationId: winner.registrationId,
        registrationRevisionId: winner.id,
        revision: winner.revision,
        submittedAt: winner.submittedAt,
      };
    }
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
  }

  private async assertAppAdmissionStillLive(
    tx: PrismaTx,
    userId: string,
    memberId: string,
  ): Promise<void> {
    const members = await tx.$queryRaw<
      Array<{ id: string; status: MemberStatus; deletedAt: Date | null }>
    >(
      Prisma.sql`
        SELECT "id", "status", "deletedAt" FROM "Member"
        WHERE "id" = ${memberId}
        FOR SHARE
      `,
    );
    const users = await tx.$queryRaw<
      Array<{ id: string; status: UserStatus; deletedAt: Date | null }>
    >(Prisma.sql`
      SELECT "id", "status", "deletedAt" FROM "User"
      WHERE "id" = ${userId}
        AND "memberId" = ${memberId}
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
    if (!profile || profile.genderCode !== genderRequirementCode) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    }
  }

  private normalizePreferences(
    rawPreferences: readonly AppActivityRegistrationPreferenceCommandDto[],
  ): NormalizedPreferences {
    const result = new Map<string, string[]>();
    const seenPositions = new Set<string>();
    for (const preference of rawPreferences) {
      if (
        !preference ||
        typeof preference.sessionId !== 'string' ||
        result.has(preference.sessionId) ||
        !Array.isArray(preference.positionIds)
      ) {
        invalidPreference();
      }
      const positions = [...preference.positionIds];
      if (new Set(positions).size !== positions.length) invalidPreference();
      for (const positionId of positions) {
        if (typeof positionId !== 'string' || seenPositions.has(positionId)) invalidPreference();
        seenPositions.add(positionId);
      }
      result.set(preference.sessionId, positions);
    }
    return result;
  }

  private async assertSessionsAndPositions(
    tx: PrismaTx,
    activityId: string,
    preferences: NormalizedPreferences,
  ): Promise<void> {
    const sessionIds = [...preferences.keys()].sort();
    if (sessionIds.length === 0) {
      // The activity-level rule is intentionally checked even when the client has named no
      // session at all.  Lock every live position in id order so a concurrent position mutation
      // cannot turn an otherwise empty preference list into a bypass after the Activity root lock.
      const livePositions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "ActivitySessionPosition"
        WHERE "activityId" = ${activityId}
          AND "deletedAt" IS NULL
        ORDER BY "id" ASC
        FOR UPDATE
      `);
      if (livePositions.length > 0) {
        throw new BizException(BizCode.ACTIVITY_POSITION_REQUIRED);
      }
      return;
    }
    const sessions = await tx.$queryRaw<
      Array<{ id: string; activityId: string; statusCode: string; deletedAt: Date | null }>
    >(
      Prisma.sql`
        SELECT "id", "activityId", "statusCode", "deletedAt"
        FROM "ActivitySession"
        WHERE "id" IN (${Prisma.join(sessionIds)})
        ORDER BY "id" ASC
        FOR UPDATE
      `,
    );
    if (
      sessions.length !== sessionIds.length ||
      sessions.some(
        (session) =>
          session.activityId !== activityId ||
          session.deletedAt !== null ||
          session.statusCode !== 'scheduled',
      )
    ) {
      invalidPreference();
    }

    // A session with live v1.1 positions is not a free-form attendance selection: the client
    // must name at least one of those positions.  Lock every live position in deterministic id
    // order before deriving this decision, then preserve the supplied order as 1-based storage
    // preferenceOrder below.
    const livePositionRows = await tx.$queryRaw<Array<{ sessionId: string }>>(Prisma.sql`
      SELECT "sessionId"
      FROM "ActivitySessionPosition"
      WHERE "activityId" = ${activityId}
        AND "sessionId" IN (${Prisma.join(sessionIds)})
        AND "deletedAt" IS NULL
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    const sessionsWithLivePositions = new Set(
      livePositionRows.map((position) => position.sessionId),
    );
    for (const [sessionId, requestedPositionIds] of preferences) {
      if (requestedPositionIds.length === 0 && sessionsWithLivePositions.has(sessionId)) {
        throw new BizException(BizCode.ACTIVITY_POSITION_REQUIRED);
      }
    }

    const positionIds = [...preferences.values()].flat().sort();
    if (positionIds.length === 0) return;
    const positions = await tx.$queryRaw<
      Array<{ id: string; sessionId: string; activityId: string; deletedAt: Date | null }>
    >(
      Prisma.sql`
        SELECT "id", "sessionId", "activityId", "deletedAt"
        FROM "ActivitySessionPosition"
        WHERE "id" IN (${Prisma.join(positionIds)})
        ORDER BY "id" ASC
        FOR UPDATE
      `,
    );
    if (positions.length !== positionIds.length) invalidPreference();
    const positionById = new Map(positions.map((position) => [position.id, position]));
    for (const [sessionId, requestedPositionIds] of preferences) {
      for (const positionId of requestedPositionIds) {
        const position = positionById.get(positionId);
        if (
          !position ||
          position.activityId !== activityId ||
          position.deletedAt !== null ||
          position.sessionId !== sessionId
        ) {
          invalidPreference();
        }
      }
    }
  }

  private async createAnswers(
    tx: PrismaTx,
    registrationRevisionId: string,
    answers: readonly ValidatedRegistrationAnswer[],
    uploadBySession: ReadonlyMap<string, RegistrationUploadSubmissionBinding>,
  ): Promise<Array<{ id: string; attachmentId: string | null; uploadSessionId?: string }>> {
    const created: Array<{ id: string; attachmentId: string | null; uploadSessionId?: string }> =
      [];
    for (const answer of answers) {
      const binding = answer.uploadSessionId
        ? uploadBySession.get(answer.uploadSessionId)
        : undefined;
      if (answer.uploadSessionId && !binding) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      const row = await tx.registrationFormAnswer.create({
        data: {
          registrationRevisionId,
          fieldId: answer.fieldId,
          ...(answer.valueText !== undefined ? { valueText: answer.valueText } : {}),
          ...(answer.valueNumber !== undefined ? { valueNumber: answer.valueNumber } : {}),
          ...(answer.valueDate !== undefined ? { valueDate: answer.valueDate } : {}),
          ...(answer.valueJson !== undefined ? { valueJson: answer.valueJson } : {}),
          ...(binding ? { attachmentId: binding.attachmentId } : {}),
        },
        select: { id: true, attachmentId: true },
      });
      created.push({
        ...row,
        ...(answer.uploadSessionId ? { uploadSessionId: answer.uploadSessionId } : {}),
      });
    }
    return created;
  }

  private async createPreferences(
    tx: PrismaTx,
    registrationRevisionId: string,
    preferences: NormalizedPreferences,
  ): Promise<void> {
    const data = [...preferences.entries()].flatMap(([sessionId, positionIds]) =>
      positionIds.map((positionId, index) => ({
        registrationRevisionId,
        sessionId,
        positionId,
        preferenceOrder: index + 1,
      })),
    );
    if (data.length > 0) await tx.activityPositionPreference.createMany({ data });
  }

  private planExistingIdentityRevisions(
    identities: readonly LockedIdentity[],
    selectedSessionIds: ReadonlySet<string>,
  ): ExistingIdentityPlan[] {
    const plans: ExistingIdentityPlan[] = [];
    for (const identity of identities) {
      const decision = decideParticipationRevision(
        identity.currentStatusCode,
        selectedSessionIds.has(identity.sessionId),
      );
      if (decision.kind === 'append') {
        plans.push({ identity, statusCode: decision.statusCode });
      }
    }
    return plans;
  }

  private async appendParticipationRevisions(input: {
    tx: PrismaTx;
    activityId: string;
    registrationId: string;
    memberId: string;
    currentUserId: string;
    selectedSessionIds: ReadonlySet<string>;
    preferences: NormalizedPreferences;
    existingPlans: readonly ExistingIdentityPlan[];
    now: Date;
    requestKey: string;
    requestHash: string;
    sourceCode: RegistrationCommandSource;
  }): Promise<
    Array<{
      id: string;
      sessionId: string;
      revision: number;
      statusCode: 'pending' | 'cancelled';
      expectedCurrentRevision: number;
      expectedVersion: number;
    }>
  > {
    const existingBySession = new Map(
      input.existingPlans.map(({ identity }) => [identity.sessionId, identity]),
    );
    const pointerUpdates: Array<{
      id: string;
      sessionId: string;
      revision: number;
      statusCode: 'pending' | 'cancelled';
      expectedCurrentRevision: number;
      expectedVersion: number;
    }> = [];

    for (const { identity, statusCode } of input.existingPlans) {
      const revision = identity.currentRevision + 1;
      await input.tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision,
          statusCode,
          preferenceSnapshot: input.selectedSessionIds.has(identity.sessionId)
            ? { positionIds: input.preferences.get(identity.sessionId) ?? [] }
            : Prisma.JsonNull,
          effectiveAt: input.now,
          createdByUserId: input.currentUserId,
          sourceCode: input.sourceCode,
          requestKey: input.requestKey,
          requestHash: input.requestHash,
          ...(statusCode === 'cancelled'
            ? {
                cancelledByUserId: input.currentUserId,
                cancelledAt: input.now,
                cancelReason: 'registration_command_removed',
              }
            : {}),
        },
      });
      pointerUpdates.push({
        id: identity.id,
        sessionId: identity.sessionId,
        revision,
        statusCode,
        expectedCurrentRevision: identity.currentRevision,
        expectedVersion: identity.version,
      });
    }

    for (const sessionId of input.selectedSessionIds) {
      if (existingBySession.has(sessionId)) continue;
      const identity = await input.tx.activityParticipationIdentity.create({
        data: {
          activityId: input.activityId,
          sessionId,
          registrationId: input.registrationId,
          memberId: input.memberId,
          currentRevision: 0,
          currentStatusCode: 'pending',
          currentPositionId: null,
          populationIncluded: false,
          version: 0,
        },
        select: { id: true },
      });
      await input.tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: 1,
          statusCode: 'pending',
          preferenceSnapshot: { positionIds: input.preferences.get(sessionId) ?? [] },
          effectiveAt: input.now,
          createdByUserId: input.currentUserId,
          sourceCode: input.sourceCode,
          requestKey: input.requestKey,
          requestHash: input.requestHash,
        },
      });
      pointerUpdates.push({
        id: identity.id,
        sessionId,
        revision: 1,
        statusCode: 'pending',
        expectedCurrentRevision: 0,
        expectedVersion: 0,
      });
    }
    return pointerUpdates;
  }
}

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { beijingDayNumber } from '../../src/modules/team-join/team-join.constants';
import { withTimeLedgerFixtureCleanup } from '../setup/time-ledger-fixture-cleanup';

/** 保留登录/RBAC底座；仅在上例确实创建过账本时清理不可变子图。 */
export async function clearContributionCreditFixtures(prisma: PrismaService): Promise<void> {
  if ((await prisma.ledgerPostingBatch.count()) === 0) return;
  await prisma.$transaction(
    (tx) =>
      withTimeLedgerFixtureCleanup(tx, async (tx) => {
        await tx.$executeRawUnsafe(
          'TRUNCATE TABLE "ActivityRegistration", "AttendanceSettlementRun", "EvidenceSeal" RESTART IDENTITY CASCADE',
        );
        await tx.activitySession.deleteMany({});
      }),
    { timeout: 30_000 },
  );
}

/**
 * 仅供入队读取/生命周期测试的已存在账本输入；不用于验证结算写链。
 * creditedPoints 显式代表正式入账净额，不在夹具里复制每日封顶算法。
 * 真正的计算、审核与提交由 journey-native-contribution 和账本 E2E 验证。
 */
export async function seedContributionCredit(
  prisma: PrismaService,
  input: {
    memberId: string;
    actorUserId: string;
    organizationId: string;
    occurredAt: Date;
    creditedPoints: string;
    recognizedPoints?: string;
    batchStatus?: 'committed' | 'preparing';
  },
): Promise<void> {
  const endAt = new Date(input.occurredAt.getTime() + 3_600_000);
  await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        title: '入队账本读取夹具',
        activityTypeCode: 'team-join-ledger-fixture',
        organizationId: input.organizationId,
        startAt: input.occurredAt,
        endAt,
        location: '测试地点',
        statusCode: 'completed',
      },
    });
    await seedParticipationReadStateInTx(tx, {
      activityId: activity.id,
      actorUserId: input.actorUserId,
      batchStatus: input.batchStatus,
      participants: [
        {
          memberId: input.memberId,
          resultCode: 'present',
          serviceHours: '1',
          creditedPoints: input.creditedPoints,
          recognizedPoints: input.recognizedPoints,
        },
      ],
    });
  });
}

interface ParticipationReadFixtureInput {
  activityId: string;
  actorUserId: string;
  batchStatus?: 'committed' | 'preparing';
  participants: Array<{
    memberId: string;
    sourceCode?: 'self' | 'onsite';
    resultCode: 'present' | 'absent' | null;
    serviceHours: string;
    creditedPoints: string;
    recognizedPoints?: string;
    startAt?: Date;
  }>;
}

/** 当前正式版本与未决身份的读取夹具，不模拟结算命令、封顶计算或更正提交。 */
export async function seedParticipationReadState(
  prisma: PrismaService,
  input: ParticipationReadFixtureInput,
): Promise<void> {
  await prisma.$transaction((tx) => seedParticipationReadStateInTx(tx, input));
}

async function seedParticipationReadStateInTx(
  tx: Prisma.TransactionClient,
  input: ParticipationReadFixtureInput,
): Promise<void> {
  const tag = randomUUID();
  const activity = await tx.activity.findUniqueOrThrow({ where: { id: input.activityId } });
  const endAt = activity.endAt;
  const committed = (input.batchStatus ?? 'committed') === 'committed';
  const population = [];
  for (const [index, participant] of input.participants.entries()) {
    const startAt = participant.startAt ?? activity.startAt;
    const session = await tx.activitySession.create({
      data: {
        activityId: activity.id,
        code: `credit-${tag}-${index}`,
        name: `参与读取场次 ${index + 1}`,
        startAt,
        endAt,
        locationText: '测试地点',
        checkInOpenAt: startAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: startAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    let registration = await tx.activityRegistration.findUnique({
      where: { activityId_memberId: { activityId: activity.id, memberId: participant.memberId } },
    });
    registration ??= await tx.activityRegistration.create({
      data: {
        activityId: activity.id,
        memberId: participant.memberId,
        statusCode: participant.sourceCode === 'onsite' ? 'pending' : 'pass',
      },
    });
    const identity = await tx.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: participant.memberId,
        currentRevision: 1,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    await tx.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: 1,
        statusCode: 'pass',
        sourceCode: participant.sourceCode ?? 'self',
        effectiveAt: startAt,
        createdByUserId: input.actorUserId,
      },
    });
    population.push({ participant, session, identity, startAt });
  }
  const posted = population.filter((row) => row.participant.resultCode !== null);
  const personCount = new Set(posted.map((row) => row.participant.memberId)).size;
  const seal = await tx.evidenceSeal.create({
    data: {
      activityId: activity.id,
      sealRevision: 1,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      allWindowsClosedAt: endAt,
      openSegmentCount: 0,
      manualReviewPendingCount: 0,
      populationCountDistinct: personCount,
      populationCountBySession: Object.fromEntries(posted.map((row) => [row.session.id, 1])),
      contentHash: `read-fixture-seal-${tag}`,
      statusCode: 'active',
      sealedByUserId: input.actorUserId,
      sealedAt: endAt,
    },
  });
  const run = await tx.attendanceSettlementRun.create({
    data: {
      activityId: activity.id,
      statusCode: committed ? 'posted' : 'posting',
      currentSubmittedVersion: 1,
      currentPostedVersion: committed ? 1 : null,
    },
  });
  const version = await tx.attendanceSettlementVersion.create({
    data: {
      settlementRunId: run.id,
      version: 1,
      evidenceSealId: seal.id,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash: `read-fixture-version-${tag}`,
      personCount,
      sessionParticipationCount: posted.length,
      serviceSegmentCount: posted.filter((row) => row.participant.resultCode === 'present').length,
      createdByUserId: input.actorUserId,
      submittedAt: endAt,
      statusCode: 'approved',
      operationKey: `read-fixture-submit-${tag}`,
    },
  });
  const batch = await tx.ledgerPostingBatch.create({
    data: {
      settlementRunId: run.id,
      settlementVersionId: version.id,
      batchRevision: 1,
      statusCode: input.batchStatus ?? 'committed',
      requestKey: `read-fixture-batch-${tag}`,
      totalCount: posted.length,
      preparedCount: posted.length,
      preparedAt: endAt,
      preparedByUserId: input.actorUserId,
      committedAt: committed ? endAt : null,
      committedByUserId: committed ? input.actorUserId : null,
    },
  });
  for (const { participant, session, identity, startAt } of posted) {
    const recognizedPoints = participant.recognizedPoints ?? participant.creditedPoints;
    const result = await tx.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 1,
        resultCode: participant.resultCode!,
        recognizedServiceHours: participant.serviceHours,
        calculatedServiceHours: participant.serviceHours,
        recognizedContributionPoints: recognizedPoints,
        calculatedContributionPoints: recognizedPoints,
        statusCode: committed ? 'committed' : 'draft',
      },
    });
    if (participant.resultCode !== 'present') continue;
    for (const entryTypeCode of ['service_credit', 'contribution_credit']) {
      const contribution = entryTypeCode === 'contribution_credit';
      await tx.participationLedgerEntry.create({
        data: {
          postingBatchId: batch.id,
          entryKey: `read-fixture-${tag}-${identity.id}-${entryTypeCode}`,
          operationKey: `read-fixture-${tag}-${identity.id}-${entryTypeCode}`,
          memberId: participant.memberId,
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          resultRevisionId: result.id,
          ledgerDate: new Date(beijingDayNumber(startAt) * 86_400_000),
          entryTypeCode,
          serviceHoursDelta: contribution ? '0' : participant.serviceHours,
          recognizedPointsDelta: contribution ? recognizedPoints : '0',
          creditedPointsDelta: contribution ? participant.creditedPoints : '0',
          cappedOutPointsDelta: contribution
            ? new Prisma.Decimal(recognizedPoints).minus(participant.creditedPoints)
            : '0',
        },
      });
    }
  }
}

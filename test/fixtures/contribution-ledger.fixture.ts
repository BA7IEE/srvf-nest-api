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
  const tag = randomUUID();
  const endAt = new Date(input.occurredAt.getTime() + 3_600_000);
  const committed = (input.batchStatus ?? 'committed') === 'committed';
  const recognizedPoints = input.recognizedPoints ?? input.creditedPoints;
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
    const session = await tx.activitySession.create({
      data: {
        activityId: activity.id,
        code: `credit-${tag}`,
        name: '贡献读取场次',
        startAt: input.occurredAt,
        endAt,
        locationText: '测试地点',
        checkInOpenAt: input.occurredAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: input.occurredAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
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
        populationCountDistinct: 1,
        populationCountBySession: { [session.id]: 1 },
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
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: input.actorUserId,
        submittedAt: endAt,
        statusCode: 'approved',
        operationKey: `read-fixture-submit-${tag}`,
      },
    });
    const registration = await tx.activityRegistration.create({
      data: { activityId: activity.id, memberId: input.memberId, statusCode: 'pass' },
    });
    const identity = await tx.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: input.memberId,
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
        sourceCode: 'self',
        effectiveAt: input.occurredAt,
        createdByUserId: input.actorUserId,
      },
    });
    const result = await tx.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 1,
        resultCode: 'present',
        recognizedServiceHours: '1',
        calculatedServiceHours: '1',
        recognizedContributionPoints: recognizedPoints,
        calculatedContributionPoints: recognizedPoints,
        statusCode: committed ? 'committed' : 'draft',
      },
    });
    const batch = await tx.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: input.batchStatus ?? 'committed',
        requestKey: `read-fixture-batch-${tag}`,
        totalCount: 2,
        preparedCount: 2,
        preparedAt: endAt,
        preparedByUserId: input.actorUserId,
        committedAt: committed ? endAt : null,
        committedByUserId: committed ? input.actorUserId : null,
      },
    });
    for (const entryTypeCode of ['service_credit', 'contribution_credit']) {
      const contribution = entryTypeCode === 'contribution_credit';
      await tx.participationLedgerEntry.create({
        data: {
          postingBatchId: batch.id,
          entryKey: `read-fixture-${tag}-${entryTypeCode}`,
          operationKey: `read-fixture-${tag}-${entryTypeCode}`,
          memberId: input.memberId,
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          resultRevisionId: result.id,
          ledgerDate: new Date(beijingDayNumber(input.occurredAt) * 86_400_000),
          entryTypeCode,
          serviceHoursDelta: contribution ? '0' : '1',
          recognizedPointsDelta: contribution ? recognizedPoints : '0',
          creditedPointsDelta: contribution ? input.creditedPoints : '0',
          cappedOutPointsDelta: contribution
            ? new Prisma.Decimal(recognizedPoints).minus(input.creditedPoints)
            : '0',
        },
      });
    }
  });
}

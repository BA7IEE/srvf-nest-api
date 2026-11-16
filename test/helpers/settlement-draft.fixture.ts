import type { PrismaService } from '../../src/database/prisma.service';

/** 合法的 working draft；提交、审核、认定由调用者驱动真实服务或 HTTP。 */
export async function createSettlementDraftFixture(
  prisma: PrismaService,
  input: {
    organizationId: string;
    participantMemberIds: string[];
    ownerMemberId: string;
    actorUserId: string;
    activityTypeCode: string;
    missingResult?: boolean;
  },
) {
  if (input.participantMemberIds.length === 0)
    throw new Error('A draft fixture needs participants');
  const startAt = new Date('2020-03-01T00:00:00Z');
  const endAt = new Date('2020-03-01T04:00:00Z');
  const activity = await prisma.activity.create({
    data: {
      title: '结算草稿验收活动',
      activityTypeCode: input.activityTypeCode,
      organizationId: input.organizationId,
      startAt,
      endAt,
      location: 'Demo',
      statusCode: 'published',
    },
    select: { id: true },
  });
  const session = await prisma.activitySession.create({
    data: {
      activityId: activity.id,
      code: 'settlement-session',
      name: '结算验收场次',
      startAt,
      endAt,
      locationText: 'Demo',
      locationRequired: false,
      locationPolicySourceCode: 'session',
      checkInOpenAt: startAt,
      checkInCloseAt: endAt,
      checkOutOpenAt: startAt,
      checkOutCloseAt: endAt,
      statusCode: 'scheduled',
    },
  });
  const identities = await Promise.all(
    input.participantMemberIds.map(async (memberId) => {
      const registration = await prisma.activityRegistration.create({
        data: { activityId: activity.id, memberId, statusCode: 'approved' },
      });
      return prisma.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registration.id,
          memberId,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
      });
    }),
  );
  await prisma.activityResponsibilityAssignment.create({
    data: {
      activityId: activity.id,
      memberId: input.ownerMemberId,
      responsibilityType: 'owner',
      canManageRegistrations: true,
      canManageAttendance: true,
      status: 'active',
      source: 'admin',
      assignedByUserId: input.actorUserId,
    },
  });
  const seal = await prisma.evidenceSeal.create({
    data: {
      activityId: activity.id,
      sealRevision: 1,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      allWindowsClosedAt: endAt,
      openSegmentCount: 0,
      manualReviewPendingCount: 0,
      populationCountDistinct: identities.length,
      populationCountBySession: {},
      contentHash: 'fixture-seal',
      statusCode: 'active',
      sealedByUserId: input.actorUserId,
      sealedAt: endAt,
    },
  });
  const run = await prisma.attendanceSettlementRun.create({
    data: { activityId: activity.id, statusCode: 'drafting', currentDraftVersion: 1 },
  });
  const draft = await prisma.attendanceSettlementVersion.create({
    data: {
      settlementRunId: run.id,
      version: 1,
      evidenceSealId: seal.id,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash: 'fixture-draft',
      personCount: identities.length,
      sessionParticipationCount: identities.length,
      serviceSegmentCount: 0,
      createdByUserId: input.actorUserId,
      statusCode: 'draft',
    },
  });
  if (!input.missingResult) {
    await prisma.participantSettlementResultRevision.createMany({
      data: identities.map((identity) => ({
        settlementVersionId: draft.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        lateFlag: false,
        earlyLeaveFlag: false,
        recognizedServiceHours: 2,
        recognizedContributionPoints: 0,
        calculatedServiceHours: 2,
        calculatedContributionPoints: 0,
        statusCode: 'draft',
      })),
    });
  }
  return {
    activityId: activity.id,
    runId: run.id,
    draftId: draft.id,
    identityId: identities[0].id,
    identityIds: identities.map((identity) => identity.id),
    sealId: seal.id,
  };
}

import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { expectBizError } from '../helpers/biz-code.assert';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const FUTURE = {
  startAt: new Date('2099-12-15T08:00:00.000Z'),
  endAt: new Date('2099-12-15T12:00:00.000Z'),
};

const PAST = {
  startAt: new Date('2020-12-15T08:00:00.000Z'),
  endAt: new Date('2020-12-15T12:00:00.000Z'),
};

type Scenario = {
  activityId: string;
  sessions: Array<{ id: string; positionId: string | null }>;
};

type ScenarioOptions = {
  activityCapacity?: number | null;
  sessionCapacity?: number | null;
  positionCapacity?: number | null;
  sessionCount?: number;
  withPosition?: boolean;
  requiresInsurance?: boolean;
  activityGenderRequirementCode?: string | null;
  activityStatusCode?: string;
  startAt?: Date;
  endAt?: Date;
};

function receiptKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected onsite receipt object');
  }
  return Object.keys(value).sort();
}

describe('activity batch4 onsite participation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let roleIds: Record<string, string>;
  let managerAuth: string;
  let unprivilegedAuth: string;
  let superAuth: string;
  let unlinkedAuth: string;
  let managerMemberId: string;
  let managerUserId: string;
  let unprivilegedMemberId: string;
  let sequence = 0;
  let previousInsuranceGate: string | undefined;

  beforeAll(async () => {
    jest.setTimeout(90_000);
    previousInsuranceGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    roleIds = await seedActivityResponsibilitySystemRoles(app);

    const [manager, unprivileged, superUser, unlinked] = await Promise.all([
      createTestUser(app, { username: 'onsite-participation-manager', role: Role.USER }),
      createTestUser(app, { username: 'onsite-participation-unpriv', role: Role.USER }),
      createTestUser(app, { username: 'onsite-participation-super', role: Role.SUPER_ADMIN }),
      createTestUser(app, { username: 'onsite-participation-unlinked', role: Role.USER }),
    ]);
    const [managerMember, unprivilegedMember, superMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'ONSITE-MANAGER',
          displayName: 'Onsite Manager',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'ONSITE-UNPRIVILEGED',
          displayName: 'Onsite Unprivileged',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'ONSITE-SUPER',
          displayName: 'Onsite Super',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    managerMemberId = managerMember.id;
    managerUserId = manager.id;
    unprivilegedMemberId = unprivilegedMember.id;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: managerMember.id } }),
      prisma.user.update({
        where: { id: unprivileged.id },
        data: { memberId: unprivilegedMember.id },
      }),
      prisma.user.update({ where: { id: superUser.id }, data: { memberId: superMember.id } }),
    ]);
    managerAuth = (await loginAs(app, manager.username)).authHeader;
    unprivilegedAuth = (await loginAs(app, unprivileged.username)).authHeader;
    superAuth = (await loginAs(app, superUser.username)).authHeader;
    unlinkedAuth = (await loginAs(app, unlinked.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
    if (previousInsuranceGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousInsuranceGate;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function freezeSystemTime(now: Date): void {
    // Only Date is faked: HTTP, Prisma, and Node scheduling must stay real so Supertest does not
    // stall while asserting the exact activity-end boundary.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(now);
  }

  const onsitePath = (activityId: string) =>
    '/api/app/v1/my/managed-activities/' + activityId + '/onsite-participations';

  async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
    const index = ++sequence;
    const activityCapacity = options.activityCapacity ?? 10;
    const sessionCapacity = options.sessionCapacity ?? activityCapacity;
    const positionCapacity = options.positionCapacity ?? sessionCapacity;
    const sessionCount = options.sessionCount ?? 1;
    const withPosition = options.withPosition ?? false;
    const startAt = options.startAt ?? FUTURE.startAt;
    const endAt = options.endAt ?? FUTURE.endAt;
    const organization = await prisma.organization.create({
      data: {
        name: 'Onsite participation team ' + index,
        nodeTypeCode: 'onsite-participation-team',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: 'Onsite participation activity ' + index,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt,
        endAt,
        location: '现场集合点',
        statusCode: options.activityStatusCode ?? 'published',
        publishedAt: new Date(),
        capacity: activityCapacity,
        requiresInsurance: options.requiresInsurance ?? false,
        genderRequirementCode: options.activityGenderRequirementCode ?? null,
      },
      select: { id: true },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: managerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: managerUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: managerMemberId,
        roleId: roleIds['activity-owner'],
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: 'onsite participation fixture',
      },
    });

    const sessions: Scenario['sessions'] = [];
    for (let position = 0; position < sessionCount; position += 1) {
      const session = await prisma.activitySession.create({
        data: {
          activityId: activity.id,
          code: 'onsite-session-' + index + '-' + position,
          name: '现场场次 ' + index + '-' + position,
          startAt,
          endAt,
          locationText: '现场集合点',
          capacity: sessionCapacity,
          checkInOpenAt: new Date(startAt.getTime() - 30 * 60_000),
          checkInCloseAt: new Date(startAt.getTime() + 30 * 60_000),
          checkOutOpenAt: new Date(endAt.getTime() - 60 * 60_000),
          checkOutCloseAt: new Date(endAt.getTime() + 30 * 60_000),
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      let positionId: string | null = null;
      if (withPosition) {
        const createdPosition = await prisma.activitySessionPosition.create({
          data: {
            activityId: activity.id,
            sessionId: session.id,
            code: 'onsite-position-' + index + '-' + position,
            name: '现场岗位 ' + index + '-' + position,
            attendanceRoleCode: 'volunteer',
            capacity: positionCapacity,
          },
          select: { id: true },
        });
        positionId = createdPosition.id;
      }
      sessions.push({ id: session.id, positionId });
    }
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: activityCapacity,
        },
        ...sessions.map((session) => ({
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: sessionCapacity,
        })),
        ...sessions
          .filter((session) => session.positionId !== null)
          .map((session) => ({
            activityId: activity.id,
            scopeTypeCode: 'position_participation',
            scopeId: session.positionId!,
            capacity: positionCapacity,
          })),
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    return { activityId: activity.id, sessions };
  }

  async function createTarget(status: MemberStatus = MemberStatus.ACTIVE): Promise<{ id: string }> {
    const index = ++sequence;
    return prisma.member.create({
      data: {
        memberNo: 'ONSITE-TARGET-' + index,
        displayName: 'Onsite Target ' + index,
        gradeCode: 'L1',
        status,
      },
      select: { id: true },
    });
  }

  async function giveVerifiedInsurance(memberId: string): Promise<void> {
    await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'Onsite Insurance',
        policyNumber: 'ONSITE-INSURANCE-' + ++sequence,
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2100-01-01T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        reviewedByUserId: managerUserId,
        reviewedAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  }

  function onsite(
    scenario: Scenario,
    input: {
      memberId: string;
      operationKey: string;
      auth?: string;
      sessionIndex?: number;
      positionId?: string | null;
      reason?: string;
    },
  ) {
    const session = scenario.sessions[input.sessionIndex ?? 0];
    if (!session) throw new Error('onsite fixture session is missing');
    const positionId = input.positionId === undefined ? session.positionId : input.positionId;
    const body: {
      operationKey: string;
      memberId: string;
      sessionId: string;
      positionId?: string;
      reason: string;
    } = {
      operationKey: input.operationKey,
      memberId: input.memberId,
      sessionId: session.id,
      reason: input.reason ?? '现场补录原因',
    };
    if (positionId !== null) body.positionId = positionId;
    return request(httpServer(app))
      .post(onsitePath(scenario.activityId))
      .set('Authorization', input.auth ?? managerAuth)
      .send(body);
  }

  async function seedPostedSettlement(
    scenario: Scenario,
    options: { currentPostedVersion?: boolean; runStatusCode?: string } = {},
  ) {
    const tag = 'onsite-finality-' + ++sequence;
    const settledAt = new Date('2099-12-16T12:00:00.000Z');
    const runStatusCode = options.runStatusCode ?? 'posted';
    const isPosting = runStatusCode === 'posting';
    const [evidenceState, populationCount] = await Promise.all([
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true, populationRevision: true },
      }),
      prisma.activityParticipationIdentity.count({
        where: { activityId: scenario.activityId, populationIncluded: true },
      }),
    ]);
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: scenario.activityId,
        sealRevision: 1,
        evidenceRevision: evidenceState.evidenceRevision,
        populationRevision: evidenceState.populationRevision,
        workflowRevision: 0,
        allWindowsClosedAt: settledAt,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: populationCount,
        populationCountBySession: {},
        contentHash: tag + '-seal',
        statusCode: 'active',
        sealedAt: settledAt,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: scenario.activityId,
        statusCode: runStatusCode,
        currentSubmittedVersion: isPosting ? 1 : null,
        currentPostedVersion: options.currentPostedVersion === false ? null : 1,
      },
      select: { id: true },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: evidenceState.evidenceRevision,
        populationRevision: evidenceState.populationRevision,
        workflowRevision: 0,
        contentHash: tag + '-version',
        personCount: populationCount,
        sessionParticipationCount: populationCount,
        serviceSegmentCount: 0,
        submittedAt: settledAt,
        statusCode: 'approved',
        operationKey: tag + '-submit',
        requestHash: tag + '-submit-hash',
      },
      select: { id: true },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: isPosting ? 'preparing' : 'committed',
        requestKey: tag + '-batch',
        requestHash: tag + '-batch-hash',
        totalCount: populationCount,
        committedAt: isPosting ? null : settledAt,
      },
      select: { id: true },
    });
    return {
      tag,
      settledAt,
      sealId: seal.id,
      versionId: version.id,
      batchId: batch.id,
      populationCount,
    };
  }

  async function seedActiveClosure(
    scenario: Scenario,
    settlement: Awaited<ReturnType<typeof seedPostedSettlement>>,
  ): Promise<void> {
    const evidenceState = await prisma.activityEvidenceState.findUniqueOrThrow({
      where: { activityId: scenario.activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    await prisma.activitySettlementClosureRevision.create({
      data: {
        activityId: scenario.activityId,
        revision: 1,
        settlementVersionId: settlement.versionId,
        postingBatchId: settlement.batchId,
        evidenceSealId: settlement.sealId,
        evidenceRevision: evidenceState.evidenceRevision,
        populationRevision: evidenceState.populationRevision,
        workflowRevision: 0,
        personCount: settlement.populationCount,
        sessionParticipationCount: settlement.populationCount,
        resultCountsJson: {},
        serviceHours: '0.00',
        contributionPoints: '0.00',
        checksHash: settlement.tag + '-closure',
        checksJson: { schemaVersion: 1, checks: [] },
        statusCode: 'active',
        closedAt: settlement.settledAt,
      },
    });
  }

  async function onsiteFacts(scenario: Scenario, memberId: string) {
    const [
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
      evidence,
    ] = await Promise.all([
      prisma.activityRegistration.count({ where: { activityId: scenario.activityId, memberId } }),
      prisma.activityParticipationIdentity.count({
        where: { activityId: scenario.activityId, memberId },
      }),
      prisma.activityRegistrationRevision.count({
        where: { registration: { activityId: scenario.activityId, memberId } },
      }),
      prisma.activityParticipationRevision.count({
        where: { identity: { activityId: scenario.activityId, memberId } },
      }),
      prisma.capacityReservation.count({
        where: { identity: { activityId: scenario.activityId, memberId } },
      }),
      prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistration: { activityId: scenario.activityId, memberId } },
      }),
    ]);
    const [state, audits, outbox] = await Promise.all([
      prisma.activityEvidenceState.findUnique({
        where: { activityId: scenario.activityId },
        select: { populationRevision: true, version: true },
      }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
    ]);
    return {
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
      evidence,
      population: state,
      audits,
      outbox,
    };
  }

  async function expectNoOnsiteWrites(
    scenario: Scenario,
    memberId: string,
    before: Awaited<ReturnType<typeof onsiteFacts>>,
  ): Promise<void> {
    await expect(onsiteFacts(scenario, memberId)).resolves.toEqual(before);
  }

  async function onsiteFinalityFacts(scenario: Scenario) {
    const [activity, run, seals, versions, batches, closures] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: {
          statusCode: true,
          endAt: true,
          currentEvidenceRevision: true,
          currentPopulationRevision: true,
          currentClosureRevision: true,
          workflowRevision: true,
        },
      }),
      prisma.attendanceSettlementRun.findUnique({
        where: { activityId: scenario.activityId },
        select: {
          statusCode: true,
          currentDraftVersion: true,
          currentSubmittedVersion: true,
          currentPostedVersion: true,
          currentClosureRevision: true,
          version: true,
        },
      }),
      prisma.evidenceSeal.count({ where: { activityId: scenario.activityId } }),
      prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId: scenario.activityId } },
      }),
      prisma.ledgerPostingBatch.count({
        where: { settlementRun: { activityId: scenario.activityId } },
      }),
      prisma.activitySettlementClosureRevision.findMany({
        where: { activityId: scenario.activityId },
        orderBy: { revision: 'asc' },
        select: {
          revision: true,
          statusCode: true,
          settlementVersionId: true,
          postingBatchId: true,
          populationRevision: true,
        },
      }),
    ]);
    return { activity, run, seals, versions, batches, closures };
  }

  async function onsiteAllFacts(scenario: Scenario, memberId: string) {
    const [command, finality] = await Promise.all([
      onsiteFacts(scenario, memberId),
      onsiteFinalityFacts(scenario),
    ]);
    return { command, finality };
  }

  async function onsiteHistoricalHeadWriteChain(scenario: Scenario, memberId: string) {
    const [
      activity,
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
      evidence,
      buckets,
      state,
      audits,
      outbox,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: {
          statusCode: true,
          currentEvidenceRevision: true,
          currentPopulationRevision: true,
          currentClosureRevision: true,
          workflowRevision: true,
        },
      }),
      prisma.activityRegistration.findMany({
        where: { activityId: scenario.activityId, memberId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          statusCode: true,
          statusSummaryCode: true,
          currentRevision: true,
          currentFormVersionId: true,
          sourceCode: true,
          cancelledAt: true,
          deletedAt: true,
          updatedAt: true,
        },
      }),
      prisma.activityParticipationIdentity.findMany({
        where: { activityId: scenario.activityId, memberId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          registrationId: true,
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
          version: true,
          updatedAt: true,
        },
      }),
      prisma.activityRegistrationRevision.findMany({
        where: { registration: { activityId: scenario.activityId, memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          registrationId: true,
          revision: true,
          sourceCode: true,
          requestKey: true,
          requestHash: true,
        },
      }),
      prisma.activityParticipationRevision.findMany({
        where: { identity: { activityId: scenario.activityId, memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          identityId: true,
          revision: true,
          statusCode: true,
          sourceCode: true,
          requestKey: true,
          requestHash: true,
        },
      }),
      prisma.capacityReservation.findMany({
        where: { identity: { activityId: scenario.activityId, memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          identityId: true,
          bucketId: true,
          reservationType: true,
          status: true,
          releasedAt: true,
          updatedAt: true,
        },
      }),
      prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistration: { activityId: scenario.activityId, memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          activityRegistrationId: true,
          sourceKind: true,
          memberInsuranceId: true,
          teamInsuranceCoverageId: true,
        },
      }),
      prisma.activityCapacityBucket.findMany({
        where: { activityId: scenario.activityId },
        orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
        select: {
          id: true,
          scopeTypeCode: true,
          scopeId: true,
          occupied: true,
          version: true,
          updatedAt: true,
        },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: {
          evidenceRevision: true,
          populationRevision: true,
          version: true,
          lastPopulationAt: true,
          updatedAt: true,
        },
      }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
    ]);
    return {
      activity,
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
      evidence,
      buckets,
      state,
      audits,
      outbox,
    };
  }

  async function seedEmptyHistoricalHeader(
    scenario: Scenario,
    memberId: string,
    kind: 'cancelled' | 'soft-deleted',
  ): Promise<void> {
    const at = new Date('2099-01-01T00:00:00.000Z');
    await prisma.activityRegistration.create({
      data: {
        activityId: scenario.activityId,
        memberId,
        statusCode: kind === 'cancelled' ? 'cancelled' : 'pending',
        currentRevision: 0,
        currentFormVersionId: null,
        statusSummaryCode: kind === 'cancelled' ? 'cancelled' : 'active',
        sourceCode: 'self',
        cancelledAt: kind === 'cancelled' ? at : null,
        deletedAt: kind === 'soft-deleted' ? at : null,
      },
    });
  }

  async function seedRejectedIdentity(
    scenario: Scenario,
    memberId: string,
  ): Promise<{ registrationId: string; identityId: string }> {
    const header = await prisma.activityRegistration.create({
      data: {
        activityId: scenario.activityId,
        memberId,
        statusCode: 'pending',
        currentRevision: 1,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: 'self',
      },
      select: { id: true },
    });
    await prisma.activityRegistrationRevision.create({
      data: {
        registrationId: header.id,
        revision: 1,
        formVersionId: null,
        answersHash: null,
        sourceCode: 'self',
        submittedByUserId: managerUserId,
        submittedAt: new Date('2099-01-01T00:00:00.000Z'),
        reason: null,
      },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: scenario.activityId,
        sessionId: scenario.sessions[0].id,
        registrationId: header.id,
        memberId,
        currentRevision: 1,
        currentStatusCode: 'rejected',
        currentPositionId: null,
        populationIncluded: false,
        version: 7,
      },
      select: { id: true },
    });
    await prisma.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: 1,
        statusCode: 'rejected',
        effectiveAt: new Date('2099-01-01T00:00:00.000Z'),
        createdByUserId: managerUserId,
        sourceCode: 'self',
      },
    });
    return { registrationId: header.id, identityId: identity.id };
  }

  it.each(['cancelled', 'soft-deleted'] as const)(
    'reuses a cancelled onsite head but rejects a %s empty historical header when soft-deleted',
    async (kind) => {
      const scenario = await createScenario();
      const target = await createTarget();
      await seedEmptyHistoricalHeader(scenario, target.id, kind);
      const before = await onsiteHistoricalHeadWriteChain(scenario, target.id);

      const response = await onsite(scenario, {
        memberId: target.id,
        operationKey: 'onsite-' + kind + '-empty-head-new-key-0001',
      });

      if (kind === 'cancelled') {
        expect(response.status).toBe(201);
      } else {
        expectBizError(response, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
        await expect(onsiteHistoricalHeadWriteChain(scenario, target.id)).resolves.toEqual(before);
      }
    },
  );

  it.each(['cancelled', 'soft-deleted'] as const)(
    'replays the exact onsite receipt after its header becomes %s without any new write',
    async (kind) => {
      const scenario = await createScenario();
      const target = await createTarget();
      const body = {
        memberId: target.id,
        operationKey: 'onsite-' + kind + '-historical-replay-0001',
        reason: '历史头精确重放',
      };
      const first = await onsite(scenario, body);
      expect(first.status).toBe(201);
      const registrationId = first.body.data.registrationId as string;
      const at = new Date('2099-01-01T00:00:00.000Z');
      await prisma.activityRegistration.update({
        where: { id: registrationId },
        data:
          kind === 'cancelled'
            ? { statusCode: 'cancelled', statusSummaryCode: 'cancelled', cancelledAt: at }
            : { deletedAt: at },
      });
      const before = await onsiteHistoricalHeadWriteChain(scenario, target.id);

      const replay = await onsite(scenario, body);

      expect(replay.status).toBe(201);
      expect(replay.body.data).toEqual(first.body.data);
      await expect(onsiteHistoricalHeadWriteChain(scenario, target.id)).resolves.toEqual(before);
    },
  );

  it('red-first destination creates one header with three capacity layers and replays 20 concurrent calls exactly', async () => {
    const scenario = await createScenario({
      withPosition: true,
      sessionCount: 2,
      requiresInsurance: true,
    });
    const target = await createTarget();
    expect(await prisma.user.findFirst({ where: { memberId: target.id } })).toBeNull();
    await giveVerifiedInsurance(target.id);
    const before = await onsiteFacts(scenario, target.id);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        onsite(scenario, {
          memberId: target.id,
          operationKey: 'onsite-concurrent-replay-0001',
          reason: '  现场补录原因  ',
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 20 }, () => 201),
    );
    const receipt = responses[0].body.data as Record<string, unknown>;
    for (const response of responses) expect(response.body.data).toEqual(receipt);
    expect(receiptKeys(receipt)).toEqual([
      'approvedAt',
      'participationIdentityId',
      'participationRevisionId',
      'positionId',
      'registrationId',
      'registrationRevisionId',
      'sourceCode',
      'statusCode',
    ]);
    expect(receipt).toMatchObject({
      statusCode: 'pass',
      sourceCode: 'onsite',
      positionId: scenario.sessions[0].positionId,
    });

    const firstFacts = await onsiteFacts(scenario, target.id);
    expect(firstFacts).toEqual({
      headers: 1,
      identities: 1,
      registrationRevisions: 1,
      participationRevisions: 1,
      reservations: 3,
      evidence: 1,
      population: { populationRevision: 1, version: 1 },
      audits: before.audits + 1,
      outbox: before.outbox,
    });
    const registration = await prisma.activityRegistration.findUniqueOrThrow({
      where: { id: receipt.registrationId as string },
      select: { currentRevision: true, sourceCode: true, statusSummaryCode: true },
    });
    expect(registration).toEqual({
      currentRevision: 1,
      sourceCode: 'onsite',
      statusSummaryCode: 'active',
    });
    const registrationRevision = await prisma.activityRegistrationRevision.findUniqueOrThrow({
      where: { id: receipt.registrationRevisionId as string },
      select: { sourceCode: true, reason: true, requestKey: true },
    });
    expect(registrationRevision).toEqual({
      sourceCode: 'onsite',
      reason: '现场补录原因',
      requestKey: 'onsite-concurrent-replay-0001',
    });
    const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: receipt.participationIdentityId as string },
      select: {
        currentRevision: true,
        currentStatusCode: true,
        currentPositionId: true,
        populationIncluded: true,
        version: true,
        capacityReservationId: true,
      },
    });
    const sessionReservation = await prisma.capacityReservation.findFirstOrThrow({
      where: {
        identityId: receipt.participationIdentityId as string,
        status: 'active',
        reservationType: 'session_participation',
      },
      select: { id: true },
    });
    expect(identity).toEqual({
      currentRevision: 1,
      currentStatusCode: 'pass',
      currentPositionId: scenario.sessions[0].positionId,
      populationIncluded: true,
      version: 1,
      capacityReservationId: sessionReservation.id,
    });
    const participationRevision = await prisma.activityParticipationRevision.findUniqueOrThrow({
      where: { id: receipt.participationRevisionId as string },
      select: { statusCode: true, positionId: true, sourceCode: true, reviewNote: true },
    });
    expect(participationRevision).toEqual({
      statusCode: 'pass',
      positionId: scenario.sessions[0].positionId,
      sourceCode: 'onsite',
      reviewNote: '现场补录原因',
    });
    const buckets = await prisma.activityCapacityBucket.findMany({
      where: { activityId: scenario.activityId },
      select: { scopeTypeCode: true, scopeId: true, occupied: true, version: true },
    });
    const usedScopes = new Set([
      'activity_person:' + scenario.activityId,
      'session_participation:' + scenario.sessions[0].id,
      'position_participation:' + scenario.sessions[0].positionId,
    ]);
    expect(
      buckets
        .filter((bucket) => usedScopes.has(bucket.scopeTypeCode + ':' + bucket.scopeId))
        .map((bucket) => [bucket.occupied, bucket.version]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    const reservationTypes = await prisma.capacityReservation.findMany({
      where: { identityId: receipt.participationIdentityId as string, status: 'active' },
      select: { reservationType: true },
      orderBy: { reservationType: 'asc' },
    });
    expect(reservationTypes.map((row) => row.reservationType)).toEqual([
      'activity_person',
      'position_participation',
      'session_participation',
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'registration.create',
        resourceId: receipt.registrationId as string,
      },
      select: { context: true },
    });
    expect(audit.context).toMatchObject({
      extra: {
        operation: 'onsite',
        source: 'onsite',
        registrationRevisionId: receipt.registrationRevisionId,
        participationIdentityId: receipt.participationIdentityId,
        participationRevisionId: receipt.participationRevisionId,
      },
    });
    expect(JSON.stringify(audit.context)).not.toMatch(
      /现场补录原因|insurance|answer|attachment|reservation|capacityReservationId/i,
    );

    const conflictBefore = await onsiteFacts(scenario, target.id);
    const conflict = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-concurrent-replay-0001',
      reason: '不同的原因',
    });
    expectBizError(conflict, BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
    await expectNoOnsiteWrites(scenario, target.id, conflictBefore);

    const second = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-insurance-reuse-0002',
      sessionIndex: 1,
      reason: '第二场现场补录',
    });
    expect(second.status).toBe(201);
    expect(second.body.data.registrationId).toBe(receipt.registrationId);
    expect((await onsiteFacts(scenario, target.id)).evidence).toBe(2);
    expect(
      await prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistrationId: receipt.registrationId as string },
        orderBy: { createdAt: 'asc' },
        select: { activityRegistrationRevisionId: true },
      }),
    ).toEqual([
      { activityRegistrationRevisionId: receipt.registrationRevisionId },
      { activityRegistrationRevisionId: second.body.data.registrationRevisionId },
    ]);
    expect(
      await prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { populationRevision: true },
      }),
    ).toEqual({ populationRevision: 2 });
  }, 90_000);

  it('reuses a safe permanent identity, advances its immutable revision once, and never recreates it', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    const seeded = await seedRejectedIdentity(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-reuse-rejected-0001',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.registrationId).toBe(seeded.registrationId);
    expect(response.body.data.participationIdentityId).toBe(seeded.identityId);
    expect(response.body.data.positionId).toBeNull();
    const [header, identity, registrationRevision, participationRevision] = await Promise.all([
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: seeded.registrationId },
        select: { currentRevision: true, sourceCode: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: seeded.identityId },
        select: { currentRevision: true, currentStatusCode: true, version: true },
      }),
      prisma.activityRegistrationRevision.count({
        where: { registrationId: seeded.registrationId },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: seeded.identityId } }),
    ]);
    expect(header).toEqual({ currentRevision: 2, sourceCode: 'onsite' });
    expect(identity).toEqual({ currentRevision: 2, currentStatusCode: 'pass', version: 8 });
    expect(registrationRevision).toBe(2);
    expect(participationRevision).toBe(2);
  });

  it('rejects an already final pass identity except for the exact idempotent replay', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    const first = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-final-state-first-0001',
    });
    expect(first.status).toBe(201);
    const before = await onsiteFacts(scenario, target.id);

    const second = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-final-state-second-0002',
    });
    expectBizError(second, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expectNoOnsiteWrites(scenario, target.id, before);
  });

  it('rejects a new operation key after the activity naturally ends with every fact unchanged', async () => {
    const scenario = await createScenario(PAST);
    const target = await createTarget();
    const before = await onsiteAllFacts(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-after-natural-end-0001',
    });

    expectBizError(response, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('rejects a new operation key when a formal posted version exists with every fact unchanged', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    await seedPostedSettlement(scenario);
    const before = await onsiteAllFacts(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-after-posted-version-0001',
    });

    expectBizError(response, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('rejects a new operation key while final review has moved the run to posting before currentPostedVersion exists', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    await seedPostedSettlement(scenario, {
      currentPostedVersion: false,
      runStatusCode: 'posting',
    });
    const before = await onsiteAllFacts(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-during-posting-null-pointer-0001',
    });

    expectBizError(response, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('allows a new operation key exactly at endAt because the activity is still ongoing at that boundary', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    const endAt = new Date(Date.now());
    const startAt = new Date(endAt.getTime() - 60_000);
    await Promise.all([
      prisma.activity.update({
        where: { id: scenario.activityId },
        data: { startAt, endAt },
      }),
      prisma.activitySession.updateMany({
        where: { activityId: scenario.activityId },
        data: {
          startAt,
          endAt,
          checkInOpenAt: new Date(startAt.getTime() - 30 * 60_000),
          checkInCloseAt: new Date(startAt.getTime() + 30 * 60_000),
          checkOutOpenAt: new Date(endAt.getTime() - 60 * 60_000),
          checkOutCloseAt: new Date(endAt.getTime() + 30 * 60_000),
        },
      }),
    ]);
    freezeSystemTime(endAt);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-exact-activity-end-boundary-0001',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.statusCode).toBe('pass');
  });

  it('rejects a new operation key when an active closure exists with every fact unchanged', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    // The active closure row is the source of truth; clear the fast posted pointer so this case
    // proves the closure gate itself rather than passing through the posted-version gate.
    const settlement = await seedPostedSettlement(scenario, {
      currentPostedVersion: false,
      runStatusCode: 'closed',
    });
    await seedActiveClosure(scenario, settlement);
    const before = await onsiteAllFacts(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-after-active-closure-0001',
    });

    expectBizError(response, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('replays an old exact receipt after closure and adds no facts', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    const request = {
      memberId: target.id,
      operationKey: 'onsite-replay-after-closure-0001',
      reason: '关账前现场补录',
    };
    const first = await onsite(scenario, request);
    expect(first.status).toBe(201);
    const settlement = await seedPostedSettlement(scenario);
    await seedActiveClosure(scenario, settlement);
    const before = await onsiteAllFacts(scenario, target.id);

    const replay = await onsite(scenario, request);

    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('replays an old exact receipt after the activity becomes completed and adds no facts', async () => {
    const scenario = await createScenario();
    const target = await createTarget();
    const request = {
      memberId: target.id,
      operationKey: 'onsite-replay-after-completed-0001',
      reason: '完结前现场补录',
    };
    const first = await onsite(scenario, request);
    expect(first.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { statusCode: 'completed' },
    });
    const before = await onsiteAllFacts(scenario, target.id);

    const replay = await onsite(scenario, request);

    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    await expect(onsiteAllFacts(scenario, target.id)).resolves.toEqual(before);
  });

  it('serializes two independent capacity pools at one and returns exactly 1 success plus 99 capacity errors', async () => {
    const scenario = await createScenario({ activityCapacity: 1, sessionCapacity: 1 });
    const targets = await Promise.all(Array.from({ length: 100 }, () => createTarget()));
    const responses = await Promise.all(
      targets.map((target, index) =>
        onsite(scenario, {
          memberId: target.id,
          operationKey: 'onsite-capacity-competition-' + index,
        }),
      ),
    );
    const successes = responses.filter((response) => response.status === 201);
    const failures = responses.filter((response) => response.status !== 201);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(99);
    for (const failure of failures) expectBizError(failure, BizCode.ACTIVITY_CAPACITY_EXCEEDED);

    const [
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
      state,
      buckets,
    ] = await Promise.all([
      prisma.activityRegistration.count({ where: { activityId: scenario.activityId } }),
      prisma.activityParticipationIdentity.count({ where: { activityId: scenario.activityId } }),
      prisma.activityRegistrationRevision.count({
        where: { registration: { activityId: scenario.activityId } },
      }),
      prisma.activityParticipationRevision.count({
        where: { identity: { activityId: scenario.activityId } },
      }),
      prisma.capacityReservation.count({
        where: { identity: { activityId: scenario.activityId } },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { populationRevision: true },
      }),
      prisma.activityCapacityBucket.findMany({
        where: { activityId: scenario.activityId },
        select: { capacity: true, occupied: true, version: true },
        orderBy: { scopeTypeCode: 'asc' },
      }),
    ]);
    expect({
      headers,
      identities,
      registrationRevisions,
      participationRevisions,
      reservations,
    }).toEqual({
      headers: 1,
      identities: 1,
      registrationRevisions: 1,
      participationRevisions: 1,
      reservations: 2,
    });
    expect(state).toEqual({ populationRevision: 1 });
    expect(buckets).toEqual([
      { capacity: 1, occupied: 1, version: 1 },
      { capacity: 1, occupied: 1, version: 1 },
    ]);
  }, 90_000);

  it('rolls back every command fact on capacity reconciliation drift', async () => {
    const scenario = await createScenario({ activityCapacity: 2, sessionCapacity: 2 });
    const target = await createTarget();
    await prisma.activityCapacityBucket.update({
      where: {
        scopeTypeCode_scopeId: {
          scopeTypeCode: 'activity_person',
          scopeId: scenario.activityId,
        },
      },
      data: { occupied: 1 },
    });
    const before = await onsiteFacts(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-capacity-drift-0001',
    });
    expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expectNoOnsiteWrites(scenario, target.id, before);
  });

  it('fails closed when a non-target identity pointer drifts before another session is added', async () => {
    const scenario = await createScenario({ sessionCount: 2 });
    const target = await createTarget();
    const first = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-non-target-pointer-first-0001',
      sessionIndex: 0,
    });
    expect(first.status).toBe(201);
    await prisma.activityParticipationIdentity.update({
      where: { id: first.body.data.participationIdentityId as string },
      data: { capacityReservationId: null },
    });
    const before = await onsiteHistoricalHeadWriteChain(scenario, target.id);

    const response = await onsite(scenario, {
      memberId: target.id,
      operationKey: 'onsite-non-target-pointer-second-0002',
      sessionIndex: 1,
    });
    expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(onsiteHistoricalHeadWriteChain(scenario, target.id)).resolves.toEqual(before);
  });

  it('requires D-5, the reusable permission, and active activity responsibility independently', async () => {
    const permissionScenario = await createScenario();
    const permissionTarget = await createTarget();
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: permissionScenario.activityId,
        memberId: unprivilegedMemberId,
        responsibilityType: 'collaborator',
        canManageRegistrations: true,
        canManageAttendance: false,
        status: 'active',
        assignedByUserId: managerUserId,
        source: 'delegation',
      },
    });
    const permissionBefore = await onsiteFacts(permissionScenario, permissionTarget.id);
    const permissionDenied = await onsite(permissionScenario, {
      memberId: permissionTarget.id,
      operationKey: 'onsite-no-permission-0001',
      auth: unprivilegedAuth,
    });
    expectBizError(permissionDenied, BizCode.RBAC_FORBIDDEN);
    await expectNoOnsiteWrites(permissionScenario, permissionTarget.id, permissionBefore);

    const responsibilityScenario = await createScenario();
    const responsibilityTarget = await createTarget();
    const responsibilityBefore = await onsiteFacts(responsibilityScenario, responsibilityTarget.id);
    const globalRoleCannotBypass = await onsite(responsibilityScenario, {
      memberId: responsibilityTarget.id,
      operationKey: 'onsite-super-no-responsibility-0001',
      auth: superAuth,
    });
    expectBizError(globalRoleCannotBypass, BizCode.RBAC_FORBIDDEN);
    await expectNoOnsiteWrites(
      responsibilityScenario,
      responsibilityTarget.id,
      responsibilityBefore,
    );

    const d5Scenario = await createScenario();
    const d5Target = await createTarget();
    const d5Before = await onsiteFacts(d5Scenario, d5Target.id);
    const d5Denied = await onsite(d5Scenario, {
      memberId: d5Target.id,
      operationKey: 'onsite-d5-unlinked-0001',
      auth: unlinkedAuth,
    });
    expectBizError(d5Denied, BizCode.FORBIDDEN);
    await expectNoOnsiteWrites(d5Scenario, d5Target.id, d5Before);
  });

  it('fails before writes for inactive targets, gender/profile mismatch, and missing insurance', async () => {
    const inactiveScenario = await createScenario();
    const inactiveTarget = await createTarget(MemberStatus.INACTIVE);
    const inactiveBefore = await onsiteFacts(inactiveScenario, inactiveTarget.id);
    const inactive = await onsite(inactiveScenario, {
      memberId: inactiveTarget.id,
      operationKey: 'onsite-inactive-target-0001',
    });
    expectBizError(inactive, BizCode.MEMBER_INACTIVE);
    await expectNoOnsiteWrites(inactiveScenario, inactiveTarget.id, inactiveBefore);

    const genderScenario = await createScenario({ activityGenderRequirementCode: 'female' });
    const genderTarget = await createTarget();
    const genderBefore = await onsiteFacts(genderScenario, genderTarget.id);
    const gender = await onsite(genderScenario, {
      memberId: genderTarget.id,
      operationKey: 'onsite-gender-missing-profile-0001',
    });
    expectBizError(gender, BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    await expectNoOnsiteWrites(genderScenario, genderTarget.id, genderBefore);

    const insuranceScenario = await createScenario({ requiresInsurance: true });
    const insuranceTarget = await createTarget();
    const insuranceBefore = await onsiteFacts(insuranceScenario, insuranceTarget.id);
    const insurance = await onsite(insuranceScenario, {
      memberId: insuranceTarget.id,
      operationKey: 'onsite-missing-insurance-0001',
    });
    expectBizError(insurance, BizCode.INSURANCE_REQUIRED);
    await expectNoOnsiteWrites(insuranceScenario, insuranceTarget.id, insuranceBefore);
  });

  it('requires a published activity, a scheduled local session, and an explicit live position', async () => {
    const unpublishedScenario = await createScenario({ activityStatusCode: 'draft' });
    const unpublishedTarget = await createTarget();
    const unpublishedBefore = await onsiteFacts(unpublishedScenario, unpublishedTarget.id);
    const unpublished = await onsite(unpublishedScenario, {
      memberId: unpublishedTarget.id,
      operationKey: 'onsite-unpublished-0001',
    });
    expectBizError(unpublished, BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN);
    await expectNoOnsiteWrites(unpublishedScenario, unpublishedTarget.id, unpublishedBefore);

    const scheduledScenario = await createScenario();
    const scheduledTarget = await createTarget();
    await prisma.activitySession.update({
      where: { id: scheduledScenario.sessions[0].id },
      data: { statusCode: 'cancelled' },
    });
    const scheduledBefore = await onsiteFacts(scheduledScenario, scheduledTarget.id);
    const notScheduled = await onsite(scheduledScenario, {
      memberId: scheduledTarget.id,
      operationKey: 'onsite-unscheduled-0001',
    });
    expectBizError(notScheduled, BizCode.BAD_REQUEST);
    await expectNoOnsiteWrites(scheduledScenario, scheduledTarget.id, scheduledBefore);

    const positionScenario = await createScenario({ withPosition: true, sessionCount: 2 });
    const positionTarget = await createTarget();
    const omittedBefore = await onsiteFacts(positionScenario, positionTarget.id);
    const omitted = await onsite(positionScenario, {
      memberId: positionTarget.id,
      operationKey: 'onsite-position-omitted-0001',
      positionId: null,
    });
    expectBizError(omitted, BizCode.ACTIVITY_POSITION_REQUIRED);
    await expectNoOnsiteWrites(positionScenario, positionTarget.id, omittedBefore);
    const foreign = await onsite(positionScenario, {
      memberId: positionTarget.id,
      operationKey: 'onsite-position-foreign-0002',
      positionId: positionScenario.sessions[1].positionId,
    });
    expectBizError(foreign, BizCode.BAD_REQUEST);
    await expectNoOnsiteWrites(positionScenario, positionTarget.id, omittedBefore);
  });

  it('fails closed before all writes for Form fields, applicable RuleSets, and explicit position bindings', async () => {
    const formScenario = await createScenario();
    const formTarget = await createTarget();
    await prisma.registrationFormVersion.create({
      data: {
        activityId: formScenario.activityId,
        version: 1,
        statusCode: 'active',
        workflowRevision: 1,
        schemaHash: 'f'.repeat(64),
        activatedAt: new Date(),
        fields: {
          create: {
            fieldCode: 'onsite-required',
            label: '现场条件',
            typeCode: 'short_text',
            required: true,
            visibilityCode: 'self_only',
          },
        },
      },
    });
    const formBefore = await onsiteFacts(formScenario, formTarget.id);
    const formBlocked = await onsite(formScenario, {
      memberId: formTarget.id,
      operationKey: 'onsite-form-blocked-0001',
    });
    expectBizError(formBlocked, BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE);
    await expectNoOnsiteWrites(formScenario, formTarget.id, formBefore);

    const rulesScenario = await createScenario();
    const rulesTarget = await createTarget();
    await prisma.activityQualificationRuleSet.create({
      data: { activityId: rulesScenario.activityId, version: 1, statusCode: 'active' },
    });
    const rulesBefore = await onsiteFacts(rulesScenario, rulesTarget.id);
    const rulesBlocked = await onsite(rulesScenario, {
      memberId: rulesTarget.id,
      operationKey: 'onsite-rules-blocked-0001',
    });
    expectBizError(rulesBlocked, BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE);
    await expectNoOnsiteWrites(rulesScenario, rulesTarget.id, rulesBefore);

    const bindingScenario = await createScenario({ withPosition: true });
    const bindingTarget = await createTarget();
    const boundRuleSet = await prisma.activityQualificationRuleSet.create({
      data: { activityId: bindingScenario.activityId, version: 1, statusCode: 'draft' },
      select: { id: true },
    });
    const boundPositionId = bindingScenario.sessions[0].positionId;
    if (boundPositionId === null) throw new Error('onsite fixture position is missing');
    await prisma.activitySessionPosition.update({
      where: { id: boundPositionId },
      data: { qualificationRuleSetId: boundRuleSet.id },
    });
    const bindingBefore = await onsiteFacts(bindingScenario, bindingTarget.id);
    const bindingBlocked = await onsite(bindingScenario, {
      memberId: bindingTarget.id,
      operationKey: 'onsite-position-ruleset-blocked-0001',
    });
    expectBizError(bindingBlocked, BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE);
    await expectNoOnsiteWrites(bindingScenario, bindingTarget.id, bindingBefore);
  });
});

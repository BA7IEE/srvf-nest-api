import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, Role, UserStatus, MemberStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { SettlementSubmitAuditRecorder } from '../../src/modules/activities/settlement-submit-audit-recorder';
import { SettlementNotificationProducer } from '../../src/modules/activities/settlement-notification-producer';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import {
  createD13Fixture,
  closeD13Fixture,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { assertConnectedTestDatabase } from '../setup/test-db';

class ObservedTimeSettlementDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
const meta = { requestId: 'd4-race-scale', ip: null, ua: null };
const PAST = new Date('2020-03-01T00:00:00.000Z');
const CLOSED = new Date('2020-03-01T01:00:00.000Z');

describe('D4 real transaction races and bounded SQL', () => {
  let f: D13Fixture, actor: CurrentUserPayload, service: ActivityTimeSettlementService;
  let bindingId: string;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createD13Fixture();
    actor = {
      id: f.creator.id,
      memberId: f.creator.memberId,
      username: 'd4-race',
      role: Role.USER,
      status: UserStatus.ACTIVE,
    };
    service = f.app.get(ActivityTimeSettlementService);
    // Measure the normal member path, not the AuthzService SUPER_ADMIN shortcut.
    await f.db.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    const role = await f.db.rbacRole.create({
      data: { code: f.key('d4_role'), displayName: 'D4 explicit race fixture' },
    });
    for (const code of [
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.settlement-submit.record',
    ]) {
      const permission = await f.db.permission.upsert({
        where: { code },
        create: {
          code,
          module: 'activity',
          action: code.split('.')[1],
          resourceType: code.split('.')[2],
        },
        update: {},
      });
      await f.db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    bindingId = (
      await f.db.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: actor.id,
          roleId: role.id,
          scopeType: 'ORGANIZATION',
          scopeOrgId: f.organizationId,
        },
      })
    ).id;
  }, 120000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await closeD13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  // Deliberately explicit absent results, never infer absence from a missing result row.
  // Bulk fixture construction does not call or replace the command under measurement.
  async function fixture(population = 1) {
    const activity = await f.db.activity.create({
      data: {
        title: f.key('activity'),
        activityTypeCode: 'event_support',
        organizationId: f.organizationId,
        startAt: PAST,
        endAt: CLOSED,
        location: 'isolated fixture',
        statusCode: 'published',
      },
    });
    const session = await f.db.activitySession.create({
      data: {
        activityId: activity.id,
        code: f.key('session'),
        name: 'fixture',
        startAt: PAST,
        endAt: CLOSED,
        locationText: 'fixture',
        checkInOpenAt: PAST,
        checkInCloseAt: CLOSED,
        checkOutOpenAt: PAST,
        checkOutCloseAt: CLOSED,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const people = Array.from({ length: population }, () => ({
      memberId: randomUUID(),
      registrationId: randomUUID(),
      identityId: randomUUID(),
    }));
    await f.db.member.createMany({
      data: people.map((p) => ({
        id: p.memberId,
        memberNo: p.memberId,
        ...memberIdentityData('D4 capacity fixture'),
      })),
    });
    await f.db.activityRegistration.createMany({
      data: people.map((p) => ({
        id: p.registrationId,
        activityId: activity.id,
        memberId: p.memberId,
        statusCode: 'pass',
      })),
    });
    await f.db.activityParticipationIdentity.createMany({
      data: people.map((p) => ({
        id: p.identityId,
        activityId: activity.id,
        sessionId: session.id,
        registrationId: p.registrationId,
        memberId: p.memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      })),
    });
    const owner = await f.db.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: f.creator.memberId,
        responsibilityType: 'owner',
        canManageAttendance: true,
        canManageRegistrations: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });
    const seal = await f.db.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: CLOSED,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: population,
        populationCountBySession: { [session.id]: population },
        contentHash: 'a'.repeat(64),
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: PAST,
      },
    });
    const run = await f.db.attendanceSettlementRun.create({
      data: { activityId: activity.id, statusCode: 'drafting', currentDraftVersion: 1 },
    });
    const version = await f.db.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: 'b'.repeat(64),
        personCount: population,
        sessionParticipationCount: population,
        serviceSegmentCount: 0,
        createdByUserId: actor.id,
        statusCode: 'draft',
      },
    });
    await f.db.participantSettlementResultRevision.createMany({
      data: people.map((p) => ({
        settlementVersionId: version.id,
        participationIdentityId: p.identityId,
        revision: 1,
        resultCode: 'absent',
        lateFlag: false,
        earlyLeaveFlag: false,
        recognizedServiceHours: 0,
        recognizedContributionPoints: 0,
        calculatedServiceHours: 0,
        calculatedContributionPoints: 0,
        statusCode: 'draft',
      })),
    });
    const command = {
      operationKey: f.key('prepare'),
      expectedDraftVersion: 1,
      expectedEvidenceSealId: seal.id,
      expectedTimeRevision: 0,
    };
    return {
      activityId: activity.id,
      ownerId: owner.id,
      sealId: seal.id,
      runId: run.id,
      versionId: version.id,
      command,
    };
  }

  it('serializes same-key replay and different-key revision CAS; never produces half a revision', async () => {
    const p = await fixture();
    const results = await Promise.all([
      service.prepare(p.activityId, p.command, actor, meta),
      service.prepare(p.activityId, p.command, actor, meta),
    ]);
    expect(results[0]).toEqual(results[1]);
    const next = { ...p.command, expectedTimeRevision: 1 };
    const race = await Promise.allSettled([
      service.prepare(p.activityId, { ...next, operationKey: f.key('cas') }, actor, meta),
      service.prepare(p.activityId, { ...next, operationKey: f.key('cas') }, actor, meta),
    ]);
    expect(race.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const failure = race.find((row) => row.status === 'rejected');
    expect(failure?.status === 'rejected' ? (failure.reason as BizException).biz : null).toBe(
      BizCode.ACTIVITY_TIME_SETTLEMENT_STALE,
    );
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(2);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(2);
  });

  it.each(['user', 'member', 'permission', 'owner'] as const)(
    'rechecks %s after an actual Activity lock wait, including old receipt replay',
    async (kind) => {
      const p = await fixture();
      await service.prepare(p.activityId, p.command, actor, meta);
      let release!: () => void, held!: (pid: number) => void;
      const blockerReady = new Promise<number>((resolve) => {
        held = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${p.activityId} FOR UPDATE`;
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          held(row.pid);
          await hold;
        },
        { timeout: 15000 },
      );
      const pid = await blockerReady;
      const attempt = service.prepare(p.activityId, p.command, actor, meta).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      try {
        await waitFor(
          async () =>
            (
              await f.db.$queryRaw<
                { blocked: boolean }[]
              >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
            )[0].blocked,
          { timeoutMs: 5000, message: 'D4 did not reach the intended Activity lock' },
        );
        if (kind === 'user')
          await f.db.user.update({
            where: { id: actor.id },
            data: { status: UserStatus.DISABLED },
          });
        if (kind === 'member')
          await f.db.member.update({
            where: { id: f.creator.memberId },
            data: { status: MemberStatus.INACTIVE },
          });
        if (kind === 'permission')
          await f.db.roleBinding.update({
            where: { id: bindingId },
            data: { deletedAt: new Date() },
          });
        if (kind === 'owner')
          await f.db.activityResponsibilityAssignment.update({
            where: { id: p.ownerId },
            data: { status: 'ended', endedAt: new Date(), endedByUserId: actor.id },
          });
        release();
        await blocker;
        const result = await attempt;
        expect(result.value).toBeNull();
        expect(result.error).toBeInstanceOf(BizException);
        expect(
          await f.db.activitySettlementTimeCommandReceipt.count({
            where: { activityId: p.activityId },
          }),
        ).toBe(1);
      } finally {
        release();
        await blocker;
        await attempt;
        if (kind === 'user')
          await f.db.user.update({ where: { id: actor.id }, data: { status: UserStatus.ACTIVE } });
        if (kind === 'member')
          await f.db.member.update({
            where: { id: f.creator.memberId },
            data: { status: MemberStatus.ACTIVE },
          });
        if (kind === 'permission')
          await f.db.roleBinding.update({ where: { id: bindingId }, data: { deletedAt: null } });
      }
    },
    25000,
  );

  it('measures 1/100/2000 identities and reports all auth queries; query count cannot grow with population', async () => {
    const observed = new ObservedTimeSettlementDatabase({
      log: [{ emit: 'event', level: 'query' }],
    });
    let count = 0;
    observed.$on('query', (event) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(event.query)) count++;
    });
    try {
      await assertConnectedTestDatabase(observed);
      const access = f.app.get(ActivityTimeSettlementAccessService);
      const queries = new ActivityTimeSettlementQueryService(
        observed,
        access,
        f.app.get(ParticipationSegmentFacade),
      );
      const legacy = new SettlementSubmitService(
        observed,
        f.app.get(SettlementSubmitAuditRecorder),
        f.app.get(SettlementNotificationProducer),
        f.app.get(ActivityWorkflowGate),
      );
      const measured = new ActivityTimeSettlementService(
        observed,
        access,
        queries,
        f.app.get(ParticipationSegmentFacade),
        f.app.get(ActivityTimeAllocationService),
        legacy,
        f.app.get(ActivityTimeSettlementAuditRecorder),
        f.app.get(ActivityWorkflowGate),
      );
      const counts: {
        population: number;
        prepare: number;
        page: number;
        submit: number;
        legacySubmit: number;
        prepareMs: number;
      }[] = [];
      for (const population of [1, 100, 2000]) {
        const p = await fixture(population);
        count = 0;
        const started = performance.now();
        const prepared = await measured.prepare(p.activityId, p.command, actor, meta);
        const prepareMs = Math.round(performance.now() - started),
          prepareCount = count;
        expect(prepared.bucketCount).toBe(population * 4);
        expect(prepareMs).toBeLessThan(30000);
        count = 0;
        const page = await queries.buckets(
          p.activityId,
          prepared.timeRevisionId,
          { page: 1, pageSize: 20 },
          actor,
        );
        const pageCount = count;
        expect(page.total).toBe(population * 4);
        count = 0;
        await measured.submit(
          p.activityId,
          {
            operationKey: f.key('submit'),
            expectedDraftVersion: 1,
            expectedEvidenceSealId: p.sealId,
            timeRevisionId: prepared.timeRevisionId,
            expectedBucketContentHash: prepared.bucketContentHash,
          },
          actor,
          meta,
        );
        const submitCount = count;
        const old = await fixture(population);
        count = 0;
        await legacy.submit(
          {
            activityId: old.activityId,
            operationKey: f.key('legacy'),
            requestHash: 'c'.repeat(64),
            expectedDraftVersion: 1,
            expectedEvidenceSealId: old.sealId,
          },
          actor,
          meta,
        );
        counts.push({
          population,
          prepare: prepareCount,
          page: pageCount,
          submit: submitCount,
          legacySubmit: count,
          prepareMs,
        });
      }
      // Counts are actual engine events, including every current-identity/scope/owner read.
      console.info('D4 SQL measurements (all authorization included):', JSON.stringify(counts));
      expect(new Set(counts.map((row) => row.prepare)).size).toBe(1);
      expect(new Set(counts.map((row) => row.page)).size).toBe(1);
      expect(new Set(counts.map((row) => row.submit)).size).toBe(1);
      // Maintainer-approved D4 supplement: total Service SQL, including authorization.
      // Retain the population-invariance and 30-second checks above; never subtract auth.
      for (const row of counts) {
        expect(row.page).toBeGreaterThan(0);
        expect(row.page).toBeLessThanOrEqual(120);
        expect(row.prepare).toBeGreaterThan(0);
        expect(row.prepare).toBeLessThanOrEqual(400);
        expect(row.submit).toBeGreaterThan(0);
        expect(row.submit).toBeLessThanOrEqual(950);
        expect(row.legacySubmit).toBeGreaterThan(0);
      }
    } finally {
      await observed.$disconnect();
    }
  }, 120000);
});

import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { ActivitySettlementHttpService } from '../../src/modules/activities/activity-settlement-http.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';

// Review state, authorization, PostgreSQL serialization and effects now belong
// to settlement versions. Hard rejection/deletion is retired, not an alias for
// returning a version: returned facts remain available for resubmission.
interface PgWaiter {
  pid: number;
  databaseName: string;
  blockingPids: number[];
}

const LOCK_OBSERVE_TIMEOUT_MS = 4_000;
const OPERATION_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const BLOCKER_TIMEOUT_MS = 20_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleAllWithTimeout(promises: Promise<unknown>[], label: string): Promise<void> {
  const results = await withTimeout(Promise.allSettled(promises), label, CLEANUP_TIMEOUT_MS);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
}

async function waitForDirectPgWaiter(
  observer: PrismaService,
  directBlockerPid: number,
  operation: Promise<unknown>,
  queryPattern: string,
  excludedPids: number[] = [],
): Promise<PgWaiter> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + LOCK_OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (settled) throw new Error('settlement operation settled before expected lock wait');
    const rows = await withTimeout(
      observer.$queryRaw<PgWaiter[]>(Prisma.sql`
      SELECT pid, datname AS "databaseName", pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND CAST(${directBlockerPid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE ${queryPattern}
        AND NOT (pid = ANY(${excludedPids}::integer[]))
      LIMIT 1
    `),
      'settlement lock observer query',
      LOCK_OBSERVE_TIMEOUT_MS,
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`settlement direct waiter missing blocker=${directBlockerPid}`);
}

const AUDIT_META: AuditMeta = {
  requestId: 'attstate-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-state-transition',
};
type Draft = Awaited<ReturnType<typeof createSettlementDraftFixture>>;
type Fixture = Draft & { versionId: string };

describe('Native settlement state transitions (characterization)', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let reviews: ActivitySettlementHttpService;
  let reviewsB: ActivitySettlementHttpService;
  let submissions: SettlementSubmitService;
  let draftCommands: SettlementDraftService;
  let submitter: CurrentUserPayload;
  let reviewer: CurrentUserPayload;
  let finalReviewer: CurrentUserPayload;
  let finalAuth: string;
  let organizationId: string;
  let ownerId: string;
  let memberIds: string[];
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    reviews = app.get(ActivitySettlementHttpService);
    reviewsB = appB.get(ActivitySettlementHttpService);
    submissions = app.get(SettlementSubmitService);
    draftCommands = app.get(SettlementDraftService);
    const user = async (username: string, role: Role): Promise<CurrentUserPayload> => {
      const created = await createTestUser(app, { username, role });
      return { id: created.id, username, role, status: UserStatus.ACTIVE, memberId: null };
    };
    submitter = await user('att-state-submitter', Role.USER);
    reviewer = await user('att-state-reviewer', Role.ADMIN);
    finalReviewer = await user('att-state-final-reviewer', Role.SUPER_ADMIN);
    finalAuth = (await loginAs(app, finalReviewer.username)).authHeader;
    const role = await prisma.rbacRole.create({
      data: { code: 'state-native-first-review', displayName: '状态验收初审' },
    });
    const code = 'activity.settlement-first-review.record';
    const permission = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: 'activity',
        action: 'settlement-first-review',
        resourceType: 'record',
      },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: reviewer.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: 'State Root Org', nodeTypeCode: 'state-root' },
      })
    ).id;
    const member = async (memberNo: string) =>
      (
        await prisma.member.create({
          data: {
            memberNo,
            ...memberIdentityData(memberNo),
            status: 'ACTIVE',
            gradeCode: 'level-2',
          },
        })
      ).id;
    ownerId = await member('att-state-owner');
    memberIds = await Promise.all([1, 2, 3].map((index) => member(`att-state-member-${index}`)));
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    await settleAllWithTimeout([app.close(), appB.close()], 'settlement app shutdown');
  });

  // Each case owns an activity. Permanent versions/actions are never deleted to
  // reset a case; worker teardown reclaims the explicitly authorized test database.
  async function draft(points = [1]): Promise<Draft> {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId,
      participantMemberIds: memberIds.slice(0, points.length),
      ownerMemberId: ownerId,
      actorUserId: submitter.id,
      activityTypeCode: 'state-type',
    });
    for (const [index, identityId] of f.identityIds.entries()) {
      await draftCommands.updateItem(
        {
          activityId: f.activityId,
          participationIdentityId: identityId,
          expectedDraftVersion: 1,
          resultCode: 'present',
          recognizedServiceHours: 2,
          recognizedContributionPoints: points[index],
          reason: '状态验收人工认定',
        },
        submitter,
        AUDIT_META,
      );
    }
    return f;
  }

  const submit = (f: Draft) =>
    submissions.submit(
      {
        activityId: f.activityId,
        operationKey: `state-submit-${f.activityId}`,
        requestHash: `state-submit-hash-${f.activityId}`,
        expectedDraftVersion: 1,
        expectedEvidenceSealId: f.sealId,
      },
      submitter,
      AUDIT_META,
    );

  async function fixture(points = [1]): Promise<Fixture> {
    const f = await draft(points);
    return { ...f, versionId: (await submit(f)).settlementVersionId };
  }

  async function review(
    f: Fixture,
    stage: 'first' | 'final',
    action: 'approve' | 'return',
    service = reviews,
    note = 'state review note',
  ) {
    const v = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: f.versionId },
    });
    return service.review(
      f.versionId,
      stage,
      action,
      {
        operationKey: `state-${stage}-${action}-${f.versionId}`,
        note,
        expectation: {
          evidenceSealId: v.evidenceSealId,
          evidenceRevision: v.evidenceRevision,
          populationRevision: v.populationRevision,
          workflowRevision: v.workflowRevision,
          contentHash: v.contentHash,
        },
      },
      stage === 'first' ? reviewer : finalReviewer,
      AUDIT_META,
    );
  }

  const results = (f: Fixture) =>
    prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: f.versionId },
      orderBy: { id: 'asc' },
    });
  const actions = (f: Fixture, stage: 'first' | 'final') =>
    prisma.settlementReviewAction.findMany({
      where: { settlementVersionId: f.versionId, stageCode: stage },
    });
  const audits = (f: Draft, stage: 'first' | 'final') =>
    prisma.auditLog.findMany({
      where: {
        resourceId: f.activityId,
        event: 'activity.publish',
        context: {
          path: ['extra', 'operation'],
          equals: `settlement-${stage}-review`,
        },
      },
    });
  const intents = (f: Draft) =>
    prisma.notificationOutboxIntent.findMany({
      where: { aggregateId: f.activityId },
      orderBy: { id: 'asc' },
    });
  async function snapshot(f: Draft) {
    return {
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }),
      versions: await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { version: 'asc' },
        include: {
          resultRevisions: { orderBy: { id: 'asc' } },
          reviewActions: true,
          postingBatches: true,
        },
      }),
      audits: await prisma.auditLog.findMany({
        where: { resourceId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      intents: await intents(f),
    };
  }

  function legacyHistory(f: Draft, statusCode: 'pending' | 'pending_final_review') {
    return prisma.attendanceSheet.create({
      data: {
        activityId: f.activityId,
        submitterUserId: submitter.id,
        statusCode,
        reviewerUserId: statusCode === 'pending_final_review' ? reviewer.id : null,
        records: {
          create: memberIds.slice(0, 2).map((memberId) => ({
            memberId,
            roleCode: 'member',
            attendanceStatusCode: 'present',
            checkInAt: new Date('2020-03-01T00:00:00Z'),
            checkOutAt: new Date('2020-03-01T02:00:00Z'),
            serviceHours: 2,
            contributionPoints: 1,
          })),
        },
      },
      include: { records: { orderBy: { id: 'asc' } } },
    });
  }

  async function runPrimaryReviewLinearization(
    firstAction: 'approve' | 'return',
    secondAction: 'approve' | 'return',
  ) {
    const f = await fixture();
    const beforeResults = await results(f);
    const identities = await Promise.all(
      [prisma, prismaB].map(
        async (client) =>
          (
            await client.$queryRaw<Array<{ pid: number; databaseName: string }>>`
        SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
      `
          )[0],
      ),
    );
    expect(identities[0].databaseName).toBe(identities[1].databaseName);
    expect(identities[0].pid).not.toBe(identities[1].pid);
    const notificationsBefore = await prisma.notification.count();
    const intentsBefore = await intents(f);
    const rootReached = deferred(),
      mutateRoot = deferred(),
      rootMutated = deferred(),
      releaseRoot = deferred();
    const lockedTitle = `locked-title-${f.activityId}`;
    let root!: { pid: number; databaseName: string };
    const blocker = prisma.$transaction(
      async (tx) => {
        root = (
          await tx.$queryRaw<Array<{ pid: number; databaseName: string }>>`
        SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
        FROM "Activity" WHERE id=${f.activityId} FOR UPDATE
      `
        )[0];
        rootReached.resolve();
        await mutateRoot.promise;
        await tx.activity.update({ where: { id: f.activityId }, data: { title: lockedTitle } });
        rootMutated.resolve();
        await releaseRoot.promise;
      },
      { timeout: BLOCKER_TIMEOUT_MS },
    );
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    let primaryFailure: unknown, cleanupFailure: unknown;
    try {
      await withTimeout(rootReached.promise, 'settlement root blocker', BLOCKER_TIMEOUT_MS);
      first = review(f, 'first', firstAction);
      const firstWaiter = await waitForDirectPgWaiter(
        prismaB,
        root.pid,
        first,
        '%FROM "Activity"%FOR UPDATE%',
      );
      expect(firstWaiter.databaseName).toBe(root.databaseName);
      expect(firstWaiter.blockingPids).toContain(root.pid);
      mutateRoot.resolve();
      await withTimeout(rootMutated.promise, 'settlement root mutation', OPERATION_TIMEOUT_MS);
      second = review(f, 'first', secondAction, reviewsB);
      const secondWaiter = await waitForDirectPgWaiter(
        prisma,
        firstWaiter.pid,
        second,
        '%FROM "Activity"%FOR UPDATE%',
        [root.pid, firstWaiter.pid],
      );
      expect(secondWaiter.databaseName).toBe(root.databaseName);
      expect(secondWaiter.pid).not.toBe(firstWaiter.pid);
      expect(secondWaiter.blockingPids).toContain(firstWaiter.pid);
      releaseRoot.resolve();
      const settled = await withTimeout(
        Promise.allSettled([first, second]),
        'settlement competing reviews',
        OPERATION_TIMEOUT_MS,
      );
      if (settled[0].status === 'rejected') throw settled[0].reason;
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1]).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED },
      });
      expect(JSON.stringify(settled[1])).not.toContain('40P01');
      const state = await snapshot(f);
      expect(state.run.statusCode).toBe(
        firstAction === 'approve' ? 'pending_final_review' : 'drafting',
      );
      expect(state.versions.find((v) => v.id === f.versionId)?.statusCode).toBe(
        firstAction === 'approve' ? 'submitted' : 'returned',
      );
      expect(await results(f)).toEqual(beforeResults);
      expect(await actions(f, 'first')).toHaveLength(1);
      expect(await audits(f, 'first')).toHaveLength(1);
      const afterIntents = await intents(f);
      expect(afterIntents).toHaveLength(intentsBefore.length + 1);
      const notification = afterIntents.find(
        (row) => row.eventKey === `settlement-review:${f.versionId}:first`,
      );
      // Mutable metadata must be reread after waiting, just like the prior
      // Sheet-version witness. Immutable settlement headers are never rewritten.
      expect(notification?.payload).toMatchObject({ body: expect.stringContaining(lockedTitle) });
      expect(await prisma.notification.count()).toBe(notificationsBefore);
    } catch (error) {
      primaryFailure = error;
    } finally {
      mutateRoot.resolve();
      releaseRoot.resolve();
      try {
        await settleAllWithTimeout(
          [
            blocker,
            ...(first ? [first.catch(() => undefined)] : []),
            ...(second ? [second.catch(() => undefined)] : []),
          ],
          'settlement linearization cleanup',
        );
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (primaryFailure !== undefined) {
      if (primaryFailure instanceof Error) {
        if (cleanupFailure !== undefined)
          Object.defineProperty(primaryFailure, 'cause', {
            value: cleanupFailure,
            configurable: true,
          });
        throw primaryFailure;
      }
      throw new Error('non-Error test failure', { cause: primaryFailure });
    }
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    if (cleanupFailure !== undefined)
      throw new Error('non-Error cleanup failure', { cause: cleanupFailure });
  }

  it('approve-first: Activity root → approve waiter → return soft waiter', async () => {
    await runPrimaryReviewLinearization('approve', 'return');
  });
  it('return-first: Activity root → return waiter → approve soft waiter', async () => {
    await runPrimaryReviewLinearization('return', 'approve');
  });

  it('first approval advances state, retains results and records reviewer/time/note/audit', async () => {
    const f = await fixture([1, 2]);
    const before = await results(f);
    expect((await review(f, 'first', 'approve')).runStatusAfter).toBe('pending_final_review');
    const recorded = await actions(f, 'first');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorUserId: reviewer.id,
      actedAt: expect.any(Date),
      note: 'state review note',
    });
    expect(await actions(f, 'final')).toHaveLength(0);
    expect(await results(f)).toEqual(before);
    const logged = await audits(f, 'first');
    expect(logged).toHaveLength(1);
    expect(logged[0].context).toMatchObject({
      extra: { actionCode: 'approve', runStatusAfter: 'pending_final_review' },
    });
  });

  it('unrecognized contribution results cannot enter review: submission fails without writes', async () => {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId,
      participantMemberIds: memberIds.slice(0, 2),
      ownerMemberId: ownerId,
      actorUserId: submitter.id,
      activityTypeCode: 'state-type',
      missingResult: true,
    });
    // New numeric fields are NOT NULL. Unknown is an unresolved result, not a
    // fabricated zero; its guard runs before an immutable review version exists.
    await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: f.draftId,
        participationIdentityId: f.identityIds[0],
        revision: 0,
        resultCode: 'present',
        lateFlag: false,
        earlyLeaveFlag: false,
        recognizedServiceHours: 2,
        calculatedServiceHours: 2,
        recognizedContributionPoints: 1,
        calculatedContributionPoints: 1,
        statusCode: 'draft',
      },
    });
    const before = await snapshot(f);
    await expect(submit(f)).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it('concurrent retired deletion requests cannot delete versions, results or audit history', async () => {
    const f = await fixture([1, 2]);
    const history = await legacyHistory(f, 'pending');
    const before = await snapshot(f);
    const responses = await Promise.all(
      [app, appB].map((instance) =>
        request(httpServer(instance))
          .delete(`/api/admin/v1/attendance-sheets/${history.id}`)
          .set('Authorization', finalAuth),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    expect(await snapshot(f)).toEqual(before);
    expect(
      await prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: history.id },
        include: { records: { orderBy: { id: 'asc' } } },
      }),
    ).toEqual(history);
  });

  it.each(['drafting', 'pending_final_review', 'posting', 'posted'])(
    'first approval rejects run=%s without writes',
    async (statusCode) => {
      const f = await fixture();
      await prisma.attendanceSettlementRun.update({ where: { id: f.runId }, data: { statusCode } });
      const before = await snapshot(f);
      await expect(review(f, 'first', 'approve')).rejects.toMatchObject({
        biz: BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
      });
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('final approval retains results, records final audit and prepares exactly one batch without premature credit', async () => {
    const f = await fixture([1, 2]);
    await review(f, 'first', 'approve');
    const before = await results(f);
    const approved = await review(f, 'final', 'approve');
    expect(approved).toMatchObject({
      runStatusAfter: 'posting',
      versionStatusAfter: 'approved',
      ledgerPostingBatchStatus: 'preparing',
    });
    const recorded = await actions(f, 'final');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorUserId: finalReviewer.id,
      actedAt: expect.any(Date),
      note: 'state review note',
    });
    expect(await results(f)).toEqual(before);
    const batches = await prisma.ledgerPostingBatch.findMany({
      where: { settlementVersionId: f.versionId },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ statusCode: 'preparing', totalCount: 2 });
    expect(
      await prisma.participationLedgerEntry.count({ where: { postingBatchId: batches[0].id } }),
    ).toBe(0);
    const logged = await audits(f, 'final');
    expect(logged).toHaveLength(1);
    expect(logged[0].context).toMatchObject({
      extra: {
        actionCode: 'approve',
        runStatusAfter: 'posting',
        ledgerPostingBatchStatus: 'preparing',
      },
    });
  });

  it('final approve versus return has one winner; the loser cannot alter results or create another batch', async () => {
    const f = await fixture([2]);
    await review(f, 'first', 'approve');
    const before = await results(f);
    const settled = await Promise.allSettled([
      review(f, 'final', 'approve'),
      review(f, 'final', 'return', reviewsB),
    ]);
    expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((row) => row.status === 'rejected');
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: { biz: BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED },
    });
    expect(JSON.stringify(loser)).not.toContain('40P01');
    expect(await results(f)).toEqual(before);
    const decision = await actions(f, 'final');
    expect(decision).toHaveLength(1);
    const batches = await prisma.ledgerPostingBatch.findMany({
      where: { settlementVersionId: f.versionId },
    });
    expect(batches).toHaveLength(decision[0].actionCode === 'approve' ? 1 : 0);
    if (batches[0]) expect(batches[0].statusCode).toBe('preparing');
    expect(await audits(f, 'final')).toHaveLength(1);
  });

  for (const action of ['approve', 'return'] as const) {
    it.each(['drafting', 'pending_first_review', 'posting', 'posted'])(
      `final ${action} rejects run=%s without writes`,
      async (statusCode) => {
        const f = await fixture();
        await review(f, 'first', 'approve');
        await prisma.attendanceSettlementRun.update({
          where: { id: f.runId },
          data: { statusCode },
        });
        const before = await snapshot(f);
        await expect(review(f, 'final', action)).rejects.toMatchObject({
          biz: BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
        });
        expect(await snapshot(f)).toEqual(before);
      },
    );
  }

  it('final return retains all three results and the actor/reason/audit; old hard rejection remains unavailable', async () => {
    const f = await fixture([1, 2, 3]);
    await review(f, 'first', 'approve');
    const before = await results(f);
    expect(before).toHaveLength(3);
    expect((await review(f, 'final', 'return')).versionStatusAfter).toBe('returned');
    const v = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: f.versionId },
    });
    expect(v).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'final',
      returnReason: 'state review note',
    });
    expect(await results(f)).toEqual(before);
    const recorded = await actions(f, 'final');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorUserId: finalReviewer.id,
      actedAt: expect.any(Date),
      note: 'state review note',
    });
    const logged = await audits(f, 'final');
    expect(logged).toHaveLength(1);
    expect(logged[0].context).toMatchObject({
      extra: { actionCode: 'return', versionStatusAfter: 'returned' },
    });
    expect(
      await prisma.ledgerPostingBatch.count({ where: { settlementVersionId: f.versionId } }),
    ).toBe(0);
    const history = await legacyHistory(f, 'pending_final_review');
    const returned = await snapshot(f);
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${history.id}/final-reject`)
      .set('Authorization', finalAuth)
      .send({ finalReviewNote: 'old hard rejection' })
      .expect(404);
    expect(await snapshot(f)).toEqual(returned);
    expect(
      await prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: history.id },
        include: { records: { orderBy: { id: 'asc' } } },
      }),
    ).toEqual(history);
  });

  it('blank final return reason is rejected without changing review fields, results or effects', async () => {
    const f = await fixture();
    await review(f, 'first', 'approve');
    const before = await snapshot(f);
    await expect(review(f, 'final', 'return', reviews, '   ')).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED,
    });
    expect(await snapshot(f)).toEqual(before);
  });
});

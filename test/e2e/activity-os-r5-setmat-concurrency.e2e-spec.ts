import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import {
  R5SetmatBarrier,
  withR5PausedWriter,
  getR5SetmatFixtureFactory,
  type R5ObservedAttempt,
  type R5SetmatFixture,
} from '../helpers/r5-setmat-concurrency-barrier';

/** Source: handoff 63711eb714713f208729065aaff57de2800b968a + 17 paths.
 * The materialize service patch is UNAPPLIED there; the SQL is uninstalled.
 * Default: pure scheduling tests + explicit NOT_RUN database cases.
 *
 * Owner integration: in an authorized Jest setupFilesAfterEnv, call
 * installR5SetmatFixtureFactory with the helper's test-layer adapter. No env
 * switch silently starts a DB test, installs SQL or grants any permission.
 * Do not run the standard e2e globalSetup merely to run these pure cases:
 * it creates/migrates databases. Use a standalone Jest config without setup.
 *
 * Actual seams: beginCorrectionWritePhase's existing exported function, then
 * CorrectionPendingTimeAllocationEvidence.create's completed INSERT. Both
 * wrappers call the originals. An INSERT return is after all BEFORE guards,
 * before callback return/COMMIT; it is not an invented in-trigger test hook.
 * Current require_open_phase also binds xid + DB role, so T2 may be rejected
 * before this pause. Record that branch separately, never claim it exercised
 * the late-commit window. Missing integration/observation => NOT_RUN, not PASS.
 */

function assertSameEvidenceSet(source: readonly string[], materialized: readonly string[]): void {
  // Keep multiplicity: Set/unique would hide an extra duplicated child.
  assert.deepEqual([...materialized].sort(), [...source].sort());
}

describe('R5 setmat pure barrier/model only (NO DATABASE)', () => {
  it('holds T2 until T1 has validated, materialized, sealed and completed', async () => {
    const order: string[] = [];
    const result = await withR5PausedWriter(
      async (barrier) => {
        order.push('T2 guard OPEN / inserted');
        await barrier.arrive();
        order.push('T2 commit');
      },
      async () => {
        order.push('T1 validate', 'T1 materialize', 'T1 seal', 'T1 commit');
      },
    );
    expect(result.arrival).toBe('arrived');
    expect(order).toEqual([
      'T2 guard OPEN / inserted',
      'T1 validate',
      'T1 materialize',
      'T1 seal',
      'T1 commit',
      'T2 commit',
    ]);
  });

  it('detects the unsafe model where both commit and the late child is absent', async () => {
    const source = ['existing'];
    let materialized: string[] = [];
    await withR5PausedWriter(
      async (barrier) => {
        await barrier.arrive();
        source.push('late');
      },
      async () => {
        materialized = [...source];
      },
    );
    expect(() => assertSameEvidenceSet(source, materialized)).toThrow();
  });

  it('accepts the model where a writer commits before validation includes it', () => {
    const source = ['existing'];
    source.push('early');
    assertSameEvidenceSet(source, [...source]);
  });

  it('does not lose duplicate rows in the set assertion', () => {
    expect(() => assertSameEvidenceSet(['row', 'row'], ['row'])).toThrow();
  });

  it('distinguishes an early guard rejection from reaching the pause', async () => {
    const result = await withR5PausedWriter(
      async () => 'model guard rejection',
      async () => 'model T1 commit',
    );
    expect(result).toEqual({
      arrival: 'completed',
      t1: 'model T1 commit',
      t2: 'model guard rejection',
    });
  });

  it('drains T2 when T1 fails, without letting the paused writer commit', async () => {
    const failure = new Error('model T1 failure');
    let drained = false;
    let committed = false;
    await expect(
      withR5PausedWriter(
        async (barrier) => {
          try {
            await barrier.arrive();
            committed = true;
          } finally {
            drained = true;
          }
        },
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect({ drained, committed }).toEqual({ drained: true, committed: false });
  });

  it('propagates an observer/fixture failure before arrival without running T1', async () => {
    const failure = new Error('model observation unavailable');
    const finish = jest.fn();
    await expect(withR5PausedWriter(() => Promise.reject(failure), finish)).rejects.toBe(failure);
    expect(finish).not.toHaveBeenCalled();
  });

  it('propagates a writer failure after release and drains it', async () => {
    const failure = new Error('model writer failure');
    await expect(
      withR5PausedWriter(
        async (barrier) => {
          await barrier.arrive();
          throw failure;
        },
        async () => undefined,
      ),
    ).rejects.toBe(failure);
  });

  it('rejects release before arrival and duplicate arrival', async () => {
    const barrier = new R5SetmatBarrier<void>();
    expect(() => barrier.open()).toThrow('without an arrival');
    const first = barrier.arrive();
    await expect(barrier.arrive()).rejects.toThrow('more than once');
    barrier.open();
    await first;
  });

  it('cancels a barrier even when no writer ever arrives', async () => {
    const barrier = new R5SetmatBarrier<void>();
    const failure = new Error('model setup failure');
    barrier.abort(failure);
    await expect(barrier.wait()).rejects.toBe(failure);
    await expect(barrier.arrive()).rejects.toBe(failure);
  });
});

interface SessionIdentity {
  database: string;
  role: string;
  pid: number;
  xid: string;
}

async function sessionIdentity(tx: Prisma.TransactionClient): Promise<SessionIdentity> {
  const rows = await tx.$queryRaw<SessionIdentity[]>`
    SELECT current_database()::text AS database, current_user::text AS role,
           pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid
  `;
  assert.equal(rows.length, 1);
  return rows[0];
}

interface HttpReply {
  status: number;
  code: number;
}

function confirmed<T>(attempt: R5ObservedAttempt<T>): void {
  expect(attempt.evidenceRef.length).toBeGreaterThan(0);
  expect(attempt.observationComplete).toBe(true);
  expect(['COMMITTED', 'ROLLED_BACK']).toContain(attempt.databaseOutcome);
}

function committed(attempt: R5ObservedAttempt<HttpReply>): void {
  confirmed(attempt);
  expect(attempt.configuredTimeoutMs).toBe(15_000);
  expect(attempt.configuredIsolationLevel).toBe('ReadCommitted');
  expect(attempt.databaseOutcome).toBe('COMMITTED');
  expect(attempt.client).toEqual({ status: 'fulfilled', value: { status: 200, code: 0 } });
}

async function readProjection(f: R5SetmatFixture) {
  const appId = f.command.correctionApplicationId;
  type EvidenceRow = { pendingId: string; attachmentId: string; ordinal: number };
  // Fresh observer session, whole application, no late-row-only/count-only read.
  const source = await f.observerDb.$queryRaw<EvidenceRow[]>`
    SELECT p.id AS "pendingId", e."attachmentId", e.ordinal
    FROM "CorrectionPendingTimeAllocation" p
    JOIN "CorrectionPendingTimeAllocationEvidence" e ON e."pendingAllocationId" = p.id
    WHERE p."applicationId" = ${appId}
  `;
  const materialized = await f.observerDb.$queryRaw<EvidenceRow[]>`
    SELECT p.id AS "pendingId", e."attachmentId", e.ordinal
    FROM "CorrectionPendingTimeAllocation" p
    JOIN "ParticipantTimeAllocationEvidence" e
      ON e."allocationRevisionId" = p."targetAllocationRevisionId"
    WHERE p."applicationId" = ${appId}
  `;
  const phases = await f.observerDb.$queryRaw<
    { state: string; actor: string | null; materializedAt: Date | null }[]
  >`
    SELECT state, "materializedByUserId" AS actor, "materializedAt"
    FROM "CorrectionWritePhase" WHERE "applicationId" = ${appId} AND phase = 'commit'
  `;
  const segments = await f.observerDb.$queryRaw<
    { pendingId: string; oldStatus: string; newStatus: string | null; actor: string | null }[]
  >`
    SELECT p.id AS "pendingId", old."statusCode" AS "oldStatus",
           target."statusCode" AS "newStatus", allocation."createdByUserId" AS actor
    FROM "CorrectionPendingTimeAllocation" p
    JOIN "CorrectionPendingSegmentRevision" pending ON pending.id = p."pendingSegmentId"
    JOIN "ParticipantServiceSegmentRevision" old ON old.id = pending."baseRevisionId"
    LEFT JOIN "ParticipantServiceSegmentRevision" target ON target.id = p."targetSegmentRevisionId"
    LEFT JOIN "ParticipantTimeAllocationRevision" allocation ON allocation.id = p."targetAllocationRevisionId"
    WHERE p."applicationId" = ${appId} ORDER BY p.id
  `;
  const key = (r: EvidenceRow) => JSON.stringify([r.pendingId, r.attachmentId, r.ordinal]);
  return {
    source: source.map(key).sort(),
    materialized: materialized.map(key).sort(),
    phases,
    segments,
  };
}

async function assertMaterialized(f: R5SetmatFixture): Promise<void> {
  const projection = await readProjection(f);
  expect(projection.phases).toEqual([
    { state: 'SEALED', actor: f.b.id, materializedAt: expect.any(Date) },
  ]);
  expect(projection.source.length).toBeGreaterThan(0);
  assertSameEvidenceSet(projection.source, projection.materialized);
  expect(projection.segments.length).toBeGreaterThan(0);
  for (const segment of projection.segments) {
    expect(segment).toMatchObject({
      oldStatus: 'superseded',
      newStatus: 'committed',
      actor: f.b.id,
    });
  }
}

const databaseCases = [
  'T2 phase-child write cannot commit late outside the materialized set',
  'authorized B commits a legitimate nonempty set',
  'authenticated A without permission cannot commit',
  'authenticated A cannot borrow B via actorUserId in the request',
  'authenticated A cannot borrow B via materializedByUserId in the request',
  'B then A on the same physical connection does not retain B authority',
] as const;

const factory = getR5SetmatFixtureFactory();
describe('R5 setmat real PostgreSQL and real HTTP authentication', () => {
  if (!factory) {
    for (const title of databaseCases) {
      it.todo(
        `NOT_RUN: ${title} (integrated candidate, owned fixture and outcome adapter required)`,
      );
    }
    return;
  }

  let f: R5SetmatFixture;
  let ownedFixture: R5SetmatFixture | undefined;
  let aAuth: string;
  let bAuth: string;
  const authTrace: (SessionIdentity & { userId: string })[] = [];
  let safetyFailed = false;
  const realCase = (title: string, work: () => Promise<void>) => {
    it(title, async () => {
      try {
        await work();
      } catch (error) {
        safetyFailed = true;
        throw error;
      }
    });
  };

  beforeEach(async () => {
    assert(!safetyFailed, 'prior safety failure stops new fixture writes');
    ownedFixture = undefined;
    f = await factory();
    ownedFixture = f;
    await f.verifyCandidate();
    expect(f.a.id).not.toBe(f.b.id);
    const { loginAs } = await import('../fixtures/auth.fixture');
    aAuth = (await loginAs(f.app, f.a.username)).authHeader;
    bAuth = (await loginAs(f.app, f.b.username)).authHeader;
    authTrace.length = 0;
    const { ActivityTimeCorrectionAccessService } =
      await import('../../src/modules/activities/activity-time-correction-access.service');
    const access = f.app.get(ActivityTimeCorrectionAccessService);
    const authorize = access.authorizeCommit.bind(access);
    jest.spyOn(access, 'authorizeCommit').mockImplementation(async (tx, user, ...rest) => {
      authTrace.push({ ...(await sessionIdentity(tx)), userId: user.id });
      return await authorize(tx, user, ...rest);
    });
  }, 120000);

  afterEach(async () => {
    jest.restoreAllMocks();
    const owned = ownedFixture;
    ownedFixture = undefined;
    if (!owned) return;
    owned.restoreObservation();
    // Preserve DB evidence. Only close this case's owned clients/application.
    const closed = await Promise.allSettled([
      owned.app.close(),
      owned.callerDb.$disconnect(),
      owned.observerDb.$disconnect(),
    ]);
    expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  async function post(auth: string, extra: Record<string, string> = {}): Promise<HttpReply> {
    const { default: request } = await import('supertest');
    const { httpServer } = await import('../helpers/http-server');
    const response = await request(httpServer(f.app))
      .post(
        `/api/app/v1/my/managed-activities/${f.activityId}/time-corrections/${f.requestId}/commit`,
      )
      .set('Authorization', auth)
      .send({ ...f.command, ...extra });
    const code: unknown = response.body.code;
    assert.equal(typeof code, 'number', 'HTTP response must use the existing BizCode envelope');
    if (typeof code !== 'number') throw new Error('Missing numeric BizCode');
    return { status: response.status, code };
  }

  realCase(databaseCases[0], async () => {
    const phase = await import('../../src/modules/activities/correction-write-phase');
    const { runMemberLinearizedTransaction } =
      await import('../../src/common/prisma/member-advisory-lock.util');
    const begin = phase.beginCorrectionWritePhase;
    const open = new R5SetmatBarrier<SessionIdentity>();
    const before = await readProjection(f);
    expect(before.source.length).toBeGreaterThan(0);
    expect(before.phases).toEqual([]);
    expect(f.lateEvidence.activityId).toBe(f.activityId);
    expect(
      await f.observerDb.correctionPendingTimeAllocation.findUniqueOrThrow({
        where: { id: f.lateEvidence.pendingAllocationId },
        select: { applicationId: true, activityId: true },
      }),
    ).toEqual({ applicationId: f.command.correctionApplicationId, activityId: f.activityId });
    expect(
      await f.observerDb.attachment.count({
        where: {
          id: f.lateEvidence.attachmentId,
          ownerType: 'activity',
          ownerId: f.activityId,
        },
      }),
    ).toBe(1);
    expect(
      await f.observerDb.correctionPendingTimeAllocationEvidence.count({
        where: {
          pendingAllocationId: f.lateEvidence.pendingAllocationId,
          OR: [{ attachmentId: f.lateEvidence.attachmentId }, { ordinal: f.lateEvidence.ordinal }],
        },
      }),
    ).toBe(0);
    expect(
      await f.observerDb.correctionPendingTimeAllocationEvidence.count({
        where: { id: f.lateEvidence.id },
      }),
    ).toBe(0);
    jest.spyOn(phase, 'beginCorrectionWritePhase').mockImplementation(async (tx, appId, name) => {
      await begin(tx, appId, name);
      if (appId === f.command.correctionApplicationId && name === 'commit') {
        await open.arrive(await sessionIdentity(tx));
      }
    });
    const t1 = f.observe('T1 authenticated B commit', () => post(bAuth));
    try {
      expect(await open.arrivalOrCompletion(t1)).toBe('arrived');
      const first = await open.wait();
      let second: SessionIdentity | undefined;
      const result = await withR5PausedWriter(
        (barrier) =>
          f.observe('T2 ordinary caller child INSERT', () =>
            runMemberLinearizedTransaction(f.callerDb, async (tx) => {
              second = await sessionIdentity(tx);
              const inserted = await tx.$executeRaw`
                INSERT INTO public."CorrectionPendingTimeAllocationEvidence"
                  (id,"pendingAllocationId","activityId","attachmentId",ordinal)
                VALUES (${f.lateEvidence.id},${f.lateEvidence.pendingAllocationId},
                  ${f.lateEvidence.activityId},${f.lateEvidence.attachmentId},${f.lateEvidence.ordinal})
              `;
              expect(inserted).toBe(1);
              // SQL completed with all original BEFORE guards enabled. Hold
              // the actual transaction before its callback returns/COMMIT.
              await barrier.arrive();
            }),
          ),
        async () => {
          open.open();
          return await t1; // includes separate final-outcome observation
        },
      );
      confirmed(result.t1);
      confirmed(result.t2);
      expect(result.t2.configuredTimeoutMs).toBe(7_000);
      expect(result.t2.configuredIsolationLevel).toBe('ReadCommitted');
      expect(second).toBeDefined();
      expect(second?.database).toBe(first.database);
      expect(second?.role).toBe(first.role);
      expect(second?.pid).not.toBe(first.pid);
      expect(second?.xid).not.toBe(first.xid);
      if (result.arrival === 'completed') {
        // A generic FK/fixture error, timeout or Promise rejection cannot
        // stand in for the candidate's specific OPEN/transaction guard.
        expect(result.t2.databaseOutcome).toBe('ROLLED_BACK');
        expect(result.t2.client.status).toBe('rejected');
        expect(result.t2.serverError?.sqlState).toBe('23514');
        assert.equal(
          result.t2.serverError?.message === 'write requires this transaction and actor open phase',
          true,
          'T2 must be rejected by the actual OPEN-phase guard',
        );
        f.recordCoverage('T2_OPEN_GUARD_REJECTED');
        committed(result.t1);
      } else {
        f.recordCoverage('T2_AFTER_GUARD_PAUSED');
        // In this schedule T2 is released only AFTER T1's final observation.
        // Both committing is therefore forbidden, even if a count matches.
        const t1Rejected =
          result.t1.databaseOutcome === 'ROLLED_BACK' &&
          (result.t1.client.status === 'rejected' || result.t1.client.value.status >= 400);
        const t2Rejected =
          result.t2.databaseOutcome === 'ROLLED_BACK' && result.t2.client.status === 'rejected';
        expect(t1Rejected || t2Rejected).toBe(true);
      }
      if (result.t1.databaseOutcome === 'COMMITTED') {
        await assertMaterialized(f);
      } else {
        const after = await readProjection(f);
        expect(after.phases).toEqual(before.phases);
        expect(after.segments).toEqual(before.segments);
        expect(after.materialized).toEqual(before.materialized);
      }
      if (result.t2.databaseOutcome === 'ROLLED_BACK') {
        expect((await readProjection(f)).source).toEqual(before.source);
        expect(
          await f.observerDb.correctionPendingTimeAllocationEvidence.count({
            where: { id: f.lateEvidence.id },
          }),
        ).toBe(0);
      }
    } finally {
      open.abort();
      await Promise.allSettled([t1]);
    }
  });

  realCase(databaseCases[1], async () => {
    committed(await f.observe('positive B commit', () => post(bAuth)));
    await assertMaterialized(f);
    expect(authTrace.length).toBeGreaterThan(0);
    expect(authTrace.every((row) => row.userId === f.b.id)).toBe(true);
  });

  realCase(databaseCases[2], async () => {
    const { BizCode } = await import('../../src/common/exceptions/biz-code.constant');
    const before = await f.snapshotBusinessState();
    const result = await f.observe('unauthorized A commit', () => post(aAuth));
    confirmed(result);
    expect(result.databaseOutcome).toBe('ROLLED_BACK');
    expect(result.client).toEqual({
      status: 'fulfilled',
      value: { status: BizCode.RBAC_FORBIDDEN.httpStatus, code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(authTrace.length).toBeGreaterThan(0);
    expect(authTrace.every((row) => row.userId === f.a.id)).toBe(true);
    expect(await f.snapshotBusinessState()).toEqual(before);
  });

  for (const [index, field] of ['actorUserId', 'materializedByUserId'].entries()) {
    realCase(databaseCases[index + 3], async () => {
      const { BizCode } = await import('../../src/common/exceptions/biz-code.constant');
      const before = await f.snapshotBusinessState();
      const attempt = await f.observe('spoofed ' + field, () => post(aAuth, { [field]: f.b.id }));
      expect(attempt.observationComplete).toBe(true);
      expect(['NO_TRANSACTION', 'ROLLED_BACK']).toContain(attempt.databaseOutcome);
      expect(attempt.client.status).toBe('fulfilled');
      assert(attempt.client.status === 'fulfilled');
      const response = attempt.client.value;
      // The real DTO has neither field. Rejecting extra fields or ignoring
      // them and denying A are safe; no fabricated actor-taking HTTP endpoint.
      expect([
        { status: BizCode.BAD_REQUEST.httpStatus, code: BizCode.BAD_REQUEST.code },
        { status: BizCode.RBAC_FORBIDDEN.httpStatus, code: BizCode.RBAC_FORBIDDEN.code },
      ]).toContainEqual(response);
      expect(authTrace.every((row) => row.userId === f.a.id)).toBe(true);
      expect(await f.snapshotBusinessState()).toEqual(before);
    });
  }

  realCase(databaseCases[5], async () => {
    const { BizCode } = await import('../../src/common/exceptions/biz-code.constant');
    committed(await f.observe('B warms caller connection', () => post(bAuth)));
    await assertMaterialized(f);
    const before = await f.snapshotBusinessState();
    const bSession = authTrace.at(-1);
    expect(bSession?.userId).toBe(f.b.id);
    authTrace.length = 0;
    const denied = await f.observe('A replay on reused connection', () => post(aAuth));
    confirmed(denied);
    expect(denied.databaseOutcome).toBe('ROLLED_BACK');
    expect(denied.client).toEqual({
      status: 'fulfilled',
      value: { status: BizCode.RBAC_FORBIDDEN.httpStatus, code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(authTrace.length).toBeGreaterThan(0);
    for (const row of authTrace) {
      expect(row.userId).toBe(f.a.id);
      expect(row.database).toBe(bSession?.database);
      expect(row.role).toBe(bSession?.role);
      expect(row.pid).toBe(bSession?.pid); // another pool connection cannot pass
      expect(row.xid).not.toBe(bSession?.xid);
    }
    expect(await f.snapshotBusinessState()).toEqual(before);
  });
});

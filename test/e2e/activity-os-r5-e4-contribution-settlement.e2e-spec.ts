import { PrismaClient, Prisma, MemberStatus, BindingStatus, PrincipalType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import request from 'supertest';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  postE4Ledger,
  E13_ADMIN,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { PrismaService } from '../../src/database/prisma.service';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { ActivityContributionSettlementQueryService } from '../../src/modules/activities/activity-contribution-settlement-query.service';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import {
  TIME_SETTLEMENT_PREPARE_OPERATION,
  timeSettlementPrepareRequestHash,
} from '../../src/modules/activities/activity-time-settlement-command';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { httpServer } from '../helpers/http-server';
import {
  SettlementReviewService,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import { SettlementNotificationProducer } from '../../src/modules/activities/settlement-notification-producer';
import { SettlementReviewAuditRecorder } from '../../src/modules/activities/settlement-review-audit-recorder';

function fixedE4RootAggregateSql(revisionId: string, sourceKindCode: string) {
  const oracleSource = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const fixed = [
    ...oracleSource.matchAll(/const E4_P_ROOT_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(fixed).toHaveLength(1);
  const oldAggregate = fixed[0][1];
  expect(createHash('sha256').update(oldAggregate).digest('hex')).toBe(
    'be771b78933b36e6d47e8fe81aa92bb626ac6b07423f6ae878988e85ee5af4af',
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  const current = [
    ...migration.matchAll(
      / {2}WITH documents AS MATERIALIZED \(\n[\s\S]*? {4}INTO counts,total,sources_hash,evaluations_hash FROM documents;/gu,
    ),
  ];
  expect(current).toHaveLength(1);
  const bind = (aggregate: string) => {
    const suffix = '    INTO counts,total,sources_hash,evaluations_hash FROM documents;';
    expect(aggregate.endsWith(suffix)).toBe(true);
    const parts = aggregate
      .replace(suffix, '    FROM documents')
      .split(/(root\.id|root\."sourceKindCode")/gu);
    expect(parts).toHaveLength(5);
    return Prisma.join(
      parts.map((part) =>
        part === 'root.id'
          ? Prisma.sql`${revisionId}::text`
          : part === 'root."sourceKindCode"'
            ? Prisma.sql`${sourceKindCode}::text`
            : Prisma.raw(part),
      ),
      '',
    );
  };
  return { old: bind(oldAggregate), candidate: bind(current[0][0]) };
}

// The fixed abc aggregate and the candidate both read actual stored rows, not expected rows.
async function assertFixedE4RootOracle(
  db: PrismaClient,
  revisionId: string,
  expectedCount?: number,
) {
  const root = await db.activitySettlementContributionRevision.findUniqueOrThrow({
    where: { id: revisionId },
  });
  const sql = fixedE4RootAggregateSql(revisionId, root.sourceKindCode);
  const [comparison] = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      return tx.$queryRaw<
        {
          oldCount: number;
          candidateCount: number;
          totalMatches: boolean;
          sourceMatches: boolean;
          evaluationMatches: boolean;
          storedMatches: boolean;
        }[]
      >`
      WITH old_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.old}),
      candidate_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.candidate})
      SELECT o.counts::int AS "oldCount",c.counts::int AS "candidateCount",
        o.total IS NOT DISTINCT FROM c.total AS "totalMatches",
        o.sources_hash IS NOT DISTINCT FROM c.sources_hash AS "sourceMatches",
        o.evaluations_hash IS NOT DISTINCT FROM c.evaluations_hash AS "evaluationMatches",
        (o.counts=r."evaluationCount" AND o.total=r."recognizedPointsTotal"
          AND (r."sourceKindCode"='unchanged_time' OR o.sources_hash=r."sourceSetHash")
          AND o.evaluations_hash=r."evaluationSetHash") AS "storedMatches"
      FROM old_root o CROSS JOIN candidate_root c
      CROSS JOIN "ActivitySettlementContributionRevision" r WHERE r.id=${revisionId}
    `;
    },
    { timeout: 30_000 },
  );
  expect(comparison).toEqual({
    oldCount: expectedCount ?? root.evaluationCount,
    candidateCount: expectedCount ?? root.evaluationCount,
    totalMatches: true,
    sourceMatches: true,
    evaluationMatches: true,
    storedMatches: true,
  });
}
// This file is read as data, never imported: importing an E2E spec would register its lifecycle.
async function assertFixedE4Oracle(db: PrismaClient, revisionId: string, expectedCount?: number) {
  const root = await db.activitySettlementContributionRevision.findUniqueOrThrow({
    where: { id: revisionId },
  });
  await assertFixedE4RootOracle(db, revisionId, expectedCount);
  if (root.sourceKindCode === 'unchanged_time') {
    expect(root.previousContributionRevisionId).not.toBeNull();
    const previous = await db.activitySettlementContributionRevision.findUniqueOrThrow({
      where: { id: root.previousContributionRevisionId! },
    });
    expect(root).toMatchObject({
      sourceSetHash: previous.sourceSetHash,
      evaluationSetHash: previous.evaluationSetHash,
      evaluationCount: previous.evaluationCount,
      recognizedPointsTotal: previous.recognizedPointsTotal,
    });
    const [copy] = await db.$queryRaw<{ equal: boolean }[]>`
      SELECT (
        SELECT coalesce(jsonb_agg(e4_evaluation_document(e) ORDER BY e."evaluationUnitKey" COLLATE "C"),'[]'::jsonb)
        FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=${root.id}
      ) IS NOT DISTINCT FROM (
        SELECT coalesce(jsonb_agg(e4_evaluation_document(e) ORDER BY e."evaluationUnitKey" COLLATE "C"),'[]'::jsonb)
        FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=${previous.id}
      ) AS equal
    `;
    expect(copy.equal).toBe(true);
    await assertFixedE4Oracle(db, previous.id, expectedCount);
    return;
  }
  const oracleSource = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const matches = [
    ...oracleSource.matchAll(/const E4_P_CANONICAL_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(matches).toHaveLength(1);
  const oldSql = matches[0][1];
  expect(createHash('sha256').update(oldSql).digest('hex')).toBe(
    '1aaf91d632713dddaeb106ad4095ac5650aa65416841f8c865d2fd0020fa465b',
  );
  const parts = oldSql.split(/\brevision_id\b/u);
  expect(parts).toHaveLength(3);
  // Only the fixed old SQL is raw. Identifiers are bound values, never string interpolation.
  const oracle = Prisma.join(
    parts.flatMap((part, index) =>
      index === parts.length - 1
        ? [Prisma.raw(part)]
        : [Prisma.raw(part), Prisma.sql`${revisionId}::text`],
    ),
    '',
  );
  const [comparison] = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      return tx.$queryRaw<
        {
          oldCount: number;
          candidateCount: number;
          storedCount: number;
          candidateDifferences: number;
          storedDifferences: number;
          rootMatches: boolean;
        }[]
      >`
        WITH oracle(unit_canonical,evaluation) AS MATERIALIZED (${oracle}),
        candidate AS MATERIALIZED (SELECT * FROM e4_expected_evaluations(${revisionId})),
        stored AS MATERIALIZED (
          SELECT e4_evaluation_document(e) AS evaluation FROM "ParticipantContributionEvaluation" e
          WHERE e."contributionRevisionId"=${revisionId}
        ), summary AS (
          SELECT count(*)::int AS count,coalesce(sum((evaluation->>'recognizedPoints')::numeric),0) AS points,
            e4_envelope_hash(jsonb_build_object('domain',${root.sourceKindCode}::text,'sources',
              coalesce(jsonb_agg(jsonb_build_object('evaluationUnitKey',evaluation->>'evaluationUnitKey',
                'sourceFingerprint',evaluation->>'sourceFingerprint') ORDER BY unit_canonical COLLATE "C"),'[]'::jsonb))) AS source_hash,
            e4_envelope_hash(jsonb_build_object('evaluations',
              coalesce(jsonb_agg(evaluation->>'evaluationHash' ORDER BY unit_canonical COLLATE "C"),'[]'::jsonb))) AS evaluation_hash
          FROM oracle
        )
        SELECT (SELECT count(*)::int FROM oracle) AS "oldCount",
          (SELECT count(*)::int FROM candidate) AS "candidateCount",
          (SELECT count(*)::int FROM stored) AS "storedCount",
          (SELECT count(*)::int FROM oracle o FULL JOIN candidate c USING (unit_canonical)
            WHERE o.unit_canonical IS NULL OR c.unit_canonical IS NULL OR o.evaluation IS DISTINCT FROM c.evaluation) AS "candidateDifferences",
          (SELECT count(*)::int FROM oracle o FULL JOIN stored s
            ON o.evaluation->>'evaluationUnitKey'=s.evaluation->>'evaluationUnitKey'
            WHERE o.evaluation IS DISTINCT FROM s.evaluation) AS "storedDifferences",
          (SELECT s.count=r."evaluationCount" AND s.points=r."recognizedPointsTotal"
             AND s.source_hash=r."sourceSetHash" AND s.evaluation_hash=r."evaluationSetHash"
           FROM summary s CROSS JOIN "ActivitySettlementContributionRevision" r WHERE r.id=${revisionId}) AS "rootMatches"
      `;
    },
    { timeout: 30_000 },
  );
  expect(comparison).toEqual({
    oldCount: expectedCount ?? root.evaluationCount,
    candidateCount: expectedCount ?? root.evaluationCount,
    storedCount: expectedCount ?? root.evaluationCount,
    candidateDifferences: 0,
    storedDifferences: 0,
    rootMatches: true,
  });
}

installE4ValidationDatabase();
describe('E4 native contribution: actual policy, frozen source, review and atomic ledger', () => {
  let f: E4Fixture;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  async function assertSameCommandHasNoFacts(
    observer: PrismaClient,
    source: Awaited<ReturnType<typeof createE4Source>>,
    command: {
      operationKey: string;
      expectedTimeRevision: number;
      expectedDraftVersion: number;
      expectedEvidenceSealId: string;
    },
    anchors: { timeRevisionId: string; contributionRevisionId: string },
  ) {
    const requestHash = timeSettlementPrepareRequestHash(source.activityId, f.creator.id, command);
    const [facts] = await observer.$queryRaw<
      {
        roots: number;
        evaluations: number;
        timeRoots: number;
        buckets: number;
        sources: number;
        receipts: number;
        audits: number;
      }[]
    >`
      WITH roots AS MATERIALIZED (
        SELECT id FROM "ActivitySettlementContributionRevision"
        WHERE id=${anchors.contributionRevisionId} AND "timeRevisionId"=${anchors.timeRevisionId}
          AND "activityId"=${source.activityId} AND "settlementRunId"=${source.generated.settlementRunId}
          AND "settlementVersionId"=${source.generated.settlementVersionId}
          AND "createdByUserId"=${f.creator.id} AND "operationKey"=${command.operationKey}
          AND "requestHash"=${requestHash}
      ), time_roots AS MATERIALIZED (
        SELECT id FROM "ActivitySettlementTimeRevision"
        WHERE id=${anchors.timeRevisionId} AND "activityId"=${source.activityId}
          AND "settlementRunId"=${source.generated.settlementRunId}
          AND "settlementVersionId"=${source.generated.settlementVersionId} AND "createdByUserId"=${f.creator.id}
      )
      SELECT (SELECT count(*)::int FROM roots) AS roots,
        (SELECT count(*)::int FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId" IN (SELECT id FROM roots)) AS evaluations,
        (SELECT count(*)::int FROM time_roots) AS "timeRoots",
        (SELECT count(*)::int FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS buckets,
        (SELECT count(*)::int FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS sources,
        (SELECT count(*)::int FROM "ActivitySettlementTimeCommandReceipt"
          WHERE "actorUserId"=${f.creator.id} AND "activityId"=${source.activityId}
            AND "operationCode"=${TIME_SETTLEMENT_PREPARE_OPERATION} AND "operationKey"=${command.operationKey}
            AND "requestHash"=${requestHash} AND "timeRevisionId"=${anchors.timeRevisionId}) AS receipts,
        (SELECT count(*)::int FROM audit_logs WHERE "actorUserId"=${f.creator.id}
          AND "resourceId"=${source.activityId} AND event='activity.time-settlement.command'
          AND context->'extra'->>'operationCode'=${TIME_SETTLEMENT_PREPARE_OPERATION}
          AND context->'extra'->>'timeRevisionId'=${anchors.timeRevisionId}
          AND context->'extra'->>'contributionRevisionId'=${anchors.contributionRevisionId}) AS audits
    `;
    expect(facts).toEqual({
      roots: 0,
      evaluations: 0,
      timeRoots: 0,
      buckets: 0,
      sources: 0,
      receipts: 0,
      audits: 0,
    });
  }

  async function reviewFixture() {
    const source = await createE4Source(f);
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: submitted.settlementVersionId },
    });
    const input: SettlementReviewInput = {
      activityId: source.activityId,
      expectedSettlementVersionId: version.id,
      actionCode: 'approve',
      operationKey: f.key('first_review_barrier'),
      requestHash: 'c'.repeat(64),
      expectation: {
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      },
    };
    return { source, submitted, version, input, review: f.app.get(SettlementReviewService) };
  }

  // Independent connection, exact request and immutable facts; no production Presenter oracle.
  async function reviewFacts(db: PrismaClient, input: SettlementReviewInput, runId: string) {
    const [facts] = await db.$queryRaw<Prisma.JsonObject[]>`
      SELECT to_jsonb(v) AS version, to_jsonb(r) AS run,
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.revision,p.id),'[]'::jsonb)
          FROM "ActivitySettlementContributionRevision" p WHERE p."settlementVersionId"=v.id) AS roots,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)
          FROM "SettlementReviewAction" a WHERE a."settlementVersionId"=v.id) AS actions,
        (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id),'[]'::jsonb)
          FROM notification_outbox_intents n WHERE n."eventKey"=${'settlement-review:' + input.expectedSettlementVersionId + ':first'}
            AND n."aggregateType"='activity' AND n."aggregateId"=${input.activityId}) AS notifications,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM audit_logs a
          WHERE a."resourceType"='activity' AND a."resourceId"=${input.activityId}
            AND a."actorUserId"=${f.reviewer.id} AND a.event='activity.publish'
            AND a.context->'extra'->>'operation'='settlement-first-review'
            AND a.context->'extra'->>'settlementRunId'=${runId}
            AND a.context->'extra'->>'settlementVersionId'=v.id
            AND a.context->'extra'->>'stageCode'='first'
            AND a.context->'extra'->>'operationKey'=${input.operationKey}
            AND a.context->'extra'->>'requestHash'=${input.requestHash}) AS audits
      FROM "AttendanceSettlementVersion" v JOIN "AttendanceSettlementRun" r
        ON r.id=v."settlementRunId"
      WHERE v.id=${input.expectedSettlementVersionId} AND r."activityId"=${input.activityId} AND r.id=${runId}
    `;
    expect(facts).toBeDefined();
    return facts;
  }

  async function waitForRelationWaiter(db: PrismaClient, holderPid: number, expected: number) {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const [{ blocked }] = await db.$queryRaw<{ blocked: number }[]>`
        WITH RECURSIVE waits(pid,blocker,path) AS (
          SELECT a.pid,b.pid,ARRAY[a.pid,b.pid] FROM pg_stat_activity a
          CROSS JOIN LATERAL unnest(pg_blocking_pids(a.pid)) b(pid)
          WHERE a.datname=current_database() AND a.wait_event_type='Lock'
          UNION ALL
          SELECT w.pid,b.pid,w.path||b.pid FROM waits w
          JOIN pg_stat_activity a ON a.pid=w.blocker AND a.datname=current_database()
          CROSS JOIN LATERAL unnest(pg_blocking_pids(a.pid)) b(pid)
          WHERE NOT b.pid=ANY(w.path)
        ) SELECT count(DISTINCT pid)::int AS blocked FROM waits WHERE blocker=${holderPid}
      `;
      if (blocked === expected) return;
      if (blocked > expected) throw new Error('Unexpected first-review lock contender');
      await nextTurn();
    }
    throw new Error('Actual first-review lock wait was not observed');
  }

  it.each([false, true])(
    'restores transaction-local native planner mode after rollback=%s on the same backend',
    async (rollback) => {
      const source = await createE4Source(f);
      const configuredUrl = process.env.DATABASE_URL;
      if (!configuredUrl) throw new Error('native planner test database unavailable');
      const url = new URL(configuredUrl);
      url.searchParams.set('connection_limit', '1');
      const observed = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const contributions = f.app.get(ActivityContributionSettlementService);
      const descriptor = Object.getOwnPropertyDescriptor(contributions, 'insertEvaluations');
      const original: unknown = Reflect.get(contributions, 'insertEvaluations');
      if (typeof original !== 'function')
        throw new Error('native planner insertion seam unavailable');
      let calls = 0;
      const command = {
        expectedDraftVersion: source.expectation.expectedDraftVersion,
        expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
        expectedTimeRevision: 0,
        operationKey: f.key('native_planner_probe'),
      };
      try {
        await assertConnectedTestDatabase(observed);
        const [initial] = await observed.$queryRaw<{ pid: number; mode: string }[]>`
          SELECT pg_backend_pid()::int AS pid, current_setting('plan_cache_mode') AS mode
        `;
        expect(initial).toBeDefined();
        expect(initial.mode).not.toBe('force_custom_plan');
        Object.defineProperty(contributions, 'insertEvaluations', {
          configurable: true,
          writable: true,
          value: async function (this: unknown, ...args: unknown[]) {
            const tx = args[0] as Prisma.TransactionClient;
            const [setting] = await tx.$queryRaw<{ pid: number; mode: string }[]>`
              SELECT pg_backend_pid()::int AS pid, current_setting('plan_cache_mode') AS mode
            `;
            expect(setting).toEqual({ pid: initial.pid, mode: 'force_custom_plan' });
            calls++;
            if (rollback) throw new Error('native planner controlled rollback');
            return Reflect.apply(original, this, args);
          },
        });
        const measured = new ActivityTimeSettlementService(
          observed as unknown as PrismaService,
          f.app.get(ActivityTimeSettlementAccessService),
          f.app.get(ActivityTimeSettlementQueryService),
          f.app.get(ParticipationSegmentFacade),
          f.app.get(ActivityTimeAllocationService),
          f.app.get(SettlementSubmitService),
          f.app.get(ActivityTimeSettlementAuditRecorder),
          f.app.get(ActivityWorkflowGate),
          contributions,
        );
        const prepared = measured.prepare(
          source.activityId,
          command,
          e4Actor(f.creator, true),
          E4_META,
        );
        if (rollback) {
          await expect(prepared).rejects.toThrow('native planner controlled rollback');
          expect(
            await f.db.activitySettlementTimeRevision.count({
              where: { activityId: source.activityId },
            }),
          ).toBe(0);
          expect(
            await f.db.activitySettlementContributionRevision.count({
              where: { activityId: source.activityId },
            }),
          ).toBe(0);
          expect(
            await f.db.activitySettlementTimeCommandReceipt.count({
              where: { activityId: source.activityId, operationKey: command.operationKey },
            }),
          ).toBe(0);
        } else {
          const result = await prepared;
          const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
            where: { timeRevisionId: result.timeRevisionId },
          });
          await assertFixedE4Oracle(f.db, root.id);
        }
        expect(calls).toBe(1);
        const [restored] = await observed.$queryRaw<{ pid: number; mode: string }[]>`
          SELECT pg_backend_pid()::int AS pid, current_setting('plan_cache_mode') AS mode
        `;
        expect(restored).toEqual(initial);
        console.info(
          'E4_NATIVE_PLANNER_LOCAL',
          JSON.stringify({
            rollback,
            calls,
            sameBackend: true,
            modeAtInsert: 'FORCE_CUSTOM',
            restored: true,
          }),
        );
      } finally {
        if (descriptor) Object.defineProperty(contributions, 'insertEvaluations', descriptor);
        else Reflect.deleteProperty(contributions, 'insertEvaluations');
        await observed.$disconnect();
      }
    },
  );
  it('First-Barrier uses live pinned guard identity, writes once, and preserves replay and key conflict', async () => {
    const c = await reviewFixture();
    const contributions = f.app.get(ActivityContributionSettlementService);
    const barrier = jest.spyOn(contributions, 'assertFirstReviewBarrierInTx');
    const full = jest.spyOn(contributions, 'assertVersionInTx');
    const observer = new PrismaClient();
    try {
      await assertConnectedTestDatabase(observer);
      const [identity] = await observer.$queryRaw<
        {
          sameDatabase: boolean;
          origin: boolean;
          guardPin: string;
          completePin: string;
          ownsVersion: boolean;
          superuser: boolean;
          sameUser: boolean;
        }[]
      >`
        SELECT current_database()=${deriveTestDbName()} AS "sameDatabase",
          current_setting('session_replication_role')='origin' AS origin,
          md5(g.prosrc) AS "guardPin", md5(p.prosrc) AS "completePin",
          c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS "ownsVersion",
          (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
          current_user=session_user AS "sameUser"
        FROM pg_proc g CROSS JOIN pg_proc p CROSS JOIN pg_class c
        WHERE g.oid=to_regprocedure('public.e4_native_version_complete_guard()')
          AND p.oid=to_regprocedure('public.e4_assert_complete(text,boolean)')
          AND c.oid=to_regclass('public."AttendanceSettlementVersion"')
      `;
      expect(identity).toEqual({
        sameDatabase: true,
        origin: true,
        guardPin: 'fa428e2eb3e733f770cbb31c15dd4720',
        completePin: 'ade4d2af9aa0baf8400a79fc6b62c797',
        ownsVersion: true,
        superuser: true,
        sameUser: true,
      });
      // This actual fixture uses the existing owner login, not a simulated restricted execution role.
      const result = await c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META);
      expect(result).toMatchObject({ replayed: false, runStatusAfter: 'pending_final_review' });
      expect(barrier).toHaveBeenCalledTimes(1);
      expect(full).not.toHaveBeenCalled();
      const after = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
      expect(after.actions).toHaveLength(1);
      expect(after.notifications).toHaveLength(1);
      expect(after.audits).toHaveLength(1);
      const versionAfter = await observer.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: c.version.id },
      });
      expect(versionAfter.updatedAt.getTime()).toBeGreaterThanOrEqual(
        c.version.updatedAt.getTime(),
      );
      const replay = await c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META);
      expect(replay).toMatchObject({ replayed: true, reviewActionId: result.reviewActionId });
      const replayFacts = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
      expect(replayFacts.version).toEqual(after.version);
      expect(replayFacts.run).toEqual(after.run);
      expect(replayFacts.roots).toEqual(after.roots);
      expect(replayFacts.actions).toEqual(after.actions);
      expect(replayFacts.notifications).toEqual(after.notifications);
      expect(replayFacts.audits).toHaveLength(2);
      expect(barrier).toHaveBeenCalledTimes(1);
      await expect(
        c.review.firstReview(
          { ...c.input, requestHash: 'b'.repeat(64) },
          e4Actor(f.reviewer),
          E4_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT });
      expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(
        replayFacts,
      );
    } finally {
      await observer.$disconnect();
    }
  }, 120_000);

  it.each(['historical_body', 'same_name_fake_body', 'security_definer', 'changed_search_path'])(
    'First-Barrier rejects actual changed complete-function metadata (%s) and restores it by rollback',
    async (point) => {
      const c = await reviewFixture();
      const observer = new PrismaClient();
      const contributions = f.app.get(ActivityContributionSettlementService);
      const rollback = new Error('E4 controlled catalog fixture rollback');
      const metadata = (db: Prisma.TransactionClient) => db.$queryRaw<Prisma.JsonObject[]>`
        SELECT oid::text AS identity,md5(prosrc) AS pin,NOT prosecdef AS invoker,
          proconfig AS config,pronargdefaults AS defaults,pg_get_expr(proargdefaults,0) AS default_expression
        FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
      `;
      try {
        await assertConnectedTestDatabase(observer);
        const proof = await observer.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: c.version.id, kindCode: 'submitted' },
          orderBy: { revision: 'desc' },
        });
        const anchor = {
          activityId: proof.activityId,
          settlementRunId: proof.settlementRunId,
          settlementVersionId: proof.settlementVersionId,
          evidenceSealId: proof.evidenceSealId,
          evidenceRevision: proof.evidenceRevision,
          populationRevision: proof.populationRevision,
          workflowRevision: proof.workflowRevision,
        };
        const before = await metadata(observer);
        expect(before).toHaveLength(1);
        expect(before[0].pin).toBe('ade4d2af9aa0baf8400a79fc6b62c797');
        const facts = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
        await expect(
          observer.$transaction(async (tx) => {
            expect(
              await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
            ).not.toBeNull();
            if (point === 'historical_body' || point === 'same_name_fake_body') {
              const migration = readFileSync(
                resolve(
                  __dirname,
                  '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
                ),
                'utf8',
              );
              const definitions = [
                ...migration.matchAll(
                  /CREATE FUNCTION e4_assert_complete\([^]*? AS \$\$([^]*?)\$\$;/gu,
                ),
              ];
              expect(definitions).toHaveLength(1);
              expect(createHash('md5').update(definitions[0][1]).digest('hex')).toBe(
                '21fe9ecf6df989a3f8fa5878df40b93c',
              );
              let definition = definitions[0][0];
              if (point === 'historical_body') {
                const oracle = readFileSync(
                  resolve(
                    __dirname,
                    'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
                  ),
                  'utf8',
                );
                const old = [
                  ...oracle.matchAll(/const E4_S13_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu),
                ];
                const candidate = [
                  ...oracle.matchAll(
                    /const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu,
                  ),
                ];
                expect(old).toHaveLength(1);
                expect(candidate).toHaveLength(1);
                expect(definition.split(candidate[0][1])).toHaveLength(2);
                definition = definition.replace(candidate[0][1], () => old[0][1]);
              } else {
                definition = definition.replace(definitions[0][1], () => '\nBEGIN RETURN; END;\n');
              }
              await tx.$executeRaw(
                Prisma.raw(definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')),
              );
              expect((await metadata(tx))[0].pin).not.toBe('ade4d2af9aa0baf8400a79fc6b62c797');
              if (point === 'historical_body')
                expect((await metadata(tx))[0].pin).toBe('edd162a44264b0d073d0009d3e592d0e');
            } else if (point === 'security_definer') {
              await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SECURITY DEFINER`;
              expect((await metadata(tx))[0].invoker).toBe(false);
            } else {
              await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;
              expect((await metadata(tx))[0].config).toEqual(['search_path=public, pg_catalog']);
            }
            await expect(
              contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
            ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(await metadata(observer)).toEqual(before);
        expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(facts);
      } finally {
        await observer.$disconnect();
      }
    },
    120_000,
  );

  for (const point of [
    'duplicate_formal_root',
    'guard_result_count',
    'update',
    'notification',
    'audit',
  ] as const) {
    it(`First-Barrier rolls back the exact actual review facts on ${point}`, async () => {
      const c = await reviewFixture();
      const contributions = f.app.get(ActivityContributionSettlementService);
      const actualCandidate = contributions.readFirstReviewBarrierCandidateInTx.bind(contributions);
      const barrier = jest.spyOn(contributions, 'assertFirstReviewBarrierInTx');
      const observeEffects = point === 'guard_result_count' || point === 'duplicate_formal_root';
      const notification = observeEffects
        ? jest.spyOn(f.app.get(SettlementNotificationProducer), 'enqueueReviewed')
        : undefined;
      const audit = observeEffects
        ? jest.spyOn(f.app.get(SettlementReviewAuditRecorder), 'log')
        : undefined;
      const observer = new PrismaClient();
      const failure = new Error('Controlled first-review callback failure');
      let versionUpdateCalls = 0;
      try {
        await assertConnectedTestDatabase(observer);
        const before = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
        if (point === 'duplicate_formal_root') {
          const original = await observer.activitySettlementContributionRevision.findFirstOrThrow({
            where: { settlementVersionId: c.version.id },
            orderBy: { revision: 'desc' },
          });
          const data = Object.fromEntries(
            Object.entries(original).filter(([key]) => key !== 'id' && key !== 'createdAt'),
          ) as Omit<typeof original, 'id' | 'createdAt'>;
          jest
            .spyOn(contributions, 'readFirstReviewBarrierCandidateInTx')
            .mockImplementationOnce(async (tx, anchor) => {
              // The real partial unique index rejects this inside the original review transaction.
              await tx.activitySettlementContributionRevision.create({
                data: {
                  ...data,
                  revision: original.revision + 1,
                  operationKey: f.key('duplicate_formal_review_root'),
                },
              });
              return actualCandidate(tx, anchor);
            });
        } else if (point === 'guard_result_count') {
          jest
            .spyOn(contributions, 'readFirstReviewBarrierCandidateInTx')
            .mockImplementationOnce(async (tx, anchor) => {
              const candidate = await actualCandidate(tx, anchor);
              expect(candidate).not.toBeNull();
              const update = tx.attendanceSettlementVersion.update.bind(
                tx.attendanceSettlementVersion,
              );
              jest
                .spyOn(tx.attendanceSettlementVersion, 'update')
                .mockImplementationOnce((args) => {
                  versionUpdateCalls++;
                  return update({
                    ...args,
                    data: {
                      ...args.data,
                      sessionParticipationCount: c.version.sessionParticipationCount + 1,
                    },
                  });
                });
              const execute = tx.$executeRaw.bind(tx);
              jest.spyOn(tx, '$executeRaw').mockImplementationOnce((statement, ...parameters) => {
                expect(statement).toEqual([
                  'SET CONSTRAINTS public.e4_native_version_complete_guard IMMEDIATE',
                ]);
                expect(parameters).toHaveLength(0);
                // Execute the same named barrier once; expose only its real SQLSTATE/constraint.
                // The test-only exception handler rethrows, so the original outer tx rolls back.
                return execute(Prisma.sql`
                  DO $e4_review_guard_probe$
                  DECLARE observed_constraint TEXT; observed_state TEXT;
                  BEGIN
                    SET CONSTRAINTS public.e4_native_version_complete_guard IMMEDIATE;
                  EXCEPTION WHEN check_violation THEN
                    GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME,
                      observed_state = RETURNED_SQLSTATE;
                    RAISE EXCEPTION USING ERRCODE = observed_state,
                      CONSTRAINT = observed_constraint,
                      MESSAGE = 'E4_FIRST_REVIEW_GUARD:' || observed_constraint;
                  END $e4_review_guard_probe$;
                `);
              });
              return candidate;
            });
        } else if (point === 'update') {
          jest
            .spyOn(contributions, 'readFirstReviewBarrierCandidateInTx')
            .mockImplementationOnce(async (tx, anchor) => {
              const candidate = await actualCandidate(tx, anchor);
              const update = tx.attendanceSettlementVersion.update.bind(
                tx.attendanceSettlementVersion,
              );
              jest
                .spyOn(tx.attendanceSettlementVersion, 'update')
                .mockImplementationOnce((args) =>
                  update({ ...args, data: { ...args.data, statusCode: 'invalid_test_status' } }),
                );
              return candidate;
            });
        } else if (point === 'notification') {
          const producer = f.app.get(SettlementNotificationProducer);
          const original = producer.enqueueReviewed.bind(producer);
          jest.spyOn(producer, 'enqueueReviewed').mockImplementationOnce(async (...args) => {
            await original(...args);
            throw failure;
          });
        } else {
          const recorder = f.app.get(SettlementReviewAuditRecorder);
          const original = recorder.log.bind(recorder);
          jest.spyOn(recorder, 'log').mockImplementationOnce(async (...args) => {
            await original(...args);
            throw failure;
          });
        }
        const outcome = c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META);
        if (point === 'duplicate_formal_root')
          await expect(outcome).rejects.toMatchObject({ code: 'P2002' });
        else if (point === 'guard_result_count') {
          await expect(outcome).rejects.toMatchObject({
            meta: {
              code: '23514',
              message: expect.stringContaining('E4_FIRST_REVIEW_GUARD:e4_result_guard') as unknown,
            },
          });
          expect(versionUpdateCalls).toBe(1);
        } else if (point === 'update')
          await expect(outcome).rejects.toThrow('attendance_settlement_version_status_code_check');
        else await expect(outcome).rejects.toBe(failure);
        expect(barrier).toHaveBeenCalledTimes(
          point === 'update' || point === 'duplicate_formal_root' ? 0 : 1,
        );
        if (point === 'guard_result_count' || point === 'duplicate_formal_root') {
          expect(notification).not.toHaveBeenCalled();
          expect(audit).not.toHaveBeenCalled();
        }
        expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(before);
      } finally {
        jest.restoreAllMocks();
        await observer.$disconnect();
      }
    }, 120_000);
  }

  it('First-Barrier rejects a real disabled trigger before any version write and restores its exact live identity', async () => {
    const c = await reviewFixture();
    const observer = new PrismaClient();
    const contributions = f.app.get(ActivityContributionSettlementService);
    const barrier = jest.spyOn(contributions, 'assertFirstReviewBarrierInTx');
    try {
      await assertConnectedTestDatabase(observer);
      const guard = () => observer.$queryRaw<Prisma.JsonObject[]>`
        SELECT t.oid::text AS trigger, t.tgenabled::text AS enabled, t.tgfoid::text AS function,
          md5(p.prosrc) AS pin FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='public."AttendanceSettlementVersion"'::regclass AND t.tgname='e4_native_version_complete_guard'
      `;
      const original = await guard();
      expect(original).toHaveLength(1);
      expect(original[0].enabled).toBe('O');
      const before = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
      try {
        // Explicitly approved committed owner fixture in this single derived test database only.
        await observer.$executeRaw`ALTER TABLE public."AttendanceSettlementVersion" DISABLE TRIGGER e4_native_version_complete_guard`;
        expect((await guard())[0].enabled).toBe('D');
        await expect(
          c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
        expect(barrier).not.toHaveBeenCalled();
        expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(before);
      } finally {
        await observer.$executeRaw`ALTER TABLE public."AttendanceSettlementVersion" ENABLE TRIGGER e4_native_version_complete_guard`;
        expect(await guard()).toEqual(original);
      }
    } finally {
      await observer.$disconnect();
    }
  }, 120_000);

  it('First-Barrier keeps actual UPDATE/table-DDL exclusion across different PostgreSQL backends', async () => {
    const c = await reviewFixture();
    const observer = new PrismaClient();
    const contributions = f.app.get(ActivityContributionSettlementService);
    const actual = contributions.assertFirstReviewBarrierInTx.bind(contributions);
    let ddl: Promise<unknown> | undefined;
    let observedWait = false;
    try {
      await assertConnectedTestDatabase(observer);
      const [{ pid: observerPid }] = await observer.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      jest
        .spyOn(contributions, 'assertFirstReviewBarrierInTx')
        .mockImplementationOnce(async (...args) => {
          const [tx] = args;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          expect(pid).not.toBe(observerPid);
          ddl = observer.$transaction(async (ddlTx) => {
            const [{ pid: ddlPid }] = await ddlTx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            expect(ddlPid).not.toBe(pid);
            await ddlTx.$executeRaw`SET LOCAL lock_timeout='5s'`;
            await ddlTx.$executeRaw`ALTER TABLE public."AttendanceSettlementVersion" DISABLE TRIGGER e4_native_version_complete_guard`;
            await ddlTx.$executeRaw`ALTER TABLE public."AttendanceSettlementVersion" ENABLE TRIGGER e4_native_version_complete_guard`;
          });
          void ddl.catch(() => undefined);
          await waitForRelationWaiter(f.db, pid, 1);
          observedWait = true;
          return actual(...args);
        });
      await expect(
        c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META),
      ).resolves.toMatchObject({ replayed: false });
      if (!ddl) throw new Error('DDL contender did not start');
      await ddl;
      expect(observedWait).toBe(true);
      const [{ enabled, pin }] = await observer.$queryRaw<{ enabled: string; pin: string }[]>`
        SELECT t.tgenabled::text AS enabled,md5(p.prosrc) AS pin FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='public."AttendanceSettlementVersion"'::regclass AND t.tgname='e4_native_version_complete_guard'
      `;
      expect({ enabled, pin }).toEqual({ enabled: 'O', pin: 'fa428e2eb3e733f770cbb31c15dd4720' });
    } finally {
      await Promise.allSettled([ddl]);
      await observer.$disconnect();
    }
  }, 120_000);

  it('First-Barrier preserves the real same-stage approve/return race and authoritative loser code', async () => {
    const c = await reviewFixture();
    const observer = new PrismaClient();
    let release: () => void = () => undefined;
    let acquired!: (pid: number) => void;
    let rejectAcquired!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      rejectAcquired = reject;
    });
    const hold = observer.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${c.input.activityId} FOR UPDATE`;
        acquired(pid);
        await gate;
      },
      { timeout: 20_000 },
    );
    void hold.catch(rejectAcquired);
    let outcomes:
      | Promise<PromiseSettledResult<Awaited<ReturnType<SettlementReviewService['firstReview']>>>[]>
      | undefined;
    try {
      const pid = await ready;
      outcomes = Promise.allSettled([
        c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META),
        c.review.firstReview(
          {
            ...c.input,
            actionCode: 'return',
            returnReason: 'controlled return',
            operationKey: f.key('return_race'),
            requestHash: 'e'.repeat(64),
          },
          e4Actor(f.reviewer),
          E4_META,
        ),
      ]);
      await waitForRelationWaiter(f.db, pid, 2);
      release();
      await hold;
      const results = await outcomes;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected');
      if (!loser || loser.status !== 'rejected')
        throw new Error('Missing authoritative race loser');
      expect(loser.reason).toMatchObject({ biz: BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED });
      expect(
        await observer.settlementReviewAction.count({
          where: { settlementVersionId: c.version.id, stageCode: 'first' },
        }),
      ).toBe(1);
      expect(
        await observer.notificationOutboxIntent.count({
          where: { eventKey: `settlement-review:${c.version.id}:first` },
        }),
      ).toBe(1);
    } finally {
      release();
      await Promise.allSettled([hold, outcomes]);
      await observer.$disconnect();
    }
  }, 120_000);

  it('First-Barrier rereads live workflow facts after actual Activity lock contention', async () => {
    const c = await reviewFixture();
    const observer = new PrismaClient();
    let release: () => void = () => undefined;
    let acquired!: (pid: number) => void;
    let rejectAcquired!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      rejectAcquired = reject;
    });
    const hold = observer.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${c.input.activityId} FOR UPDATE`;
        await tx.activity.update({
          where: { id: c.input.activityId },
          data: { workflowRevision: { increment: 1 } },
        });
        acquired(pid);
        await gate;
      },
      { timeout: 20_000 },
    );
    void hold.catch(rejectAcquired);
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const barrier = jest.spyOn(
      f.app.get(ActivityContributionSettlementService),
      'assertFirstReviewBarrierInTx',
    );
    try {
      const before = await reviewFacts(f.db, c.input, c.submitted.settlementRunId);
      const pid = await ready;
      outcome = Promise.allSettled([c.review.firstReview(c.input, e4Actor(f.reviewer), E4_META)]);
      await waitForRelationWaiter(f.db, pid, 1);
      release();
      await hold;
      const [result] = await outcome;
      if (result.status !== 'rejected') throw new Error('A changed workflow must not be approved');
      expect(result.reason).toMatchObject({
        biz: BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
      });
      expect(barrier).not.toHaveBeenCalled();
      expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(before);
    } finally {
      release();
      await Promise.allSettled([hold, outcome]);
      await observer.$disconnect();
    }
  }, 120_000);

  it('First-Barrier rejects the current suspended HTTP reviewer binding without writing review effects', async () => {
    const c = await reviewFixture();
    const observer = new PrismaClient();
    try {
      await assertConnectedTestDatabase(observer);
      const before = await reviewFacts(observer, c.input, c.submitted.settlementRunId);
      const changed = await observer.roleBinding.updateMany({
        where: {
          principalType: PrincipalType.USER,
          principalId: f.reviewer.id,
          status: BindingStatus.ACTIVE,
        },
        data: { status: BindingStatus.SUSPENDED },
      });
      expect(changed.count).toBeGreaterThan(0);
      const response = await request(httpServer(f.app))
        .post(`${E13_ADMIN}/attendance-settlements/${c.version.id}/first-approve`)
        .set('Authorization', f.reviewer.auth)
        .send({ operationKey: c.input.operationKey, ...c.input.expectation });
      expect({ status: response.status, code: (response.body as { code: unknown }).code }).toEqual({
        status: BizCode.RBAC_FORBIDDEN.httpStatus,
        code: BizCode.RBAC_FORBIDDEN.code,
      });
      expect(await reviewFacts(observer, c.input, c.submitted.settlementRunId)).toEqual(before);
    } finally {
      await observer.$disconnect();
    }
  }, 120_000);

  it('freezes an actual policy evaluation and posts it through the unchanged dual review and member/day locks', async () => {
    const source = await createE4Source(f);
    const draft = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: source.generated.settlementVersionId },
    });
    expect(draft.contributionRegimeCode).toBe('policy_v1');
    const provisional = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: draft.id },
    });
    expect(provisional.recognizedContributionPoints.toFixed(2)).toBe('0.00');
    const prepared = await prepareE4Time(f, source);
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: draft.id, kindCode: 'draft' },
    });
    expect(proof.evaluationCount).toBe(1);
    expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1.00');
    const evaluation = await f.db.participantContributionEvaluation.findFirstOrThrow({
      where: { contributionRevisionId: proof.id },
    });
    expect(evaluation).toMatchObject({
      policyVersionId: source.contributionPointer.versionId,
      durationSeconds: 3600,
      explanationCode: 'service_hour_plus',
    });
    const submitted = await submitE4Time(f, source, prepared);
    const formal = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    expect(formal.recognizedContributionPoints.toFixed(2)).toBe('1.00');
    expect(formal.calculatedContributionPoints.toFixed(2)).toBe('1.00');
    expect(submitted.contentHash).not.toBe(prepared.contentHash);
    const posted = await postE4Ledger(f, submitted);
    expect(posted.committed.replayed).toBe(false);
    const entries = await f.db.participationLedgerEntry.findMany({
      where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].creditedPointsDelta.toFixed(2)).toBe('1.00');
    const summary = await f.db.$transaction((tx) =>
      f.app
        .get(ActivityContributionSettlementQueryService)
        .readSummaryInTx(tx, submitted.settlementVersionId),
    );
    expect(summary).toMatchObject({
      regimeCode: 'policy_v1',
      pending: false,
      recognizedPointsTotal: '1.00',
      evaluationCount: 1,
    });
    await assertFixedE4Oracle(f.db, proof.id, 1);
    const formalProof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await assertFixedE4Oracle(f.db, formalProof.id, 1);
  }, 120_000);

  it('uses an explicit zero policy, retaining its actual four-tuple and immutable explanation', async () => {
    const source = await createE4Source(f, {
      definition: {
        defaultResult: { recognizedPoints: '0.00', explanationCode: 'explicit_zero_policy' },
        roleRules: [],
      },
    });
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    const rows = await f.db.participantContributionEvaluation.findMany({
      where: { contributionRevisionId: proof.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      policyVersionId: source.contributionPointer.versionId,
      definitionHash: source.contributionPointer.definitionHash,
      evaluatorVersion: 1,
      explanationCode: 'explicit_zero_policy',
      durationSeconds: 3600,
    });
    expect(rows[0].recognizedPoints.toFixed(2)).toBe('0.00');
    await postE4Ledger(f, submitted);
    const originalProof = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({
      where: { id: proof.id },
    });
    expect(originalProof.sourceSetHash).toBe(proof.sourceSetHash);
    await assertFixedE4Oracle(f.db, proof.id, 1);
  }, 120_000);

  it('splits a single award across actual Beijing days instead of awarding every slice/day', async () => {
    const source = await createE4Source(f, {
      startsAt: new Date('2020-03-01T15:00:00.000Z'),
      endsAt: new Date('2020-03-01T17:00:00.000Z'),
      definition: {
        defaultResult: { recognizedPoints: '1.01', explanationCode: 'fixed_once' },
        roleRules: [],
      },
    });
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const posted = await postE4Ledger(f, submitted);
    const entries = await f.db.participationLedgerEntry.findMany({
      where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
      orderBy: { ledgerDate: 'asc' },
    });
    expect(
      entries.map((row) => [
        row.ledgerDate.toISOString().slice(0, 10),
        row.recognizedPointsDelta.toFixed(2),
      ]),
    ).toEqual([
      ['2020-03-01', '0.51'],
      ['2020-03-02', '0.50'],
    ]);
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await assertFixedE4Oracle(f.db, proof.id, 1);
  }, 120_000);

  it('allows a training award independently of volunteer-service time', async () => {
    const source = await createE4Source(f, {
      recognizedServiceHours: 0,
      timeDefinition: {
        defaultCategory: 'training',
        roleMappings: [],
        allowSplit: true,
        specialIntervals: {
          preparation: { mode: 'exclude' },
          duty: { mode: 'exclude' },
          travel: { mode: 'exclude' },
        },
        rounding: { mode: 'floor', quantumSeconds: 60 },
        evidence: { requiredSources: [], requireManualRecognition: false },
        manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
      },
      definition: {
        defaultResult: { recognizedPoints: '1.00', explanationCode: 'training_fixed' },
        roleRules: [],
      },
    });
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const posted = await postE4Ledger(f, submitted);
    const entries = await f.db.participationLedgerEntry.findMany({
      where: { postingBatchId: posted.batchId },
    });
    expect(
      entries
        .find((row) => row.entryTypeCode === 'contribution_credit')
        ?.recognizedPointsDelta.toFixed(2),
    ).toBe('1.00');
    expect(
      entries
        .filter((row) => row.entryTypeCode === 'service_credit')
        .every((row) => row.serviceHoursDelta.isZero()),
    ).toBe(true);
    const bucket = await f.db.participantSettlementTimeBucket.findFirstOrThrow({
      where: { timeRevisionId: submitted.timeRevisionId, categoryCode: 'volunteer_service' },
    });
    expect(bucket.recognizedSeconds).toBe(0);
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await assertFixedE4Oracle(f.db, proof.id, 1);
  }, 120_000);

  it('does not turn a missing frozen contribution selection into a zero policy or partial time preparation', async () => {
    const source = await createE4Source(f, { withoutFrozenContribution: true });
    await expect(prepareE4Time(f, source)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
    });
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: source.activityId } }),
    ).toBe(0);
    expect(
      await f.db.activitySettlementContributionRevision.count({
        where: { activityId: source.activityId },
      }),
    ).toBe(0);
  }, 120_000);

  it('reads native proof with off mode but refuses a new native write', async () => {
    const source = await createE4Source(f);
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const queries = f.app.get(ActivityContributionSettlementQueryService);
    const actualService = f.app.get(ActivityContributionSettlementService);
    // A separate off-mode consumer, not mutation of the live fixture's configured instance.
    const off = new ActivityContributionSettlementService(
      { env: 'test', contributionSettlementMode: 'off' } as never,
      queries,
      f.app.get(ActivityWorkflowGate),
    );
    expect(() => off.assertNativeWriteAllowed()).toThrow();
    await expect(
      f.db.$transaction((tx) => off.assertVersionInTx(tx, submitted.settlementVersionId)),
    ).resolves.toMatchObject({ regimeCode: 'policy_v1' });
    expect(actualService.draftRegime('policy_v1')).toBe('policy_v1');
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await assertFixedE4Oracle(f.db, proof.id, 1);
  }, 120_000);

  it('P-Root accepts a real sealed empty population without converting missing policy evidence to zero', async () => {
    const source = await createE4Source(f, {
      beforeSeal: async (draft) => {
        // Test-owned historical population, fixed before the actual seal and draft generation.
        const excluded = await f.db.activityParticipationIdentity.updateMany({
          where: { activityId: draft.activityId, populationIncluded: true },
          data: { populationIncluded: false },
        });
        expect(excluded.count).toBe(1);
      },
    });
    const prepared = await prepareE4Time(f, source);
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { timeRevisionId: prepared.timeRevisionId },
    });
    expect(prepared).toMatchObject({ bucketCount: 0, sourceCount: 0 });
    expect(proof.evaluationCount).toBe(0);
    expect(proof.recognizedPointsTotal.toFixed(2)).toBe('0.00');
    expect(
      await f.db.participantContributionEvaluation.count({
        where: { contributionRevisionId: proof.id },
      }),
    ).toBe(0);
    await assertFixedE4Oracle(f.db, proof.id, 0);
  }, 120_000);

  it('P-Barrier preserves exact single-cause PostgreSQL guards and the original deferred receipt rejection', async () => {
    const source = await createE4Source(f, {
      beforeSeal: async (draft) => {
        const excluded = await f.db.activityParticipationIdentity.updateMany({
          where: { activityId: draft.activityId, populationIncluded: true },
          data: { populationIncluded: false },
        });
        expect(excluded.count).toBe(1);
      },
    });
    const prepared = await prepareE4Time(f, source);
    const original = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { timeRevisionId: prepared.timeRevisionId },
    });
    const originalTime = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: prepared.timeRevisionId },
    });
    expect(original.evaluationCount).toBe(0);
    const rootData = Object.fromEntries(
      Object.entries(original).filter(([key]) => key !== 'id' && key !== 'createdAt'),
    ) as Omit<typeof original, 'id' | 'createdAt'>;
    const timeData = Object.fromEntries(
      Object.entries(originalTime).filter(([key]) => key !== 'id' && key !== 'createdAt'),
    ) as Omit<typeof originalTime, 'id' | 'createdAt'>;
    const observer = new PrismaClient();
    const counts = async () => ({
      roots: await observer.activitySettlementContributionRevision.count({
        where: { activityId: source.activityId },
      }),
      evaluations: await observer.participantContributionEvaluation.count({
        where: { activityId: source.activityId },
      }),
      timeRoots: await observer.activitySettlementTimeRevision.count({
        where: { activityId: source.activityId },
      }),
      buckets: await observer.participantSettlementTimeBucket.count({
        where: { activityId: source.activityId },
      }),
      sources: await observer.participantSettlementTimeBucketSource.count({
        where: { activityId: source.activityId },
      }),
      receipts: await observer.activitySettlementTimeCommandReceipt.count({
        where: { activityId: source.activityId },
      }),
      audits: await observer.auditLog.count({
        where: { resourceId: source.activityId, event: 'activity.time-settlement.command' },
      }),
    });
    const cases = [
      {
        mutation: { sourceSetHash: '0'.repeat(64) },
        missingReceipt: false,
        guard: 'e4_complete_guard',
      },
      { mutation: { evaluationCount: 1 }, missingReceipt: false, guard: 'e4_complete_guard' },
      {
        mutation: { draftContentHash: '0'.repeat(64) },
        missingReceipt: false,
        guard: 'e4_source_guard',
      },
      { mutation: {}, missingReceipt: true, guard: 'astr_complete_guard' },
    ] as const;
    try {
      await assertConnectedTestDatabase(observer);
      const before = await counts();
      for (const testcase of cases) {
        const outcome = f.db.$transaction(async (tx) => {
          let timeId = originalTime.id;
          if (testcase.missingReceipt) {
            const time = await tx.activitySettlementTimeRevision.create({
              data: {
                ...timeData,
                revision: originalTime.revision + 1,
                previousTimeRevisionId: originalTime.id,
              },
            });
            timeId = time.id;
          }
          await tx.activitySettlementContributionRevision.create({
            data: {
              ...rootData,
              revision: original.revision + 1,
              timeRevisionId: timeId,
              operationKey: f.key('named_guard_negative'),
              ...testcase.mutation,
            },
          });
          // Only closed test literals become SQL; all actual identifiers above remain bound ORM values.
          const constraint = Prisma.raw("'" + testcase.guard + "'");
          await tx.$executeRaw(Prisma.sql`DO $guard$
            DECLARE actual_state TEXT; actual_constraint TEXT;
            BEGIN
              SET CONSTRAINTS public.astr_parent_complete_guard,public.e4_revision_complete_guard IMMEDIATE;
            EXCEPTION WHEN OTHERS THEN
              GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_constraint=CONSTRAINT_NAME;
              IF actual_state IS DISTINCT FROM '23514' OR actual_constraint IS DISTINCT FROM ${constraint} THEN
                RAISE;
              END IF;
              RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='E4 verified original SQLSTATE and constraint: '||actual_constraint;
            END; $guard$`);
        });
        await expect(outcome).rejects.toMatchObject({
          code: 'P2010',
          meta: {
            code: '23514',
            message: expect.stringContaining(
              'E4 verified original SQLSTATE and constraint: ' + testcase.guard,
            ),
          },
        });
        expect(await counts()).toEqual(before);
      }
      // No explicit SET here: the unchanged default deferred check must still reject actual COMMIT.
      await expect(
        f.db.$transaction(async (tx) => {
          await tx.activitySettlementTimeRevision.create({
            data: {
              ...timeData,
              revision: originalTime.revision + 1,
              previousTimeRevisionId: originalTime.id,
            },
          });
        }),
      ).rejects.toThrow('classified settlement revision requires its complete receipt');
      expect(await counts()).toEqual(before);
      await assertFixedE4Oracle(f.db, original.id, 0);
    } finally {
      await observer.$disconnect();
    }
  }, 120_000);

  for (const failureKind of ['callback_after_barrier', 'member_inactive_after_barrier'] as const) {
    it(`P-Barrier rolls back all seven actual same-command fact classes on ${failureKind}`, async () => {
      const source = await createE4Source(f);
      const command = {
        expectedDraftVersion: source.expectation.expectedDraftVersion,
        expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
        operationKey: f.key('barrier_rollback'),
        expectedTimeRevision: 0,
      };
      const observer = new PrismaClient();
      const failure = new Error('E4 controlled callback failure after successful named barrier');
      let anchors: { timeRevisionId: string; contributionRevisionId: string } | undefined;
      let barrierCompleted = false;
      const recorder = f.app.get(ActivityTimeSettlementAuditRecorder);
      const actualLog = recorder.log.bind(recorder);
      try {
        await assertConnectedTestDatabase(observer);
        jest.spyOn(recorder, 'log').mockImplementationOnce(async (...args) => {
          await actualLog(...args);
          const [tx, , , operation, result, replayed, proof] = args;
          expect(operation).toBe(TIME_SETTLEMENT_PREPARE_OPERATION);
          expect(replayed).toBe(false);
          if (!proof) throw new Error('Actual contribution root is required at the audit barrier');
          anchors = { timeRevisionId: result.timeRevisionId, contributionRevisionId: proof.id };
          expect(
            await tx.activitySettlementTimeCommandReceipt.count({
              where: { timeRevisionId: result.timeRevisionId, operationKey: command.operationKey },
            }),
          ).toBe(1);
          expect(
            await tx.auditLog.count({
              where: {
                actorUserId: f.creator.id,
                resourceId: source.activityId,
                event: 'activity.time-settlement.command',
              },
            }),
          ).toBe(1);
          const actualExecute = tx.$executeRaw.bind(tx);
          jest.spyOn(tx, '$executeRaw').mockImplementationOnce((query, ...values: unknown[]) => {
            const text = ('strings' in query ? query.strings : [...query])
              .join(' ')
              .replace(/\s+/gu, ' ')
              .trim();
            expect(text).toBe(
              'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE',
            );
            // Execute the actual PostgreSQL guards first; injection happens only after they succeed.
            return actualExecute(query, ...values).then(async (result) => {
              barrierCompleted = true;
              if (failureKind === 'callback_after_barrier') throw failure;
              // Separate connection commits a real membership change; final authorize must reread it.
              await observer.member.update({
                where: { id: f.creator.memberId },
                data: { status: MemberStatus.INACTIVE },
              });
              return result;
            }) as never;
          });
        });
        const operation = f.app
          .get(ActivityTimeSettlementService)
          .prepare(source.activityId, command, e4Actor(f.creator, true), E4_META);
        if (failureKind === 'callback_after_barrier') await expect(operation).rejects.toBe(failure);
        else await expect(operation).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
        expect(barrierCompleted).toBe(true);
        if (!anchors)
          throw new Error('The actual transaction did not reach its receipt/audit barrier');
        await assertSameCommandHasNoFacts(observer, source, command, anchors);
      } finally {
        jest.restoreAllMocks();
        await observer.$disconnect();
      }
    }, 120_000);
  }
});

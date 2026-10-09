import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  postE4Ledger,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';

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
describe('E4 current correction contribution proof: actual predecessor and actual D7 source', () => {
  let f: E4Fixture;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterEach(async () => {
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  async function base() {
    const source = await createE4Source(f);
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    await postE4Ledger(f, submitted);
    const result = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await assertFixedE4Oracle(f.db, proof.id, 1);
    return { source, submitted, result, proof };
  }

  async function applyFlag(
    b: Awaited<ReturnType<typeof base>>,
    versionId: string,
    lateFlag: boolean,
  ) {
    const previous = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: versionId, kindCode: { in: ['submitted', 'correction'] } },
    });
    const result = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: versionId, participationIdentityId: b.source.identity.id },
    });
    const correction = f.app.get(CorrectionApplicationService);
    const requested = await correction.submit(
      {
        activityId: b.source.activityId,
        participationIdentityId: b.source.identity.id,
        requestTypeCode: 'result',
        requestedChangeJson: {
          schemaVersion: 1,
          results: [
            {
              participationIdentityId: b.source.identity.id,
              resultCode: result.resultCode,
              lateFlag,
              earlyLeaveFlag: result.earlyLeaveFlag,
              recognizedServiceHours: result.recognizedServiceHours.toFixed(2),
              recognizedContributionPoints: result.recognizedContributionPoints.toFixed(2),
              adjustmentReason: '仅更正标记，不改变时间依据',
            },
          ],
          segments: [],
        },
        reason: '核实标记',
        operationKey: f.key('flag_request'),
        requestHash: 'e'.repeat(64),
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    await correction.review(
      { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    const input = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('flag_apply'),
      requestHash: 'f'.repeat(64),
    };
    const prepared = await correction.prepare(input, e4Actor(f.finalReviewer), E4_META);
    const own = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    expect(own.effectiveTimeSettlementVersionId).toBe(previous.effectiveTimeSettlementVersionId);
    expect(own.previousContributionRevisionId).toBe(previous.id);
    expect(own.evaluationSetHash).toBe(previous.evaluationSetHash);
    expect(own.sourceKindCode).toBe('unchanged_time');
    expect(own.timeRevisionId).toBeNull();
    expect(own.correctionTimeSourceProofId).toBeNull();
    await correction.commit(input, e4Actor(f.finalReviewer), E4_META);
    expect((await correction.commit(input, e4Actor(f.finalReviewer), E4_META)).replayed).toBe(true);
    const [timeBasis] = await f.db.$queryRaw<
      { effectiveVersionId: string; contributionRevisionId: string }[]
    >`
      SELECT * FROM e4_effective_time_base(${own.settlementVersionId}, ${b.source.activityId}, ${own.settlementRunId})
    `;
    expect(timeBasis).toEqual({
      effectiveVersionId: previous.effectiveTimeSettlementVersionId,
      contributionRevisionId: own.id,
    });
    await assertFixedE4Oracle(f.db, own.id, 1);
    return own;
  }

  async function applyTime(
    b: Awaited<ReturnType<typeof base>>,
    versionId: string,
    seconds: number,
  ) {
    const previous = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: versionId, kindCode: { in: ['submitted', 'correction'] } },
    });
    const segment = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
      where: {
        participationIdentityId: b.source.identity.id,
        statusCode: 'committed',
        resultCode: 'valid',
      },
      orderBy: { revision: 'desc' },
    });
    const latestAllocation = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { sourceSegmentId: segment.id },
      orderBy: { revision: 'desc' },
    });
    const allocation = await f.app.get(ActivityTimeAllocationService).recognize(
      b.source.activityId,
      {
        operationKey: f.key('current_allocation'),
        sourceSegmentId: segment.id,
        expectedRevision: latestAllocation.revision,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    const original = await f.db.participationTimeLedgerManifest.findFirstOrThrow({
      where: { settlementVersionId: b.submitted.settlementVersionId },
    });
    const timePredecessor = await f.db.participationTimeCorrectionManifest.findFirst({
      where: { settlementVersionId: previous.effectiveTimeSettlementVersionId },
    });
    const roots = await f.db.participationTimeLedgerEntry.findMany({
      where: { manifestId: original.id },
    });
    const correction = f.app.get(CorrectionApplicationService);
    const requested = await correction.submit(
      {
        activityId: b.source.activityId,
        participationIdentityId: b.source.identity.id,
        requestTypeCode: 'time',
        requestedChangeJson: {
          schemaVersion: 3,
          results: [],
          segments: [
            {
              participationIdentityId: b.source.identity.id,
              segmentKey: segment.segmentKey,
              checkInAt: b.source.startsAt.toISOString(),
              checkOutAt: new Date(b.source.startsAt.getTime() + seconds * 1000).toISOString(),
              resultCode: 'valid',
              serviceHours: (seconds / 3600).toFixed(2),
            },
          ],
          timeCorrection: {
            baseSettlementVersionId: versionId,
            baseTimeLedgerHash: timePredecessor?.contentHash ?? original.contentHash,
            reason: '核实时长',
            items: roots.map((root) => ({
              rootEntryId: root.id,
              recognizedSeconds:
                root.categoryCode === 'volunteer_service' ? seconds : root.recognizedSeconds,
            })),
          },
          allocations: [
            {
              participationIdentityId: b.source.identity.id,
              segmentKey: segment.segmentKey,
              baseSegmentRevisionId: segment.id,
              baseAllocationRevisionId: allocation.allocationRevisionId,
              recognitionModeCode: 'automatic',
              manualReason: null,
              slices: [],
              evidenceAttachmentIds: [],
            },
          ],
        },
        reason: '实际服务段时间更正',
        operationKey: f.key('time_request'),
        requestHash: 'e'.repeat(64),
      },
      e4Actor(f.creator, true),
      E4_META,
      { human: true },
    );
    await correction.review(
      { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    const input = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('time_apply'),
      requestHash: 'f'.repeat(64),
    };
    const prepared = await correction.prepare(input, e4Actor(f.finalReviewer), E4_META);
    const own = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    expect(own.effectiveTimeSettlementVersionId).toBe(own.settlementVersionId);
    expect(own.sourceKindCode).toBe('correction_time_proof');
    expect(own.previousContributionRevisionId).toBe(previous.id);
    const manifest = await f.db.participationTimeCorrectionManifest.findUniqueOrThrow({
      where: { id: own.correctionManifestId! },
    });
    expect(manifest.baseSettlementVersionId).toBe(versionId);
    expect(manifest.predecessorManifestId).toBe(timePredecessor?.id ?? null);
    expect(manifest.rootManifestId).toBe(original.id);
    await correction.commit(input, e4Actor(f.finalReviewer), E4_META);
    expect((await correction.commit(input, e4Actor(f.finalReviewer), E4_META)).replayed).toBe(true);
    expect(
      (
        await f.db.participantContributionEvaluation.findFirstOrThrow({
          where: { contributionRevisionId: own.id },
        })
      ).durationSeconds,
    ).toBe(seconds);
    await assertFixedE4Oracle(f.db, own.id, 1);
    return own;
  }

  it('makes a current own proof when time is unchanged and reverses/reposts without a second fixed award', async () => {
    const b = await base();
    const correction = f.app.get(CorrectionApplicationService);
    const requested = await correction.submit(
      {
        activityId: b.source.activityId,
        participationIdentityId: b.source.identity.id,
        requestTypeCode: 'result',
        requestedChangeJson: {
          schemaVersion: 1,
          results: [
            {
              participationIdentityId: b.source.identity.id,
              resultCode: 'present',
              lateFlag: true,
              earlyLeaveFlag: false,
              recognizedServiceHours: b.result.recognizedServiceHours.toFixed(2),
              recognizedContributionPoints: b.result.recognizedContributionPoints.toFixed(2),
              adjustmentReason: '核实迟到标记；时间和贡献评价未变',
            },
          ],
          segments: [],
        },
        reason: '修正迟到标记',
        operationKey: f.key('correction_submit'),
        requestHash: 'e'.repeat(64),
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    await correction.review(
      { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    const input = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('apply'),
      requestHash: 'f'.repeat(64),
    };
    const prepared = await correction.prepare(input, e4Actor(f.finalReviewer), E4_META);
    const own = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    expect(own).toMatchObject({
      kindCode: 'correction',
      sourceKindCode: 'unchanged_time',
      previousContributionRevisionId: b.proof.id,
      timeRevisionId: null,
      correctionTimeSourceProofId: null,
    });
    expect(own.id).not.toBe(b.proof.id);
    expect(own.evaluationSetHash).toBe(b.proof.evaluationSetHash);
    await assertFixedE4Oracle(f.db, own.id, 1);
    const committed = await correction.commit(input, e4Actor(f.finalReviewer), E4_META);
    expect(committed.replayed).toBe(false);
    expect((await correction.commit(input, e4Actor(f.finalReviewer), E4_META)).replayed).toBe(true);
    const entries = await f.db.participationLedgerEntry.findMany({
      where: {
        postingBatchId: prepared.newPostingBatchId,
        entryTypeCode: { in: ['contribution_credit', 'contribution_reversal'] },
      },
    });
    expect(
      entries.reduce((sum, row) => sum + Number(row.recognizedPointsDelta.toString()), 0),
    ).toBe(0);
    expect(entries.map((row) => row.entryTypeCode).sort()).toEqual([
      'contribution_credit',
      'contribution_reversal',
    ]);
    expect(
      (
        await f.db.memberContributionDayState.findFirstOrThrow({
          where: { memberId: b.source.identity.memberId },
        })
      ).committedCreditedPoints.toFixed(2),
    ).toBe('1.00');
    expect(
      await f.db.activitySettlementContributionRevision.count({
        where: { settlementVersionId: b.submitted.settlementVersionId },
      }),
    ).toBe(1);
  }, 120_000);

  it('reevaluates a shortened actual V3 service source and binds the new proof to that exact application', async () => {
    const b = await base();
    const committedSegment = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
      where: { participationIdentityId: b.source.identity.id, statusCode: 'committed' },
      orderBy: { revision: 'desc' },
    });
    const draftAllocation = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { sourceSegmentId: committedSegment.id },
      orderBy: { revision: 'desc' },
    });
    const allocation = await f.app.get(ActivityTimeAllocationService).recognize(
      b.source.activityId,
      {
        operationKey: f.key('committed_allocation'),
        sourceSegmentId: committedSegment.id,
        expectedRevision: draftAllocation.revision,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    const root = await f.db.participationTimeLedgerManifest.findFirstOrThrow({
      where: { settlementVersionId: b.submitted.settlementVersionId },
    });
    const roots = await f.db.participationTimeLedgerEntry.findMany({
      where: { manifestId: root.id },
    });
    const correctedEnd = new Date(b.source.endsAt.getTime() - 60_000);
    const correction = f.app.get(CorrectionApplicationService);
    const requested = await correction.submit(
      {
        activityId: b.source.activityId,
        participationIdentityId: b.source.identity.id,
        requestTypeCode: 'time',
        requestedChangeJson: {
          schemaVersion: 3,
          results: [],
          segments: [
            {
              participationIdentityId: b.source.identity.id,
              segmentKey: committedSegment.segmentKey,
              checkInAt: b.source.startsAt.toISOString(),
              checkOutAt: correctedEnd.toISOString(),
              resultCode: 'valid',
              serviceHours: '0.98',
            },
          ],
          timeCorrection: {
            baseSettlementVersionId: b.submitted.settlementVersionId,
            baseTimeLedgerHash: root.contentHash,
            reason: '核实结束时刻',
            items: roots.map((row) => ({
              rootEntryId: row.id,
              recognizedSeconds:
                row.categoryCode === 'volunteer_service' ? 3540 : row.recognizedSeconds,
            })),
          },
          allocations: [
            {
              participationIdentityId: b.source.identity.id,
              segmentKey: committedSegment.segmentKey,
              baseSegmentRevisionId: committedSegment.id,
              baseAllocationRevisionId: allocation.allocationRevisionId,
              recognitionModeCode: 'automatic',
              manualReason: null,
              slices: [],
              evidenceAttachmentIds: [],
            },
          ],
        },
        reason: '服务段时刻更正',
        operationKey: f.key('correction_submit'),
        requestHash: 'e'.repeat(64),
      },
      e4Actor(f.creator, true),
      E4_META,
      { human: true },
    );
    await correction.review(
      { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    const input = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('apply'),
      requestHash: 'f'.repeat(64),
    };
    const prepared = await correction.prepare(input, e4Actor(f.finalReviewer), E4_META);
    const own = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    expect(own).toMatchObject({
      sourceKindCode: 'correction_time_proof',
      correctionApplicationId: prepared.correctionApplicationId,
      correctionPostingBatchId: prepared.newPostingBatchId,
      baseSettlementVersionId: b.submitted.settlementVersionId,
      timeRevisionId: null,
    });
    expect(own.correctionTimeSourceProofId).not.toBeNull();
    expect(own.recognizedPointsTotal.toFixed(2)).toBe('0.50');
    const evaluation = await f.db.participantContributionEvaluation.findFirstOrThrow({
      where: { contributionRevisionId: own.id },
    });
    expect(evaluation.durationSeconds).toBe(3540);
    expect(evaluation.explanationCode).toBe('service_under_hour');
    await assertFixedE4Oracle(f.db, own.id, 1);
    await correction.commit(input, e4Actor(f.finalReviewer), E4_META);
    expect(
      (
        await f.db.memberContributionDayState.findFirstOrThrow({
          where: { memberId: b.source.identity.memberId },
        })
      ).committedCreditedPoints.toFixed(2),
    ).toBe('0.50');
  }, 120_000);
  it('keeps the actual initial time root through two unchanged versions and then a real V3 correction', async () => {
    const b = await base();
    const first = await applyFlag(b, b.submitted.settlementVersionId, true);
    const second = await applyFlag(b, first.settlementVersionId, false);
    expect(second.effectiveTimeSettlementVersionId).toBe(b.submitted.settlementVersionId);
    const changed = await applyTime(b, second.settlementVersionId, 3540);
    expect(changed.recognizedPointsTotal.toFixed(2)).toBe('0.50');
    expect(
      (
        await f.db.memberContributionDayState.findFirstOrThrow({
          where: { memberId: b.source.identity.memberId },
        })
      ).committedCreditedPoints.toFixed(2),
    ).toBe('0.50');
  }, 120_000);

  it('retains the latest real D7 predecessor after an unchanged version, without reversing the initial time root twice', async () => {
    const b = await base();
    const first = await applyTime(b, b.submitted.settlementVersionId, 3540);
    const flag = await applyFlag(b, first.settlementVersionId, true);
    expect(flag.effectiveTimeSettlementVersionId).toBe(first.settlementVersionId);
    const second = await applyTime(b, flag.settlementVersionId, 3480);
    expect(second.recognizedPointsTotal.toFixed(2)).toBe('0.50');
    const deltas = await f.db.participationTimeCorrectionEntry.findMany({
      where: { manifestId: second.correctionManifestId!, categoryCode: 'volunteer_service' },
      orderBy: { entryTypeCode: 'asc' },
    });
    expect(deltas.map((entry) => entry.secondsDelta)).toEqual([3480, -3540]);
    expect(
      deltas.find((entry) => entry.entryTypeCode === 'reversal')!.reversesCorrectionEntryId,
    ).not.toBeNull();
    expect(
      (
        await f.db.memberContributionDayState.findFirstOrThrow({
          where: { memberId: b.source.identity.memberId },
        })
      ).committedCreditedPoints.toFixed(2),
    ).toBe('0.50');
  }, 120_000);
});

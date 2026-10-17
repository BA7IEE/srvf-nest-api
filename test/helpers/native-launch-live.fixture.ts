import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivitySettlementContributionRevision, PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { ContributionPolicyDefinition } from '../../src/modules/activities/activity-contribution-policy-definition';
import { httpServer } from './http-server';
import type { E4Fixture } from './activity-contribution-policy.fixture';
import {
  createNativeLaunchPublication,
  nativeLaunchRawInput,
  nativeLaunchSlices,
} from './activity-native-launch.fixture';

export type NativeLaunchObservation = {
  transport: 'http' | 'service';
  entry: string;
  status: number | null;
  bizCode: number | null;
};
export type NativeLaunchStage = (<T>(label: string, work: () => Promise<T>) => Promise<T>) & {
  observe?: (event: NativeLaunchObservation) => void;
};
export function observeNativeLaunchHttp(
  stage: NativeLaunchStage,
  entry: string,
  response: { status: number; body: { code?: unknown } },
) {
  stage.observe?.({
    transport: 'http',
    entry,
    status: response.status,
    bizCode: typeof response.body.code === 'number' ? response.body.code : null,
  });
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Both are valid closed V1 policies. Bytes runs first; its band shape also exceeds launch. */
export function nativeLaunchAdmissionPolicies() {
  const band = (maximum: number | null, explanation = 'service') => ({
    maxSecondsInclusive: maximum,
    recognizedPoints: '0.50',
    explanationCode: explanation,
  });
  const definition = (
    categories: ContributionPolicyDefinition['roleRules'][number]['categoryRules'],
  ) => ({
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'zero' },
    roleRules: [{ attendanceRoleCode: 'service', categoryRules: categories }],
  });
  return {
    shape: definition([
      {
        timeCategoryCode: 'volunteer_service',
        durationBands: [band(10), band(20), band(null)],
      },
    ]),
    bytes: definition(
      (['volunteer_service', 'training', 'organization', 'non_creditable'] as const).map(
        (timeCategoryCode) => ({
          timeCategoryCode,
          durationBands: Array.from({ length: 16 }, (_, index) =>
            band(index === 15 ? null : (index + 1) * 10, 'b'.repeat(64)),
          ),
        }),
      ),
    ),
  } satisfies Record<string, ContributionPolicyDefinition>;
}

/** Public publication/approval, real elapsed source window, raw punches and seal. */
export async function createNativeLaunchSealedSource(
  f: E4Fixture,
  population: number,
  stage: NativeLaunchStage,
  options: { contributionDefinition?: ContributionPolicyDefinition } = {},
) {
  const published = await createNativeLaunchPublication(f, population, stage, options);
  const raw = nativeLaunchRawInput(published, f.creator, population, f.key, new Date());
  await stage('RAW_SOURCE_OBSERVATIONS', () =>
    f.db.$transaction(
      async (tx) => {
        if (raw.members.length) await tx.member.createMany({ data: raw.members });
        await tx.activityRegistration.createMany({ data: raw.registrations });
        await tx.activityParticipationIdentity.createMany({ data: raw.identities });
        await tx.attendancePunchEvent.createMany({ data: raw.events });
        await tx.participantServiceSegmentRevision.createMany({ data: raw.segments });
      },
      { timeout: 30_000 },
    ),
  );
  const post = async (suffix: string, body: object = {}) => {
    const response = await request(httpServer(f.app))
      .post(published.appUrl + suffix)
      .set('Authorization', f.creator.auth)
      .send(body);
    observeNativeLaunchHttp(stage, suffix, response);
    assert(
      [200, 201].includes(response.status) && response.body.code === 0,
      'NATIVE_LAUNCH_HTTP_' + response.status + '_' + response.body.code,
    );
    return response.body.data;
  };
  const seal = await stage('REAL_SEAL', () => post('/evidence-seals'));
  return { ...published, post, raw, seal };
}

/** Positive sources continue through the first native admission, draft and allocations. */
export async function createNativeLaunchLiveSource(
  f: E4Fixture,
  population: number,
  stage: NativeLaunchStage,
  options: { contributionDefinition?: ContributionPolicyDefinition } = {},
) {
  const published = await createNativeLaunchSealedSource(f, population, stage, options);
  const { post, raw, seal } = published;
  const generated = await stage('REAL_GENERATE', () =>
    post('/settlement/generate', { operationKey: f.key('launch_generate') }),
  );
  assert.equal(generated.outcome, 'draft');
  const draft = await stage('ADMISSION_IO_89', () =>
    f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: generated.settlementVersionId },
    }),
  );
  assert.equal(draft.contributionRegimeCode, 'policy_v1');
  const expectation = {
    expectedDraftVersion: draft.version,
    expectedEvidenceSealId: seal.sealId as string,
    expectedEvidenceRevision: seal.evidenceRevision as number,
    expectedPopulationRevision: seal.populationRevision as number,
    expectedWorkflowRevision: seal.workflowRevision as number,
  };
  const segments = await stage('ADMISSION_IO_100', () =>
    f.db.participantServiceSegmentRevision.findMany({
      where: { identity: { activityId: published.activityId }, statusCode: { not: 'superseded' } },
      orderBy: { id: 'asc' },
    }),
  );
  assert.equal(segments.length, population);
  for (const segment of segments)
    await stage('REAL_ALLOCATE', () =>
      post('/time-settlement/allocations', {
        ...expectation,
        operationKey: f.key('launch_allocate'),
        sourceSegmentId: segment.id,
        expectedRevision: 0,
        recognitionModeCode: 'manual',
        manualReason: 'Isolated native launch complete four-category allocation',
        slices: nativeLaunchSlices(published.startsAt, published.endsAt),
        evidenceAttachmentIds: [],
      }),
    );
  return {
    ...published,
    post,
    raw,
    segments,
    expectation,
    draft,
    seal,
    prepare: {
      ...expectation,
      operationKey: f.key('launch_prepare'),
      expectedTimeRevision: 0,
    },
  };
}

/** All rows/columns from all 196 business tables, independently committed visibility. */
export async function nativeLaunchBusinessFingerprint(db: PrismaClient, stage: NativeLaunchStage) {
  const tables = await stage(
    'FINGERPRINT_TABLES',
    () => db.$queryRaw<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'_prisma_migrations'
    ORDER BY relname COLLATE "C"
  `,
  );
  assert.equal(tables.length, 196);
  const rows: { name: string; hash: string }[] = [];
  for (const { name } of tables) {
    const [row] = await stage('FINGERPRINT_TABLE', () =>
      db.$queryRawUnsafe<{ hash: string }[]>(
        'SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),\'[]\'::jsonb)::text) AS hash FROM public."' +
          name.replaceAll('"', '""') +
          '" t',
      ),
    );
    rows.push({ name, hash: row.hash });
  }
  return { tables: rows.length, hash: hash(JSON.stringify(rows)), rows };
}

/** Immutable original SQL oracle; no current evaluator output is used as expected data. */
export async function assertNativeLaunchFrozenOracle(
  db: PrismaClient,
  root: Pick<ActivitySettlementContributionRevision, 'id' | 'sourceKindCode'>,
  expectedCount: number,
  stage: NativeLaunchStage,
) {
  const source = readFileSync(
    resolve(__dirname, '../e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const extract = (name: string, pin: string) => {
    const matches = [
      ...source.matchAll(new RegExp('const ' + name + ' = String.raw`([\\s\\S]*?)`;', 'g')),
    ];
    assert.equal(matches.length, 1);
    assert.equal(hash(matches[0][1]), pin);
    return matches[0][1];
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const canonical = extract(
    'E4_P_CANONICAL_ORACLE_SQL',
    '1aaf91d632713dddaeb106ad4095ac5650aa65416841f8c865d2fd0020fa465b',
  ).replace(/\brevision_id\b/g, quote(root.id));
  const aggregate = extract(
    'E4_P_ROOT_ORACLE_SQL',
    'be771b78933b36e6d47e8fe81aa92bb626ac6b07423f6ae878988e85ee5af4af',
  )
    .replace('INTO counts,total,sources_hash,evaluations_hash FROM documents;', 'FROM documents')
    .replaceAll('root.id', quote(root.id))
    .replaceAll('root."sourceKindCode"', quote(root.sourceKindCode));
  const [result] = await stage('FROZEN_ORACLE', () =>
    db.$queryRawUnsafe<
      {
        oracleCount: number;
        storedCount: number;
        expectedDifferences: number;
        storedDifferences: number;
        rootMatches: boolean;
      }[]
    >(
      `WITH oracle(unit_canonical,evaluation) AS MATERIALIZED (${canonical}),
    actual(unit_canonical,evaluation) AS MATERIALIZED (SELECT * FROM e4_expected_evaluations(${quote(root.id)})),
    stored AS MATERIALIZED (SELECT e4_evaluation_document(e) AS evaluation FROM "ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=${quote(root.id)}),
    summary(counts,total,source_hash,evaluation_hash) AS (${aggregate})
    SELECT (SELECT count(*)::int FROM oracle) AS "oracleCount",
      (SELECT count(*)::int FROM stored) AS "storedCount",
      (SELECT count(*)::int FROM oracle o FULL JOIN actual a USING(unit_canonical) WHERE o.evaluation IS DISTINCT FROM a.evaluation) AS "expectedDifferences",
      (SELECT count(*)::int FROM oracle o FULL JOIN stored s ON o.evaluation->>'evaluationUnitKey'=s.evaluation->>'evaluationUnitKey' WHERE o.evaluation IS DISTINCT FROM s.evaluation) AS "storedDifferences",
      (SELECT counts=r."evaluationCount" AND total=r."recognizedPointsTotal"
        AND (r."sourceKindCode"='unchanged_time' OR source_hash=r."sourceSetHash")
        AND evaluation_hash=r."evaluationSetHash"
       FROM summary,"ActivitySettlementContributionRevision" r WHERE r.id=${quote(root.id)}) AS "rootMatches"`,
    ),
  );
  assert.deepEqual(result, {
    oracleCount: expectedCount,
    storedCount: expectedCount,
    expectedDifferences: 0,
    storedDifferences: 0,
    rootMatches: true,
  });
  const daySql = extract(
    'E4_P_DAY_ORACLE_SQL',
    'a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274',
  ).replace('CREATE FUNCTION e4_day_points(', 'CREATE FUNCTION pg_temp.native_launch_frozen_day(');
  const day = await stage('FROZEN_DAY_ORACLE', () =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(daySql);
        const [row] = await tx.$queryRawUnsafe<
          { evaluations: number; functionDifferences: number; storedDifferences: number }[]
        >(
          `SELECT count(*)::int AS evaluations,
          count(*) FILTER(WHERE pg_temp.native_launch_frozen_day("sourceRefsJson",("recognizedPoints"*100)::int)
            IS DISTINCT FROM public.e4_day_points("sourceRefsJson",("recognizedPoints"*100)::int))::int AS "functionDifferences",
          count(*) FILTER(WHERE pg_temp.native_launch_frozen_day("sourceRefsJson",("recognizedPoints"*100)::int)
            IS DISTINCT FROM "beijingDayPointsJson")::int AS "storedDifferences"
         FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${quote(root.id)}`,
        );
        await tx.$executeRawUnsafe('DROP FUNCTION pg_temp.native_launch_frozen_day(jsonb,integer)');
        return row;
      },
      { timeout: 30_000, maxWait: 2_000 },
    ),
  );
  assert.deepEqual(day, {
    evaluations: expectedCount,
    functionDifferences: 0,
    storedDifferences: 0,
  });
  return { ...result, day };
}

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  E4_MIGRATION_137,
  E4_MIGRATION_138,
  E4_MIGRATION_139,
} from '../helpers/e4-migration-prefix';

const reference = {
  allocationHash: 'quote" slash\\ tab\t newline\n 救援 é é 😀',
  allocationRevisionId: 'allocation',
  durationSeconds: 3600,
  endsAt: '2026-09-01T02:00:00.000Z',
  selectionItemId: 'selection',
  sliceId: 'slice',
  sourceSegmentId: 'segment',
  sourceSegmentRevision: 1,
  startsAt: '2026-09-01T01:00:00.000Z',
};
const complete = JSON.stringify(reference);
const corpus: (string | null)[] = [
  complete,
  JSON.stringify(Object.fromEntries(Object.entries(reference).reverse())),
  complete.replace('"durationSeconds":3600', '"durationSeconds":1.2300'),
  complete.replace('"durationSeconds":3600', '"durationSeconds":-1.25e-20'),
  complete.replace('"sourceSegmentRevision":1', '"sourceSegmentRevision":9007199254740993'),
  JSON.stringify(Object.fromEntries(Object.keys(reference).map((key) => [key, null]))),
  JSON.stringify(Object.fromEntries(Object.keys(reference).map((key) => [key, true]))),
  JSON.stringify(Object.fromEntries(Object.keys(reference).map((key) => [key, '']))),
  JSON.stringify({ ...reference, correctionSource: { id: 'correction' } }),
  JSON.stringify({ ...reference, unknown: null }),
  JSON.stringify(
    Object.fromEntries(Object.entries(reference).filter(([key]) => key !== 'sliceId')),
  ),
  JSON.stringify({ ...reference, sliceId: { id: 'nested' } }),
  JSON.stringify({ ...reference, durationSeconds: [3600] }),
  JSON.stringify({ ...reference, durationSeconds: [[3600]] }),
  '{}',
  '[]',
  '[{"sliceId":"slice"}]',
  '"scalar"',
  'true',
  '1.2300',
  'null',
  null,
];

function oldExpectedDefinition(): string {
  const migration = readFileSync(
    resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_137, 'migration.sql'),
    'utf8',
  );
  const definitions = [
    ...migration.matchAll(
      /CREATE FUNCTION e4_expected_evaluations\(revision_id TEXT\)[\s\S]*?\n\$\$;/gu,
    ),
  ];
  expect(definitions).toHaveLength(1);
  const definition = definitions[0][0];
  expect(createHash('sha256').update(definition).digest('hex')).toBe(
    '47bbe7aae8da7e51619533ff683a429121f42f0ee4c041bbc7c77d94ea53ddf0',
  );
  return definition;
}

async function migrations(db: PrismaClient) {
  return db.$queryRaw<{ name: string; checksum: string }[]>`
    SELECT migration_name AS name,checksum FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
  `;
}
async function catalog(db: PrismaClient) {
  return db.$queryRaw`
    SELECT to_jsonb(p)-'prosrc' AS metadata
    FROM pg_proc p WHERE p.oid='public.e4_expected_evaluations(text)'::regprocedure
  `;
}
async function constraints(db: PrismaClient) {
  return db.$queryRaw`
    SELECT to_jsonb(c)::text AS definition FROM pg_constraint c
    WHERE connamespace='public'::regnamespace ORDER BY oid
  `;
}
const businessTables = [
  'Activity',
  'ActivitySession',
  'ActivitySessionPosition',
  'ActivityParticipationIdentity',
  'ParticipantServiceSegmentRevision',
  'AttendanceSettlementRun',
  'AttendanceSettlementVersion',
  'ActivitySettlementTimeRevision',
  'ParticipantSettlementTimeBucket',
  'ParticipantSettlementTimeBucketSource',
  'ActivitySettlementContributionRevision',
  'ParticipantContributionEvaluation',
  'ActivitySettlementTimeCommandReceipt',
] as const;
async function businessSnapshot(db: PrismaClient) {
  const rows = [];
  for (const table of businessTables) {
    rows.push(
      await db.$queryRawUnsafe(
        "SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]'::jsonb)::text AS snapshot FROM \"" +
          table +
          '" row',
      ),
    );
  }
  return JSON.stringify(rows);
}
async function expectedDocuments(db: PrismaClient) {
  return db.$queryRaw<{ document: string }[]>`
    SELECT r.id,e.unit_canonical,e.evaluation::text AS document,
      astr_canonical_json(e.evaluation) AS canonical,
      encode(sha256(convert_to(astr_canonical_json(e.evaluation),'UTF8')),'hex') AS hash
    FROM "ActivitySettlementContributionRevision" r
    CROSS JOIN LATERAL e4_expected_evaluations(r.id) e
    ORDER BY r.id COLLATE "C",e.unit_canonical COLLATE "C",e.evaluation::text COLLATE "C"
  `;
}
async function verifyRootsAndOldOracle(db: PrismaClient) {
  const oracle = oldExpectedDefinition().replace(
    'CREATE FUNCTION e4_expected_evaluations(',
    'CREATE OR REPLACE FUNCTION pg_temp.e4_reference_old_expected(',
  );
  const facts = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE TEMP TABLE e4_reference_scope (id int) ON COMMIT DROP');
    await tx.$executeRawUnsafe(oracle);
    return tx.$queryRaw<{ expected: number; forward: number; backward: number; fields: number }[]>`
      WITH actual AS MATERIALIZED (
        SELECT r.id,e.* FROM "ActivitySettlementContributionRevision" r
        CROSS JOIN LATERAL public.e4_expected_evaluations(r.id) e
      ), original AS MATERIALIZED (
        SELECT r.id,e.* FROM "ActivitySettlementContributionRevision" r
        CROSS JOIN LATERAL pg_temp.e4_reference_old_expected(r.id) e
      )
      SELECT (SELECT count(*)::int FROM actual) AS expected,
        (SELECT count(*)::int FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM original) d) AS forward,
        (SELECT count(*)::int FROM (SELECT * FROM original EXCEPT ALL SELECT * FROM actual) d) AS backward,
        (SELECT count(*)::int FROM actual a WHERE
          (SELECT count(*) FROM jsonb_object_keys(a.evaluation)) <> 21) AS fields
    `;
  });
  expect(facts).toHaveLength(1);
  expect(facts[0].expected).toBeGreaterThan(0);
  expect(facts[0].forward).toBe(0);
  expect(facts[0].backward).toBe(0);
  expect(facts[0].fields).toBe(0);
  const [timeHashes] = await db.$queryRaw<{ mismatches: number }[]>`
    SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" r
    WHERE astr_bucket_content_hash(r.id) IS DISTINCT FROM r."bucketContentHash"
  `;
  expect(timeHashes.mismatches).toBe(0);
  await db.$queryRaw`
    SELECT e4_assert_complete(id)::text FROM "ActivitySettlementContributionRevision" ORDER BY id
  `;
}
async function verifyInstalledExpression(db: PrismaClient) {
  const [definition] = await db.$queryRaw<{ body: string }[]>`
    SELECT prosrc AS body FROM pg_proc
    WHERE oid='public.e4_expected_evaluations(text)'::regprocedure
  `;
  const expressions = [
    ...definition.body.matchAll(
      /SELECT source\.\*,([\s\S]*?) AS source_canonical FROM e4_source_rows\(revision_id\) source/gu,
    ),
  ];
  expect(expressions).toHaveLength(1);
  const expression = expressions[0][1];
  const results = await db.$queryRawUnsafe<{ cases: number; mismatches: number; fast: number }[]>(
    `WITH corpus AS MATERIALIZED (
       SELECT document::jsonb AS source_ref FROM unnest($1::text[]) AS c(document)
     ), comparisons AS (
       SELECT source_ref,(${expression}) AS actual,
         astr_canonical_json(source_ref) AS original FROM corpus
     )
     SELECT count(*)::int AS cases,
       count(*) FILTER (WHERE actual IS DISTINCT FROM original)::int AS mismatches,
       count(*) FILTER (WHERE CASE WHEN jsonb_typeof(source_ref)='object' THEN
         source_ref ?& $2::text[]
         AND source_ref - $2::text[] = '{}'::jsonb
         AND NOT jsonb_path_exists(source_ref,
           'strict $.* ? (@.type() == "object" || @.type() == "array")')
         ELSE false END)::int AS fast
     FROM comparisons`,
    corpus,
    Object.keys(reference),
  );
  expect(results).toEqual([{ cases: 22, mismatches: 0, fast: 8 }]);
}

describe('E4 reference canonical migration 139 nonempty upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  let fixture: E4Fixture | undefined;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployScalarMigrations();
    fixture = await createE4Fixture();
    const source = await createE4Source(fixture);
    const prepared = await prepareE4Time(fixture, source);
    await submitE4Time(fixture, source, prepared);
  });
  afterAll(async () => {
    try {
      await closeE13Fixture(fixture);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  it('preserves all 21 fields and hashes, business rows, constraints and function identity through 138 to 139 and no-op', async () => {
    if (!fixture) throw new Error('E4 nonempty upgrade fixture missing');
    const db = fixture.db;
    const beforeMigrations = await migrations(db);
    expect(beforeMigrations).toHaveLength(138);
    expect(beforeMigrations[137].name).toBe(E4_MIGRATION_138);
    const beforeCatalog = await catalog(db);
    const beforeConstraints = await constraints(db);
    const beforeBusiness = await businessSnapshot(db);
    const beforeDocuments = await expectedDocuments(db);
    expect(beforeDocuments.length).toBeGreaterThan(0);
    await verifyRootsAndOldOracle(db);

    owner.deployLatestMigrations();
    const afterMigrations = await migrations(db);
    expect(afterMigrations).toHaveLength(139);
    expect(JSON.stringify(afterMigrations.slice(0, 138)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[138].name).toBe(E4_MIGRATION_139);
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_139, 'migration.sql'),
    );
    expect(
      afterMigrations[138].checksum === createHash('sha256').update(candidate).digest('hex'),
    ).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await expectedDocuments(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
    await verifyRootsAndOldOracle(db);
    await verifyInstalledExpression(db);

    owner.deployLatestMigrations();
    expect(JSON.stringify(await migrations(db)) === JSON.stringify(afterMigrations)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect(JSON.stringify(await expectedDocuments(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
  });
});

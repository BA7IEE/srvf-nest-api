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
import { E4_MIGRATION_137, E4_MIGRATION_138 } from '../helpers/e4-migration-prefix';

const corpus = [
  null,
  'null',
  'true',
  'false',
  '0',
  '-0.0',
  '1.2300',
  '1e30',
  '-1.25e-20',
  '9007199254740993',
  '""',
  JSON.stringify('quote" slash\\ tab\t newline\n'),
  '"救援 é é 😀 \\u0001"',
  '{}',
  '[]',
  '{"z":null,"A":false,"a":true,"救援":1.2300,"é":"é","é":"é"}',
  '[null,true,false,0,1.2300,"",{},[]]',
  '{"outer":[{"b":[{"z":null,"a":["😀",true,1.2300]}],"a":{}},[]]}',
];

function oldCanonicalDefinition(): string {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql',
    ),
    'utf8',
  );
  const definitions = [
    ...migration.matchAll(
      /CREATE FUNCTION astr_canonical_json\(value JSONB\) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS \$\$[\s\S]*?\n\$\$;/gu,
    ),
  ];
  expect(definitions).toHaveLength(1);
  return definitions[0][0];
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
    FROM pg_proc p WHERE p.oid='public.astr_canonical_json(jsonb)'::regprocedure
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
    const result = await db.$queryRawUnsafe(
      "SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]'::jsonb)::text AS snapshot FROM \"" +
        table +
        '" row',
    );
    rows.push(result);
  }
  return JSON.stringify(rows);
}

// Complete canonical bytes and their SHA are computed for real stored documents;
// results remain private to the comparison and only mismatching counts are asserted.
async function documentFingerprints(db: PrismaClient) {
  return db.$queryRaw`
    WITH documents AS (
      SELECT 'time' AS kind,t.id,to_jsonb(t) AS document
        FROM "ActivitySettlementTimeRevision" t
      UNION ALL SELECT 'bucket',t.id,to_jsonb(t) FROM "ParticipantSettlementTimeBucket" t
      UNION ALL SELECT 'bucket_source',t.id,to_jsonb(t) FROM "ParticipantSettlementTimeBucketSource" t
      UNION ALL SELECT 'contribution',t.id,to_jsonb(t) FROM "ActivitySettlementContributionRevision" t
      UNION ALL SELECT 'evaluation',t.id,to_jsonb(t) FROM "ParticipantContributionEvaluation" t
      UNION ALL SELECT 'version',t.id,to_jsonb(t) FROM "AttendanceSettlementVersion" t
    )
    SELECT kind,id,astr_canonical_json(document) AS canonical,
      encode(sha256(convert_to(astr_canonical_json(document),'UTF8')),'hex') AS hash
      FROM documents ORDER BY kind COLLATE "C",id COLLATE "C"
  `;
}

async function verifyRealRoots(db: PrismaClient) {
  const [facts] = await db.$queryRaw<
    { times: number; contributions: number; evaluations: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM "ActivitySettlementTimeRevision") AS times,
      (SELECT count(*)::int FROM "ActivitySettlementContributionRevision") AS contributions,
      (SELECT count(*)::int FROM "ParticipantContributionEvaluation") AS evaluations
  `;
  expect(facts.times).toBeGreaterThan(0);
  expect(facts.contributions).toBeGreaterThan(0);
  expect(facts.evaluations).toBeGreaterThan(0);
  const [timeHashes] = await db.$queryRaw<{ mismatches: number }[]>`
    SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" r
    WHERE astr_bucket_content_hash(r.id) IS DISTINCT FROM r."bucketContentHash"
  `;
  expect(timeHashes.mismatches).toBe(0);
  await db.$queryRaw`
    SELECT e4_assert_complete(id)::text FROM "ActivitySettlementContributionRevision" ORDER BY id
  `;
}

describe('E4 canonical scalar migration 138 nonempty upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  let fixture: E4Fixture | undefined;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(() => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
  });
  afterAll(async () => {
    try {
      await closeE13Fixture(fixture);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  it('preserves canonical bytes, hashes, business rows, function identity and privileges through 137 to 138 and no-op', async () => {
    owner.deployCurrentMigrations();
    fixture = await createE4Fixture();
    const source = await createE4Source(fixture);
    const prepared = await prepareE4Time(fixture, source);
    await submitE4Time(fixture, source, prepared);
    const db = fixture.db;
    const beforeMigrations = await migrations(db);
    expect(beforeMigrations).toHaveLength(137);
    expect(beforeMigrations[136].name).toBe(E4_MIGRATION_137);
    const beforeCatalog = await catalog(db);
    const beforeBusiness = await businessSnapshot(db);
    const beforeDocuments = await documentFingerprints(db);
    await verifyRealRoots(db);

    const oldDefinition = oldCanonicalDefinition();
    const oracle = oldDefinition
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      .replaceAll('astr_canonical_json(', 'pg_temp.e4_old_canonical(');
    const oracleHash = createHash('sha256').update(oldDefinition).digest('hex');
    expect(oracleHash).toBe('9f9bf45e972f24970c7000f317dfaf54089b33485ca6e003344f69e5a9aa187a');
    const beforeCorpus = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE e4_canonical_scope (id int) ON COMMIT DROP');
      await tx.$executeRawUnsafe(oracle);
      return tx.$queryRawUnsafe(
        `SELECT ordinal::int,
          astr_canonical_json(document::jsonb) AS canonical,
          astr_canonical_json(document::jsonb) IS NOT DISTINCT FROM
            pg_temp.e4_old_canonical(document::jsonb) AS equal
          FROM unnest($1::text[]) WITH ORDINALITY AS c(document,ordinal)
          ORDER BY ordinal`,
        corpus,
      );
    });
    expect((beforeCorpus as { equal: boolean }[]).every((row) => row.equal)).toBe(true);

    owner.deployScalarMigrations();
    const afterMigrations = await migrations(db);
    expect(afterMigrations).toHaveLength(138);
    expect(JSON.stringify(afterMigrations.slice(0, 137)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[137].name).toBe(E4_MIGRATION_138);
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_138, 'migration.sql'),
    );
    expect(
      afterMigrations[137].checksum === createHash('sha256').update(candidate).digest('hex'),
    ).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await documentFingerprints(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
    await verifyRealRoots(db);

    const afterCorpus = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE e4_canonical_scope (id int) ON COMMIT DROP');
      await tx.$executeRawUnsafe(oracle);
      return tx.$queryRawUnsafe(
        `SELECT ordinal::int,
          astr_canonical_json(document::jsonb) AS canonical,
          astr_canonical_json(document::jsonb) IS NOT DISTINCT FROM
            pg_temp.e4_old_canonical(document::jsonb) AS equal
          FROM unnest($1::text[]) WITH ORDINALITY AS c(document,ordinal)
          ORDER BY ordinal`,
        corpus,
      );
    });
    expect(JSON.stringify(afterCorpus) === JSON.stringify(beforeCorpus)).toBe(true);
    expect((afterCorpus as { equal: boolean }[]).every((row) => row.equal)).toBe(true);

    owner.deployScalarMigrations();
    expect(JSON.stringify(await migrations(db)) === JSON.stringify(afterMigrations)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
  });
});

import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
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
import { E4_MIGRATION_141, E4_MIGRATION_142 } from '../helpers/e4-migration-prefix';

const CANDIDATE_SHA = 'bfac074c91474783f7b91f73b44e8ff431facef3f8139d1535a06c0fe45e6fa7';
const GUARD_MD5 = '21fe9ecf6df989a3f8fa5878df40b93c';
const namespace = 'e4_unit_oracle_' + randomBytes(8).toString('hex');
const keys = [
  'attendanceRoleCode',
  'definitionHash',
  'evaluatorVersion',
  'mode',
  'participationIdentityId',
  'policyId',
  'policyVersionId',
  'sessionId',
  'timeCategoryCode',
] as const;

// Raw JSON strings preserve PostgreSQL numeric precision, scale and normalization.
const scalars = [
  'null',
  'true',
  'false',
  '0',
  '-0.0',
  '1.2300',
  '1e30',
  '-1.25e-20',
  '9007199254740993',
  '9223372036854775807',
  '""',
  JSON.stringify('quote" slash\\ tab\t newline\n'),
  JSON.stringify('雪🙂 é é'),
  JSON.stringify('\u2028\u2029'),
  '"\\u0001"',
  JSON.stringify('  spaces  '),
];

function unit(overrides: Record<string, string> = {}, omit?: string, extra?: string) {
  const fields = [...keys]
    .reverse()
    .filter((key) => key !== omit)
    .map((key) => JSON.stringify(key) + ':' + (overrides[key] ?? JSON.stringify('unit-' + key)));
  if (extra) fields.push(extra);
  return '{' + fields.join(',') + '}';
}

function corpus() {
  const cases: { raw: string | null; fastRoot: boolean }[] = [];
  const add = (raw: string, fastRoot: boolean) => cases.push({ raw, fastRoot });
  for (const scalar of scalars) {
    add(unit(Object.fromEntries(keys.map((key): [string, string] => [key, scalar]))), true);
    for (const key of keys) add(unit({ [key]: scalar }), true);
  }
  for (const key of keys) {
    add(unit({}, key), false);
    add(unit({}, undefined, '"extra-' + key + '":null'), false);
    add(unit({}, key, '"extra-' + key + '":null'), false);
    for (const container of [
      '{}',
      '[]',
      '{"z":[9007199254740993,{"a":1.2300}]}',
      '[null,{"a":true}]',
    ])
      add(unit({ [key]: container }), false);
  }
  const originals = [...cases];
  for (const { raw } of originals) {
    // Exercise nested fast objects through both unchanged recursion branches and hash envelopes.
    add('{"definition":' + raw + ',"unknown":{"z":[],"a":null}}', false);
    add('[' + raw + ',' + raw + ',{"é":"é","A":false}]', false);
  }
  for (const raw of [...scalars, '{}', '[]', '{"é":1.2300,"A":true,"a":null}', '[null,true,{},[]]'])
    add(raw, false);
  for (let index = 0; index < originals.length; index += 7) cases.push(originals[index]);
  cases.push({ raw: null, fastRoot: false }); // SQL NULL remains distinct from JSON null.
  return cases;
}

function bodyOf(definition: string) {
  const parts = definition.split('$$');
  expect(parts).toHaveLength(3);
  return parts[1];
}

function frozenDefinition() {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql',
    ),
    'utf8',
  );
  const definitions = [
    ...source.matchAll(
      /CREATE FUNCTION astr_canonical_json\(value JSONB\) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS \$\$[\s\S]*?\n\$\$;/gu,
    ),
  ];
  expect(definitions).toHaveLength(1);
  const definition = definitions[0][0];
  expect(createHash('sha256').update(definition).digest('hex')).toBe(
    '9f9bf45e972f24970c7000f317dfaf54089b33485ca6e003344f69e5a9aa187a',
  );
  return definition;
}

async function migrationRows(db: PrismaClient) {
  return db.$queryRaw<{ name: string; checksum: string }[]>`
    SELECT migration_name AS name,checksum FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
  `;
}

async function publicCatalog(db: PrismaClient) {
  return db.$queryRaw`
    SELECT p.oid::text AS oid,
      CASE WHEN p.oid='public.astr_canonical_json(jsonb)'::regprocedure
        THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid
  `;
}

async function constraints(db: PrismaClient) {
  return db.$queryRaw`
    SELECT to_jsonb(c)::text AS definition FROM pg_constraint c
    WHERE connamespace='public'::regnamespace ORDER BY oid
  `;
}

async function indexes(db: PrismaClient) {
  return db.$queryRaw`
    SELECT oid::text AS oid,pg_get_indexdef(oid) AS definition FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid
  `;
}

async function businessSnapshot(db: PrismaClient) {
  const tables = await db.$queryRaw<{ name: string }[]>`
    SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relkind='r' AND relname <> '_prisma_migrations' ORDER BY relname COLLATE "C"
  `;
  expect(tables.length).toBeGreaterThanOrEqual(196);
  const snapshots = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const rows = await db.$queryRawUnsafe<{ snapshot: string }[]>(
      'SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text COLLATE "C"),\'[]\'::jsonb)::text AS snapshot FROM public.' +
        quoted +
        ' row',
    );
    snapshots.push({ table: name, snapshot: rows[0].snapshot });
  }
  // Only booleans/counts enter assertions and logs; private rows never enter failure output.
  return JSON.stringify(snapshots);
}

async function documentFingerprints(db: PrismaClient) {
  return db.$queryRaw`
    WITH documents AS (
      SELECT 'time' AS kind,t.id,to_jsonb(t) AS document FROM "ActivitySettlementTimeRevision" t
      UNION ALL SELECT 'bucket',t.id,to_jsonb(t) FROM "ParticipantSettlementTimeBucket" t
      UNION ALL SELECT 'bucket_source',t.id,to_jsonb(t) FROM "ParticipantSettlementTimeBucketSource" t
      UNION ALL SELECT 'contribution',t.id,to_jsonb(t) FROM "ActivitySettlementContributionRevision" t
      UNION ALL SELECT 'evaluation',t.id,to_jsonb(t) FROM "ParticipantContributionEvaluation" t
      UNION ALL SELECT 'version',t.id,to_jsonb(t) FROM "AttendanceSettlementVersion" t
    ) SELECT kind,id,encode(convert_to(astr_canonical_json(document),'UTF8'),'hex') AS bytes,
      encode(sha256(convert_to(astr_canonical_json(document),'UTF8')),'hex') AS hash
      FROM documents ORDER BY kind COLLATE "C",id COLLATE "C"
  `;
}

async function verifyRealRoots(db: PrismaClient) {
  const [facts] = await db.$queryRaw<
    { times: number; contributions: number; evaluations: number }[]
  >`
    SELECT (SELECT count(*)::int FROM "ActivitySettlementTimeRevision") AS times,
      (SELECT count(*)::int FROM "ActivitySettlementContributionRevision") AS contributions,
      (SELECT count(*)::int FROM "ParticipantContributionEvaluation") AS evaluations
  `;
  expect(facts.times).toBeGreaterThan(0);
  expect(facts.contributions).toBeGreaterThan(0);
  expect(facts.evaluations).toBeGreaterThan(0);
  const [stored] = await db.$queryRaw<{ mismatches: number }[]>`
    SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" r
    WHERE astr_bucket_content_hash(r.id) IS DISTINCT FROM r."bucketContentHash"
  `;
  expect(stored.mismatches).toBe(0);
  await db.$queryRaw`
    SELECT e4_assert_complete(id)::text FROM "ActivitySettlementContributionRevision" ORDER BY id
  `;
  const [guard] = await db.$queryRaw<{ fingerprint: string }[]>`
    SELECT md5(prosrc) AS fingerprint FROM pg_proc
    WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
  `;
  expect(guard.fingerprint).toBe(GUARD_MD5);
}

async function verifyCorpus(db: PrismaClient) {
  const cases = corpus();
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const [facts] = await tx.$queryRawUnsafe<
        {
          cases: number;
          mismatches: number;
          hashMismatches: number;
          fastRoots: number;
          nullInputs: number;
          nullOutputs: number;
        }[]
      >(
        'WITH inputs AS MATERIALIZED (SELECT raw::jsonb AS value FROM unnest($1::text[]) AS x(raw)), ' +
          'documents AS MATERIALIZED (SELECT value,public.astr_canonical_json(value) AS actual,' +
          namespace +
          '.canonical121(value) AS original FROM inputs) ' +
          'SELECT count(*)::int AS cases,' +
          "count(*) FILTER (WHERE convert_to(actual,'UTF8') IS DISTINCT FROM convert_to(original,'UTF8'))::int AS mismatches," +
          "count(*) FILTER (WHERE sha256(convert_to(actual,'UTF8')) IS DISTINCT FROM sha256(convert_to(original,'UTF8')))::int AS \"hashMismatches\"," +
          "count(*) FILTER (WHERE CASE WHEN jsonb_typeof(value)='object' THEN value ?& $2::text[] AND value-$2::text[]='{}'::jsonb " +
          'AND NOT jsonb_path_exists(value,\'strict $.* ? (@.type() == "object" || @.type() == "array")\') ELSE false END)::int AS "fastRoots",' +
          'count(*) FILTER (WHERE value IS NULL)::int AS "nullInputs",count(*) FILTER (WHERE actual IS NULL)::int AS "nullOutputs" FROM documents',
        cases.map(({ raw }) => raw),
        [...keys],
      );
      expect(facts.cases).toBe(cases.length);
      expect(facts.mismatches).toBe(0);
      expect(facts.hashMismatches).toBe(0);
      expect(facts.fastRoots).toBe(cases.filter(({ fastRoot }) => fastRoot).length);
      expect(facts.fastRoots).toBeGreaterThan(0);
      expect(facts.cases - facts.fastRoots).toBeGreaterThan(0);
      expect(facts.nullInputs).toBe(1);
      expect(facts.nullOutputs).toBe(1);
      return facts;
    },
    { timeout: 5_000 },
  );
}

describe('E4 unit canonical helper migration 142 nonempty upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  let fixture: E4Fixture | undefined;
  let oracleInstalled = false;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployBucketMigrations();
    fixture = await createE4Fixture();
    const source = await createE4Source(fixture);
    const prepared = await prepareE4Time(fixture, source);
    await submitE4Time(fixture, source, prepared);
    if (!/^e4_unit_oracle_[a-f0-9]{16}$/u.test(namespace))
      throw new Error('E4 unit private oracle identifier invalid');
    const oracle = frozenDefinition().replaceAll(
      'astr_canonical_json(',
      namespace + '.canonical121(',
    );
    await fixture.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('CREATE SCHEMA ' + namespace);
        await tx.$executeRawUnsafe(oracle);
      },
      { timeout: 5_000 },
    );
    oracleInstalled = true;
  });
  afterAll(async () => {
    try {
      if (oracleInstalled && fixture)
        await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
    } finally {
      try {
        await closeE13Fixture(fixture);
      } finally {
        if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
      }
    }
  });

  it('preserves all business rows, stored roots, catalog, constraints, indexes and old checksums across nonempty141 to142 and no-op', async () => {
    if (!fixture) throw new Error('E4 unit upgrade fixture missing');
    const db = fixture.db;
    const beforeMigrations = await migrationRows(db);
    expect(beforeMigrations).toHaveLength(141);
    expect(beforeMigrations[140].name).toBe(E4_MIGRATION_141);
    const beforeCatalog = await publicCatalog(db);
    const beforeConstraints = await constraints(db);
    const beforeIndexes = await indexes(db);
    const beforeBusiness = await businessSnapshot(db);
    const beforeDocuments = await documentFingerprints(db);
    await verifyRealRoots(db);
    await verifyCorpus(db);

    owner.deployLatestMigrations();
    const afterMigrations = await migrationRows(db);
    expect(afterMigrations).toHaveLength(142);
    expect(JSON.stringify(afterMigrations.slice(0, 141)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[141].name).toBe(E4_MIGRATION_142);
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_142, 'migration.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(candidate).digest('hex')).toBe(CANDIDATE_SHA);
    expect(afterMigrations[141].checksum).toBe(CANDIDATE_SHA);
    const [installed] = await db.$queryRaw<{ body: string }[]>`
      SELECT prosrc AS body FROM pg_proc WHERE oid='public.astr_canonical_json(jsonb)'::regprocedure
    `;
    expect(installed.body === bodyOf(candidate)).toBe(true);
    expect(JSON.stringify(await publicCatalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect(JSON.stringify(await indexes(db)) === JSON.stringify(beforeIndexes)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await documentFingerprints(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
    await verifyRealRoots(db);
    await verifyCorpus(db);
    owner.deployLatestMigrations();
    expect(JSON.stringify(await migrationRows(db)) === JSON.stringify(afterMigrations)).toBe(true);
    expect(JSON.stringify(await publicCatalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect(JSON.stringify(await indexes(db)) === JSON.stringify(beforeIndexes)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await documentFingerprints(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
    await verifyRealRoots(db);
    console.info(
      'E4_UNIT142_NONEMPTY_UPGRADE',
      JSON.stringify({
        from: 141,
        to: 142,
        historicalChecksums: 141,
        businessUnchanged: true,
        rootsEquivalent: true,
        catalogUnchanged: true,
        indexesUnchanged: true,
        firstReviewPinUnchanged: true,
        noop: true,
      }),
    );
  });

  it('compares complete installed UTF8 bytes and hashes to independent frozen121 for scalars, exact units, missing/extra keys, every-key containers and nested arrays', async () => {
    if (!fixture) throw new Error('E4 unit corpus fixture missing');
    const migrations = await migrationRows(fixture.db);
    expect(migrations).toHaveLength(142);
    expect(migrations[141].name).toBe(E4_MIGRATION_142);
    const facts = await verifyCorpus(fixture.db);
    console.info('E4_UNIT142_TYPED_CORPUS', JSON.stringify(facts));
  });
});

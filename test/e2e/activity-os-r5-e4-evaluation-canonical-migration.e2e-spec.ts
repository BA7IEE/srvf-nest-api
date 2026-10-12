import { PrismaClient, Prisma } from '@prisma/client';
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
import {
  E4_MIGRATION_137,
  E4_MIGRATION_139,
  E4_MIGRATION_140,
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
  return db.$queryRaw<{ id: string; unit_canonical: string; document: string }[]>`
    SELECT r.id,e.unit_canonical,e.evaluation::text AS document,
      astr_canonical_json(e.evaluation) AS canonical,
      encode(sha256(convert_to(astr_canonical_json(e.evaluation),'UTF8')),'hex') AS hash
    FROM "ActivitySettlementContributionRevision" r
    CROSS JOIN LATERAL e4_expected_evaluations(r.id) e
    ORDER BY r.id COLLATE "C",e.unit_canonical COLLATE "C",e.evaluation::text COLLATE "C"
  `;
}
async function verifyRootsAndOldOracle(
  db: PrismaClient,
  namespace: string,
  prepare: boolean,
  installed: () => void,
  originalSnapshot?: string,
  firstActualDocuments?: { id: string; unit_canonical: string; document: string }[],
) {
  if (!/^e4_evaluation_oracle_[a-f0-9]{16}$/u.test(namespace))
    throw new Error('E4 private oracle namespace invalid');
  const oracle = oldExpectedDefinition().replace(
    'CREATE FUNCTION e4_expected_evaluations(',
    'CREATE FUNCTION ' + namespace + '.e4_evaluation_old_expected(',
  );
  if (!prepare && originalSnapshot === undefined)
    throw new Error('E4 original oracle snapshot missing');
  // Capture complete PostgreSQL text once, before upgrading the only changed function.
  // The fixture rows and every dependency of the fixed 137 oracle stay unchanged.
  // JSONB text retains numeric precision, nulls, nested fields and duplicate rows.
  const originalRows = prepare
    ? Prisma.sql`SELECT r.id,e.* FROM "ActivitySettlementContributionRevision" r
        CROSS JOIN LATERAL ${Prisma.raw(namespace + '.e4_evaluation_old_expected')}(r.id) e`
    : Prisma.sql`SELECT * FROM jsonb_to_recordset(${originalSnapshot}::jsonb)
        AS original(id text,unit_canonical text,evaluation jsonb)`;
  if (prepare && firstActualDocuments === undefined)
    throw new Error('E4 pre-upgrade actual documents missing');
  const actualRows = prepare
    ? Prisma.sql`SELECT id,unit_canonical,document::jsonb AS evaluation
        FROM jsonb_to_recordset(${JSON.stringify(firstActualDocuments)}::jsonb)
          AS actual(id text,unit_canonical text,document text)`
    : Prisma.sql`SELECT r.id,e.* FROM "ActivitySettlementContributionRevision" r
        CROSS JOIN LATERAL public.e4_expected_evaluations(r.id) e`;
  const facts = await db.$transaction(async (tx) => {
    if (prepare) {
      // Same original 5s transaction: install once, then retain this immutable
      // oracle across the public upgrade and pooled physical connections.
      await tx.$executeRawUnsafe('CREATE SCHEMA ' + namespace);
      await tx.$executeRawUnsafe(oracle);
    }
    return tx.$queryRaw<
      { expected: number; forward: number; backward: number; fields: number; original: string }[]
    >`
      WITH actual AS MATERIALIZED (
        ${actualRows}
      ), original AS MATERIALIZED (
        ${originalRows}
      )
      SELECT (SELECT count(*)::int FROM actual) AS expected,
        (SELECT count(*)::int FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM original) d) AS forward,
        (SELECT count(*)::int FROM (SELECT * FROM original EXCEPT ALL SELECT * FROM actual) d) AS backward,
        (SELECT count(*)::int FROM actual a WHERE
          (SELECT count(*) FROM jsonb_object_keys(a.evaluation)) <> 21) AS fields,
        (SELECT coalesce(jsonb_agg(to_jsonb(original)),'[]'::jsonb)::text FROM original) AS original
    `;
  });
  if (prepare) installed();
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
  return facts[0].original;
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

async function verifyEvaluationExpressions(db: PrismaClient) {
  const [definition] = await db.$queryRaw<{ body: string }[]>`
    SELECT prosrc AS body FROM pg_proc
    WHERE oid='public.e4_expected_evaluations(text)'::regprocedure
  `;
  const extract = (start: string, end: string) => {
    expect(definition.body.split(start)).toHaveLength(2);
    const tail = definition.body.split(start)[1];
    expect(tail.split(end)).toHaveLength(2);
    return tail.split(end)[0];
  };
  const unitExpression = extract(
    'g.representative,g.seconds,g.refs_canonical,resolved.result,',
    ' AS unit,',
  );
  const keyExpression = extract("'evaluationUnitKey',", ",'durationSeconds',seconds");
  const leafExpression = extract(
    'SELECT key AS field_name,',
    ' AS field_canonical FROM jsonb_each(metadata)',
  );
  const values = [
    '',
    'ascii',
    'quote" slash\\',
    'a\nb\tc',
    '雪🙂',
    '\u2028\u2029',
    '\u0001',
    '  space ',
    'x'.repeat(64),
    null,
  ];
  const fields = [
    'identity_id',
    'session_id',
    'policy_id',
    'policy_version_id',
    'definition_hash',
    'role_code',
    'category_code',
  ];
  const units = [];
  for (let n = 0; n < values.length; n++) {
    for (const integer of [null, -2147483648, -1, 0, 1, 2147483647]) {
      units.push({
        ...Object.fromEntries(
          fields.map((field, index) => [field, values[(n + index) % values.length]]),
        ),
        evaluator_version: integer,
      });
    }
  }
  const keyInputs = [
    null,
    '',
    'ascii',
    'quote" slash\\',
    '雪🙂',
    '\u2028\u2029',
    'a\nb\tc',
    '\u0001',
    '  space ',
    'x'.repeat(64),
    '{"unit":"nested"}',
    '[1,2]',
  ];
  // Raw text is parsed by PostgreSQL, including numbers outside JS precision.
  const leaves: (string | null)[] = [
    null,
    'null',
    'true',
    'false',
    '""',
    '"quote\\" slash\\\\"',
    '"雪🙂"',
    '"a\\nb\\tc"',
    '"\\u0001"',
    '-2147483648',
    '2147483647',
    '9007199254740993',
    '1.2300',
    '-1.25e-20',
    '1e300',
    '{}',
    '[]',
    '{"z":1.2300,"a":null}',
    '[1.2300,null,true]',
    '{"unknown":{"z":[9007199254740993,{"a":"雪"}]}}',
    '[{"b":2,"a":1},[]]',
    '{"é":"é","a":"\\u2028"}',
  ];
  const results = await db.$queryRawUnsafe<
    {
      units: number;
      unitMismatches: number;
      keys: number;
      keyMismatches: number;
      leaves: number;
      leafMismatches: number;
    }[]
  >(
    `WITH inputs AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS g(
        identity_id text,session_id text,policy_id text,policy_version_id text,
        definition_hash text,evaluator_version integer,role_code text,category_code text)
    ), units AS MATERIALIZED (
      SELECT (${unitExpression}) AS unit,
        astr_canonical_json(jsonb_build_object(
          'participationIdentityId',g.identity_id,'sessionId',g.session_id,
          'policyId',g.policy_id,'policyVersionId',g.policy_version_id,
          'definitionHash',g.definition_hash,'evaluatorVersion',g.evaluator_version,
          'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code,
          'mode','policy')) AS original FROM inputs g
    ), key_inputs AS MATERIALIZED (
      SELECT unit FROM units UNION ALL SELECT unit FROM unnest($2::text[]) c(unit)
    ), keys AS (
      SELECT (${keyExpression}) AS actual,
        e4_envelope_hash(jsonb_build_object('unit',unit)) AS original FROM key_inputs
    ), leaf_inputs AS MATERIALIZED (
      SELECT document::jsonb AS value FROM unnest($3::text[]) c(document)
    ), leaves AS (
      SELECT (${leafExpression}) AS actual,
        astr_canonical_json(value) AS original FROM leaf_inputs
    )
    SELECT (SELECT count(*)::int FROM units) AS units,
      (SELECT count(*)::int FROM units WHERE unit IS DISTINCT FROM original) AS "unitMismatches",
      (SELECT count(*)::int FROM keys) AS keys,
      (SELECT count(*)::int FROM keys WHERE actual IS DISTINCT FROM original) AS "keyMismatches",
      (SELECT count(*)::int FROM leaves) AS leaves,
      (SELECT count(*)::int FROM leaves WHERE actual IS DISTINCT FROM original) AS "leafMismatches"`,
    JSON.stringify(units),
    keyInputs,
    leaves,
  );
  expect(results).toEqual([
    {
      units: 60,
      unitMismatches: 0,
      keys: 72,
      keyMismatches: 0,
      leaves: 22,
      leafMismatches: 0,
    },
  ]);
}

describe('E4 evaluation canonical migration 140 nonempty upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  let fixture: E4Fixture | undefined;
  const namespace = 'e4_evaluation_oracle_' + randomBytes(8).toString('hex');
  let oracleInstalled = false;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployReferenceMigrations();
    fixture = await createE4Fixture();
    const source = await createE4Source(fixture);
    const prepared = await prepareE4Time(fixture, source);
    await submitE4Time(fixture, source, prepared);
  });
  afterAll(async () => {
    try {
      if (oracleInstalled && fixture) {
        await fixture.db.$executeRawUnsafe(
          'DROP FUNCTION ' + namespace + '.e4_evaluation_old_expected(TEXT)',
        );
        await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace);
      }
    } finally {
      try {
        await closeE13Fixture(fixture);
      } finally {
        if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
      }
    }
  });

  it('preserves all 21 fields and hashes, business rows, constraints and function identity through 139 to 140 and no-op', async () => {
    if (!fixture) throw new Error('E4 nonempty upgrade fixture missing');
    const db = fixture.db;
    const beforeMigrations = await migrations(db);
    expect(beforeMigrations).toHaveLength(139);
    expect(beforeMigrations[138].name).toBe(E4_MIGRATION_139);
    const beforeCatalog = await catalog(db);
    const beforeConstraints = await constraints(db);
    const beforeBusiness = await businessSnapshot(db);
    const beforeDocuments = await expectedDocuments(db);
    expect(beforeDocuments.length).toBeGreaterThan(0);
    const originalSnapshot = await verifyRootsAndOldOracle(
      db,
      namespace,
      true,
      () => {
        oracleInstalled = true;
      },
      undefined,
      beforeDocuments,
    );

    owner.deployEvaluationMigrations();
    const afterMigrations = await migrations(db);
    expect(afterMigrations).toHaveLength(140);
    expect(JSON.stringify(afterMigrations.slice(0, 139)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[139].name).toBe(E4_MIGRATION_140);
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_140, 'migration.sql'),
    );
    expect(
      afterMigrations[139].checksum === createHash('sha256').update(candidate).digest('hex'),
    ).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await expectedDocuments(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
    await verifyRootsAndOldOracle(
      db,
      namespace,
      false,
      () => {
        oracleInstalled = true;
      },
      originalSnapshot,
    );
    await verifyInstalledExpression(db);
    await verifyEvaluationExpressions(db);

    owner.deployEvaluationMigrations();
    expect(JSON.stringify(await migrations(db)) === JSON.stringify(afterMigrations)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect(JSON.stringify(await catalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect(JSON.stringify(await expectedDocuments(db)) === JSON.stringify(beforeDocuments)).toBe(
      true,
    );
  });
});

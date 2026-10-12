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
import { E4_MIGRATION_140, E4_MIGRATION_141 } from '../helpers/e4-migration-prefix';

const CANDIDATE_SHA = 'd10d495eb1e2bc9447f491fb7960eba0c58b8bfb3ab990803e57f676431658a4';
const FROZEN_121 = '20260913090000_activity_os_r4_d4_time_bucket_settlement';
const namespace = 'e4_bucket_oracle_' + randomBytes(8).toString('hex');

function frozenDefinition(name: 'astr_canonical_json' | 'astr_bucket_content_hash') {
  const source = readFileSync(
    resolve(__dirname, '../../prisma/migrations', FROZEN_121, 'migration.sql'),
    'utf8',
  );
  const definitions = [
    ...source.matchAll(new RegExp('CREATE FUNCTION ' + name + '\\([\\s\\S]*?\\n\\$\\$;', 'gu')),
  ];
  expect(definitions).toHaveLength(1);
  const definition = definitions[0][0];
  expect(createHash('sha256').update(definition).digest('hex')).toBe(
    name === 'astr_canonical_json'
      ? '9f9bf45e972f24970c7000f317dfaf54089b33485ca6e003344f69e5a9aa187a'
      : '191ee5cddd5a1c8ef8d5c4ba509630e9650f4935df270c873f2c75c22849016d',
  );
  return definition;
}

function bodyOf(definition: string) {
  const parts = definition.split('$$');
  expect(parts).toHaveLength(3);
  return parts[1];
}

/** Extract the complete installed expression; never rebuild the candidate by hand. */
function documentBody(body: string) {
  const start = 'SELECT encode(sha256(convert_to(';
  expect(body.split(start)).toHaveLength(2);
  const end = /,\s*'UTF8'\)\),\s*'hex'\)/gu;
  expect([...body.matchAll(end)]).toHaveLength(1);
  return body.replace(start, 'SELECT ').replace(end, '');
}

function oracleBody(body: string) {
  return body.replaceAll('astr_canonical_json(', namespace + '.canonical121(');
}

function corpusBody(body: string) {
  let result = body;
  for (const table of [
    'ParticipantSettlementTimeBucket',
    'ParticipantSettlementTimeBucketSource',
  ]) {
    const anchor = 'FROM "' + table + '"';
    expect(result.split(anchor)).toHaveLength(2);
    result = result.replace(anchor, 'FROM ' + namespace + '."' + table + '"');
  }
  return result;
}

async function createSqlFunction(tx: Prisma.TransactionClient, name: string, body: string) {
  if (!/^e4_bucket_oracle_[a-f0-9]{16}$/u.test(namespace) || !/^[a-z0-9_]+$/u.test(name))
    throw new Error('E4 bucket private oracle identifier invalid');
  await tx.$executeRawUnsafe(
    'CREATE FUNCTION ' +
      namespace +
      '.' +
      name +
      '(revision_id TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$' +
      body +
      '$$;',
  );
}

async function migrationRows(db: PrismaClient) {
  return db.$queryRaw<{ name: string; checksum: string }[]>`
    SELECT migration_name AS name,checksum FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
  `;
}

async function functionCatalog(db: PrismaClient) {
  return db.$queryRaw`
    SELECT p.oid::text AS oid,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
    WHERE p.oid IN ('public.astr_bucket_content_hash(text)'::regprocedure,
      'public.astr_canonical_json(jsonb)'::regprocedure) ORDER BY p.oid
  `;
}

async function constraints(db: PrismaClient) {
  return db.$queryRaw`
    SELECT to_jsonb(c)::text AS definition FROM pg_constraint c
    WHERE connamespace='public'::regnamespace ORDER BY oid
  `;
}

/** Include every public business table, including policy, allocation and fixture setup rows. */
async function businessSnapshot(db: PrismaClient) {
  const tables = await db.$queryRaw<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations'
    ORDER BY relname COLLATE "C"
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
  // Keep raw PostgreSQL text inside this boolean comparison, so failures never print sensitive rows.
  return JSON.stringify(snapshots);
}

async function installedBody(db: PrismaClient) {
  const [result] = await db.$queryRaw<{ body: string }[]>`
    SELECT prosrc AS body FROM pg_proc WHERE oid='public.astr_bucket_content_hash(text)'::regprocedure
  `;
  return result.body;
}

async function verifyBusinessRoots(db: PrismaClient, candidate: boolean) {
  const documents = await db.$transaction(
    async (tx) => {
      const documents = await tx.$queryRawUnsafe<{ id: string; document: string }[]>(
        'SELECT r.id,' +
          namespace +
          '.document121(r.id) AS document FROM "ActivitySettlementTimeRevision" r ORDER BY r.id COLLATE "C"',
      );
      expect(documents.length).toBeGreaterThan(0);
      const [facts] = await tx.$queryRawUnsafe<
        { cases: number; buckets: number; mismatches: number }[]
      >(
        'WITH ids AS MATERIALIZED (SELECT id FROM "ActivitySettlementTimeRevision" UNION ALL SELECT NULL::text UNION ALL SELECT \'bucket141-absent-revision\'), ' +
          'comparisons AS MATERIALIZED (SELECT id,public.astr_bucket_content_hash(id) AS actual,' +
          namespace +
          '.hash121(id) AS original,' +
          namespace +
          '.document121(id) AS old_document,' +
          namespace +
          (candidate ? '.document141' : '.document_before') +
          '(id) AS document FROM ids) ' +
          "SELECT count(*)::int AS cases,sum(jsonb_array_length(document::jsonb->'definition'))::int AS buckets," +
          'count(*) FILTER (WHERE actual IS DISTINCT FROM original OR document IS DISTINCT FROM old_document ' +
          "OR actual IS DISTINCT FROM encode(sha256(convert_to(document,'UTF8')),'hex'))::int AS mismatches FROM comparisons",
      );
      expect(facts.cases).toBe(documents.length + 2);
      expect(facts.buckets).toBeGreaterThan(0);
      expect(facts.mismatches).toBe(0);
      const [contributions] = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "ActivitySettlementContributionRevision"
    `;
      expect(contributions.count).toBeGreaterThan(0);
      await tx.$queryRaw`
      SELECT e4_assert_complete(id)::text FROM "ActivitySettlementContributionRevision" ORDER BY id
    `;
      const [stored] = await tx.$queryRaw<{ mismatches: number }[]>`
      SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" r
      WHERE astr_bucket_content_hash(r.id) IS DISTINCT FROM r."bucketContentHash"
    `;
      expect(stored.mismatches).toBe(0);
      return JSON.stringify(documents);
    },
    { timeout: 5_000 },
  );
  return documents;
}

const texts = [
  '',
  'ascii',
  'quote" slash\\ tab\t newline\n',
  '雪🙂 é é',
  '\u2028\u2029',
  '\u0001',
  '  spaces  ',
];
const integers = [null, -2147483648, -1, 0, 1, 2147483647];
const bigints = [
  null,
  '-9223372036854775808',
  '-9007199254740993',
  '0',
  '9007199254740993',
  '9223372036854775807',
];
// These are raw JSON texts. PostgreSQL parses numbers without a JS Number round-trip.
const adjustments = [
  null,
  'null',
  'true',
  'false',
  '1.2300',
  '-1.25e-20',
  '9007199254740993',
  '"quote\\" slash\\\\"',
  '"雪🙂 é é"',
  '{"unknown":{"z":[9007199254740993,{"a":1.2300}]}}',
  '[{"z":1,"a":null},{"a":true},[]]',
  '{"é":"é","a":"\\u2028","controls":"\\u0001"}',
];
const orderedIds = ['é', 'a', 'Z', 'A', 'é', '雪'];

function typedCorpus() {
  const buckets = [];
  const sources = [];
  const revisions = [];
  for (let n = 0; n < 600; n++) {
    const revision = 'bucket141-corpus-' + n;
    revisions.push(revision);
    for (let j = 0; j < n % 9; j++) {
      const id = revision + ':' + j;
      const text = texts[(n + j) % texts.length];
      const bucket = {
        id,
        timeRevisionId: revision,
        participationIdentityId: orderedIds[Math.floor(j / 4)],
        categoryCode: ['non_creditable', 'organization', 'training', 'volunteer_service'][j % 4],
        calculatedSeconds: integers[(n + j) % integers.length],
        recognizedSeconds: integers[(n + j + 1) % integers.length],
        timePolicyVersionId: n % 3 ? text : null,
        definitionHash: n % 4 ? text : null,
        evaluatorVersion: integers[(n + j + 2) % integers.length],
        quantumSeconds: integers[(n + j + 3) % integers.length],
        rawCalculatedMilliseconds: bigints[(n + j) % bigints.length],
        rawRecognizedMilliseconds: bigints[(n + j + 1) % bigints.length],
        adjustmentText: adjustments[(n + j) % adjustments.length],
      };
      buckets.push(bucket);
      const bucketSources = [];
      for (let k = 0; k < (n + j) % 5; k++) {
        bucketSources.push({
          bucketId: id,
          timeRevisionId: revision,
          allocationRevisionId: orderedIds[k],
          sourceSegmentId: text,
          sourceSegmentRevision: integers[(n + k) % integers.length],
          rawCalculatedMilliseconds: bigints[(n + k) % bigints.length],
          rawRecognizedMilliseconds: bigints[(n + k + 1) % bigints.length],
        });
      }
      sources.push(...bucketSources);
      // A mismatched revision must be filtered inside the aggregate, even for a matching bucket.
      sources.push({
        bucketId: id,
        timeRevisionId: 'bucket141-wrong-revision',
        allocationRevisionId: 'ignored',
        sourceSegmentId: 'ignored',
        sourceSegmentRevision: 1,
        rawCalculatedMilliseconds: '1',
        rawRecognizedMilliseconds: '1',
      });
      // A same-revision source from another bucket must not enter this bucket's array.
      sources.push({
        bucketId: 'bucket141-absent-' + id,
        timeRevisionId: revision,
        allocationRevisionId: 'ignored-other-bucket',
        sourceSegmentId: 'ignored',
        sourceSegmentRevision: 1,
        rawCalculatedMilliseconds: '1',
        rawRecognizedMilliseconds: '1',
      });
      if (n % 19 === 0) {
        // Duplicate identical canonical records preserve bag multiplicity without unspecified tie ordering.
        const duplicateId = id + ':duplicate';
        buckets.push({ ...bucket, id: duplicateId });
        sources.push(...bucketSources.map((source) => ({ ...source, bucketId: duplicateId })));
      }
    }
  }
  return { buckets, sources, revisions };
}

async function verifyTypedCorpus(db: PrismaClient, body: string) {
  const corpus = typedCorpus();
  const old = oracleBody(bodyOf(frozenDefinition('astr_bucket_content_hash')));
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TABLE ' +
          namespace +
          '."ParticipantSettlementTimeBucket" (' +
          'id text,"timeRevisionId" text,"participationIdentityId" text,"categoryCode" text,' +
          '"calculatedSeconds" integer,"recognizedSeconds" integer,"timePolicyVersionId" text,' +
          '"definitionHash" text,"evaluatorVersion" integer,"quantumSeconds" integer,' +
          '"rawCalculatedMilliseconds" bigint,"rawRecognizedMilliseconds" bigint,"adjustmentReason" jsonb)',
      );
      await tx.$executeRawUnsafe(
        'CREATE TABLE ' +
          namespace +
          '."ParticipantSettlementTimeBucketSource" (' +
          '"bucketId" text,"timeRevisionId" text,"allocationRevisionId" text,"sourceSegmentId" text,' +
          '"sourceSegmentRevision" integer,"rawCalculatedMilliseconds" bigint,"rawRecognizedMilliseconds" bigint)',
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO ' +
          namespace +
          '."ParticipantSettlementTimeBucket" ' +
          'SELECT id,"timeRevisionId","participationIdentityId","categoryCode","calculatedSeconds","recognizedSeconds",' +
          '"timePolicyVersionId","definitionHash","evaluatorVersion","quantumSeconds",' +
          '"rawCalculatedMilliseconds","rawRecognizedMilliseconds","adjustmentText"::jsonb ' +
          'FROM jsonb_to_recordset($1::jsonb) AS b(id text,"timeRevisionId" text,"participationIdentityId" text,' +
          '"categoryCode" text,"calculatedSeconds" integer,"recognizedSeconds" integer,"timePolicyVersionId" text,' +
          '"definitionHash" text,"evaluatorVersion" integer,"quantumSeconds" integer,' +
          '"rawCalculatedMilliseconds" bigint,"rawRecognizedMilliseconds" bigint,"adjustmentText" text)',
        JSON.stringify(corpus.buckets),
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO ' +
          namespace +
          '."ParticipantSettlementTimeBucketSource" ' +
          'SELECT * FROM jsonb_to_recordset($1::jsonb) AS s("bucketId" text,"timeRevisionId" text,' +
          '"allocationRevisionId" text,"sourceSegmentId" text,"sourceSegmentRevision" integer,' +
          '"rawCalculatedMilliseconds" bigint,"rawRecognizedMilliseconds" bigint)',
        JSON.stringify(corpus.sources),
      );
      await tx.$executeRawUnsafe(
        'CREATE INDEX ON ' + namespace + '."ParticipantSettlementTimeBucket" ("timeRevisionId")',
      );
      await tx.$executeRawUnsafe(
        'CREATE INDEX ON ' +
          namespace +
          '."ParticipantSettlementTimeBucketSource" ("bucketId","allocationRevisionId")',
      );
      await createSqlFunction(tx, 'corpus_hash141', corpusBody(body));
      await createSqlFunction(tx, 'corpus_hash121', corpusBody(old));
      await createSqlFunction(tx, 'corpus_document141', corpusBody(documentBody(body)));
      await createSqlFunction(tx, 'corpus_document121', corpusBody(documentBody(old)));
      const [facts] = await tx.$queryRawUnsafe<
        { cases: number; mismatches: number; buckets: number; empty: number }[]
      >(
        'WITH documents AS MATERIALIZED (SELECT id,' +
          namespace +
          '.corpus_document141(id) AS actual,' +
          namespace +
          '.corpus_document121(id) AS original,' +
          namespace +
          '.corpus_hash141(id) AS hash141,' +
          namespace +
          '.corpus_hash121(id) AS hash121 FROM unnest($1::text[]) AS ids(id)) ' +
          "SELECT count(*)::int AS cases,sum(jsonb_array_length(actual::jsonb->'definition'))::int AS buckets," +
          "count(*) FILTER (WHERE actual::jsonb->'definition'='[]'::jsonb)::int AS empty," +
          'count(*) FILTER (WHERE actual IS DISTINCT FROM original OR hash141 IS DISTINCT FROM hash121 ' +
          "OR hash141 IS DISTINCT FROM encode(sha256(convert_to(actual,'UTF8')),'hex'))::int AS mismatches FROM documents",
        [...corpus.revisions, null, 'bucket141-corpus-absent'],
      );
      expect(facts.cases).toBe(602);
      expect(facts.buckets).toBe(corpus.buckets.length);
      expect(facts.empty).toBe(corpus.revisions.filter((_, n) => n % 9 === 0).length + 2);
      expect(facts.mismatches).toBe(0);
      // Pin preservation of duplicate arrays, C ordering, 13 bucket keys and all five source fields.
      const [shape] = await tx.$queryRawUnsafe<
        { invalid: number; sources: number; duplicates: number }[]
      >(
        'WITH documents AS MATERIALIZED (SELECT id,' +
          namespace +
          '.corpus_document141(id)::jsonb AS document ' +
          'FROM unnest($1::text[]) AS ids(id)), buckets AS MATERIALIZED (' +
          "SELECT id,ordinal,bucket FROM documents CROSS JOIN LATERAL jsonb_array_elements(document->'definition') WITH ORDINALITY AS b(bucket,ordinal)) " +
          'SELECT (SELECT count(*)::int FROM buckets WHERE (SELECT count(*) FROM jsonb_object_keys(bucket))<>13 ' +
          "OR EXISTS (SELECT 1 FROM jsonb_array_elements(bucket->'sources') s WHERE (SELECT count(*) FROM jsonb_object_keys(s))<>5)) AS invalid," +
          "(SELECT coalesce(sum(jsonb_array_length(bucket->'sources')),0)::int FROM buckets) AS sources," +
          '(SELECT count(*)::int FROM (SELECT id,bucket FROM buckets GROUP BY id,bucket HAVING count(*)>1) d) AS duplicates',
        corpus.revisions,
      );
      expect(shape.invalid).toBe(0);
      expect(shape.sources).toBe(
        corpus.sources.filter(
          (s) =>
            s.timeRevisionId !== 'bucket141-wrong-revision' &&
            !s.bucketId.startsWith('bucket141-absent-'),
        ).length,
      );
      expect(shape.duplicates).toBeGreaterThan(0);
      console.info(
        'E4_BUCKET141_TYPED_CORPUS',
        JSON.stringify({
          cases: facts.cases,
          canonicalMismatches: facts.mismatches,
          fieldsInvalid: shape.invalid,
          duplicates: shape.duplicates,
        }),
      );
    },
    { timeout: 5_000 },
  );
}

describe('E4 bucket canonical migration 141 nonempty upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  let fixture: E4Fixture | undefined;
  let oracleInstalled = false;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployEvaluationMigrations();
    fixture = await createE4Fixture();
    const source = await createE4Source(fixture);
    const prepared = await prepareE4Time(fixture, source);
    await submitE4Time(fixture, source, prepared);
    const db = fixture.db;
    const before = await installedBody(db);
    await db.$transaction(
      async (tx) => {
        if (!/^e4_bucket_oracle_[a-f0-9]{16}$/u.test(namespace))
          throw new Error('E4 private oracle namespace invalid');
        await tx.$executeRawUnsafe('CREATE SCHEMA ' + namespace);
        await tx.$executeRawUnsafe(
          frozenDefinition('astr_canonical_json').replaceAll(
            'astr_canonical_json(',
            namespace + '.canonical121(',
          ),
        );
        const old = oracleBody(bodyOf(frozenDefinition('astr_bucket_content_hash')));
        await createSqlFunction(tx, 'hash121', old);
        await createSqlFunction(tx, 'document121', documentBody(old));
        await createSqlFunction(tx, 'document_before', documentBody(before));
      },
      { timeout: 5_000 },
    );
    oracleInstalled = true;
  });
  afterAll(async () => {
    try {
      if (oracleInstalled && fixture) {
        // Only the randomly named private test namespace is removed; public objects stay untouched.
        await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
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

  it('preserves every business table, stored time and contribution roots, catalog, old checksums and no-op across 140 to 141', async () => {
    if (!fixture) throw new Error('E4 bucket upgrade fixture missing');
    const db = fixture.db;
    const beforeMigrations = await migrationRows(db);
    expect(beforeMigrations).toHaveLength(140);
    expect(beforeMigrations[139].name).toBe(E4_MIGRATION_140);
    const beforeCatalog = await functionCatalog(db);
    const beforeConstraints = await constraints(db);
    const beforeBusiness = await businessSnapshot(db);
    const beforeDocuments = await verifyBusinessRoots(db, false);
    owner.deployLatestMigrations();
    const afterMigrations = await migrationRows(db);
    expect(afterMigrations).toHaveLength(141);
    expect(JSON.stringify(afterMigrations.slice(0, 140)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[140].name).toBe(E4_MIGRATION_141);
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_141, 'migration.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(candidate).digest('hex')).toBe(CANDIDATE_SHA);
    expect(afterMigrations[140].checksum).toBe(CANDIDATE_SHA);
    const actualBody = await installedBody(db);
    expect(actualBody === bodyOf(candidate)).toBe(true);
    await db.$transaction((tx) => createSqlFunction(tx, 'document141', documentBody(actualBody)), {
      timeout: 5_000,
    });
    expect(JSON.stringify(await functionCatalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect((await verifyBusinessRoots(db, true)) === beforeDocuments).toBe(true);
    owner.deployLatestMigrations();
    expect(JSON.stringify(await migrationRows(db)) === JSON.stringify(afterMigrations)).toBe(true);
    expect(JSON.stringify(await functionCatalog(db)) === JSON.stringify(beforeCatalog)).toBe(true);
    expect(JSON.stringify(await constraints(db)) === JSON.stringify(beforeConstraints)).toBe(true);
    expect((await businessSnapshot(db)) === beforeBusiness).toBe(true);
    expect((await verifyBusinessRoots(db, true)) === beforeDocuments).toBe(true);
    console.info(
      'E4_BUCKET141_NONEMPTY_UPGRADE',
      JSON.stringify({
        from: 140,
        to: 141,
        historicalChecksums: 140,
        businessUnchanged: true,
        rootsEquivalent: true,
        catalogUnchanged: true,
        noop: true,
      }),
    );
  });

  it('compares complete installed canonical bytes and hashes to the frozen 121 chain over typed PostgreSQL scalar and nested JSON bags', async () => {
    if (!fixture) throw new Error('E4 bucket corpus fixture missing');
    const migrations = await migrationRows(fixture.db);
    expect(migrations).toHaveLength(141);
    expect(migrations[140].name).toBe(E4_MIGRATION_141);
    await verifyTypedCorpus(fixture.db, await installedBody(fixture.db));
  });
});

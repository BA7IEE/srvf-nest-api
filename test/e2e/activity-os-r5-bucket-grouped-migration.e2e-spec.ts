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
import {
  E4_MIGRATION_141,
  E4_MIGRATION_150,
  E4_MIGRATION_151,
} from '../helpers/e4-migration-prefix';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';

type Database = PrismaClient | Prisma.TransactionClient;
const CANDIDATE_SHA = '7b027fe0764525f7bc23500fd99d01ee363cc21b40c6654e492e4db35e502b54';
const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_151, 'migration.sql'),
  'utf8',
);
const original = readFileSync(
  resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_141, 'migration.sql'),
  'utf8',
);
const corpus = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/activity-bucket-grouped-boundaries.json'), 'utf8'),
) as {
  cases: Array<string | null>;
  buckets: unknown[];
  sources: unknown[];
};
const stage = async <T>(_label: string, work: () => Promise<T>) => work();
let pending = 0;
let failed = false;
let terminalUnknown = false;
let appClosed = true;

async function owned(work: () => Promise<void>) {
  if (pending) {
    terminalUnknown = true;
    throw new Error('Bucket151 prior work pending; resource terminal UNKNOWN');
  }
  if (failed || terminalUnknown)
    throw new Error('Bucket151 prior failure or UNKNOWN; further work refused');
  pending++;
  try {
    await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    pending--;
  }
}
function bodyOf(sql: string) {
  const parts = sql.split('$$');
  expect(parts).toHaveLength(3);
  return parts[1];
}
function documentBody(body: string) {
  const start = 'SELECT encode(sha256(convert_to(';
  const end = /,\s*'UTF8'\)\),\s*'hex'\)/gu;
  expect(body.split(start)).toHaveLength(2);
  expect([...body.matchAll(end)]).toHaveLength(1);
  return body.replace(start, 'SELECT ').replace(end, '');
}
async function installedBody(db: Database) {
  const [row] = await db.$queryRaw<
    { body: string }[]
  >`SELECT prosrc AS body FROM pg_proc WHERE oid='public.astr_bucket_content_hash(text)'::regprocedure`;
  return row.body;
}
async function migrationRows(db: Database) {
  return db.$queryRaw<
    { name: string; checksum: string }[]
  >`SELECT migration_name AS name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
}
async function catalog(db: Database) {
  const functions =
    await db.$queryRaw`SELECT p.oid::text AS oid,CASE WHEN p.oid='public.astr_bucket_content_hash(text)'::regprocedure THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`;
  const dependencies =
    await db.$queryRaw`SELECT to_jsonb(d)::text AS definition FROM pg_depend d WHERE (classid='pg_proc'::regclass AND objid='public.astr_bucket_content_hash(text)'::regprocedure) OR (refclassid='pg_proc'::regclass AND refobjid='public.astr_bucket_content_hash(text)'::regprocedure) ORDER BY to_jsonb(d)::text COLLATE "C"`;
  const constraints =
    await db.$queryRaw`SELECT to_jsonb(c)::text AS definition FROM pg_constraint c WHERE connamespace='public'::regnamespace ORDER BY oid`;
  const triggers =
    await db.$queryRaw`SELECT to_jsonb(t)::text AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`;
  const indexes =
    await db.$queryRaw`SELECT oid::text,pg_get_indexdef(oid) AS definition FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid`;
  const settings =
    await db.$queryRaw`SELECT name,setting FROM pg_settings WHERE name IN ('work_mem','hash_mem_multiplier','jit','plan_cache_mode','statement_timeout','lock_timeout','row_security') ORDER BY name`;
  return JSON.stringify({ functions, dependencies, constraints, triggers, indexes, settings });
}
async function createFunction(tx: Prisma.TransactionClient, name: string, body: string) {
  if (!/^bucket151_[a-z_]+$/u.test(name))
    throw new Error('Bucket151 private oracle identifier invalid');
  await tx.$executeRawUnsafe(
    'CREATE FUNCTION pg_temp.' +
      name +
      '(revision_id TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$' +
      body +
      '$$;',
  );
}
async function verifyRoots(db: PrismaClient) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE bucket151_marker(value INTEGER) ON COMMIT DROP`;
      await createFunction(tx, 'bucket151_original_document', documentBody(bodyOf(original)));
      await createFunction(tx, 'bucket151_actual_document', documentBody(await installedBody(tx)));
      const docs = await tx.$queryRaw<
        { id: string; canonical: string }[]
      >`SELECT id,pg_temp.bucket151_original_document(id) AS canonical FROM "ActivitySettlementTimeRevision" ORDER BY id COLLATE "C"`;
      expect(docs.length).toBeGreaterThan(0);
      const [facts] = await tx.$queryRaw<{ cases: number; mismatches: number }[]>`
      WITH ids AS (SELECT id FROM "ActivitySettlementTimeRevision" UNION ALL SELECT NULL::text UNION ALL SELECT 'bucket151-absent-revision'),
      pairs AS MATERIALIZED (SELECT id,pg_temp.bucket151_original_document(id) AS expected,pg_temp.bucket151_actual_document(id) AS actual,public.astr_bucket_content_hash(id) AS hash FROM ids)
      SELECT count(*)::int AS cases,count(*) FILTER (WHERE convert_to(expected,'UTF8') IS DISTINCT FROM convert_to(actual,'UTF8') OR hash IS DISTINCT FROM encode(sha256(convert_to(expected,'UTF8')),'hex'))::int AS mismatches FROM pairs`;
      expect(facts.cases).toBe(docs.length + 2);
      expect(facts.mismatches).toBe(0);
      const [stored] = await tx.$queryRaw<
        { mismatches: number }[]
      >`SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" WHERE astr_bucket_content_hash(id) IS DISTINCT FROM "bucketContentHash"`;
      expect(stored.mismatches).toBe(0);
      await tx.$executeRaw`DROP FUNCTION pg_temp.bucket151_original_document(TEXT)`;
      await tx.$executeRaw`DROP FUNCTION pg_temp.bucket151_actual_document(TEXT)`;
      return JSON.stringify(docs);
    },
    { timeout: 30000 },
  );
}
function corpusBody(body: string) {
  let result = body;
  for (const [table, temporary] of [
    ['ParticipantSettlementTimeBucket', 'bucket151_buckets'],
    ['ParticipantSettlementTimeBucketSource', 'bucket151_sources'],
  ]) {
    const refs = new RegExp('\\b(FROM|JOIN) "' + table + '"', 'gu');
    expect([...result.matchAll(refs)]).toHaveLength(1);
    result = result.replace(refs, '$1 pg_temp.' + temporary);
  }
  return result;
}
const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  settlementMode: 'active',
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (pending || terminalUnknown || !appClosed)
      throw new Error('Bucket151 work/resource terminal UNKNOWN; finalization refused');
  },
});

describe('151 bucket grouped hash on nonempty150', () => {
  let fixture: E4Fixture | undefined;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const f = () => {
    if (!fixture) throw new Error('Bucket151 fixture unavailable');
    return fixture;
  };
  beforeAll(
    async () =>
      owned(async () => {
        expect(createHash('sha256').update(migration).digest('hex')).toBe(CANDIDATE_SHA);
        expect(createHash('sha256').update(original).digest('hex')).toBe(
          'd10d495eb1e2bc9447f491fb7960eba0c58b8bfb3ab990803e57f676431658a4',
        );
        await owner.deploySourceProofCountMigrations(60000);
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        appClosed = false;
        fixture = await createE4Fixture();
        const source = await createE4Source(fixture);
        const prepared = await prepareE4Time(fixture, source);
        const submitted = await submitE4Time(fixture, source, prepared);
        expect(submitted.kindCode).toBe('submitted');
        expect(await fixture.db.participantSettlementTimeBucket.count()).toBeGreaterThan(0);
        expect(await installedBody(fixture.db)).toBe(bodyOf(original));
      }),
    120000,
  );
  afterAll(async () => {
    try {
      if (pending) {
        terminalUnknown = true;
        throw new Error('Bucket151 pending work; cleanup refused');
      }
      if (fixture) {
        await closeE13Fixture(fixture);
        appClosed = true;
      } else if (!appClosed) terminalUnknown = true;
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
    if (terminalUnknown) throw new Error('Bucket151 resource terminal UNKNOWN');
  });

  it(
    'upgrades nonempty150 to151 and no-op while preserving complete roots, rows, metadata and checksums',
    async () =>
      owned(async () => {
        const deadline = performance.now() + 117000;
        const remaining = () => {
          const ms = Math.floor(deadline - performance.now());
          if (ms < 1) throw new Error('Bucket151 lifecycle deadline exceeded');
          return ms;
        };
        const db = f().db;
        const beforeMigrations = await migrationRows(db);
        expect(beforeMigrations).toHaveLength(150);
        expect(beforeMigrations[149].name).toBe(E4_MIGRATION_150);
        const beforeCatalog = await catalog(db);
        const beforeRows = await nativeLaunchBusinessFingerprint(db, stage);
        const beforeRoots = await verifyRoots(db);
        await owner.deployLatestMigrations(remaining());
        const afterMigrations = await migrationRows(db);
        expect(afterMigrations).toEqual([
          ...beforeMigrations,
          { name: E4_MIGRATION_151, checksum: CANDIDATE_SHA },
        ]);
        expect(await installedBody(db)).toBe(bodyOf(migration));
        expect(await catalog(db)).toBe(beforeCatalog);
        expect(await nativeLaunchBusinessFingerprint(db, stage)).toEqual(beforeRows);
        expect(await verifyRoots(db)).toBe(beforeRoots);
        await owner.deployLatestMigrations(remaining());
        expect(await migrationRows(db)).toEqual(afterMigrations);
        expect(await catalog(db)).toBe(beforeCatalog);
        expect(await nativeLaunchBusinessFingerprint(db, stage)).toEqual(beforeRows);
        expect(await verifyRoots(db)).toBe(beforeRoots);
        console.info(
          'BUCKET151_NONEMPTY_UPGRADE',
          JSON.stringify({
            from: 150,
            to: 151,
            checksums: 150,
            rows: true,
            metadata: true,
            completeBytes: true,
            noop: true,
          }),
        );
      }),
    120000,
  );

  it(
    'preserves complete canonical UTF8 bytes and business hashes for thirteen typed boundary groups',
    async () =>
      owned(async () => {
        expect(corpus.cases).toHaveLength(13);
        await f().db.$transaction(
          async (tx) => {
            await tx.$executeRaw`CREATE TEMP TABLE bucket151_buckets (LIKE public."ParticipantSettlementTimeBucket" INCLUDING INDEXES) ON COMMIT DROP`;
            await tx.$executeRaw`CREATE TEMP TABLE bucket151_sources (LIKE public."ParticipantSettlementTimeBucketSource" INCLUDING INDEXES) ON COMMIT DROP`;
            await tx.$executeRawUnsafe(
              'INSERT INTO pg_temp.bucket151_buckets SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.bucket151_buckets,$1::jsonb)',
              JSON.stringify(corpus.buckets),
            );
            await tx.$executeRawUnsafe(
              'INSERT INTO pg_temp.bucket151_sources SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.bucket151_sources,$1::jsonb)',
              JSON.stringify(corpus.sources),
            );
            await createFunction(
              tx,
              'bucket151_original_corpus',
              corpusBody(documentBody(bodyOf(original))),
            );
            await createFunction(
              tx,
              'bucket151_actual_corpus',
              corpusBody(documentBody(await installedBody(tx))),
            );
            const [facts] = await tx.$queryRawUnsafe<{ cases: number; mismatches: number }[]>(
              "WITH pairs AS MATERIALIZED (SELECT revision_id,pg_temp.bucket151_original_corpus(revision_id) AS expected,pg_temp.bucket151_actual_corpus(revision_id) AS actual FROM unnest($1::text[]) AS ids(revision_id)) SELECT count(*)::int AS cases,count(*) FILTER (WHERE convert_to(expected,'UTF8') IS DISTINCT FROM convert_to(actual,'UTF8') OR sha256(convert_to(expected,'UTF8')) IS DISTINCT FROM sha256(convert_to(actual,'UTF8')))::int AS mismatches FROM pairs",
              corpus.cases,
            );
            expect(facts.cases).toBe(13);
            expect(facts.mismatches).toBe(0);
            await tx.$executeRaw`DROP FUNCTION pg_temp.bucket151_original_corpus(TEXT)`;
            await tx.$executeRaw`DROP FUNCTION pg_temp.bucket151_actual_corpus(TEXT)`;
          },
          { timeout: 30000 },
        );
        console.info(
          'BUCKET151_BOUNDARIES',
          JSON.stringify({ cases: 13, byteMismatches: 0, hashMismatches: 0 }),
        );
      }),
    120000,
  );

  it(
    'preserves the receipt guard positive and forged bucket-hash rejection then formally submits new151 sources',
    async () =>
      owned(async () => {
        const db = f().db;
        const source = await createE4Source(f());
        const prepared = await prepareE4Time(f(), source);
        const parent = await db.activitySettlementTimeRevision.findUniqueOrThrow({
          where: { id: prepared.timeRevisionId },
        });
        const buckets = await db.participantSettlementTimeBucket.findMany({
          where: { timeRevisionId: parent.id },
        });
        const sources = await db.participantSettlementTimeBucketSource.findMany({
          where: { timeRevisionId: parent.id },
        });
        const receipt = await db.activitySettlementTimeCommandReceipt.findUniqueOrThrow({
          where: {
            timeRevisionId_activityId: { timeRevisionId: parent.id, activityId: parent.activityId },
          },
        });
        expect(buckets).toHaveLength(4);
        expect(sources).toHaveLength(4);
        const before = await nativeLaunchBusinessFingerprint(db, stage);
        const sentinel = new Error('Bucket151 complete receipt positive verified; rollback');
        const safeJson = (v: unknown) =>
          JSON.stringify(v, (_key, item: unknown) =>
            typeof item === 'bigint' ? item.toString() : item,
          );
        const probe = async (forged: boolean) => {
          const id = 'bucket151-probe-' + randomBytes(8).toString('hex');
          const row = {
            ...parent,
            id,
            revision: parent.revision + 1,
            previousTimeRevisionId: parent.id,
            bucketContentHash: forged ? 'f'.repeat(64) : parent.bucketContentHash,
          };
          const children = buckets.map((b) => ({ ...b, id: id + ':' + b.id, timeRevisionId: id }));
          const provenance = sources.map((s) => ({
            ...s,
            id: id + ':' + s.id,
            bucketId: id + ':' + s.bucketId,
            timeRevisionId: id,
          }));
          const command = {
            ...receipt,
            id: id + ':receipt',
            timeRevisionId: id,
            operationKey: id,
            resultJson: {
              ...prepared,
              timeRevisionId: id,
              revision: row.revision,
              bucketContentHash: row.bucketContentHash,
            },
          };
          await db.$transaction(
            async (tx) => {
              await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeRevision" SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeRevision",${safeJson(row)}::jsonb)`;
              await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucket" SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucket",${safeJson(children)}::jsonb)`;
              await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucketSource" SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucketSource",${safeJson(provenance)}::jsonb)`;
              await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeCommandReceipt" SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeCommandReceipt",${safeJson(command)}::jsonb)`;
              throw sentinel;
            },
            { timeout: 30000 },
          );
        };
        expect(parent.bucketContentHash).not.toBe('f'.repeat(64));
        await expect(probe(false)).rejects.toBe(sentinel);
        expect(await nativeLaunchBusinessFingerprint(db, stage)).toEqual(before);
        const error: unknown = await probe(true).then(
          () => null,
          (cause: unknown) => cause,
        );
        expect(error instanceof Prisma.PrismaClientKnownRequestError).toBe(true);
        if (!(error instanceof Prisma.PrismaClientKnownRequestError))
          throw new Error('Bucket151 expected native guard rejection');
        expect(error.code).toBe('P2010');
        expect(error.meta?.code).toBe('23514');
        expect(String(error.meta?.message)).toContain(
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
        );
        expect(await nativeLaunchBusinessFingerprint(db, stage)).toEqual(before);
        const submitted = await submitE4Time(f(), source, prepared);
        expect(submitted.kindCode).toBe('submitted');
        expect(
          await db.activitySettlementTimeCommandReceipt.count({
            where: { timeRevisionId: submitted.timeRevisionId },
          }),
        ).toBe(1);
        await verifyRoots(db);
      }),
    120000,
  );

  it(
    'rehearses restoring141 transactionally and retains installed151 after forced rollback',
    async () =>
      owned(async () => {
        const db = f().db;
        const beforeRows = await nativeLaunchBusinessFingerprint(db, stage);
        const beforeCatalog = await catalog(db);
        const beforeMigrations = await migrationRows(db);
        const sentinel = new Error('Bucket151 old body restoration verified; rollback');
        await expect(
          db.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(original);
              expect(await installedBody(tx)).toBe(bodyOf(original));
              expect(await catalog(tx)).toBe(beforeCatalog);
              const [roots] = await tx.$queryRaw<
                { mismatches: number }[]
              >`SELECT count(*)::int AS mismatches FROM "ActivitySettlementTimeRevision" WHERE astr_bucket_content_hash(id) IS DISTINCT FROM "bucketContentHash"`;
              expect(roots.mismatches).toBe(0);
              throw sentinel;
            },
            { timeout: 30000 },
          ),
        ).rejects.toBe(sentinel);
        expect(await installedBody(db)).toBe(bodyOf(migration));
        expect(await catalog(db)).toBe(beforeCatalog);
        expect(await migrationRows(db)).toEqual(beforeMigrations);
        expect(await nativeLaunchBusinessFingerprint(db, stage)).toEqual(beforeRows);
      }),
    120000,
  );
});

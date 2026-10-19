import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { E4_MIGRATION_147, E4_MIGRATION_148 } from '../helpers/e4-migration-prefix';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';

type Database = PrismaClient | Prisma.TransactionClient;
const CANDIDATE_SHA = 'bbde4b75459953641dd80a57d83a924b9b7e5068432b54847f08f1ee9f90914d';
const namespace = 'source_envelope_' + randomBytes(8).toString('hex');
const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_148, 'migration.sql'),
  'utf8',
);
const stage = async <T>(_label: string, work: () => Promise<T>) => work();
let pending = 0;
let failed = false;
let terminalUnknown = false;
let appClosed = true;

async function owned(work: () => Promise<void>) {
  if (pending !== 0) {
    failed = true;
    terminalUnknown = true;
    throw new Error('Source envelope prior work still pending; further validation refused');
  }
  if (failed || terminalUnknown)
    throw new Error('Source envelope prior failure or UNKNOWN; further validation refused');
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

function remaining(deadline: number) {
  const ms = Math.floor(deadline - performance.now());
  if (ms < 1) throw new Error('Source envelope execution deadline exceeded');
  return ms;
}

function originalDefinition() {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql',
    ),
    'utf8',
  );
  const definitions = [...sql.matchAll(/CREATE FUNCTION astr_source_set_hash\([\s\S]*?\n\$\$;/gu)];
  expect(definitions).toHaveLength(1);
  expect(createHash('sha256').update(definitions[0][0]).digest('hex')).toBe(
    '0ec20439da18fa1c544e2fe4db2e18d99c085e262b963723391b12bb72310f69',
  );
  return definitions[0][0];
}

function bodyOf(sql: string) {
  const parts = sql.split('$$');
  expect(parts).toHaveLength(3);
  return parts[1];
}

/** Extract the installed preimage; do not reimplement candidate serialization in the oracle. */
function documentBody(body: string) {
  const start = 'SELECT encode(sha256(convert_to(';
  const end = /,\s*'UTF8'\s*\)\),\s*'hex'\)/gu;
  expect(body.split(start)).toHaveLength(2);
  expect([...body.matchAll(end)]).toHaveLength(1);
  expect(body.split(/astr_source_set_document\(activity_id,\s*draft_id\)/u)).toHaveLength(2);
  return body
    .replace(start, 'SELECT ')
    .replace(end, '')
    .replace(/astr_source_set_document\(activity_id,\s*draft_id\)/u, 'value');
}

async function catalog(db: Database) {
  const functions = await db.$queryRaw`
    SELECT p.oid::text AS oid,CASE WHEN p.oid='public.astr_source_set_hash(text,text)'::regprocedure
      THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid
  `;
  const constraints = await db.$queryRaw`
    SELECT to_jsonb(c)::text AS definition FROM pg_constraint c
    WHERE connamespace='public'::regnamespace ORDER BY oid
  `;
  const triggers = await db.$queryRaw`
    SELECT to_jsonb(t)::text AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid
  `;
  const indexes = await db.$queryRaw`
    SELECT oid::text,pg_get_indexdef(oid) AS definition FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid
  `;
  return JSON.stringify({ functions, constraints, triggers, indexes });
}

async function installedBody(db: Database) {
  const [row] = await db.$queryRaw<{ body: string }[]>`
    SELECT prosrc AS body FROM pg_proc WHERE oid='public.astr_source_set_hash(text,text)'::regprocedure
  `;
  return row.body;
}

async function migrationRows(db: Database) {
  return db.$queryRaw<{ name: string; checksum: string }[]>`
    SELECT migration_name AS name,checksum FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
  `;
}

async function settings(db: Database) {
  return db.$queryRaw`
    SELECT name,setting FROM pg_settings WHERE name IN
    ('work_mem','jit','plan_cache_mode','statement_timeout','lock_timeout','row_security') ORDER BY name
  `;
}

async function verifyRoots(db: Database) {
  const [facts] = await db.$queryRawUnsafe<{ roots: number; mismatches: number }[]>(
    'WITH roots AS (SELECT r.*,CASE WHEN r."kindCode"=\'submitted\' THEN ' +
      '(SELECT "settlementVersionId" FROM "ActivitySettlementTimeRevision" WHERE id=r."sourceDraftTimeRevisionId") ' +
      'ELSE r."settlementVersionId" END AS draft FROM "ActivitySettlementTimeRevision" r) ' +
      'SELECT count(*)::int AS roots,count(*) FILTER (WHERE ' +
      'public.astr_source_set_hash("activityId",draft) IS DISTINCT FROM "sourceSetHash" OR ' +
      'public.astr_source_set_hash("activityId",draft) IS DISTINCT FROM ' +
      namespace +
      '.hash121("activityId",draft))::int AS mismatches FROM roots',
  );
  expect(facts.roots).toBeGreaterThan(0);
  expect(facts.mismatches).toBe(0);
  const [contributions] = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "ActivitySettlementContributionRevision"
  `;
  expect(contributions.count).toBeGreaterThan(0);
  await db.$queryRaw`SELECT e4_assert_complete(id)::text FROM "ActivitySettlementContributionRevision" ORDER BY id`;
}

const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (pending || terminalUnknown || !appClosed)
      throw new Error('Source envelope work/resource terminal UNKNOWN; finalization refused');
  },
});

describe('148 source hash fixed envelope on nonempty147', () => {
  let fixture: E4Fixture | undefined;
  let oracleInstalled = false;
  let upgraded = false;
  let nextSource: Awaited<ReturnType<typeof createE4Source>>;
  let nextPrepared: TimeSettlementReceiptResult;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const db = () => {
    if (!fixture) throw new Error('Source envelope fixture unavailable');
    return fixture.db;
  };

  beforeAll(
    async () =>
      owned(async () => {
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        await owner.deployCorrectionHashMigrations(60_000);
        appClosed = false;
        fixture = await createE4Fixture();
        const source = await createE4Source(fixture);
        const prepared = await prepareE4Time(fixture, source);
        await submitE4Time(fixture, source, prepared);
        if (!/^source_envelope_[a-f0-9]{16}$/u.test(namespace))
          throw new Error('Source envelope oracle namespace invalid');
        await db().$executeRawUnsafe('CREATE SCHEMA ' + namespace);
        oracleInstalled = true;
        await db().$executeRawUnsafe(
          originalDefinition().replace('astr_source_set_hash(', namespace + '.hash121('),
        );
        await db().$executeRawUnsafe(
          'CREATE FUNCTION ' +
            namespace +
            '.document121(value JSONB) RETURNS TEXT LANGUAGE sql STABLE AS $$' +
            documentBody(bodyOf(originalDefinition())) +
            '$$;',
        );
      }),
    120_000,
  );

  afterAll(async () => {
    try {
      if (pending) {
        terminalUnknown = true;
        throw new Error('Source envelope work still pending; cleanup refused');
      }
      try {
        if (oracleInstalled && fixture)
          await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
      } finally {
        if (fixture) {
          await closeE13Fixture(fixture);
          appClosed = true;
        } else if (!appClosed) terminalUnknown = true;
      }
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  it('upgrades147 nonempty roots to148 and no-op without changing rows, other functions, permissions, constraints, triggers or settings', async () =>
    owned(async () => {
      const deadline = performance.now() + 27_000;
      const beforeMigrations = await migrationRows(db());
      expect(beforeMigrations).toHaveLength(147);
      expect(beforeMigrations[146].name).toBe(E4_MIGRATION_147);
      expect(await installedBody(db())).toBe(bodyOf(originalDefinition()));
      const beforeCatalog = await catalog(db());
      const beforeSettings = await settings(db());
      const beforeRows = await nativeLaunchBusinessFingerprint(db(), stage);
      await verifyRoots(db());
      await owner.deployLatestMigrations(remaining(deadline));
      expect(createHash('sha256').update(migration).digest('hex')).toBe(CANDIDATE_SHA);
      expect(await installedBody(db())).toBe(bodyOf(migration));
      const afterMigrations = await migrationRows(db());
      expect(afterMigrations).toEqual([
        ...beforeMigrations,
        { name: E4_MIGRATION_148, checksum: CANDIDATE_SHA },
      ]);
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await settings(db())).toEqual(beforeSettings);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(beforeRows);
      await verifyRoots(db());
      await owner.deployLatestMigrations(remaining(deadline));
      expect(await migrationRows(db())).toEqual(afterMigrations);
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(beforeRows);
      upgraded = true;
    }));

  it('compares installed complete UTF8 preimages and hashes for NULL, unknown shapes, precision, escapes and nested values', async () =>
    owned(async () => {
      expect(upgraded).toBe(true);
      const body = await installedBody(db());
      expect(body).toBe(bodyOf(migration));
      await db().$executeRawUnsafe(
        'CREATE FUNCTION ' +
          namespace +
          '.document148(value JSONB) RETURNS TEXT LANGUAGE sql STABLE AS $$' +
          documentBody(body) +
          '$$;',
      );
      const scalars: (string | null)[] = [
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
        '9223372036854775807',
        '""',
        JSON.stringify('quote" slash\\ tab\t newline\n'),
        JSON.stringify('雪🙂 é é\u2028\u2029\u0001'),
      ];
      const inputs = [
        ...scalars,
        '{}',
        '[]',
        '{"unknown":{"z":[9007199254740993,{"a":1.2300}]}}',
        '[null,true,{"é":"é","a":null}]',
        ...scalars
          .filter((v): v is string => v !== null)
          .flatMap((value) => [
            '{"unknown":' + value + ',"A":null}',
            '[' + value + ',{},[]]',
            '{"segments":[{"exceptionFlagsJson":' + value + '}],"population":[]}',
          ]),
      ];
      const [facts] = await db().$queryRawUnsafe<
        { cases: number; mismatches: number; nullInputs: number; nullOutputs: number }[]
      >(
        'WITH inputs AS MATERIALIZED (SELECT raw::jsonb AS value FROM unnest($1::text[]) i(raw)), ' +
          'documents AS MATERIALIZED (SELECT value,' +
          namespace +
          '.document121(value) AS original,' +
          namespace +
          '.document148(value) AS actual FROM inputs) SELECT count(*)::int AS cases,' +
          "count(*) FILTER (WHERE convert_to(actual,'UTF8') IS DISTINCT FROM convert_to(original,'UTF8') OR " +
          "sha256(convert_to(actual,'UTF8')) IS DISTINCT FROM sha256(convert_to(original,'UTF8')))::int AS mismatches," +
          'count(*) FILTER (WHERE value IS NULL)::int AS "nullInputs",count(*) FILTER (WHERE actual IS NULL)::int AS "nullOutputs" FROM documents',
        inputs,
      );
      expect(facts).toEqual({ cases: inputs.length, mismatches: 0, nullInputs: 1, nullOutputs: 0 });
      const [arguments_] = await db().$queryRawUnsafe<{ cases: number; mismatches: number }[]>(
        'WITH ids AS (SELECT "activityId" AS activity,id AS draft FROM "AttendanceSettlementVersion" ' +
          "UNION ALL SELECT NULL::text,NULL::text UNION ALL SELECT 'missing-activity','missing-draft') " +
          'SELECT count(*)::int AS cases,count(*) FILTER (WHERE public.astr_source_set_hash(activity,draft) ' +
          'IS DISTINCT FROM ' +
          namespace +
          '.hash121(activity,draft))::int AS mismatches FROM ids',
      );
      expect(arguments_.cases).toBeGreaterThan(2);
      expect(arguments_.mismatches).toBe(0);
    }));

  it('prepares a new real guarded source under148 with the original transaction budget', async () =>
    owned(async () => {
      expect(upgraded).toBe(true);
      if (!fixture) throw new Error('Source envelope fixture unavailable');
      nextSource = await createE4Source(fixture);
      nextPrepared = await prepareE4Time(fixture, nextSource);
      await verifyRoots(db());
    }));

  it('accepts the complete receipt control and independently rejects a forged source hash with every new write rolled back', async () =>
    owned(async () => {
      expect(upgraded).toBe(true);
      const original = await db().activitySettlementTimeRevision.findUniqueOrThrow({
        where: { id: nextPrepared.timeRevisionId },
      });
      const buckets = await db().participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: original.id },
      });
      const sources = await db().participantSettlementTimeBucketSource.findMany({
        where: { timeRevisionId: original.id },
      });
      const receipt = await db().activitySettlementTimeCommandReceipt.findUniqueOrThrow({
        where: {
          timeRevisionId_activityId: {
            timeRevisionId: original.id,
            activityId: original.activityId,
          },
        },
      });
      expect(buckets).toHaveLength(4);
      expect(sources).toHaveLength(4);
      const before = await nativeLaunchBusinessFingerprint(db(), stage);
      const positiveRollback = new Error(
        'Complete receipt control verified; roll back test writes',
      );
      const safeJson = (value: unknown) =>
        JSON.stringify(value, (_key, item: unknown) =>
          typeof item === 'bigint' ? item.toString() : item,
        );
      const probe = async (forged: boolean) => {
        const id = 'source-envelope-probe-' + randomBytes(8).toString('hex');
        const parent = {
          ...original,
          id,
          revision: original.revision + 1,
          previousTimeRevisionId: original.id,
          sourceSetHash: forged ? 'f'.repeat(64) : original.sourceSetHash,
        };
        const children = buckets.map((row) => ({
          ...row,
          id: id + ':' + row.id,
          timeRevisionId: id,
        }));
        const provenance = sources.map((row) => ({
          ...row,
          id: id + ':' + row.id,
          bucketId: id + ':' + row.bucketId,
          timeRevisionId: id,
        }));
        const result = { ...nextPrepared, timeRevisionId: id, revision: parent.revision };
        const command = {
          ...receipt,
          id: id + ':receipt',
          timeRevisionId: id,
          operationKey: id,
          resultJson: result,
        };
        await db().$transaction(
          async (tx) => {
            await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeRevision" SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeRevision", ${safeJson(parent)}::jsonb)`;
            await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucket" SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucket", ${safeJson(children)}::jsonb)`;
            await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucketSource" SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucketSource", ${safeJson(provenance)}::jsonb)`;
            await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeCommandReceipt" SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeCommandReceipt", ${safeJson(command)}::jsonb)`;
            // This controls the BEFORE receipt guard only. The separate real submit test proves COMMIT.
            throw positiveRollback;
          },
          { timeout: 30000 },
        );
      };
      expect(original.sourceSetHash).not.toBe('f'.repeat(64));
      await expect(probe(false)).rejects.toBe(positiveRollback);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(before);
      const error: unknown = await probe(true).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error instanceof Prisma.PrismaClientKnownRequestError).toBe(true);
      if (!(error instanceof Prisma.PrismaClientKnownRequestError))
        throw new Error('Expected PostgreSQL fingerprint rejection');
      expect(error.code).toBe('P2010');
      expect(error.meta?.code).toBe('23514');
      expect(String(error.meta?.message)).toContain(
        'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      );
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(before);
    }));

  it('rehearses the forward restore body transactionally and retains installed148 after forced rollback', async () =>
    owned(async () => {
      const beforeRows = await nativeLaunchBusinessFingerprint(db(), stage);
      const beforeCatalog = await catalog(db());
      const beforeMigrations = await migrationRows(db());
      const rehearsal = new Error('Forward-restore body verified; roll back rehearsal');
      await expect(
        db().$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              originalDefinition().replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
            );
            expect(await installedBody(tx)).toBe(bodyOf(originalDefinition()));
            expect((await catalog(tx)) === beforeCatalog).toBe(true);
            await verifyRoots(tx);
            throw rehearsal;
          },
          { timeout: 30000 },
        ),
      ).rejects.toBe(rehearsal);
      expect(await installedBody(db())).toBe(bodyOf(migration));
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await migrationRows(db())).toEqual(beforeMigrations);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(beforeRows);
    }));

  it('formally submits the new source under148 and validates stored roots after COMMIT', async () =>
    owned(async () => {
      if (!fixture) throw new Error('Source envelope fixture unavailable');
      const submitted = await submitE4Time(fixture, nextSource, nextPrepared);
      expect(submitted.kindCode).toBe('submitted');
      expect(
        await db().activitySettlementTimeCommandReceipt.count({
          where: { timeRevisionId: submitted.timeRevisionId },
        }),
      ).toBe(1);
      await verifyRoots(db());
    }));
});

import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  closeE13Fixture,
  createE4Fixture,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { approvedE4TimeCorrection } from '../helpers/activity-r5-correction-hash.fixture';
import { E4_MIGRATION_149, E4_MIGRATION_150 } from '../helpers/e4-migration-prefix';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';
import { assertTestDatabaseUrl } from '../setup/test-db';

type Database = PrismaClient | Prisma.TransactionClient;
const CANDIDATE_SHA = '9451091106a43afff7419f6debca85bf29322bbaa19a34bb93924d51bbeff0f0';
const namespace = 'source_count_' + randomBytes(8).toString('hex');
const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_150, 'migration.sql'),
  'utf8',
);
const stage = async <T>(_label: string, work: () => Promise<T>) => work();
let pending = 0;
let failed = false;
let terminalUnknown = false;
let appClosed = true;

async function owned(work: () => Promise<void>) {
  if (pending !== 0) {
    terminalUnknown = true;
    throw new Error('Source count prior work still pending; further validation refused');
  }
  if (failed || terminalUnknown)
    throw new Error('Source count prior failure or UNKNOWN; further validation refused');
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

function originalDefinition() {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260915180000_activity_os_r4_d7_2_fact_correction/migration.sql',
    ),
    'utf8',
  );
  const definitions = [...sql.matchAll(/CREATE FUNCTION ctsp_assert_complete\([\s\S]*?\n\$\$;/gu)];
  expect(definitions).toHaveLength(1);
  return definitions[0][0];
}

function bodyOf(sql: string) {
  const parts = sql.split('$$');
  expect(parts).toHaveLength(3);
  return parts[1];
}

async function installedBody(db: Database) {
  const [row] = await db.$queryRaw<{ body: string }[]>`
    SELECT prosrc AS body FROM pg_proc WHERE oid='public.ctsp_assert_complete(text,boolean)'::regprocedure
  `;
  return row.body;
}

async function catalog(db: Database) {
  const functions = await db.$queryRaw`
    SELECT p.oid::text AS oid,CASE WHEN p.oid='public.ctsp_assert_complete(text,boolean)'::regprocedure
      THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid
  `;
  const dependencies = await db.$queryRaw`
    SELECT to_jsonb(d)::text AS definition FROM pg_depend d
    WHERE (classid='pg_proc'::regclass AND objid='public.ctsp_assert_complete(text,boolean)'::regprocedure)
       OR (refclassid='pg_proc'::regclass AND refobjid='public.ctsp_assert_complete(text,boolean)'::regprocedure)
    ORDER BY to_jsonb(d)::text COLLATE "C"
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
  return JSON.stringify({ functions, dependencies, constraints, triggers, indexes });
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
    ('work_mem','hash_mem_multiplier','jit','plan_cache_mode','statement_timeout','lock_timeout','row_security') ORDER BY name
  `;
}

async function installOracleControls(db: Database) {
  await db.$executeRawUnsafe(
    'CREATE FUNCTION ' +
      namespace +
      `.count_controls() RETURNS integer LANGUAGE plpgsql AS $controls$
DECLARE
  test record; before_count integer; after_count integer; before_state text; after_state text;
  cases integer := 0;
BEGIN
  FOR test IN SELECT * FROM (VALUES
    ('SQL_NULL',NULL::text),('empty','[]'),('JSON_null_element','[null]'),('repeated_nulls','[null,null]'),
    ('mixed_scalars','[1,"s",true,false,null]'),('nested_arrays','[[],[1,2],[null]]'),
    ('objects','[{"sliceCount":null},{"sliceCount":1},{"x":[1,2]}]'),('repeated_objects','[{"x":1},{"x":1}]'),
    ('large_10000',(SELECT jsonb_agg(jsonb_build_object('sliceCount',5,'ordinal',i))::text FROM generate_series(1,10000) i)),
    ('object_empty','{}'),('object_array_field','{"items":[]}'),('JSON_null_scalar','null'),
    ('number_zero','0'),('number_negative','-1'),('number_decimal','1.5'),('string_scalar','"text"'),
    ('boolean_true','true'),('boolean_false','false'),('invalid_JSON','['),('empty_text','')
  ) AS t(name,doc) LOOP
    before_count:=NULL;after_count:=NULL;before_state:='00000';after_state:='00000';
    BEGIN
      EXECUTE 'SELECT count(*)::integer FROM jsonb_array_elements($1::jsonb)' INTO before_count USING test.doc;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS before_state=RETURNED_SQLSTATE;
    END;
    BEGIN
      EXECUTE 'SELECT coalesce(jsonb_array_length($1::jsonb),0)' INTO after_count USING test.doc;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS after_state=RETURNED_SQLSTATE;
    END;
    IF before_count IS DISTINCT FROM after_count OR before_state IS DISTINCT FROM after_state THEN
      RAISE EXCEPTION 'count equivalence control failed: %',test.name;
    END IF;
    cases:=cases+1;
  END LOOP;
  RETURN cases;
END;
$controls$;`,
  );
  await db.$executeRawUnsafe(
    'CREATE FUNCTION ' +
      namespace +
      `.compare_guards(batch_id text,bindings boolean) RETURNS text LANGUAGE plpgsql AS $guards$
DECLARE
  before_state text:='00000';after_state text:='00000';
  before_constraint text;after_constraint text;before_message text;after_message text;
BEGIN
  BEGIN
    PERFORM ` +
      namespace +
      `.complete149(batch_id,bindings);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS before_state=RETURNED_SQLSTATE,before_constraint=CONSTRAINT_NAME,before_message=MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM public.ctsp_assert_complete(batch_id,bindings);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS after_state=RETURNED_SQLSTATE,after_constraint=CONSTRAINT_NAME,after_message=MESSAGE_TEXT;
  END;
  IF before_state IS DISTINCT FROM after_state OR before_constraint IS DISTINCT FROM after_constraint
    OR before_message IS DISTINCT FROM after_message THEN
    RAISE EXCEPTION 'complete guard comparison differs: old %, new %',before_state,after_state;
  END IF;
  RETURN after_state;
END;
$guards$;`,
  );
}

const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  settlementMode: 'active',
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (pending || terminalUnknown || !appClosed)
      throw new Error('Source count work/resource terminal UNKNOWN; finalization refused');
  },
});

describe('150 outer proof-array count on nonempty149', () => {
  let fixture: E4Fixture | undefined;
  let oracleInstalled = false;
  let upgraded = false;
  let correction: Awaited<ReturnType<typeof approvedE4TimeCorrection>>;
  let prepared: Awaited<ReturnType<typeof correction.correction.prepare>>;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const db = () => {
    if (!fixture) throw new Error('Source count fixture unavailable');
    return fixture.db;
  };
  const f = () => {
    if (!fixture) throw new Error('Source count fixture unavailable');
    return fixture;
  };

  beforeAll(
    async () =>
      owned(async () => {
        await owner.deploySingletonMigrations(60_000);
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        appClosed = false;
        fixture = await createE4Fixture();
        correction = await approvedE4TimeCorrection(fixture);
        prepared = await correction.correction.prepare(
          correction.input,
          e4Actor(fixture.finalReviewer),
          E4_META,
        );
        expect(await db().correctionTimeSourceProof.count()).toBeGreaterThan(0);
        await db()
          .$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},false)::text`;
        if (!/^source_count_[a-f0-9]{16}$/u.test(namespace))
          throw new Error('Source count oracle namespace invalid');
        assertTestDatabaseUrl(process.env.DATABASE_URL);
        await db().$executeRawUnsafe('CREATE SCHEMA ' + namespace);
        oracleInstalled = true;
        await db().$executeRawUnsafe(
          originalDefinition().replace('ctsp_assert_complete(', namespace + '.complete149('),
        );
        await installOracleControls(db());
      }),
    120_000,
  );

  afterAll(async () => {
    try {
      if (pending) {
        terminalUnknown = true;
        throw new Error('Source count work still pending; cleanup refused');
      }
      try {
        if (oracleInstalled && fixture) {
          assertTestDatabaseUrl(process.env.DATABASE_URL);
          await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
        }
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

  it('upgrades149 with a real nonempty V3 proof to150 and no-op while preserving rows, identity, metadata and dependencies', async () =>
    owned(async () => {
      const deadline = performance.now() + 27_000;
      const remaining = () => {
        const ms = Math.floor(deadline - performance.now());
        if (ms < 1) throw new Error('Source count execution deadline exceeded');
        return ms;
      };
      const beforeMigrations = await migrationRows(db());
      expect(beforeMigrations).toHaveLength(149);
      expect(beforeMigrations[148].name).toBe(E4_MIGRATION_149);
      expect(await installedBody(db())).toBe(bodyOf(originalDefinition()));
      expect(
        createHash('md5')
          .update(await installedBody(db()))
          .digest('hex'),
      ).toBe('1e48ec063dbf452210a1c7dd9a0159ff');
      const beforeCatalog = await catalog(db());
      const beforeSettings = await settings(db());
      const beforeRows = await nativeLaunchBusinessFingerprint(db(), stage);
      await owner.deployLatestMigrations(remaining());
      expect(createHash('sha256').update(migration).digest('hex')).toBe(CANDIDATE_SHA);
      expect(await installedBody(db())).toBe(bodyOf(migration));
      const afterMigrations = await migrationRows(db());
      expect(afterMigrations).toEqual([
        ...beforeMigrations,
        { name: E4_MIGRATION_150, checksum: CANDIDATE_SHA },
      ]);
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await settings(db())).toEqual(beforeSettings);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(beforeRows);
      await db()
        .$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},false)::text`;
      await owner.deployLatestMigrations(remaining());
      expect(await migrationRows(db())).toEqual(afterMigrations);
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await settings(db())).toEqual(beforeSettings);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(beforeRows);
      upgraded = true;
    }));

  it('checks the installed statement against the original for twenty array, SQL NULL and rejected-input controls', async () =>
    owned(async () => {
      expect(upgraded).toBe(true);
      const oldStatement =
        /SELECT count\(\*\)::integer INTO source_count\s+FROM jsonb_array_elements\(proof_row\."sourceSnapshotJson"\);/u;
      const newStatement =
        /SELECT coalesce\(jsonb_array_length\(proof_row\."sourceSnapshotJson"\), 0\)\s+INTO source_count;/u;
      const installed = await installedBody(db());
      expect([
        ...bodyOf(originalDefinition()).matchAll(new RegExp(oldStatement, 'gu')),
      ]).toHaveLength(1);
      expect([...installed.matchAll(new RegExp(newStatement, 'gu'))]).toHaveLength(1);
      expect(
        installed.replace(newStatement, bodyOf(originalDefinition()).match(oldStatement)![0]),
      ).toBe(bodyOf(originalDefinition()));
      const [result] = await db().$queryRawUnsafe<{ cases: number; mismatches: number }[]>(
        'SELECT ' + namespace + '.count_controls() AS cases,0::integer AS mismatches',
      );
      expect(result).toEqual({ cases: 20, mismatches: 0 });
    }));

  it('commits the proof prepared under149 with both installed complete branches and preserves replay and four entries', async () =>
    owned(async () => {
      const committed = await correction.correction.commit(
        correction.input,
        e4Actor(f().finalReviewer),
        E4_META,
      );
      expect(committed).toMatchObject({
        applicationStatus: 'committed',
        correctionStatus: 'applied',
        replayed: false,
        ledger: {
          postingBatchId: prepared.newPostingBatchId,
          batchStatus: 'committed',
          entryCount: 4,
        },
      });
      await db()
        .$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},false)::text`;
      await db()
        .$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},true)::text`;
      expect(
        (await correction.correction.commit(correction.input, e4Actor(f().finalReviewer), E4_META))
          .replayed,
      ).toBe(true);
    }));

  it('compares full original and installed guards on rollback-only temporary copies with positive and independent negative controls', async () =>
    owned(async () => {
      const before = await nativeLaunchBusinessFingerprint(db(), stage);
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      const proof = await db().correctionTimeSourceProof.findFirstOrThrow({
        where: { postingBatchId: prepared.newPostingBatchId },
      });
      expect(proof.expectedSegmentCount).toBe(1);
      expect(proof.expectedBindingCount).toBe(1);
      expect(
        await db().correctionTimeAllocationBinding.count({ where: { proofId: proof.id } }),
      ).toBe(1);
      const tables = [
        'CorrectionTimeSourceProof',
        'CorrectionApplication',
        'AttendanceCorrectionRequest',
        'ParticipationTimeCorrectionManifest',
        'CorrectionPendingTimeAllocation',
        'CorrectionPendingTimeAllocationEvidence',
        'CorrectionTimeAllocationBinding',
      ];
      const cases = [
        { name: 'complete', mutation: '', noBindings: '00000', bindings: '00000' },
        {
          name: 'source count mismatch',
          mutation:
            'UPDATE pg_temp."CorrectionTimeSourceProof" SET "expectedSegmentCount"="expectedSegmentCount"+1',
          noBindings: '23514',
          bindings: '23514',
        },
        {
          name: 'missing proof',
          mutation:
            'UPDATE pg_temp."CorrectionTimeSourceProof" SET "postingBatchId"=\'not-the-batch\'',
          noBindings: '23514',
          bindings: '23514',
        },
        {
          name: 'inconsistent source anchor',
          mutation: 'UPDATE pg_temp."CorrectionTimeSourceProof" SET "sourceSetHash"=\'bad-anchor\'',
          noBindings: '23514',
          bindings: '23514',
        },
        {
          name: 'missing pending coverage',
          mutation:
            'UPDATE pg_temp."CorrectionPendingTimeAllocation" SET "baseAllocationRevisionId"=\'not-in-source\'',
          noBindings: '23514',
          bindings: '23514',
        },
        {
          name: 'missing binding',
          mutation:
            'UPDATE pg_temp."CorrectionTimeAllocationBinding" SET "proofId"=\'not-the-proof\'',
          noBindings: '00000',
          bindings: '23514',
        },
        ...[
          'participationIdentityId',
          'segmentKey',
          'sourceSegmentId',
          'allocationRevisionId',
          'pendingAllocationId',
          'sourceHash',
        ].map((field) => ({
          name: 'binding ' + field,
          mutation:
            'UPDATE pg_temp."CorrectionTimeAllocationBinding" SET "' + field + "\"='not-in-source'",
          noBindings: '00000',
          bindings: '23514',
        })),
        {
          name: 'binding source revision',
          mutation:
            'UPDATE pg_temp."CorrectionTimeAllocationBinding" SET "sourceSegmentRevision"="sourceSegmentRevision"+1',
          noBindings: '00000',
          bindings: '23514',
        },
        {
          name: 'duplicate binding replacing a distinct source while totals match',
          mutation:
            'INSERT INTO pg_temp."CorrectionTimeAllocationBinding" SELECT * FROM pg_temp."CorrectionTimeAllocationBinding";' +
            'UPDATE pg_temp."CorrectionTimeSourceProof" SET "sourceSnapshotJson"="sourceSnapshotJson"||jsonb_set("sourceSnapshotJson"->0,\'{participationIdentityId}\',\'"missing-other-identity"\'::jsonb),' +
            '"expectedSegmentCount"=2,"expectedBindingCount"=2,"expectedSliceCount"="expectedSliceCount"*2',
          noBindings: '00000',
          bindings: '23514',
        },
      ];
      const rollback = new Error('Full guard matrix control observed; roll back temporary copies');
      for (const control of cases) {
        await expect(
          db().$transaction(
            async (tx) => {
              for (const table of tables)
                await tx.$executeRawUnsafe(
                  'CREATE TEMP TABLE "' +
                    table +
                    '" ON COMMIT DROP AS TABLE public."' +
                    table +
                    '"',
                );
              await tx.$executeRawUnsafe('SET LOCAL search_path=pg_temp,public');
              const [resolved] = await tx.$queryRaw<{ shadow: boolean }[]>`
            SELECT '"CorrectionTimeSourceProof"'::regclass::oid<>'public."CorrectionTimeSourceProof"'::regclass::oid AS shadow
          `;
              expect(resolved.shadow).toBe(true);
              if (control.mutation)
                for (const sql of control.mutation.split(';')) await tx.$executeRawUnsafe(sql);
              // Each call catches its own SQLSTATE in a subtransaction; expected refusals do not abort the oracle's comparison.
              const [observed] = await tx.$queryRawUnsafe<
                { noBindings: string; bindings: string }[]
              >(
                'SELECT ' +
                  namespace +
                  '.compare_guards($1,false) AS "noBindings",' +
                  namespace +
                  '.compare_guards($1,true) AS bindings',
                prepared.newPostingBatchId,
              );
              expect({ name: control.name, ...observed }).toEqual({
                name: control.name,
                noBindings: control.noBindings,
                bindings: control.bindings,
              });
              throw rollback;
            },
            { timeout: 30000 },
          ),
        ).rejects.toBe(rollback);
      }
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(before);
    }));

  it('rehearses the prior body transactionally and retains150, catalog and rows after forced rollback', async () =>
    owned(async () => {
      const before = await nativeLaunchBusinessFingerprint(db(), stage);
      const beforeCatalog = await catalog(db());
      const beforeMigrations = await migrationRows(db());
      const rollback = new Error('Prior function body verified; roll back rehearsal');
      await expect(
        db().$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              originalDefinition().replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
            );
            expect(await installedBody(tx)).toBe(bodyOf(originalDefinition()));
            expect((await catalog(tx)) === beforeCatalog).toBe(true);
            await tx.$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},true)::text`;
            throw rollback;
          },
          { timeout: 30000 },
        ),
      ).rejects.toBe(rollback);
      expect(await installedBody(db())).toBe(bodyOf(migration));
      expect((await catalog(db())) === beforeCatalog).toBe(true);
      expect(await migrationRows(db())).toEqual(beforeMigrations);
      expect(await nativeLaunchBusinessFingerprint(db(), stage)).toEqual(before);
    }));

  it('prepares and commits a fresh real source under150 with the original service budgets and guards', async () =>
    owned(async () => {
      const next = await approvedE4TimeCorrection(f());
      const nextPrepared = await next.correction.prepare(
        next.input,
        e4Actor(f().finalReviewer),
        E4_META,
      );
      const committed = await next.correction.commit(
        next.input,
        e4Actor(f().finalReviewer),
        E4_META,
      );
      expect(committed).toMatchObject({
        applicationStatus: 'committed',
        correctionStatus: 'applied',
        replayed: false,
        ledger: {
          postingBatchId: nextPrepared.newPostingBatchId,
          batchStatus: 'committed',
          entryCount: 4,
        },
      });
      await db()
        .$queryRaw`SELECT public.ctsp_assert_complete(${nextPrepared.newPostingBatchId},true)::text`;
      expect(
        (await next.correction.commit(next.input, e4Actor(f().finalReviewer), E4_META)).replayed,
      ).toBe(true);
    }));
});

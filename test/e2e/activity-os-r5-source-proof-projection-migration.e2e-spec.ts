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
import {
  E4_MIGRATION_150,
  E4_MIGRATION_151,
  E4_MIGRATION_152,
} from '../helpers/e4-migration-prefix';
import { assertTestDatabaseUrl } from '../setup/test-db';

type Database = PrismaClient | Prisma.TransactionClient;
const CANDIDATE_SHA = 'ae2b166f5a58b47b5938cde13fa3e9205d01bfa91e30096155aaab04582ed745';
const namespace = 'source_projection_' + randomBytes(8).toString('hex');
const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_152, 'migration.sql'),
  'utf8',
);
const corpus = readFileSync(
  resolve(__dirname, '../fixtures/activity-source-projection-boundaries.json'),
  'utf8',
);
async function touchedRows(db: Database) {
  const rows: unknown[] = [];
  for (const table of [
    'CorrectionTimeSourceProof',
    'CorrectionApplication',
    'AttendanceCorrectionRequest',
    'ParticipationTimeCorrectionManifest',
    'CorrectionPendingTimeAllocation',
    'CorrectionPendingTimeAllocationEvidence',
    'CorrectionTimeAllocationBinding',
  ]) {
    rows.push(
      await db.$queryRawUnsafe(
        "SELECT count(*)::int AS count,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE \"C\")::text,'[]'),'UTF8')),'hex') AS hash FROM public.\"" +
          table +
          '" t',
      ),
    );
  }
  return JSON.stringify(rows);
}
let pending = 0;
let failed = false;
let terminalUnknown = false;
let appClosed = true;

async function owned(work: () => Promise<void>) {
  if (pending !== 0) {
    terminalUnknown = true;
    throw new Error('Source projection prior work still pending; further validation refused');
  }
  if (failed || terminalUnknown)
    throw new Error('Source projection prior failure or UNKNOWN; further validation refused');
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
  return readFileSync(
    resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_150, 'migration.sql'),
    'utf8',
  );
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

const ATOM_SQL =
  "CREATE FUNCTION pg_temp.compare_source_projections(source_input JSONB,pending_identity TEXT,pending_segment TEXT,pending_allocation TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$\nDECLARE original_sum INTEGER;candidate_sum INTEGER;original_member BOOLEAN;candidate_member BOOLEAN;original_state TEXT:='00000';candidate_state TEXT:='00000';original_message TEXT;candidate_message TEXT;\nBEGIN\n BEGIN\n  PERFORM coalesce(jsonb_array_length(source_input),0);\n  SELECT (SELECT coalesce(sum((source->>'sliceCount')::integer), 0)::integer\n      FROM jsonb_array_elements(source_input) source) INTO original_sum;\n  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(source_input) s WHERE s->>'participationIdentityId'=pending_identity AND s->>'segmentKey'=pending_segment AND s->>'baseAllocationRevisionId'=pending_allocation) INTO original_member;\n EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS original_state=RETURNED_SQLSTATE,original_message=MESSAGE_TEXT; END;\n BEGIN\n  PERFORM coalesce(jsonb_array_length(source_input),0);\n  SELECT (CASE\n      WHEN jsonb_path_exists(source_input, 'strict $[*] ? (@.type() != \"object\")')\n      THEN (SELECT coalesce(sum((source->>'sliceCount')::integer), 0)::integer\n      FROM jsonb_array_elements(source_input) source)\n      ELSE (SELECT coalesce(sum(source.\"sliceCount\"::integer), 0)::integer\n        FROM jsonb_to_recordset(source_input) AS source(\"sliceCount\" TEXT))\n    END) INTO candidate_sum;\n  SELECT CASE WHEN jsonb_path_exists(source_input,'strict $[*] ? (@.type() != \"object\")') THEN EXISTS(SELECT 1 FROM jsonb_array_elements(source_input) s WHERE s->>'participationIdentityId'=pending_identity AND s->>'segmentKey'=pending_segment AND s->>'baseAllocationRevisionId'=pending_allocation) ELSE EXISTS(SELECT 1 FROM jsonb_to_recordset(source_input) AS s(\"participationIdentityId\" TEXT,\"segmentKey\" TEXT,\"baseAllocationRevisionId\" TEXT) WHERE s.\"participationIdentityId\"=pending_identity AND s.\"segmentKey\"=pending_segment AND s.\"baseAllocationRevisionId\"=pending_allocation) END INTO candidate_member;\n EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS candidate_state=RETURNED_SQLSTATE,candidate_message=MESSAGE_TEXT; END;\n RETURN jsonb_build_object('originalSum',original_sum,'candidateSum',candidate_sum,'originalMember',original_member,'candidateMember',candidate_member,'originalState',original_state,'candidateState',candidate_state,'originalMessage',original_message,'candidateMessage',candidate_message);\nEND;$$;";

async function installOracleControls(db: Database) {
  await db.$executeRawUnsafe(
    ATOM_SQL.replace(
      'pg_temp.compare_source_projections(',
      namespace + '.compare_source_projections(',
    ),
  );
  if (corpus.includes('$projection$')) throw new Error('Projection oracle delimiter collision');
  await db.$executeRawUnsafe(
    'CREATE FUNCTION ' +
      namespace +
      `.projection_controls() RETURNS integer LANGUAGE plpgsql AS $controls$
DECLARE t record; r jsonb; n integer:=0;
BEGIN
  FOR t IN SELECT * FROM jsonb_to_recordset($projection$` +
      corpus +
      `$projection$::jsonb) AS c(name TEXT,input JSONB,"expectedSum" INTEGER,"expectedMember" BOOLEAN,"expectedState" TEXT,"sqlNull" BOOLEAN,"pendingIdentity" TEXT,"pendingSegment" TEXT,"pendingAllocation" TEXT) LOOP
    SELECT ` +
      namespace +
      `.compare_source_projections(CASE WHEN t."sqlNull" THEN NULL ELSE coalesce(t.input,'null'::JSONB) END,t."pendingIdentity",t."pendingSegment",t."pendingAllocation") INTO r;
    IF r->>'originalState' IS DISTINCT FROM r->>'candidateState' OR r->>'originalState' IS DISTINCT FROM t."expectedState"
      OR r->'originalMessage' IS DISTINCT FROM r->'candidateMessage' OR r->'originalSum' IS DISTINCT FROM r->'candidateSum'
      OR r->'originalMember' IS DISTINCT FROM r->'candidateMember'
      OR (t."expectedState"='00000' AND ((r->>'originalSum')::integer IS DISTINCT FROM t."expectedSum" OR (r->>'originalMember')::boolean IS DISTINCT FROM t."expectedMember"))
    THEN RAISE EXCEPTION 'source projection equivalence control failed: %',t.name; END IF;
    n:=n+1;
  END LOOP;
  RETURN n;
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
      `.complete151(batch_id,bindings);
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
      throw new Error('Source projection work/resource terminal UNKNOWN; finalization refused');
  },
});

describe('152 narrow source-proof projection on nonempty151', () => {
  let fixture: E4Fixture | undefined;
  let oracleInstalled = false;
  let upgraded = false;
  let correction: Awaited<ReturnType<typeof approvedE4TimeCorrection>>;
  let prepared: Awaited<ReturnType<typeof correction.correction.prepare>>;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const db = () => {
    if (!fixture) throw new Error('Source projection fixture unavailable');
    return fixture.db;
  };
  const f = () => {
    if (!fixture) throw new Error('Source projection fixture unavailable');
    return fixture;
  };

  beforeAll(
    async () =>
      owned(async () => {
        await owner.deployBucketGroupedMigrations(60_000);
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
        if (!/^source_projection_[a-f0-9]{16}$/u.test(namespace))
          throw new Error('Source projection oracle namespace invalid');
        assertTestDatabaseUrl(process.env.DATABASE_URL);
        await db().$executeRawUnsafe('CREATE SCHEMA ' + namespace);
        oracleInstalled = true;
        await db().$executeRawUnsafe(
          originalDefinition().replace('ctsp_assert_complete(', namespace + '.complete151('),
        );
        await installOracleControls(db());
      }),
    120_000,
  );

  afterAll(async () => {
    try {
      if (pending) {
        terminalUnknown = true;
        throw new Error('Source projection work still pending; cleanup refused');
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

  it(
    'upgrades151 with a real nonempty V3 proof to152 and no-op while preserving rows, identity, metadata and dependencies',
    async () =>
      owned(async () => {
        const deadline = performance.now() + 117_000;
        const remaining = () => {
          const ms = Math.floor(deadline - performance.now());
          if (ms < 1) throw new Error('Source projection execution deadline exceeded');
          return Math.min(60_000, ms);
        };
        const beforeMigrations = await migrationRows(db());
        expect(beforeMigrations).toHaveLength(151);
        expect(beforeMigrations[150].name).toBe(E4_MIGRATION_151);
        expect(await installedBody(db())).toBe(bodyOf(originalDefinition()));
        expect(
          createHash('md5')
            .update(await installedBody(db()))
            .digest('hex'),
        ).toBe('4fbc9fab54eb6e429b79f7002a493efe');
        const beforeCatalog = await catalog(db());
        const beforeSettings = await settings(db());
        const beforeRows = await touchedRows(db());
        await owner.deploySourceProofProjectionMigrations(remaining());
        expect(createHash('sha256').update(migration).digest('hex')).toBe(CANDIDATE_SHA);
        expect(await installedBody(db())).toBe(bodyOf(migration));
        const afterMigrations = await migrationRows(db());
        expect(afterMigrations).toEqual([
          ...beforeMigrations,
          { name: E4_MIGRATION_152, checksum: CANDIDATE_SHA },
        ]);
        expect((await catalog(db())) === beforeCatalog).toBe(true);
        expect(await settings(db())).toEqual(beforeSettings);
        expect(await touchedRows(db())).toEqual(beforeRows);
        await db()
          .$queryRaw`SELECT public.ctsp_assert_complete(${prepared.newPostingBatchId},false)::text`;
        await owner.deploySourceProofProjectionMigrations(remaining());
        expect(await migrationRows(db())).toEqual(afterMigrations);
        expect((await catalog(db())) === beforeCatalog).toBe(true);
        expect(await settings(db())).toEqual(beforeSettings);
        expect(await touchedRows(db())).toEqual(beforeRows);
        upgraded = true;
      }),
    120_000,
  );

  it('checks thirty-six PG projection boundaries including literal JSON null, integer errors and mixed-array fallback', async () =>
    owned(async () => {
      expect(upgraded).toBe(true);
      const [result] = await db().$queryRawUnsafe<{ cases: number }[]>(
        'SELECT ' + namespace + '.projection_controls() AS cases',
      );
      expect(result.cases).toBe(36);
    }));

  it('commits the proof prepared under151 with both installed complete branches and preserves replay and four entries', async () =>
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

  it(
    'compares full original and installed guards on rollback-only temporary copies with positive and independent negative controls',
    async () =>
      owned(async () => {
        const before = await touchedRows(db());
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
            name: 'source projection mismatch',
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
            mutation:
              'UPDATE pg_temp."CorrectionTimeSourceProof" SET "sourceSetHash"=\'bad-anchor\'',
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
              'UPDATE pg_temp."CorrectionTimeAllocationBinding" SET "' +
              field +
              "\"='not-in-source'",
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
        const rollback = new Error(
          'Full guard matrix control observed; roll back temporary copies',
        );
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
        expect(await touchedRows(db())).toEqual(before);
      }),
    120_000,
  );

  it(
    'rehearses the prior body transactionally and retains152, catalog and rows after forced rollback',
    async () =>
      owned(async () => {
        const before = await touchedRows(db());
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
        expect(await touchedRows(db())).toEqual(before);
      }),
    120_000,
  );

  it(
    'prepares and commits a fresh real source under152 with the original service budgets and guards',
    async () =>
      owned(async () => {
        const next = await approvedE4TimeCorrection(f(), {
          startsAt: new Date('2020-03-02T08:00:00.000Z'),
          endsAt: new Date('2020-03-02T09:00:00.000Z'),
        });
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
      }),
    120_000,
  );
});

import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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
  E4_MIGRATION_140,
  E4_MIGRATION_142,
  E4_MIGRATION_143,
} from '../helpers/e4-migration-prefix';
import { assertConnectedTestDatabase } from '../setup/test-db';

const namespace = 'e4_assert_oracle_' + randomBytes(8).toString('hex');
const oldPin = '21fe9ecf6df989a3f8fa5878df40b93c';
const newPin = '59a9bc7d7c0c3b38df982536a2632b15';
const candidateSha = 'e1403f8aefb8e41bf050b4355551c42f3c7a889723782ce4b362ffc740c1d15b';
const rollback = new Error('E4 source reuse intentional rollback');
type Database = PrismaClient | Prisma.TransactionClient;
type Outcome = { state: string; guard: string };

function frozenAssertion() {
  const source = readFileSync(
    resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_137, 'migration.sql'),
    'utf8',
  );
  const definitions = [
    ...source.matchAll(/CREATE FUNCTION e4_assert_complete\([^]*? AS \$\$([^]*?)\$\$;/gu),
  ];
  expect(definitions).toHaveLength(1);
  expect(createHash('md5').update(definitions[0][1]).digest('hex')).toBe(oldPin);
  return definitions[0][0].replace(
    'CREATE FUNCTION e4_assert_complete(',
    'CREATE FUNCTION ' + namespace + '.original142(',
  );
}

// Load the existing independently frozen oracle as data, without registering its suite.
function frozenOracle() {
  const path = resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts');
  const source = readFileSync(path, 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6',
  );
  const names = [
    'fixedE4RootAggregateSql',
    'assertFixedE4RootOracle',
    'assertE4SliceSourceDenominators',
    'assertFixedE4DayOracle',
    'assertFixedE4Oracle',
  ];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(5);
  const code = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname,
    expect,
  }) as (db: PrismaClient, id: string, count?: number) => Promise<void>;
}

async function outcome(
  db: Database,
  id: string,
  original = false,
  validateVersion = true,
): Promise<Outcome> {
  const [row] = await db.$queryRawUnsafe<Outcome[]>(
    'SELECT state,guard FROM ' + namespace + '.outcome($1,$2,$3)',
    id,
    original,
    validateVersion,
  );
  return row;
}

async function catalog(db: Database) {
  const functions = await db.$queryRaw`
    SELECT p.oid::text AS oid,CASE WHEN p.oid='public.e4_assert_complete(text,boolean)'::regprocedure
      THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid
  `;
  const constraints =
    await db.$queryRaw`SELECT to_jsonb(c)::text AS definition FROM pg_constraint c WHERE connamespace='public'::regnamespace ORDER BY oid`;
  const triggers =
    await db.$queryRaw`SELECT to_jsonb(t)::text AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`;
  const indexes =
    await db.$queryRaw`SELECT oid::text AS oid,pg_get_indexdef(oid) AS definition FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid`;
  return JSON.stringify({ functions, constraints, triggers, indexes });
}

async function migrationRows(db: Database) {
  return db.$queryRaw<
    { name: string; checksum: string }[]
  >`SELECT migration_name AS name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
}

async function businessSnapshot(db: Database) {
  const tables = await db.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations' ORDER BY relname COLLATE "C"`;
  expect(tables.length).toBeGreaterThanOrEqual(196);
  const snapshots: string[] = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const [row] = await db.$queryRawUnsafe<{ snapshot: string }[]>(
      'SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text COLLATE "C"),\'[]\'::jsonb)::text AS snapshot FROM public.' +
        quoted +
        ' row',
    );
    snapshots.push(row.snapshot);
  }
  // Private rows remain in memory; failure output receives only a boolean.
  return JSON.stringify(snapshots);
}

function withoutIdentity<T extends { id: string; createdAt: Date }>(
  row: T,
): Omit<T, 'id' | 'createdAt'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'id' && key !== 'createdAt'),
  ) as Omit<T, 'id' | 'createdAt'>;
}

function rootData(
  root: ActivitySettlementContributionRevision,
  revision: number,
  operationKey: string,
) {
  const data = withoutIdentity(root);
  return { ...data, revision, operationKey };
}

describe('E4 complete assertion source reuse migration 143', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  const priorGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let fixture: E4Fixture | undefined;
  let installed = false;
  let roots: ActivitySettlementContributionRevision[] = [];
  const oracle = frozenOracle();
  const db = () => {
    if (!fixture) throw new Error('E4 source reuse fixture missing');
    return fixture.db;
  };
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployUnitMigrations();
    fixture = await createE4Fixture();
    for (const options of [
      {},
      {
        startsAt: new Date('2020-03-01T15:30:00.000Z'),
        endsAt: new Date('2020-03-01T17:00:00.000Z'),
      },
      {
        beforeSeal: async (draft: { activityId: string }) => {
          await db().activityParticipationIdentity.updateMany({
            where: { activityId: draft.activityId, populationIncluded: true },
            data: { populationIncluded: false },
          });
        },
      },
    ]) {
      const source = await createE4Source(fixture, options);
      const prepared = await prepareE4Time(fixture, source);
      await submitE4Time(fixture, source, prepared);
    }
    roots = await db().activitySettlementContributionRevision.findMany({
      orderBy: { revision: 'asc' },
    });
    expect(roots.length).toBe(6);
    if (!/^e4_assert_oracle_[a-f0-9]{16}$/u.test(namespace))
      throw new Error('E4 oracle namespace refused');
    await db().$executeRawUnsafe('CREATE SCHEMA ' + namespace);
    installed = true;
    await db().$executeRawUnsafe(frozenAssertion());
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.outcome(root_id text, original boolean, validate_version boolean) RETURNS TABLE(state text,guard text)
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
      DECLARE actual_state text; actual_guard text;
      BEGIN
        IF original THEN PERFORM ` +
        namespace +
        `.original142(root_id,validate_version);
        ELSE PERFORM public.e4_assert_complete(root_id,validate_version); END IF;
        RETURN QUERY SELECT '00000'::text,'NONE'::text;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
        IF actual_state='P0002' THEN RETURN QUERY SELECT 'P0002'::text,'NONE'::text;
        ELSIF actual_state='23514' AND actual_guard IN ('e4_source_guard','e4_evaluation_guard','e4_complete_guard','e4_version_guard','e4_result_guard','e4_selection_guard','e4_policy_guard','e4_copy_guard','e4_correction_guard')
          THEN RETURN QUERY SELECT actual_state,actual_guard;
        ELSE RAISE EXCEPTION 'E4 assertion unexpected error category'; END IF;
      END $body$;`,
    );
  }, 120_000);
  afterAll(async () => {
    try {
      if (installed && fixture)
        await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
    } finally {
      try {
        await closeE13Fixture(fixture);
      } finally {
        if (priorGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = priorGate;
      }
    }
  });

  it('preserves every business row and catalog identity on nonempty142 to143 and no-op with frozen root/day/source oracle', async () => {
    const beforeMigrations = await migrationRows(db());
    expect(beforeMigrations).toHaveLength(142);
    expect(beforeMigrations[141].name).toBe(E4_MIGRATION_142);
    const beforeCatalog = await catalog(db());
    const beforeBusiness = await businessSnapshot(db());
    for (const root of roots) {
      expect(await outcome(db(), root.id)).toEqual({ state: '00000', guard: 'NONE' });
      await oracle(db(), root.id, root.evaluationCount);
    }
    owner.deployLatestMigrations();
    const afterMigrations = await migrationRows(db());
    expect(afterMigrations).toHaveLength(143);
    expect(JSON.stringify(afterMigrations.slice(0, 142)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[142]).toEqual({ name: E4_MIGRATION_143, checksum: candidateSha });
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_143, 'migration.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(candidate).digest('hex')).toBe(candidateSha);
    const [installedBody] = await db().$queryRaw<
      { pin: string; body: string }[]
    >`SELECT md5(prosrc) AS pin,prosrc AS body FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure`;
    expect(installedBody.pin).toBe(newPin);
    expect(installedBody.body === candidate.split('$$')[1]).toBe(true);
    expect((await catalog(db())) === beforeCatalog).toBe(true);
    expect((await businessSnapshot(db())) === beforeBusiness).toBe(true);
    for (const root of roots) {
      expect(await outcome(db(), root.id)).toEqual(await outcome(db(), root.id, true));
      await oracle(db(), root.id, root.evaluationCount);
    }
    owner.deployLatestMigrations();
    expect(JSON.stringify(await migrationRows(db())) === JSON.stringify(afterMigrations)).toBe(
      true,
    );
    expect((await catalog(db())) === beforeCatalog).toBe(true);
    expect((await businessSnapshot(db())) === beforeBusiness).toBe(true);
    console.info(
      'E4_ASSERT143_NONEMPTY_UPGRADE',
      JSON.stringify({
        from: 142,
        to: 143,
        historicalChecksums: 142,
        roots: roots.length,
        businessUnchanged: true,
        catalogUnchanged: true,
        frozenOracle: true,
        noop: true,
      }),
    );
  }, 120_000);

  it('retains native source before evaluation before root error precedence with exact old/new SQLSTATE and rollback', async () => {
    const empty = roots.find((root) => root.kindCode === 'draft' && root.evaluationCount === 0)!;
    const nonempty = roots.find((root) => root.kindCode === 'draft' && root.evaluationCount > 0)!;
    const cases = [
      { root: empty, mutation: { evaluationCount: 1 }, guard: 'e4_complete_guard' },
      { root: empty, mutation: { draftContentHash: '0'.repeat(64) }, guard: 'e4_source_guard' },
      {
        root: empty,
        mutation: { draftContentHash: '0'.repeat(64), evaluationCount: 1 },
        guard: 'e4_source_guard',
      },
      { root: nonempty, mutation: {}, guard: 'e4_evaluation_guard' },
      { root: nonempty, mutation: { evaluationCount: 99 }, guard: 'e4_evaluation_guard' },
      {
        root: nonempty,
        mutation: { draftContentHash: '0'.repeat(64), evaluationCount: 99 },
        guard: 'e4_source_guard',
      },
    ];
    const before = await businessSnapshot(db());
    for (const testcase of cases) {
      await expect(
        db().$transaction(async (tx) => {
          const root = await tx.activitySettlementContributionRevision.create({
            data: {
              ...rootData(
                testcase.root,
                testcase.root.revision + 10,
                fixture!.key('source_reuse_negative'),
              ),
              ...testcase.mutation,
            },
          });
          const expected = { state: '23514', guard: testcase.guard };
          expect(await outcome(tx, root.id, true)).toEqual(expected);
          expect(await outcome(tx, root.id)).toEqual(expected);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect((await businessSnapshot(db())) === before).toBe(true);
    }
  }, 120_000);

  it('keeps the independent final version/result check after valid sources and evaluations', async () => {
    const root = roots.find((row) => row.kindCode === 'submitted' && row.evaluationCount > 0)!;
    const before = await businessSnapshot(db());
    await expect(
      db().$transaction(async (tx) => {
        await tx.attendanceSettlementVersion.update({
          where: { id: root.settlementVersionId },
          data: { sessionParticipationCount: { increment: 1 } },
        });
        expect(await outcome(tx, root.id, true, false)).toEqual({ state: '00000', guard: 'NONE' });
        expect(await outcome(tx, root.id, false, false)).toEqual({ state: '00000', guard: 'NONE' });
        expect(await outcome(tx, root.id, true)).toEqual({
          state: '23514',
          guard: 'e4_result_guard',
        });
        expect(await outcome(tx, root.id)).toEqual({ state: '23514', guard: 'e4_result_guard' });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await businessSnapshot(db())) === before).toBe(true);
  });

  it('rejects unresolved sources before evaluation/day construction in private SQL fault fixtures', async () => {
    const root = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    // No production function, trigger, index or constraint is changed. Private copies
    // inject one NULL source field and a failing day constructor to exercise the
    // otherwise unreachable double fault without weakening earlier database guards.
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.invalid_sources(revision_id text)
      RETURNS TABLE(identity_id text,member_id text,session_id text,snapshot_id text,item_id text,
        policy_id text,policy_version_id text,definition_hash text,evaluator_version integer,
        role_code text,category_code text,source_ref jsonb)
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
      SELECT identity_id,NULL::text,session_id,snapshot_id,item_id,policy_id,policy_version_id,
        definition_hash,evaluator_version,role_code,category_code,source_ref
      FROM public.e4_source_rows(revision_id) $body$;`,
    );
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.failing_days(refs jsonb,hundredths integer)
      RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $body$
      BEGIN RAISE EXCEPTION 'E4 private unexpected day construction'; END $body$;`,
    );
    const expectedSql = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_140, 'migration.sql'),
      'utf8',
    );
    const expectedDefinitions = [
      ...expectedSql.matchAll(/CREATE OR REPLACE FUNCTION e4_expected_evaluations\([^]*?\$\$;/gu),
    ];
    expect(expectedDefinitions).toHaveLength(1);
    await db().$executeRawUnsafe(
      expectedDefinitions[0][0]
        .replace(
          'CREATE OR REPLACE FUNCTION e4_expected_evaluations(',
          'CREATE FUNCTION ' + namespace + '.invalid_expected(',
        )
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_day_points(', namespace + '.failing_days('),
    );
    await db().$executeRawUnsafe(
      frozenAssertion()
        .replace(namespace + '.original142(', namespace + '.invalid142(')
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_expected_evaluations(', namespace + '.invalid_expected('),
    );
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_143, 'migration.sql'),
      'utf8',
    );
    const definition = [
      ...candidate.matchAll(/CREATE OR REPLACE FUNCTION e4_assert_complete\([^]*?\$\$;/gu),
    ];
    expect(definition).toHaveLength(1);
    await db().$executeRawUnsafe(
      definition[0][0]
        .replace(
          'CREATE OR REPLACE FUNCTION e4_assert_complete(',
          'CREATE FUNCTION ' + namespace + '.invalid143(',
        )
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_day_points(', namespace + '.failing_days('),
    );
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.invalid_priority(revision_id text) RETURNS boolean
      LANGUAGE plpgsql SECURITY INVOKER AS $body$
      DECLARE actual_state text; actual_guard text; day_failed boolean := false;
      BEGIN
        BEGIN PERFORM * FROM ` +
        namespace +
        `.invalid_expected(revision_id);
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM IS DISTINCT FROM 'E4 private unexpected day construction' THEN
            RAISE EXCEPTION 'E4 private day fault fixture mismatch';
          END IF;
          day_failed := true;
        END;
        IF NOT day_failed THEN RAISE EXCEPTION 'E4 private day fault fixture did not execute'; END IF;
        BEGIN PERFORM ` +
        namespace +
        `.invalid142(revision_id);
          RAISE EXCEPTION 'E4 private unresolved source accepted';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
          IF actual_state IS DISTINCT FROM '23514' OR actual_guard IS DISTINCT FROM 'e4_source_guard' THEN
            RAISE EXCEPTION 'E4 private old unresolved source priority mismatch';
          END IF;
        END;
        BEGIN PERFORM ` +
        namespace +
        `.invalid143(revision_id);
          RAISE EXCEPTION 'E4 private unresolved source accepted';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
          IF actual_state IS DISTINCT FROM '23514' OR actual_guard IS DISTINCT FROM 'e4_source_guard' THEN
            RAISE EXCEPTION 'E4 private new unresolved source priority mismatch';
          END IF;
        END;
        RETURN true;
      END $body$;`,
    );
    const [result] = await db().$queryRawUnsafe<{ matches: boolean }[]>(
      'SELECT ' + namespace + '.invalid_priority($1) AS matches',
      root.id,
    );
    expect(result.matches).toBe(true);
  });

  it('keeps INSERT and deferred checks independent and rolls back the whole transaction on a later incomplete root', async () => {
    const template = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    const evaluations = await db().participantContributionEvaluation.findMany({
      where: { contributionRevisionId: template.id },
    });
    const before = await businessSnapshot(db());
    let statementPassed = false;
    await expect(
      db().$transaction(async (tx) => {
        const root = await tx.activitySettlementContributionRevision.create({
          data: rootData(template, template.revision + 10, fixture!.key('source_reuse_insert')),
        });
        await tx.participantContributionEvaluation.createMany({
          data: evaluations.map((evaluation) => ({
            ...withoutIdentity(evaluation),
            contributionRevisionId: root.id,
            sourceRefsJson: evaluation.sourceRefsJson as Prisma.InputJsonValue,
            beijingDayPointsJson: evaluation.beijingDayPointsJson as Prisma.InputJsonValue,
          })),
        });
        statementPassed = true;
        expect(await outcome(tx, root.id)).toEqual({ state: '00000', guard: 'NONE' });
        await tx.activitySettlementContributionRevision.create({
          data: rootData(template, template.revision + 11, fixture!.key('source_reuse_deferred')),
        });
        // No explicit SET: the unchanged native deferred trigger must reject COMMIT.
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    expect(statementPassed).toBe(true);
    expect((await businessSnapshot(db())) === before).toBe(true);
  });

  it('uses a real statement snapshot across an observed two-backend commit and reads fresh sources on the next invocation', async () => {
    const observer = new PrismaClient();
    const template = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    const evaluations = await db().participantContributionEvaluation.findMany({
      where: { contributionRevisionId: template.id },
    });
    const lockKey = randomBytes(4).readInt32BE();
    const rootId = fixture!.key('source_reuse_visibility');
    let started!: (pid: number) => void;
    let rejectStarted!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve, reject) => {
      started = resolve;
      rejectStarted = reject;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writer: Promise<unknown> | undefined;
    let reader: Promise<{ before: number; after: number }[]> | undefined;
    try {
      await assertConnectedTestDatabase(observer);
      writer = db().$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)::text`;
          await tx.activitySettlementContributionRevision.create({
            data: {
              ...rootData(template, template.revision + 20, fixture!.key('source_reuse_committed')),
              id: rootId,
            },
          });
          await tx.participantContributionEvaluation.createMany({
            data: evaluations.map((evaluation) => ({
              ...withoutIdentity(evaluation),
              contributionRevisionId: rootId,
              sourceRefsJson: evaluation.sourceRefsJson as Prisma.InputJsonValue,
              beijingDayPointsJson: evaluation.beijingDayPointsJson as Prisma.InputJsonValue,
            })),
          });
          started(pid);
          await gate;
        },
        { timeout: 20_000 },
      );
      void writer.catch(rejectStarted);
      const writerPid = await ready;
      expect(await outcome(observer, rootId)).toEqual({ state: 'P0002', guard: 'NONE' });
      reader = observer.$queryRaw<{ before: number; after: number }[]>`
        WITH before_read AS MATERIALIZED (SELECT count(*)::int AS n FROM public.e4_source_rows(${rootId})),
        barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(${lockKey}::bigint)::text FROM before_read)
        SELECT b.n AS before,(SELECT count(*)::int FROM public.e4_source_rows(${rootId})) AS after FROM before_read b CROSS JOIN barrier
      `.then((rows) => rows);
      void reader.catch(() => undefined);
      // Observe the actual advisory waiter in this database before permitting COMMIT.
      const deadline = Date.now() + 5_000;
      let waited = false;
      while (Date.now() < deadline) {
        const [row] = await db().$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND ${writerPid} = ANY(pg_blocking_pids(pid))) AS waiting
        `;
        if (row.waiting) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waited).toBe(true);
      release();
      await writer;
      expect(await reader).toEqual([{ before: 0, after: 0 }]);
      const [fresh] = await observer.$queryRaw<
        { sources: number }[]
      >`SELECT count(*)::int AS sources FROM public.e4_source_rows(${rootId})`;
      expect(fresh.sources).toBeGreaterThan(0);
      expect(await outcome(observer, rootId)).toEqual({ state: '00000', guard: 'NONE' });
      expect(await outcome(observer, rootId, true)).toEqual({ state: '00000', guard: 'NONE' });
      await oracle(observer, rootId, template.evaluationCount);
      console.info(
        'E4_ASSERT143_SNAPSHOT',
        JSON.stringify({
          observedWait: true,
          statementBefore: 0,
          statementAfter: 0,
          nextInvocationFresh: true,
          committed: true,
        }),
      );
    } finally {
      release?.();
      await Promise.allSettled([writer, reader]);
      await observer.$disconnect();
    }
  }, 30_000);

  it('runs real prepare and submit after143 with native guards and the independent frozen oracle', async () => {
    const source = await createE4Source(fixture!);
    const prepared = await prepareE4Time(fixture!, source);
    await submitE4Time(fixture!, source, prepared);
    const current = await db().activitySettlementContributionRevision.findMany({
      where: { activityId: source.activityId },
    });
    expect(current).toHaveLength(2);
    for (const root of current) {
      expect(await outcome(db(), root.id)).toEqual(await outcome(db(), root.id, true));
      await oracle(db(), root.id, root.evaluationCount);
    }
  }, 120_000);
});

import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  installE4ValidationDatabase,
  prepareE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  compactRealKeyCarryEvidence,
  realKeyCarryProbeSql,
  createDiagnosticE4Source,
  verifyRealKeyCarryDatabase,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';
import { deriveTestDbName } from '../setup/worktree-db';
import { assertConnectedTestDatabase } from '../setup/test-db';

type Database = PrismaClient | Prisma.TransactionClient;
async function businessSnapshot(db: Database) {
  const tables = await db.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations' ORDER BY relname COLLATE "C"`;
  expect(tables.length).toBeGreaterThanOrEqual(196);
  const hashes: string[] = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const [row] = await db.$queryRawUnsafe<{ hash: string }[]>(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE "C"),\'[]\'::jsonb)::TEXT) AS hash FROM public.' +
        quoted +
        ' t',
    );
    hashes.push(row.hash);
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
async function catalog(db: Database) {
  const functions =
    await db.$queryRaw`SELECT p.oid::TEXT AS oid,CASE WHEN p.oid='public.e4_assert_complete(text,boolean)'::regprocedure THEN (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) ELSE to_jsonb(p) END AS metadata FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`;
  const constraints =
    await db.$queryRaw`SELECT to_jsonb(c)::TEXT AS definition FROM pg_constraint c WHERE connamespace='public'::regnamespace ORDER BY oid`;
  const triggers =
    await db.$queryRaw`SELECT to_jsonb(t)::TEXT AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`;
  const indexes =
    await db.$queryRaw`SELECT oid::TEXT AS oid,pg_get_indexdef(oid) AS definition FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid`;
  return JSON.stringify({ functions, constraints, triggers, indexes });
}
function withoutIdentity<T extends { id: string; createdAt: Date }>(
  row: T,
): Omit<T, 'id' | 'createdAt'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'id' && key !== 'createdAt'),
  ) as Omit<T, 'id' | 'createdAt'>;
}

// Root teardown runs after the suite closes its Prisma/Nest clients.
const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });

describe('E4 real evaluation JOIN key migration145', () => {
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let fixture: E4Fixture | undefined;
  let upgraded = false;
  let template: ActivitySettlementContributionRevision;
  const db = () => {
    if (!fixture) throw new Error('E4 key145 fixture unavailable');
    return fixture.db;
  };
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deploySourceBucketMigrations();
    fixture = await createE4Fixture();
    const source = await createDiagnosticE4Source(fixture, 1, createE4Source);
    const prepared = await prepareE4Time(fixture, source);
    template = await db().activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.settlementVersionId },
    });
  }, 120000);
  afterAll(async () => {
    try {
      await closeE13Fixture(fixture);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });
  it('upgrades nonempty144 without changing business rows, other functions, guard catalogs or settings; repeat deploy is a no-op', async () => {
    const beforeRows = await businessSnapshot(db()),
      beforeCatalog = await catalog(db());
    const beforeSettings = await db().$queryRaw`SELECT name,setting FROM pg_settings ORDER BY name`;
    const prior = await db().$queryRaw<
      { count: number; pin: string }[]
    >`SELECT (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure) AS pin`;
    expect(prior).toEqual([{ count: 144, pin: 'ade4d2af9aa0baf8400a79fc6b62c797' }]);
    owner.deployLatestMigrations();
    await verifyRealKeyCarryDatabase(db());
    expect((await businessSnapshot(db())) === beforeRows).toBe(true);
    expect((await catalog(db())) === beforeCatalog).toBe(true);
    expect(await db().$queryRaw`SELECT name,setting FROM pg_settings ORDER BY name`).toEqual(
      beforeSettings,
    );
    owner.deployLatestMigrations();
    await verifyRealKeyCarryDatabase(db());
    expect((await businessSnapshot(db())) === beforeRows).toBe(true);
    upgraded = true;
    console.info(
      'E4_KEY145_NONEMPTY_UPGRADE',
      JSON.stringify({
        from: 144,
        to: 145,
        businessRowsUnchanged: true,
        otherCatalogUnchanged: true,
        settingsUnchanged: true,
        noOp: true,
      }),
    );
  }, 60000);
  it('preserves both full implementations with six shadow evaluation negatives and six shadow error-priority rollback cases', async () => {
    expect(upgraded).toBe(true);
    const before = await businessSnapshot(db());
    await verifyRealKeyCarryDatabase(db());
    const proc = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        'u-nest-api-postgres',
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
        '-v',
        'root_id=' + template.id,
        '-U',
        'postgres',
        '-d',
        deriveTestDbName(),
      ],
      {
        input: realKeyCarryProbeSql(template.id, deriveTestDbName(), 4),
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 2097152,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (proc.status !== 0) {
      writeFileSync(join(tmpdir(), 'e4-key145-controls-failure-private.log'), proc.stderr, {
        mode: 0o600,
      });
      throw new Error('E4 key145 controls failed; private stderr retained');
    }
    const evidence = compactRealKeyCarryEvidence(proc.stderr, 4);
    console.info('E4_KEY145_CONTROLS', JSON.stringify(evidence));
    expect((await businessSnapshot(db())) === before).toBe(true);
    await verifyRealKeyCarryDatabase(db());
  }, 120000);
  it('rejects a missing evaluation through the actual native INSERT statement guard and rolls back', async () => {
    expect(upgraded).toBe(true);
    const observer = new PrismaClient();
    const rollback = new Error('E4 key145 statement negative rollback');
    try {
      await assertConnectedTestDatabase(observer);
      const before = await businessSnapshot(observer);
      let receipt: unknown;
      try {
        await db().$transaction(
          async (tx) => {
            const root = await tx.activitySettlementContributionRevision.create({
              data: {
                ...withoutIdentity(template),
                revision: template.revision + 20,
                operationKey: fixture!.key('key145_missing'),
              },
            });
            await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.e4_key145_missing(root_id TEXT,template_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $body$
          DECLARE state TEXT; guard TEXT;
          BEGIN
            BEGIN
              INSERT INTO public."ParticipantContributionEvaluation"
              SELECT (jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||jsonb_build_object('id',md5(e.id||root_id),'contributionRevisionId',root_id))).*
              FROM public."ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=template_id ORDER BY e."evaluationUnitKey" OFFSET 1;
              RETURN jsonb_build_object('state','ACCEPTED','guard','NONE');
            EXCEPTION WHEN OTHERS THEN
              GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,guard=CONSTRAINT_NAME;
              RETURN jsonb_build_object('state',state,'guard',guard,'rowsAfter',(SELECT count(*) FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root_id));
            END;
          END $body$;`);
            const [row] = await tx.$queryRaw<
              { receipt: unknown }[]
            >`SELECT pg_temp.e4_key145_missing(${root.id},${template.id}) AS receipt`;
            receipt = row.receipt;
            throw rollback;
          },
          { maxWait: 5000, timeout: 30000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const rolledBack = (await businessSnapshot(observer)) === before;
      console.info('E4_KEY145_INSERT_NEGATIVE', JSON.stringify({ receipt, rolledBack }));
      expect(rolledBack).toBe(true);
      expect(receipt).toEqual({ state: '23514', guard: 'e4_evaluation_guard', rowsAfter: 0 });
      await verifyRealKeyCarryDatabase(observer);
    } finally {
      await observer.$disconnect();
    }
  }, 60000);
  it('keeps the native INSERT guard and a later failing deferred COMMIT atomic under145', async () => {
    expect(upgraded).toBe(true);
    const observer = new PrismaClient();
    try {
      await assertConnectedTestDatabase(observer);
      const before = await businessSnapshot(observer);
      const evaluations = await db().participantContributionEvaluation.findMany({
        where: { contributionRevisionId: template.id },
      });
      let statementPassed = false,
        callbackReturned = false,
        actualError: unknown;
      try {
        await db().$transaction(
          async (tx) => {
            const complete = await tx.activitySettlementContributionRevision.create({
              data: {
                ...withoutIdentity(template),
                revision: template.revision + 10,
                operationKey: fixture!.key('key145_complete'),
              },
            });
            await tx.participantContributionEvaluation.createMany({
              data: evaluations.map((e) => ({
                ...withoutIdentity(e),
                contributionRevisionId: complete.id,
                sourceRefsJson: e.sourceRefsJson as Prisma.InputJsonValue,
                beijingDayPointsJson: e.beijingDayPointsJson as Prisma.InputJsonValue,
              })),
            });
            statementPassed = true;
            await tx.activitySettlementContributionRevision.create({
              data: {
                ...withoutIdentity(template),
                revision: template.revision + 11,
                operationKey: fixture!.key('key145_incomplete'),
              },
            });
            callbackReturned = true;
          },
          { maxWait: 5000, timeout: 30000 },
        );
      } catch (error) {
        actualError = error;
      }
      const rolledBack = (await businessSnapshot(observer)) === before;
      console.info(
        'E4_KEY145_DEFERRED_ROLLBACK',
        JSON.stringify({
          statementPassed,
          callbackReturned,
          rolledBack,
          unknownRequest: actualError instanceof Prisma.PrismaClientUnknownRequestError,
        }),
      );
      expect(rolledBack).toBe(true);
      expect(statementPassed).toBe(true);
      expect(callbackReturned).toBe(true);
      expect(actualError).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect((actualError as Error).message).toBe(
        'Error in connector: Error querying the database: ERROR: contribution evaluation set mismatch',
      );
      await verifyRealKeyCarryDatabase(observer);
    } finally {
      await observer.$disconnect();
    }
  }, 60000);
});

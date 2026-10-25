import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  prepareE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { approvedE4TimeCorrection } from '../helpers/activity-r5-correction-hash.fixture';
import { E4_MIGRATION_144, E4_MIGRATION_153 } from '../helpers/e4-migration-prefix';
import {
  createDiagnosticE4Source,
  SOURCE_JOIN_INPUTS,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';
import { assertConnectedTestDatabase } from '../setup/test-db';

type Database = PrismaClient | Prisma.TransactionClient;
const sqlRoot = resolve(__dirname, '../../prisma/migrations');
const original = readFileSync(resolve(sqlRoot, E4_MIGRATION_144, 'migration.sql'), 'utf8');
const candidate = readFileSync(resolve(sqlRoot, E4_MIGRATION_153, 'migration.sql'), 'utf8');
const candidateBody = candidate.split('$$')[1];
const candidateSha = '8be33faf3d4e5cc3f5036117684f620be83f9c9be49acc6c168f5bf894afd0df';
const columns =
  'identity_id,member_id,session_id,snapshot_id,item_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,source_ref';
let pending = 0;
let failed = false;
let appClosed = true;
let terminalUnknown = false;

async function owned(work: () => Promise<void>) {
  if (pending) terminalUnknown = true;
  if (pending || failed || terminalUnknown)
    throw new Error('Source153 prior FAIL/UNKNOWN; further work refused');
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

async function installedBody(db: Database) {
  const [row] = await db.$queryRaw<
    { body: string }[]
  >`SELECT prosrc AS body FROM pg_proc WHERE oid='public.e4_source_rows(text)'::regprocedure`;
  return row.body;
}

async function migrationRows(db: Database) {
  return db.$queryRaw<
    { name: string; checksum: string }[]
  >`SELECT migration_name AS name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
}

async function settingsSnapshot(db: PrismaClient) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`DO $$ BEGIN NULL; END $$`;
    return tx.$queryRaw`SELECT name,setting FROM pg_settings ORDER BY name`;
  });
}

async function businessSnapshot(db: Database) {
  const tables = await db.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations' ORDER BY relname COLLATE "C"`;
  expect(tables.length).toBeGreaterThanOrEqual(196);
  const hashes: string[] = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const [row] = await db.$queryRawUnsafe<{ hash: string }[]>(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),\'[]\'::jsonb)::text) AS hash FROM public.' +
        quoted +
        ' t',
    );
    hashes.push(row.hash);
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

async function catalog(db: Database) {
  const functions =
    await db.$queryRaw`SELECT p.oid::text AS oid,CASE WHEN p.oid='public.e4_source_rows(text)'::regprocedure THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`;
  const dependencies =
    await db.$queryRaw`SELECT to_jsonb(d)::text AS definition FROM pg_depend d WHERE (classid='pg_proc'::regclass AND objid='public.e4_source_rows(text)'::regprocedure) OR (refclassid='pg_proc'::regclass AND refobjid='public.e4_source_rows(text)'::regprocedure) ORDER BY to_jsonb(d)::text COLLATE "C"`;
  const constraints =
    await db.$queryRaw`SELECT to_jsonb(c)::text AS definition FROM pg_constraint c WHERE connamespace='public'::regnamespace ORDER BY oid`;
  const triggers =
    await db.$queryRaw`SELECT to_jsonb(t)::text AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`;
  const indexes =
    await db.$queryRaw`SELECT oid::text AS oid,pg_get_indexdef(oid) AS definition FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid`;
  return JSON.stringify({ functions, dependencies, constraints, triggers, indexes });
}

function reference(name: string, sql: string, shadow: boolean) {
  if (!/^source153_[a-z_]+$/u.test(name)) throw new Error('Source153 oracle identifier refused');
  const begin = sql.indexOf('CREATE OR REPLACE FUNCTION e4_source_rows(');
  const end = sql.lastIndexOf('$$;') + 3;
  if (begin < 0 || end < begin || sql.split('$$').length !== 3)
    throw new Error('Source153 fixed function boundary refused');
  let definition = sql
    .slice(begin, end)
    .replace('CREATE OR REPLACE FUNCTION e4_source_rows(', 'CREATE FUNCTION pg_temp.' + name + '(');
  if (shadow)
    for (const [table, temporary] of SOURCE_JOIN_INPUTS)
      definition = definition.replaceAll('"' + table + '"', 'pg_temp.' + temporary);
  return definition;
}

async function compareBag(
  tx: Prisma.TransactionClient,
  left: string,
  right: string,
  rootId: string | null,
) {
  if (
    ![left, right].every((name) =>
      /^(?:pg_temp\.source153_[a-z_]+|public\.e4_source_rows)$/u.test(name),
    )
  )
    throw new Error('Source153 comparison function refused');
  const [row] = await tx.$queryRawUnsafe<
    { oldCount: number; newCount: number; oldOnly: number; newOnly: number }[]
  >(
    'WITH a AS MATERIALIZED (SELECT ' +
      columns +
      ' FROM ' +
      left +
      '($1::text)),b AS MATERIALIZED (SELECT ' +
      columns +
      ' FROM ' +
      right +
      '($1::text)),old_only AS (SELECT ' +
      columns +
      ' FROM a EXCEPT ALL SELECT ' +
      columns +
      ' FROM b),new_only AS (SELECT ' +
      columns +
      ' FROM b EXCEPT ALL SELECT ' +
      columns +
      ' FROM a) SELECT (SELECT count(*)::int FROM a) AS "oldCount",(SELECT count(*)::int FROM b) AS "newCount",(SELECT count(*)::int FROM old_only) AS "oldOnly",(SELECT count(*)::int FROM new_only) AS "newOnly"',
    rootId,
  );
  expect(row.oldOnly).toBe(0);
  expect(row.newOnly).toBe(0);
  expect(row.newCount).toBe(row.oldCount);
  return row.oldCount;
}

function withoutIdentity<T extends { id: string; createdAt: Date }>(
  row: T,
): Omit<T, 'id' | 'createdAt'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'id' && key !== 'createdAt'),
  ) as Omit<T, 'id' | 'createdAt'>;
}

const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  boundMigrationProcesses: true,
  settlementMode: 'active',
  assertReadyToFinalize: () => {
    if (pending || failed || terminalUnknown || !appClosed)
      throw new Error('Source153 failed or resource terminal UNKNOWN; preserve database');
  },
});

describe('153 parameterized source reads on nonempty152', () => {
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let fixture: E4Fixture | undefined;
  let template: ActivitySettlementContributionRevision;
  let upgraded = false;
  const db = () => {
    if (!fixture) throw new Error('Source153 fixture unavailable');
    return fixture.db;
  };
  beforeAll(
    async () =>
      owned(async () => {
        await owner.deploySourceProofProjectionMigrations(60_000);
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        appClosed = false;
        fixture = await createE4Fixture();
        const source = await createDiagnosticE4Source(fixture, 1, createE4Source);
        const prepared = await prepareE4Time(fixture, source);
        template = await db().activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
        const correction = await approvedE4TimeCorrection(fixture);
        await correction.correction.prepare(
          correction.input,
          e4Actor(fixture.finalReviewer),
          E4_META,
        );
        const kinds = await db().activitySettlementContributionRevision.findMany({
          select: { sourceKindCode: true },
        });
        expect(kinds.map((row) => row.sourceKindCode)).toContain('time_revision');
        expect(kinds.map((row) => row.sourceKindCode)).toContain('correction_time_proof');
      }),
    120_000,
  );

  afterAll(async () => {
    try {
      if (pending) {
        terminalUnknown = true;
        throw new Error('Source153 pending work; close refused');
      }
      await closeE13Fixture(fixture);
      appClosed = true;
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  it(
    'upgrades nonempty152 to153 and no-op without data, function identity, ACL, dependency or GUC drift',
    async () =>
      owned(async () => {
        const prior = await migrationRows(db());
        expect(prior).toHaveLength(152);
        expect(await installedBody(db())).toBe(original.split('$$')[1]);
        const beforeSettings = await settingsSnapshot(db());
        const beforeRows = await businessSnapshot(db());
        const beforeCatalog = await catalog(db());
        await owner.deployLatestMigrations(60_000);
        expect(createHash('sha256').update(candidate).digest('hex')).toBe(candidateSha);
        expect(await installedBody(db())).toBe(candidateBody);
        const after = [...prior, { name: E4_MIGRATION_153, checksum: candidateSha }];
        expect(await migrationRows(db())).toEqual(after);
        expect(await businessSnapshot(db())).toBe(beforeRows);
        expect(await catalog(db())).toBe(beforeCatalog);
        expect(await settingsSnapshot(db())).toEqual(beforeSettings);
        await owner.deployLatestMigrations(60_000);
        expect(await migrationRows(db())).toEqual(after);
        expect(await businessSnapshot(db())).toBe(beforeRows);
        expect(await catalog(db())).toBe(beforeCatalog);
        expect(await settingsSnapshot(db())).toEqual(beforeSettings);
        upgraded = true;
      }),
    120_000,
  );

  it(
    'compares frozen144 to installed153 as full12-column bags for both branches, NULLs and non-vacuous source mutations',
    async () =>
      owned(async () => {
        expect(upgraded).toBe(true);
        const before = await businessSnapshot(db());
        const receipts = await db().$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
            await tx.$executeRaw`CREATE TEMP TABLE source153_marker(value INTEGER) ON COMMIT DROP`;
            expect(createHash('sha256').update(original.split('$$')[1]).digest('hex')).toBe(
              'a90576dfd0a06e169212838a4a5adf685afd747975f3e205fbaae97f6597b73c',
            );
            await tx.$executeRawUnsafe(reference('source153_old', original, false));
            const roots = await tx.activitySettlementContributionRevision.findMany({
              orderBy: { id: 'asc' },
            });
            for (const root of roots)
              expect(
                await compareBag(tx, 'pg_temp.source153_old', 'public.e4_source_rows', root.id),
              ).toBeGreaterThan(0);
            expect(
              await compareBag(tx, 'pg_temp.source153_old', 'public.e4_source_rows', null),
            ).toBe(0);
            expect(
              await compareBag(
                tx,
                'pg_temp.source153_old',
                'public.e4_source_rows',
                'source153-absent',
              ),
            ).toBe(0);
            for (const [table, temporary] of SOURCE_JOIN_INPUTS)
              await tx.$executeRawUnsafe(
                'CREATE TEMP TABLE ' +
                  temporary +
                  ' ON COMMIT DROP AS SELECT * FROM public."' +
                  table +
                  '" ORDER BY id COLLATE "C" DESC',
              );
            await tx.$executeRawUnsafe(reference('source153_old_shadow', original, true));
            await tx.$executeRawUnsafe(reference('source153_new_shadow', candidate, true));
            const bag = () =>
              compareBag(
                tx,
                'pg_temp.source153_old_shadow',
                'pg_temp.source153_new_shadow',
                template.id,
              );
            const base = await bag();
            expect(base).toBeGreaterThan(0);
            expect(
              await compareBag(
                tx,
                'pg_temp.source153_old_shadow',
                'public.e4_source_rows',
                template.id,
              ),
            ).toBe(base);
            const cases = [
              [
                'DUPLICATE_EDGE',
                'INSERT INTO pg_temp.e4_sj_links SELECT * FROM pg_temp.e4_sj_links',
                'double',
              ],
              ['MISSING_EDGE', 'DELETE FROM pg_temp.e4_sj_links', 'empty'],
              ['NULL_LINK', 'UPDATE pg_temp.e4_sj_links SET "allocationRevisionId"=NULL', 'empty'],
              [
                'WRONG_ACTIVITY',
                'UPDATE pg_temp.e4_sj_links SET "activityId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_TIME_REVISION',
                'UPDATE pg_temp.e4_sj_links SET "timeRevisionId"=\'source153-wrong\'',
                'empty',
              ],
              ['NULL_ACTIVITY', 'UPDATE pg_temp.e4_sj_links SET "activityId"=NULL', 'empty'],
              [
                'WRONG_IDENTITY',
                'UPDATE pg_temp.e4_sj_allocations SET "participationIdentityId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_SEGMENT',
                'UPDATE pg_temp.e4_sj_allocations SET "sourceSegmentId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_SEGMENT_REVISION',
                'UPDATE pg_temp.e4_sj_allocations SET "sourceSegmentRevision"="sourceSegmentRevision"+1',
                'empty',
              ],
              [
                'WRONG_SLICE_ALLOCATION',
                'UPDATE pg_temp.e4_sj_slices SET "allocationRevisionId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_SLICE_ACTIVITY',
                'UPDATE pg_temp.e4_sj_slices SET "activityId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_CATEGORY',
                'UPDATE pg_temp.e4_sj_slices SET "categoryCode"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_VERSION',
                'UPDATE pg_temp.e4_sj_results SET "settlementVersionId"=\'source153-wrong\'',
                'empty',
              ],
              [
                'WRONG_RESULT_IDENTITY',
                'UPDATE pg_temp.e4_sj_results SET "participationIdentityId"=\'source153-wrong\'',
                'empty',
              ],
              ['NULL_RESULT', 'UPDATE pg_temp.e4_sj_results SET "resultCode"=NULL', 'empty'],
              ['NULL_MEMBER', 'UPDATE pg_temp.e4_sj_allocations SET "memberId"=NULL', 'same'],
              ['ZERO_WEIGHT', 'UPDATE pg_temp.e4_sj_slices SET "endAt"="startAt"', 'same'],
            ] as const;
            const result: Array<{ name: string; rows: number }> = [];
            for (const [name, mutation, expected] of cases) {
              await tx.$executeRawUnsafe('SAVEPOINT source153_case');
              try {
                expect(await tx.$executeRawUnsafe(mutation)).toBeGreaterThan(0);
                const rows = await bag();
                expect(rows).toBe(
                  expected === 'double' ? base * 2 : expected === 'empty' ? 0 : base,
                );
                if (name === 'NULL_MEMBER') {
                  const [row] = await tx.$queryRaw<
                    { valid: boolean }[]
                  >`SELECT bool_and(member_id IS NULL) AS valid FROM pg_temp.source153_new_shadow(${template.id})`;
                  expect(row.valid).toBe(true);
                }
                result.push({ name, rows });
              } finally {
                await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT source153_case');
                await tx.$executeRawUnsafe('RELEASE SAVEPOINT source153_case');
              }
              expect(await bag()).toBe(base);
            }
            await tx.$executeRawUnsafe('SAVEPOINT source153_fraction');
            try {
              await tx.$executeRawUnsafe(
                "INSERT INTO pg_temp.e4_sj_slices SELECT (jsonb_populate_record(NULL::pg_temp.e4_sj_slices,to_jsonb(s)||jsonb_build_object('id',s.id||'_source153_tie'))).* FROM pg_temp.e4_sj_slices s",
              );
              await tx.$executeRawUnsafe(
                'UPDATE pg_temp.e4_sj_slices SET "endAt"="startAt"+interval \'1 millisecond\'',
              );
              await tx.$executeRawUnsafe('UPDATE pg_temp.e4_sj_buckets SET "recognizedSeconds"=1');
              expect(await bag()).toBe(base * 2);
              const [weights] = await tx.$queryRaw<
                { zero: number; one: number; other: number }[]
              >`SELECT count(*) FILTER(WHERE (source_ref->>'durationSeconds')::int=0)::int AS zero,count(*) FILTER(WHERE (source_ref->>'durationSeconds')::int=1)::int AS one,count(*) FILTER(WHERE (source_ref->>'durationSeconds')::int NOT IN (0,1))::int AS other FROM pg_temp.source153_new_shadow(${template.id})`;
              expect(weights.zero).toBeGreaterThan(0);
              expect(weights.one).toBeGreaterThan(0);
              expect(weights.other).toBe(0);
              result.push({ name: 'FRACTIONAL_WEIGHT_AND_TIES', rows: base * 2 });
            } finally {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT source153_fraction');
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT source153_fraction');
            }
            expect(await bag()).toBe(base);
            for (const name of ['source153_old', 'source153_old_shadow', 'source153_new_shadow'])
              await tx.$executeRawUnsafe('DROP FUNCTION pg_temp.' + name + '(TEXT)');
            return { roots: roots.length, mutations: result };
          },
          { timeout: 30_000 },
        );
        expect(await businessSnapshot(db())).toBe(before);
        expect(await installedBody(db())).toBe(candidateBody);
        console.info('E4_SOURCE153_FULL_BAG_CONTROLS', JSON.stringify(receipts));
      }),
    60_000,
  );

  it(
    'rejects a missing evaluation through the actual native INSERT statement guard and rolls back',
    async () =>
      owned(async () => {
        expect(upgraded).toBe(true);
        const observer = new PrismaClient();
        const rollback = new Error('E4 source153 statement negative rollback');
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
                    operationKey: fixture!.key('source153_missing'),
                  },
                });
                await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.e4_source153_missing(root_id TEXT,template_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $body$
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
                >`SELECT pg_temp.e4_source153_missing(${root.id},${template.id}) AS receipt`;
                receipt = row.receipt;
                throw rollback;
              },
              { maxWait: 5000, timeout: 30000 },
            );
          } catch (error) {
            if (error !== rollback) throw error;
          }
          const rolledBack = (await businessSnapshot(observer)) === before;
          console.info('E4_SOURCE153_INSERT_NEGATIVE', JSON.stringify({ receipt, rolledBack }));
          expect(rolledBack).toBe(true);
          expect(receipt).toEqual({ state: '23514', guard: 'e4_evaluation_guard', rowsAfter: 0 });
          expect(await installedBody(observer)).toBe(candidateBody);
        } finally {
          await observer.$disconnect();
        }
      }),
    60000,
  );
  it(
    'keeps the native INSERT guard and a later failing deferred COMMIT atomic under153',
    async () =>
      owned(async () => {
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
                    operationKey: fixture!.key('source153_complete'),
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
                    operationKey: fixture!.key('source153_incomplete'),
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
            'E4_SOURCE153_DEFERRED_ROLLBACK',
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
          expect(await installedBody(observer)).toBe(candidateBody);
        } finally {
          await observer.$disconnect();
        }
      }),
    60000,
  );
});

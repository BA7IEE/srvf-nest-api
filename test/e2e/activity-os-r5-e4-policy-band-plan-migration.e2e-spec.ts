import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  createDiagnosticE4Source,
  verifyPolicyBandDatabase,
  verifyPolicyBandMigrationSource,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';
import {
  policyBandControlsSql,
  policyBandCompleteBody,
} from '../helpers/e4-policy-band-plan.fixture';
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
let pending = 0;
let terminalUnknown = false;
let appClosed = true;
async function owned<T>(work: () => Promise<T>): Promise<T> {
  pending++;
  try {
    return await work();
  } finally {
    pending--;
  }
}
const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (pending || terminalUnknown || !appClosed)
      throw new Error('E4 pb146 work/resource terminal UNKNOWN; database finalizer refused');
  },
});

describe('E4 complete policy-band planning migration146', () => {
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let fixture: E4Fixture | undefined;
  let upgraded = false;
  let template: ActivitySettlementContributionRevision;
  const db = () => {
    if (!fixture) throw new Error('E4 pb146 fixture unavailable');
    return fixture.db;
  };
  beforeAll(
    async () =>
      owned(async () => {
        const deadline = performance.now() + 117000;
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        await owner.deployEvaluationKeyMigrations(
          Math.max(1, Math.floor(deadline - performance.now())),
        );
        appClosed = false;
        fixture = await createE4Fixture();
        const source = await createDiagnosticE4Source(fixture, 100, createE4Source);
        const prepared = await prepareE4Time(fixture, source);
        template = await db().activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
      }),
    120000,
  );
  afterAll(async () => {
    if (pending) {
      terminalUnknown = true;
      throw new Error('E4 pb146 async work pending; close and DROP refused');
    }
    try {
      if (fixture) {
        await closeE13Fixture(fixture);
        appClosed = true;
      } else if (!appClosed) {
        terminalUnknown = true;
        throw new Error('E4 pb146 app initialization close terminal UNKNOWN');
      }
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });
  it(
    'upgrades nonempty145 without changing business rows, other functions, guard catalogs or settings; repeat deploy is a no-op',
    async () =>
      owned(async () => {
        const deadline = performance.now() + 57000;
        verifyPolicyBandMigrationSource();
        const beforeRows = await businessSnapshot(db()),
          beforeCatalog = await catalog(db());
        const beforeSettings = await db()
          .$queryRaw`SELECT name,setting FROM pg_settings ORDER BY name`;
        const prior = await db().$queryRaw<
          { count: number; pin: string }[]
        >`SELECT (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure) AS pin`;
        expect(prior).toEqual([{ count: 145, pin: 'b03a7298e625b703fa2f011c0fbcc6c0' }]);
        await owner.deployLatestMigrations(Math.max(1, Math.floor(deadline - performance.now())));
        await verifyPolicyBandDatabase(db());
        expect((await businessSnapshot(db())) === beforeRows).toBe(true);
        expect((await catalog(db())) === beforeCatalog).toBe(true);
        expect(await db().$queryRaw`SELECT name,setting FROM pg_settings ORDER BY name`).toEqual(
          beforeSettings,
        );
        await owner.deployLatestMigrations(Math.max(1, Math.floor(deadline - performance.now())));
        await verifyPolicyBandDatabase(db());
        expect((await businessSnapshot(db())) === beforeRows).toBe(true);
        upgraded = true;
        console.info(
          'E4_PB146_NONEMPTY_UPGRADE',
          JSON.stringify({
            from: 145,
            to: 146,
            businessRowsUnchanged: true,
            otherCatalogUnchanged: true,
            settingsUnchanged: true,
            noOp: true,
          }),
        );
      }),
    60000,
  );
  it.each([false, true])(
    'compares both complete functions: smallNegatives=%s (400 real shared-policy groups remain an independent positive)',
    async (negatives) =>
      owned(async () => {
        expect(upgraded).toBe(true);
        let controlRoot = template;
        if (negatives) {
          const source = await createDiagnosticE4Source(fixture!, 1, createE4Source);
          const prepared = await prepareE4Time(fixture!, source);
          controlRoot = await db().activitySettlementContributionRevision.findFirstOrThrow({
            where: { settlementVersionId: prepared.settlementVersionId },
          });
        }
        const beforeControls = await businessSnapshot(db());
        const units = await db().participantContributionEvaluation.count({
          where: { contributionRevisionId: controlRoot.id },
        });
        expect(units).toBe(negatives ? 4 : 400);
        const ownerLabel = `e4_pb146_${process.pid}_${negatives ? 'small' : 'shared'}`;
        const proc = spawnSync(
          'docker',
          [
            'exec',
            '-i',
            'u-nest-api-postgres',
            'psql',
            '-Xq',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'postgres',
            '-d',
            deriveTestDbName(),
          ],
          {
            input:
              `SET application_name='${ownerLabel}';\nSELECT 'E4_PB_BACKEND '||pg_backend_pid();\n` +
              policyBandControlsSql(controlRoot.id, negatives),
            encoding: 'utf8',
            timeout: 110000,
            maxBuffer: 2097152,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        if (proc.error || proc.signal) terminalUnknown = true;
        const [{ remaining }] = await db().$queryRaw<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=${ownerLabel}
    `.catch(() => {
          terminalUnknown = true;
          return [{ remaining: -1 }];
        });
        if (proc.error || proc.signal || remaining !== 0) terminalUnknown = true;
        if (proc.status !== 0 || terminalUnknown) {
          let retained = false;
          try {
            const directory = mkdtempSync(join(tmpdir(), 'e4-pb146-controls-'));
            writeFileSync(join(directory, 'failure-private.log'), proc.stderr, { mode: 0o600 });
            writeFileSync(
              join(directory, 'process.json'),
              JSON.stringify({
                status: proc.status,
                signal: proc.signal,
                errorCode: proc.error && 'code' in proc.error ? proc.error.code : null,
                ownedBackendsRemaining: remaining,
                terminalUnknown,
              }),
              { mode: 0o600 },
            );
            retained = true;
          } catch {
            /* Keep the original subprocess outcome even if retention fails. */
          }
          throw new Error(
            `E4 pb146 full controls failed status=${proc.status} signal=${proc.signal} childError=${Boolean(proc.error)} ownedBackends=${remaining} terminalUnknown=${terminalUnknown} retained=${retained}`,
          );
        }
        const receipts = proc.stderr
          .split('\n')
          .filter((line) => line.startsWith('NOTICE:  E4_PB_CONTROL '))
          .map(
            (line) =>
              JSON.parse(line.slice('NOTICE:  E4_PB_CONTROL '.length)) as {
                case: string;
                version?: number;
                rolledBack?: boolean;
              },
          );
        expect(receipts).toHaveLength(negatives ? 15 : 1);
        for (const version of negatives ? [145, 146] : [])
          for (const kind of [
            'MISSING',
            'EXTRA',
            'TAMPERED',
            'DUPLICATE',
            'SOURCE_PRIORITY',
            'ROOT',
            'INVALID_UNSELECTED_POLICY',
          ]) {
            expect(receipts.filter((row) => row.case === kind && row.version === version)).toEqual([
              expect.objectContaining({ rolledBack: true }),
            ]);
          }
        expect(await businessSnapshot(db())).toBe(beforeControls);
        console.info(
          'E4_PB146_CONTROLS',
          JSON.stringify({ realGroups: units, receipts, businessRowsUnchanged: true }),
        );
      }),
    120000,
  );
  it(
    'rejects a missing evaluation through the actual native INSERT statement guard and rolls back',
    async () =>
      owned(async () => {
        expect(upgraded).toBe(true);
        const observer = new PrismaClient();
        const rollback = new Error('E4 pb146 statement negative rollback');
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
                    operationKey: fixture!.key('pb146_missing'),
                  },
                });
                await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.e4_pb146_missing(root_id TEXT,template_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $body$
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
                >`SELECT pg_temp.e4_pb146_missing(${root.id},${template.id}) AS receipt`;
                receipt = row.receipt;
                throw rollback;
              },
              { maxWait: 5000, timeout: 30000 },
            );
          } catch (error) {
            if (error !== rollback) throw error;
          }
          const rolledBack = (await businessSnapshot(observer)) === before;
          console.info('E4_PB146_INSERT_NEGATIVE', JSON.stringify({ receipt, rolledBack }));
          expect(rolledBack).toBe(true);
          expect(receipt).toEqual({ state: '23514', guard: 'e4_evaluation_guard', rowsAfter: 0 });
          await verifyPolicyBandDatabase(observer);
        } finally {
          await observer.$disconnect();
        }
      }),
    60000,
  );
  it(
    'keeps the native INSERT guard and a later failing deferred COMMIT atomic under146',
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
                    operationKey: fixture!.key('pb146_complete'),
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
                    operationKey: fixture!.key('pb146_incomplete'),
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
            'E4_PB146_DEFERRED_ROLLBACK',
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
          await verifyPolicyBandDatabase(observer);
        } finally {
          await observer.$disconnect();
        }
      }),
    60000,
  );

  it(
    'preserves inclusive bands, open upper bounds, empty-role/category defaults and distinct policy IDs in both complete functions',
    async () =>
      owned(async () => {
        expect(upgraded).toBe(true);
        const definition = {
          defaultResult: { recognizedPoints: '0.25', explanationCode: 'plan_default' },
          roleRules: [
            {
              attendanceRoleCode: 'service',
              categoryRules: [
                {
                  timeCategoryCode: 'volunteer_service' as const,
                  durationBands: [
                    {
                      maxSecondsInclusive: 60,
                      recognizedPoints: '0.50',
                      explanationCode: 'plan_inclusive',
                    },
                    {
                      maxSecondsInclusive: null,
                      recognizedPoints: '1.00',
                      explanationCode: 'plan_open',
                    },
                  ],
                },
              ],
            },
          ],
        };
        const cases = [
          { seconds: 60, definition, expected: '0.50' },
          { seconds: 61, definition, expected: '1.00' },
          { seconds: 60, definition: { ...definition, roleRules: [] }, expected: '0.25' },
          {
            seconds: 60,
            definition: {
              ...definition,
              roleRules: [{ attendanceRoleCode: 'service', categoryRules: [] }],
            },
            expected: '0.25',
          },
        ];
        const policies = new Set<string>();
        for (const item of cases) {
          const startsAt = new Date('2020-03-01T08:00:00.000Z');
          const source = await createE4Source(fixture!, {
            definition: item.definition,
            timeDefinition: {
              defaultCategory: 'volunteer_service',
              roleMappings: [],
              allowSplit: false,
              specialIntervals: {
                preparation: { mode: 'exclude' },
                duty: { mode: 'exclude' },
                travel: { mode: 'exclude' },
              },
              rounding: { mode: 'floor', quantumSeconds: 1 },
              evidence: { requiredSources: [], requireManualRecognition: false },
              manualAdjustment: { enabled: false },
            },
            startsAt,
            endsAt: new Date(startsAt.getTime() + item.seconds * 1000),
          });
          const prepared = await prepareE4Time(fixture!, source);
          const root = await db().activitySettlementContributionRevision.findFirstOrThrow({
            where: { settlementVersionId: prepared.settlementVersionId },
            include: { evaluations: true },
          });
          expect(root.evaluations).toHaveLength(1);
          expect(root.evaluations[0].durationSeconds).toBe(item.seconds);
          expect(root.evaluations[0].recognizedPoints.toFixed(2)).toBe(item.expected);
          policies.add(root.evaluations[0].policyVersionId);
          await db().$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(
                `CREATE OR REPLACE FUNCTION pg_temp.e4_boundary145(revision_id TEXT,validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $pb$${policyBandCompleteBody(145)}$pb$;`,
              );
              await tx.$queryRaw`SELECT pg_temp.e4_boundary145(${root.id})::TEXT`;
              await tx.$queryRaw`SELECT public.e4_assert_complete(${root.id})::TEXT`;
            },
            { timeout: 20000 },
          );
        }
        expect(policies.size).toBe(cases.length);
        console.info(
          'E4_PB146_BOUNDARIES',
          JSON.stringify({
            completeVersions: [145, 146],
            inclusiveSeconds: 60,
            nextSecond: 61,
            emptyRolesDefault: true,
            emptyCategoriesDefault: true,
            distinctPolicies: policies.size,
          }),
        );
      }),
    120000,
  );

  it(
    'reads one consistent policy snapshot across concurrent retirement and still rejects definition mutation',
    async () =>
      owned(async () => {
        expect(upgraded).toBe(true);
        const evaluation = await db().participantContributionEvaluation.findFirstOrThrow({
          where: { contributionRevisionId: template.id },
        });
        const writer = new PrismaClient();
        let release!: () => void, written!: () => void;
        const mayCommit = new Promise<void>((resolve) => {
          release = resolve;
        });
        const didWrite = new Promise<void>((resolve) => {
          written = resolve;
        });
        let pending: Promise<unknown> | undefined;
        try {
          await assertConnectedTestDatabase(writer);
          pending = writer.$transaction(
            async (tx) => {
              await tx.contributionPolicyVersion.update({
                where: { id: evaluation.policyVersionId },
                data: {
                  statusCode: 'retired',
                  retiredAt: new Date(),
                  retiredByUserId: fixture!.creator.id,
                },
              });
              written();
              await mayCommit;
            },
            { timeout: 30000 },
          );
          await Promise.race([
            didWrite,
            pending.then(() => {
              throw new Error('Policy writer ended before its barrier');
            }),
          ]);
          await db().$queryRaw`SELECT e4_assert_complete(${template.id})::TEXT`;
          release();
          await pending;
          await db().$queryRaw`SELECT e4_assert_complete(${template.id})::TEXT`;
          expect(
            (
              await db().contributionPolicyVersion.findUniqueOrThrow({
                where: { id: evaluation.policyVersionId },
              })
            ).statusCode,
          ).toBe('retired');
          const before = await businessSnapshot(db());
          await expect(
            writer.$executeRaw`UPDATE "ContributionPolicyVersion" SET "definitionJson"=jsonb_set("definitionJson",'{defaultResult,recognizedPoints}','"99.00"'::jsonb) WHERE id=${evaluation.policyVersionId}`,
          ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
          expect(await businessSnapshot(db())).toBe(before);
          console.info(
            'E4_PB146_POLICY_CONCURRENCY',
            JSON.stringify({
              beforeRetirementComplete: true,
              afterRetirementComplete: true,
              immutableDefinitionRejected: true,
              noMutationLeaked: true,
            }),
          );
        } finally {
          release();
          if (pending) await pending.catch(() => undefined);
          await writer.$disconnect();
        }
      }),
    60000,
  );
});

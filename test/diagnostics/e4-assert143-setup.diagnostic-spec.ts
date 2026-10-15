import { Prisma, PrismaClient } from '@prisma/client';
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
import { E4AssertionCaseOwner } from '../helpers/e4-assert143-lifecycle';
import { assertConnectedTestDatabase } from '../setup/test-db';

if (process.env.SRVF_E4_W98 !== '1' || process.env.SRVF_E4_GITHUB_ISOLATED !== undefined)
  throw new Error('E4 single-source diagnostic requires the explicit local W98 lease scope');

// Diagnostic only: one legal activity locates historical setup cost. It cannot
// satisfy the unchanged three-activity/six-root migration143 regression suite.
function fixedOracle() {
  const directory = resolve(__dirname, '../e2e');
  const file = resolve(directory, 'activity-os-r5-e4-contribution-settlement.e2e-spec.ts');
  const source = readFileSync(file, 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '46c31154bfa284f923ab34ca8be651573a8fe3a1f6d6035e1010265371a17e72',
  );
  const names = ['fixedE4RootAggregateSql', 'assertFixedE4RootOracle', 'assertFixedE4Oracle'];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(3);
  const code = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname: directory,
    expect,
  }) as (db: PrismaClient, id: string, count?: number) => Promise<void>;
}

const oracle = fixedOracle();
const applicationName = 'e4_143_setup_' + randomBytes(8).toString('hex');
let fixture: E4Fixture | undefined;
let monitor: PrismaClient | undefined;
let closed = false;
const cases = new E4AssertionCaseOwner(async () => {
  if (!monitor) throw new Error('E4 single-source cancellation monitor unavailable');
  await monitor.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname=current_database() AND application_name=${applicationName} AND pid<>pg_backend_pid()`;
  const until = performance.now() + 500;
  do {
    const [row] = await monitor.$queryRaw<{ remaining: bigint }[]>`SELECT count(*) AS remaining
      FROM pg_stat_activity WHERE datname=current_database() AND application_name=${applicationName}`;
    if (row.remaining === 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < until);
  throw new Error('E4 single-source cancellation terminal state unknown');
});
const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    cases.assertSettled();
    if (!closed) throw new Error('E4 single-source clients still open');
  },
});

describe('E4 historical142 single-source setup diagnostic only', () => {
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let previousUrl: string | undefined;
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      cases.assertSettled();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([closeE13Fixture(fixture), monitor?.$disconnect()]);
    closed = results.every((result) => result.status === 'fulfilled');
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    if (previousUrl !== undefined) process.env.DATABASE_URL = previousUrl;
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    if (failures.length) throw new AggregateError(failures, 'E4 single-source cleanup failed');
  });

  it(
    'records source, prepare, submit and frozen oracle under the original 120s envelope',
    () =>
      cases.run(async () => {
        const started = performance.now();
        const stages: { stage: string; wallMs: number }[] = [];
        let stage = 'MONITOR';
        const measure = async <T>(name: string, work: () => Promise<T>) => {
          stage = name;
          const at = performance.now();
          console.info(
            'E4_ASSERT143_SINGLE_SOURCE_STAGE',
            JSON.stringify({ stage, event: 'ENTER', elapsedMs: at - started }),
          );
          const value = await work();
          const wallMs = performance.now() - at;
          stages.push({ stage, wallMs });
          console.info(
            'E4_ASSERT143_SINGLE_SOURCE_STAGE',
            JSON.stringify({ stage, event: 'COMPLETE', wallMs }),
          );
          return value;
        };
        try {
          process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
          previousUrl = process.env.DATABASE_URL;
          const url = new URL(previousUrl!);
          url.searchParams.set('application_name', applicationName);
          process.env.DATABASE_URL = url.toString();
          url.searchParams.set('application_name', applicationName + '_monitor');
          monitor = new PrismaClient({ datasourceUrl: url.toString() });
          await assertConnectedTestDatabase(monitor);
          await measure('UNIT142_DEPLOY', () => owner.deployUnitMigrations(cases.remainingMs()));
          const [installed] = await monitor.$queryRaw<{ count: number; pin: string }[]>`SELECT
        (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,
        (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure) AS pin`;
          expect(installed).toEqual({ count: 142, pin: '21fe9ecf6df989a3f8fa5878df40b93c' });
          fixture = await measure('APP_FIXTURE', createE4Fixture);
          const source = await measure('SOURCE', () => createE4Source(fixture!));
          const prepared = await measure('PREPARE', () => prepareE4Time(fixture!, source));
          await measure('SUBMIT', () => submitE4Time(fixture!, source, prepared));
          await measure('FROZEN_ORACLE', async () => {
            const roots = await fixture!.db.activitySettlementContributionRevision.findMany();
            expect(roots).toHaveLength(2);
            for (const root of roots) await oracle(fixture!.db, root.id, 1);
          });
          console.info(
            'E4_ASSERT143_SINGLE_SOURCE',
            JSON.stringify({
              diagnosticOnly: true,
              acceptance: false,
              activities: 1,
              roots: 2,
              stages,
              totalWallMs: performance.now() - started,
            }),
          );
        } finally {
          console.info(
            'E4_ASSERT143_SINGLE_SOURCE_END',
            JSON.stringify({ stage, stages, totalWallMs: performance.now() - started }),
          );
        }
      }, 120_000),
    120_000,
  );
});

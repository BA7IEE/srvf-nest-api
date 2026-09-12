import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260910100000_activity_os_r4_d1_time_policy_foundation';
const tables = [
  'User',
  'Organization',
  'Activity',
  'ActivityMetricDefinition',
  'ActivityMetricSetVersion',
  'ActivityMetricSetItem',
  'ActivityOutcomeRevision',
  'ActivityMetricValueRevision',
  'ActivityOutcomeCommandReceipt',
  'AttendanceSettlementRun',
];
function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('D1-1 requires isolated worker');
  return { worker, database: deriveTestDbName() };
}
function sql(statement: string) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      target().database,
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
function recreate() {
  const { worker, database } = target();
  dropWorkerDatabase(worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
}
function deploy(schema: string) {
  target();
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
      stdio: 'pipe',
      env: process.env,
    });
  } catch {
    throw new Error('D1-1 isolated migration deploy failed (connection details suppressed)');
  }
}
function snapshot() {
  return tables.map((table) => sql(`SELECT row_to_json(t)::text FROM "${table}" t ORDER BY id`));
}
function seedLegacy() {
  const hash = 'a'.repeat(64);
  const receipt = JSON.stringify({
    schemaVersion: 1,
    activityId: 'd11-activity',
    outcomeRevisionId: 'd11-outcome',
    revision: 1,
    metricSetVersionId: 'd11-set',
    metricSetDefinitionHash: hash,
    createdStatusCode: 'draft',
    sourceCode: 'manual',
    valueCount: 1,
    evidenceCount: 0,
    createdAt: '2025-01-03T00:00:00.000Z',
  });
  sql(`BEGIN;
    INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('d11-actor','d11-actor','test-only',CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('d11-org',CURRENT_TIMESTAMP,'Test','team');
    INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('d11-activity',CURRENT_TIMESTAMP,'Test','test','d11-org','2025-01-01','2025-01-02','Test','draft');
    INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('d11-definition','d11_count',1,'Count','non_negative_integer','人','{"kindCode":"non_negative_integer","unit":"人","minimum":0,"maximum":2000}',1,'${hash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('d11-set','d11_set',1,'Set',1,'${hash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('d11-item','d11-set','d11-definition','count',0,true);
    INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId","createdAt") VALUES ('d11-outcome','d11-activity',1,'d11-set','${hash}','draft','d11-actor','2025-01-03T00:00:00.000Z');
    INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES ('d11-value','d11-outcome','d11-activity','d11-set','d11-definition','3','${hash}','manual');
    INSERT INTO "ActivityOutcomeCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","activityId","outcomeRevisionId","resultJson") VALUES ('d11-receipt','d11-actor','record_manual_outcome','d11-operation','${hash}','d11-activity','d11-outcome','${receipt}');
    INSERT INTO "AttendanceSettlementRun" (id,"updatedAt","activityId","statusCode") VALUES ('d11-run',CURRENT_TIMESTAMP,'d11-activity','not_started');
    COMMIT;`);
}

describe('D1-1 117 to 118 migration', () => {
  const root = path.resolve('prisma');

  // The historical upgrade deliberately leaves this worker at migration 118.
  // Restore the shared Jest worker clone so later E2E specs always see the
  // current Prisma surface, including migrations introduced after D1-1.
  afterAll(() => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
  }, 120000);

  it('replays 120 migrations from empty and verifies every SQL checksum', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(120);
    expect(names[117]).toBe(MIGRATION);
    const records = sql(
      'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
    ).split('\n');
    expect(records).toEqual(
      names.map(
        (name) =>
          name +
          '\t' +
          createHash('sha256')
            .update(readFileSync(path.join(root, 'migrations', name, 'migration.sql')))
            .digest('hex'),
      ),
    );
    expect(
      sql(
        `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TimePolicy','TimePolicyVersion','TimePolicyCommandReceipt')`,
      ),
    ).toBe('3');
  }, 120000);

  it('preserves nonempty activity, outcome and settlement facts when upgrading 117 to 118', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d11-pre118-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(names.indexOf(MIGRATION)).toBe(117);
      for (const name of names.slice(0, 117))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      const schema = path.join(temporary, 'schema.prisma');
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '117',
      );
      seedLegacy();
      const before = snapshot();
      for (const rows of before) expect(rows.length).toBeGreaterThan(0);
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        { recursive: true, force: false, errorOnExist: true },
      );
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '118',
      );
      expect(snapshot()).toEqual(before);
      for (const table of ['TimePolicy', 'TimePolicyVersion', 'TimePolicyCommandReceipt'])
        expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
      deploy(schema);
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
});

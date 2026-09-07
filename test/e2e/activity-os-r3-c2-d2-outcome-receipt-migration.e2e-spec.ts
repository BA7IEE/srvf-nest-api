import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  assertTestDatabaseUrl,
  recreateWorkerDatabase,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const WORKER = 98;
const hash = 'a'.repeat(64);
function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-q',
      '-tA',
      '-U',
      'postgres',
      '-d',
      deriveWorkerTestDbName(WORKER),
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
function rejected(statement: string, state: string) {
  let stderr = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    stderr = String(error.stderr);
  }
  expect(stderr).toContain(state);
}
function receipt(change: Record<string, unknown> = {}, activity = 'outcome-activity') {
  const result = JSON.stringify({
    schemaVersion: 1,
    activityId: 'outcome-activity',
    outcomeRevisionId: 'outcome',
    revision: 1,
    metricSetVersionId: 'outcome-set',
    metricSetDefinitionHash: hash,
    createdStatusCode: 'draft',
    sourceCode: 'manual',
    valueCount: 1,
    evidenceCount: 0,
    createdAt: '2026-09-07T08:00:00.000Z',
    ...change,
  }).replaceAll("'", "''");
  return `INSERT INTO "ActivityOutcomeCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","activityId","outcomeRevisionId","resultJson") VALUES ('receipt','outcome-actor','record_manual_outcome','command','${hash}','${activity}','outcome','${result}')`;
}

function seedDefinitionFixture() {
  sql(`INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('outcome-actor','outcome-actor','test-only',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('outcome-org',CURRENT_TIMESTAMP,'test','team');
      INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES
      ('outcome-activity',CURRENT_TIMESTAMP,'test','test','outcome-org','2099-10-01','2099-10-02','test','draft');
      INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES
      ('outcome-definition','receipt_metric',1,'test','boolean',NULL,'{"kindCode":"boolean","unit":null}',1,'${hash}','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES
      ('outcome-set','receipt_set',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('outcome-item','outcome-set','outcome-definition','result',0,true);`);
}

describe('C2 D2 actual PostgreSQL outcome receipt constraints', () => {
  beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    recreateWorkerDatabase(WORKER);
    seedDefinitionFixture();
  });
  afterAll(() => dropWorkerDatabase(WORKER));
  beforeEach(() => {
    sql(`TRUNCATE "ActivityOutcomeCommandReceipt", "ActivityMetricValueEvidence", "ActivityMetricValueRevision", "ActivityOutcomeRevision";
      INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId","createdAt") VALUES
      ('outcome','outcome-activity',1,'outcome-set','${hash}','draft','outcome-actor','2026-09-07T08:00:00.000Z');
      INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES
      ('outcome-value','outcome','outcome-activity','outcome-set','outcome-definition','true','${hash}','manual');`);
  });
  it('accepts a same-chain receipt on the current migrated database', () => {
    expect(sql('SELECT current_database()')).toBe(deriveWorkerTestDbName(WORKER));
    sql(receipt());
    expect(sql('SELECT count(*) FROM "ActivityOutcomeCommandReceipt"')).toBe('1');
  });
  it.each([
    { revision: 2 },
    { metricSetVersionId: 'other' },
    { metricSetDefinitionHash: 'b'.repeat(64) },
    { valueCount: 2 },
    { evidenceCount: 1 },
    { createdAt: '2026-09-07T08:00:00.001Z' },
    { sourceCode: 'system' },
    { createdStatusCode: 'confirmed' },
    { key: 'forbidden' },
    { schemaVersion: null },
    { activityId: 'other' },
  ])('rejects a forged creation fact or unsafe envelope %#', (change) => {
    rejected(receipt(change), '23514');
    expect(sql('SELECT count(*) FROM "ActivityOutcomeCommandReceipt"')).toBe('0');
  });
  it('rejects cross-activity receipt anchors', () => {
    rejected(receipt({}, 'another-activity'), '23503');
  });
  it('rejects duplicate commands', () => {
    sql(receipt());
    rejected(receipt().replace("'receipt'", "'duplicate'"), '23505');
  });
  it.each([
    'UPDATE "ActivityOutcomeCommandReceipt" SET "operationKey"=\'other\'',
    'DELETE FROM "ActivityOutcomeCommandReceipt"',
  ])('preserves receipts against mutation %#', (statement) => {
    sql(receipt());
    rejected(statement, '23514');
    expect(sql('SELECT "operationKey" FROM "ActivityOutcomeCommandReceipt"')).toBe('command');
  });
});

describe('C2 D2 nonempty 113 to 114 upgrade', () => {
  afterAll(() => dropWorkerDatabase(WORKER));
  it('preserves old outcomes, values, evidence and catalogue receipts byte-for-byte', () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    dropWorkerDatabase(WORKER);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveWorkerTestDbName(WORKER)],
      { stdio: 'pipe' },
    );
    const root = path.resolve('prisma');
    const migration = '20260907160030_activity_os_r3_c2_outcome_command_receipt';
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(migration)).toBe(113);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c2-pre114-'));
    const deploy = (schema: string) => {
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = '/' + deriveWorkerTestDbName(WORKER);
      try {
        execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: 'pipe',
        });
      } catch {
        throw new Error('C2 receipt upgrade failed; connection details suppressed');
      }
    };
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, 113))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '113',
      );
      seedDefinitionFixture();
      sql(`INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId") VALUES ('legacy-outcome','outcome-activity',1,'outcome-set','${hash}','draft','outcome-actor');
        INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES ('legacy-value','legacy-outcome','outcome-activity','outcome-set','outcome-definition','true','${hash}','manual');
        INSERT INTO attachments (id,"updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES ('legacy-attachment',CURRENT_TIMESTAMP,'receipt-upgrade-test','test','text/plain',1,'outcome-actor','activity','outcome-activity',ARRAY[]::text[]);
        INSERT INTO "ActivityMetricValueEvidence" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","attachmentId","sortOrder") VALUES ('legacy-evidence','legacy-value','legacy-outcome','outcome-activity','outcome-set','legacy-attachment',0);
        INSERT INTO "ActivityMetricCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","definitionId","resultJson") VALUES ('legacy-receipt','outcome-actor','create_definition','legacy-command','${hash}','outcome-definition','{"id":"outcome-definition","code":"receipt_metric","version":1,"schemaVersion":1,"statusCode":"draft","definitionHash":"${hash}"}');`);
      const tables = [
        'ActivityOutcomeRevision',
        'ActivityMetricValueRevision',
        'ActivityMetricValueEvidence',
        'ActivityMetricCommandReceipt',
      ];
      const snapshots = tables.map((table) =>
        sql(`SELECT row_to_json(t)::text FROM "${table}" t ORDER BY id`),
      );
      for (const snapshot of snapshots) expect(snapshot.length).toBeGreaterThan(0);
      deploy(path.join(root, 'schema.prisma'));
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '114',
      );
      tables.forEach((table, index) =>
        expect(sql(`SELECT row_to_json(t)::text FROM "${table}" t ORDER BY id`)).toBe(
          snapshots[index],
        ),
      );
      expect(sql('SELECT count(*) FROM "ActivityOutcomeCommandReceipt"')).toBe('0');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);
});

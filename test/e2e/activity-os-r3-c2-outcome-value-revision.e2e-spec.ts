import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  assertTestDatabaseUrl,
  assertDroppableTestDbName,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const WORKER = 98;
const database = () => deriveWorkerTestDbName(WORKER);
const hash = 'a'.repeat(64);
const MIGRATION = '20260907103134_activity_os_r3_c2_outcome_value_revision';
function url() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  assertDroppableTestDbName(database());
  const value = new URL(process.env.DATABASE_URL!);
  value.pathname = '/' + database();
  return value.toString();
}
function sql(input: string) {
  url();
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
      database(),
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
    ],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
function rejected(statement: string, state: string) {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain(state);
}
function outcome(
  id: string,
  activity = 'activity',
  revision = 1,
  prior = 'NULL',
  status = 'draft',
  setHash = hash,
) {
  return `INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","priorRevisionId","createdByUserId") VALUES ('${id}','${activity}',${revision},'set','${setHash}','${status}',${prior},'actor')`;
}
function value(id = 'value', activity = 'activity', set = 'set', definition = 'definition') {
  return `INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES ('${id}','outcome','${activity}','${set}','${definition}','true','${hash}','manual')`;
}
function evidence(attachment = 'attachment', activity = 'activity') {
  return `INSERT INTO "ActivityMetricValueEvidence" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","attachmentId","sortOrder") VALUES ('evidence','value','outcome','${activity}','set','${attachment}',0)`;
}

describe('C2 D1 nonempty 112 to 113 upgrade', () => {
  afterAll(() => dropWorkerDatabase(WORKER));
  it('preserves an existing activity byte-for-byte and creates empty outcome tables', () => {
    url();
    dropWorkerDatabase(WORKER);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database()],
      { stdio: 'pipe' },
    );
    const root = path.resolve('prisma');
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(112);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c2-pre113-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, 112))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      const deploy = (schema: string) => {
        try {
          execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
            env: { ...process.env, DATABASE_URL: url() },
            stdio: 'pipe',
          });
        } catch {
          throw new Error('C2 upgrade deployment failed; connection details suppressed');
        }
      };
      deploy(path.join(temporary, 'schema.prisma'));
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '112',
      );
      sql(`INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('legacy-org',CURRENT_TIMESTAMP,'legacy','team');
        INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('legacy',CURRENT_TIMESTAMP,'legacy','test','legacy-org','2099-10-01','2099-10-02','legacy','draft');`);
      const before = sql(`SELECT row_to_json(a)::text FROM "Activity" a WHERE id='legacy'`);
      // Historical D1 upgrade ends at 113 even after later migrations are added.
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(sql(`SELECT row_to_json(a)::text FROM "Activity" a WHERE id='legacy'`)).toBe(before);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '113',
      );
      for (const table of [
        'ActivityOutcomeRevision',
        'ActivityMetricValueRevision',
        'ActivityMetricValueEvidence',
      ])
        expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);
});

describe('C2 D1 outcome revision database constraints', () => {
  beforeAll(() => {
    url();
    dropWorkerDatabase(WORKER);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database()],
      { stdio: 'pipe' },
    );
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url() },
        stdio: 'pipe',
      });
    } catch {
      throw new Error('C2 isolated migration replay failed; connection details suppressed');
    }
    sql(`INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('actor','c2-actor','test-only',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('org',CURRENT_TIMESTAMP,'test','team');
      INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES
      ('activity',CURRENT_TIMESTAMP,'test','test','org','2099-10-01','2099-10-02','test','draft'),
      ('other',CURRENT_TIMESTAMP,'test','test','org','2099-10-01','2099-10-02','test','draft');
      INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES
      ('definition','metric',1,'test','boolean',NULL,'{"kindCode":"boolean","unit":null}',1,'${hash}','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES
      ('set','set',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP),('other-set','other_set',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('item','set','definition','result',0,true);
      INSERT INTO attachments (id,"updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES ('attachment',CURRENT_TIMESTAMP,'c2-test','test','text/plain',1,'actor','activity','activity',ARRAY[]::text[]);`);
  }, 180000);
  afterAll(() => dropWorkerDatabase(WORKER));
  beforeEach(() => {
    sql(
      'TRUNCATE "ActivityOutcomeCommandReceipt", "ActivityMetricValueEvidence", "ActivityMetricValueRevision", "ActivityOutcomeRevision"',
    );
    sql(outcome('outcome'));
  });
  it('replays 116 migrations and targets only the derived isolated database', () => {
    expect(sql('SELECT current_database()')).toBe(database());
    expect(
      sql(
        'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
    ).toBe('116');
  });
  it('accepts same-chain values and evidence, preserving the predecessor', () => {
    sql(value());
    sql(evidence());
    sql(outcome('next', 'activity', 2, "'outcome'"));
    expect(sql('SELECT count(*) FROM "ActivityOutcomeRevision"')).toBe('2');
    expect(sql('SELECT count(*) FROM "ActivityMetricValueEvidence"')).toBe('1');
  });
  it('rejects duplicate revisions, invalid status, hash and cross-activity prior', () => {
    rejected(outcome('duplicate'), '23505');
    rejected(outcome('bad-status', 'activity', 2, 'NULL', 'revised'), '23514');
    rejected(outcome('bad-hash', 'activity', 2, 'NULL', 'draft', 'b'.repeat(64)), '23503');
    rejected(outcome('cross', 'other', 2, "'outcome'"), '23503');
    rejected(outcome('backward', 'activity', 1, "'outcome'"), '23514');
  });
  it('rejects cross-chain values, missing set items and duplicate metrics', () => {
    rejected(value('cross', 'other'), '23503');
    rejected(value('wrong-set', 'activity', 'other-set'), '23503');
    rejected(value('missing', 'activity', 'set', 'missing'), '23503');
    sql(value());
    rejected(value('duplicate'), '23505');
  });
  it('rejects missing attachments and cross-chain evidence; restricts attachment deletion', () => {
    sql(value());
    rejected(evidence('missing'), '23503');
    rejected(evidence('attachment', 'other'), '23503');
    sql(evidence());
    rejected("DELETE FROM attachments WHERE id='attachment'", '23503');
  });
  it('rejects in-place content updates and deletion', () => {
    sql(value());
    sql(evidence());
    rejected(`UPDATE "ActivityOutcomeRevision" SET revision=2 WHERE id='outcome'`, '55000');
    rejected(
      `UPDATE "ActivityMetricValueRevision" SET "valueJson"='false' WHERE id='value'`,
      '55000',
    );
    rejected(`UPDATE "ActivityMetricValueEvidence" SET "sortOrder"=1 WHERE id='evidence'`, '55000');
    for (const table of [
      'ActivityMetricValueEvidence',
      'ActivityMetricValueRevision',
      'ActivityOutcomeRevision',
    ])
      rejected(`DELETE FROM "${table}"`, '55000');
  });
  it('rejects confirmation without value metadata on either insertion or status change', () => {
    sql(value());
    rejected(
      `UPDATE "ActivityOutcomeRevision" SET "statusCode"='confirmed' WHERE id='outcome'`,
      '23514',
    );
    sql(
      'TRUNCATE "ActivityOutcomeCommandReceipt", "ActivityMetricValueEvidence", "ActivityMetricValueRevision", "ActivityOutcomeRevision"',
    );
    sql(outcome('outcome', 'activity', 1, 'NULL', 'confirmed'));
    rejected(value(), '23514');
  });
});

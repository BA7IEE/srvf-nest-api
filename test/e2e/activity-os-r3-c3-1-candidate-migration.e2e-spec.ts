import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const hash = 'a'.repeat(64);
const migration = '20260908054308_activity_os_r3_c3_metric_candidates';
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
      deriveTestDbName(),
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
function deploy(schema: string) {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/' + deriveTestDbName();
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
    });
  } catch {
    throw new Error('C3-1 isolated migration deploy failed; connection details suppressed');
  }
}
function seedLegacy() {
  sql(`INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('c3-actor','c3-actor','test-only',CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('c3-org',CURRENT_TIMESTAMP,'test','team');
    INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('c3-activity',CURRENT_TIMESTAMP,'test','test','c3-org','2025-01-01','2025-01-02','test','draft');
    INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c3-definition','c3_people',1,'test','non_negative_integer','人','{"kindCode":"non_negative_integer","unit":"人","minimum":0,"maximum":2000}',1,'${hash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c3-set','c3_set',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('c3-item','c3-set','c3-definition','people',0,true);
    INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId") VALUES ('c3-old-outcome','c3-activity',1,'c3-set','${hash}','draft','c3-actor');
    INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES ('c3-old-value','c3-old-outcome','c3-activity','c3-set','c3-definition','3','${hash}','manual');
    INSERT INTO "ActivityMetricCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","definitionId","resultJson") VALUES ('c3-old-receipt','c3-actor','create_definition','old-command','${hash}','c3-definition','{"id":"c3-definition","code":"c3_people","version":1,"schemaVersion":1,"statusCode":"draft","definitionHash":"${hash}"}');`);
}
const tables = [
  'User',
  'Organization',
  'Activity',
  'ActivityMetricDefinition',
  'ActivityMetricSetVersion',
  'ActivityMetricSetItem',
  'ActivityOutcomeRevision',
  'ActivityMetricValueRevision',
  'ActivityMetricCommandReceipt',
];
function legacySnapshot() {
  return tables.map((table) => sql(`SELECT row_to_json(t)::text FROM "${table}" t ORDER BY id`));
}
function candidate(valueCount = 1, sourceCount = 0) {
  return `INSERT INTO "ActivityMetricCandidate" (id,"schemaVersion","activityId","candidateRevision","metricSetVersionId","metricSetDefinitionHash","expectedOutcomeRevision","sourceMode","providerVersion","sourceDigest","bindingsDigest","valueCount","sourceCount","createdAt","createdByUserId") VALUES ('c3-candidate',1,'c3-activity',1,'c3-set','${hash}',1,'participation_segments',1,'${hash}','${hash}',${valueCount},${sourceCount},'2025-01-03T00:00:00.000Z','c3-actor');`;
}
function value(binding = 'c3-binding', json = '0') {
  return `INSERT INTO "ActivityMetricCandidateValue" (id,"candidateId","activityId","setVersionId","definitionId","definitionHash","bindingId","valueJson","valueHash") VALUES ('c3-value','c3-candidate','c3-activity','c3-set','c3-definition','${hash}','${binding}','${json}','${hash}');`;
}
function receipt(change: Record<string, unknown> = {}) {
  const result = JSON.stringify({
    schemaVersion: 1,
    candidateId: 'c3-candidate',
    activityId: 'c3-activity',
    revision: 1,
    metricSetVersionId: 'c3-set',
    metricSetDefinitionHash: hash,
    createdStatusCode: 'candidate',
    sourceCode: 'system',
    valueCount: 1,
    sourceCount: 0,
    createdAt: '2025-01-03T00:00:00.000Z',
    ...change,
  }).replaceAll("'", "''");
  return `INSERT INTO "ActivityMetricCandidateCommandReceipt" (id,"actorId",operation,"operationKey","requestHash","candidateId","activityId","resultJson") VALUES ('c3-receipt','c3-actor','calculate_metric_candidate','candidate-key','${hash}','c3-candidate','c3-activity','${result}');`;
}

describe('C3-1 nonempty 115 to 116 upgrade and physical constraints', () => {
  beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    // This test owns its Jest worker clone; the shared template is never modified.
    const worker = process.env.JEST_WORKER_ID;
    if (!worker) throw new Error('C3-1 migration replay requires a Jest worker database');
    dropWorkerDatabase(worker);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    const root = path.resolve('prisma');
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(migration)).toBe(115);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c3-pre116-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, 115))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '115',
      );
      seedLegacy();
      const before = legacySnapshot();
      cpSync(
        path.join(root, 'migrations', migration),
        path.join(temporary, 'migrations', migration),
        { recursive: true, force: false, errorOnExist: true },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '116',
      );
      expect(legacySnapshot()).toEqual(before);
      deploy(path.join(temporary, 'schema.prisma'));
      expect(legacySnapshot()).toEqual(before);
      sql(
        `INSERT INTO "ActivityMetricRuleBinding" (id,"schemaVersion","metricDefinitionId","definitionHash","ruleCode","evaluatorVersion","ruleDigest","unitCode",scale,"bindingHash","createdByUserId") VALUES ('c3-binding',1,'c3-definition','${hash}','actual_participant_count_v1',1,'${hash}','count',0,'${hash}','c3-actor');`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
  // Leave this worker clone at the verified latest migration for the next local suite.
  beforeEach(() => {
    sql(
      'TRUNCATE "ActivityMetricCandidateCommandReceipt", "ActivityMetricCandidateSource", "ActivityMetricCandidateValue", "ActivityMetricCandidate"',
    );
  });
  it('accepts a complete aggregate on the upgraded database', () => {
    expect(sql('SELECT current_database()')).toBe(deriveTestDbName());
    sql('BEGIN;' + candidate() + value() + receipt() + 'COMMIT;');
    expect(sql('SELECT count(*) FROM "ActivityMetricCandidate"')).toBe('1');
  });
  it.each(['value', 'receipt', 'sources'])(
    'rejects an incomplete aggregate missing %s at commit',
    (missing) => {
      rejected(
        'BEGIN;' +
          candidate(1, missing === 'sources' ? 1 : 0) +
          (missing === 'value' ? '' : value()) +
          (missing === 'receipt' ? '' : receipt(missing === 'sources' ? { sourceCount: 1 } : {})) +
          'COMMIT;',
        '23514',
      );
      expect(sql('SELECT count(*) FROM "ActivityMetricCandidate"')).toBe('0');
    },
  );
  it.each([
    { revision: 2 },
    { sourceCode: 'manual' },
    { valueCount: 2 },
    { sourceCount: 1 },
    { createdAt: '2025-01-03T00:00:00.001Z' },
    { operationKey: 'forbidden' },
    { schemaVersion: null },
  ])('rejects forged or expanded receipt %#', (change) => {
    rejected('BEGIN;' + candidate() + value() + receipt(change) + 'COMMIT;', '23514');
    expect(sql('SELECT count(*) FROM "ActivityMetricCandidate"')).toBe('0');
  });
  it('rejects a missing binding reference', () => {
    rejected('BEGIN;' + candidate() + value('missing-binding') + receipt() + 'COMMIT;', '23503');
    expect(sql('SELECT count(*) FROM "ActivityMetricCandidate"')).toBe('0');
  });
  it.each(['true', 'null', '{}', '[]', '-1', '0.5', '"01"', '"0.10"'])(
    'rejects a noncanonical calculated value %s',
    (json) => {
      rejected('BEGIN;' + candidate() + value('c3-binding', json) + receipt() + 'COMMIT;', '23514');
      expect(sql('SELECT count(*) FROM "ActivityMetricCandidate"')).toBe('0');
    },
  );
});

import { execFileSync } from 'node:child_process';
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

/** Each probe rolls back its own fixture. Never touches the shared template. */
function rawSql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('C3-2 SQL tests require an isolated worker');
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
function sql(statement: string): string {
  return rawSql(`BEGIN;\n${statement};\nROLLBACK;`);
}

const migration = '20260909092502_activity_os_r3_c3_outcome_finalization';
const legacyHash = 'a'.repeat(64);
function legacyFormal(includeEvidence = true, valueJson = '3') {
  return `
    INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('c32-old-actor','c32-old-actor','test-only',CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('c32-old-org',CURRENT_TIMESTAMP,'test','team');
    INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('c32-old-activity',CURRENT_TIMESTAMP,'test','test','c32-old-org','2025-01-01','2025-01-02','test','completed');
    INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c32-old-definition','c32_people',1,'test','non_negative_integer','人','{"kindCode":"non_negative_integer","unit":"人","minimum":0,"maximum":2000}',1,'${legacyHash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c32-old-set','c32_set',1,'test',1,'${legacyHash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('c32-old-item','c32-old-set','c32-old-definition','people',0,true);
    INSERT INTO "attachments" (id,"updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES ('c32-old-attachment',CURRENT_TIMESTAMP,'attachments/c32-old/test.txt','test.txt','text/plain',1,'c32-old-actor','activity','c32-old-activity',ARRAY[]::text[]);
    INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId","createdAt") VALUES ('c32-old-formal','c32-old-activity',1,'c32-old-set','${legacyHash}','confirmed','c32-old-actor','2025-01-03T00:00:00.000Z');
    INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode","sourceReference","calculatedByRuleVersion","confirmedByUserId","confirmedAt") VALUES ('c32-old-formal-value','c32-old-formal','c32-old-activity','c32-old-set','c32-old-definition','${valueJson}','${legacyHash}','manual','human_manual','manual-outcome-v1','c32-old-actor','2025-01-03T00:00:00.000Z');
    ${includeEvidence ? `INSERT INTO "ActivityMetricValueEvidence" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","attachmentId","sortOrder") VALUES ('c32-old-evidence','c32-old-formal-value','c32-old-formal','c32-old-activity','c32-old-set','c32-old-attachment',0);` : ''}
  `;
}
function legacyDraftAndCandidate() {
  const draftReceipt = JSON.stringify({
    schemaVersion: 1,
    activityId: 'c32-draft-activity',
    outcomeRevisionId: 'c32-old-draft',
    revision: 1,
    metricSetVersionId: 'c32-old-set',
    metricSetDefinitionHash: legacyHash,
    createdStatusCode: 'draft',
    sourceCode: 'manual',
    valueCount: 1,
    evidenceCount: 0,
    createdAt: '2025-01-03T00:00:00.000Z',
  });
  const candidateReceipt = JSON.stringify({
    schemaVersion: 1,
    candidateId: 'c32-old-candidate',
    activityId: 'c32-draft-activity',
    revision: 1,
    metricSetVersionId: 'c32-old-set',
    metricSetDefinitionHash: legacyHash,
    createdStatusCode: 'candidate',
    sourceCode: 'system',
    valueCount: 1,
    sourceCount: 0,
    createdAt: '2025-01-03T00:00:00.000Z',
  });
  return `
    INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('c32-draft-activity',CURRENT_TIMESTAMP,'test','test','c32-old-org','2025-01-01','2025-01-02','test','draft');
    INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId","createdAt") VALUES ('c32-old-draft','c32-draft-activity',1,'c32-old-set','${legacyHash}','draft','c32-old-actor','2025-01-03T00:00:00.000Z');
    INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode") VALUES ('c32-old-draft-value','c32-old-draft','c32-draft-activity','c32-old-set','c32-old-definition','3','${legacyHash}','manual');
    INSERT INTO "ActivityOutcomeCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","activityId","outcomeRevisionId","resultJson") VALUES ('c32-old-draft-receipt','c32-old-actor','record_manual_outcome','legacy-draft','${legacyHash}','c32-draft-activity','c32-old-draft','${draftReceipt}');
    INSERT INTO "ActivityMetricRuleBinding" (id,"schemaVersion","metricDefinitionId","definitionHash","ruleCode","evaluatorVersion","ruleDigest","unitCode",scale,"bindingHash","createdByUserId") VALUES ('c32-old-binding',1,'c32-old-definition','${legacyHash}','actual_participant_count_v1',1,'${legacyHash}','count',0,'${legacyHash}','c32-old-actor');
    INSERT INTO "ActivityMetricCandidate" (id,"schemaVersion","activityId","candidateRevision","metricSetVersionId","metricSetDefinitionHash","expectedOutcomeRevision","sourceMode","providerVersion","sourceDigest","bindingsDigest","valueCount","sourceCount","createdAt","createdByUserId") VALUES ('c32-old-candidate',1,'c32-draft-activity',1,'c32-old-set','${legacyHash}',1,'participation_segments',1,'${legacyHash}','${legacyHash}',1,0,'2025-01-03T00:00:00.000Z','c32-old-actor');
    INSERT INTO "ActivityMetricCandidateValue" (id,"candidateId","activityId","setVersionId","definitionId","definitionHash","bindingId","valueJson","valueHash") VALUES ('c32-old-candidate-value','c32-old-candidate','c32-draft-activity','c32-old-set','c32-old-definition','${legacyHash}','c32-old-binding','0','${legacyHash}');
    INSERT INTO "ActivityMetricCandidateCommandReceipt" (id,"actorId",operation,"operationKey","requestHash","candidateId","activityId","resultJson") VALUES ('c32-old-candidate-receipt','c32-old-actor','calculate_metric_candidate','legacy-candidate','${legacyHash}','c32-old-candidate','c32-draft-activity','${candidateReceipt}');
  `;
}
function retainedSnapshot() {
  return [
    'User',
    'Organization',
    'Activity',
    'attachments',
    'ActivityMetricDefinition',
    'ActivityMetricSetVersion',
    'ActivityMetricSetItem',
    'ActivityOutcomeRevision',
    'ActivityMetricValueRevision',
    'ActivityMetricValueEvidence',
    'ActivityOutcomeCommandReceipt',
    'ActivityMetricRuleBinding',
    'ActivityMetricCandidate',
    'ActivityMetricCandidateValue',
    'ActivityMetricCandidateSource',
    'ActivityMetricCandidateCommandReceipt',
  ].map((table) => rawSql(`SELECT row_to_json(t)::text FROM "${table}" t ORDER BY id`));
}
function deploy(schema: string) {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {
    throw new Error('C3-2 isolated migration deploy failed; connection details suppressed');
  }
}

beforeAll(() => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('C3-2 migration upgrade requires an isolated worker');
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
  expect(names.indexOf(migration)).toBe(116);
  const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c32-pre117-'));
  try {
    mkdirSync(path.join(temporary, 'migrations'));
    copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
    copyFileSync(
      path.join(root, 'migrations/migration_lock.toml'),
      path.join(temporary, 'migrations/migration_lock.toml'),
    );
    for (const name of names.slice(0, 116))
      cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    const schema = path.join(temporary, 'schema.prisma');
    deploy(schema);
    expect(rawSql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
      '116',
    );
    const migrationSql = readFileSync(
      path.join(root, 'migrations', migration, 'migration.sql'),
      'utf8',
    );
    expect(migrationSql.endsWith('COMMIT;\n')).toBe(true);
    // Keep even an unexpectedly accepted probe rollback-only; no data repair.
    const body = migrationSql.replace(/^BEGIN;$/m, '').slice(0, -8);
    rejected(legacyFormal(false) + body, '23514', 'retained formal outcome is incomplete');
    rejected(
      legacyFormal(true, '2001') + body,
      '23514',
      'retained formal value violates its definition',
    );
    expect(rawSql('SELECT count(*) FROM "ActivityOutcomeRevision"')).toBe('0');
    expect(rawSql(`SELECT to_regclass('"ActivityOutcomeFinalizationReceipt"') IS NULL`)).toBe('t');
    rawSql('BEGIN;' + legacyFormal() + legacyDraftAndCandidate() + 'COMMIT;');
    expect(rawSql('SELECT count(*) FROM "ActivityOutcomeCommandReceipt"')).toBe('1');
    expect(rawSql('SELECT count(*) FROM "ActivityMetricCandidateCommandReceipt"')).toBe('1');
    expect(rawSql('SELECT count(*) FROM "ActivityMetricCandidateValue"')).toBe('1');
    const before = retainedSnapshot();
    cpSync(
      path.join(root, 'migrations', migration),
      path.join(temporary, 'migrations', migration),
      { recursive: true, force: false, errorOnExist: true },
    );
    deploy(schema);
    expect(rawSql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
      '117',
    );
    expect(retainedSnapshot()).toEqual(before);
    expect(rawSql('SELECT count(*) FROM "ActivityOutcomeValueSource"')).toBe('0');
    expect(rawSql('SELECT count(*) FROM "ActivityOutcomeFinalizationReceipt"')).toBe('0');
    deploy(schema);
    expect(retainedSnapshot()).toEqual(before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 120000);

// This replay deliberately leaves its worker on migration 117. Restore the
// shared Jest worker clone so every following E2E suite sees the current
// Prisma surface, including migrations introduced after C3-2.
afterAll(() => {
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('C3-2 migration upgrade requires an isolated worker');
  dropWorkerDatabase(worker);
  execFileSync(
    'docker',
    ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
    { stdio: 'pipe' },
  );
  deploy(path.resolve('prisma/schema.prisma'));
}, 120000);

function rejected(statement: string, state: string, message: string): void {
  let stderr = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    stderr = String(error.stderr);
  }
  expect(stderr).toContain(state);
  expect(stderr).toContain(message);
}

function formalAssembly(
  options: { evidence?: boolean; source?: boolean; wrongSourceActivity?: boolean } = {},
) {
  const timestamp = '2025-01-04T00:00:00.000Z';
  const result = JSON.stringify({
    schemaVersion: 1,
    activityId: 'c32-draft-activity',
    outcomeRevisionId: 'c32-new-formal',
    revision: 2,
    createdStatusCode: 'confirmed',
    valueCount: 1,
    evidenceCount: options.evidence === false ? 0 : 1,
    createdAt: timestamp,
    operationCode: 'confirm_outcome',
  });
  return `
    UPDATE "ActivityOutcomeRevision" SET "statusCode"='superseded' WHERE id='c32-old-draft';
    INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"priorRevisionId","metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId","createdAt") VALUES ('c32-new-formal','c32-draft-activity',2,'c32-old-draft','c32-old-set','${legacyHash}','confirmed','c32-old-actor','${timestamp}');
    INSERT INTO "ActivityMetricValueRevision" (id,"outcomeRevisionId","activityId","setVersionId","metricDefinitionId","valueJson","valueHash","sourceCode","sourceReference","calculatedByRuleVersion","confirmedByUserId","confirmedAt","createdAt") VALUES ('c32-new-value','c32-new-formal','c32-draft-activity','c32-old-set','c32-old-definition','3','${legacyHash}','manual','human_manual','manual-outcome-v1','c32-old-actor','${timestamp}','${timestamp}');
    ${
      options.evidence === false
        ? ''
        : `INSERT INTO "attachments" (id,"updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES ('c32-new-attachment',CURRENT_TIMESTAMP,'attachments/c32-new/test.txt','test.txt','text/plain',1,'c32-old-actor','activity','c32-draft-activity',ARRAY[]::text[]);
    INSERT INTO "ActivityMetricValueEvidence" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","attachmentId","sortOrder","createdAt") VALUES ('c32-new-evidence','c32-new-value','c32-new-formal','c32-draft-activity','c32-old-set','c32-new-attachment',0,'${timestamp}');`
    }
    ${options.source === false ? '' : `INSERT INTO "ActivityOutcomeValueSource" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","metricDefinitionId","sourceKind","manualValueRevisionId","createdAt") VALUES ('c32-new-source','c32-new-value','c32-new-formal','${options.wrongSourceActivity ? 'c32-old-activity' : 'c32-draft-activity'}','c32-old-set','c32-old-definition','manual','c32-old-draft-value','${timestamp}');`}
    INSERT INTO "ActivityOutcomeFinalizationReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","activityId","outcomeRevisionId","resultJson","createdAt") VALUES ('c32-new-receipt','c32-old-actor','confirm_outcome','sql-confirm','${legacyHash}','c32-draft-activity','c32-new-formal','${result}','${timestamp}');
    SET CONSTRAINTS ALL IMMEDIATE;
  `;
}

describe('C3-2 PostgreSQL value and finalization guards', () => {
  it('accepts a complete direct SQL assembly while leaving retained facts unchanged after rollback', () => {
    const before = retainedSnapshot();
    expect(
      sql(
        formalAssembly() +
          `SELECT count(*) FROM "ActivityOutcomeFinalizationReceipt" WHERE id='c32-new-receipt';`,
      ),
    ).toBe('1');
    expect(retainedSnapshot()).toEqual(before);
  });
  it.each([
    ['missing evidence', { evidence: false }, '23514', 'finalization values or sources incomplete'],
    ['missing source', { source: false }, '23514', 'finalization values or sources incomplete'],
    ['wrong source activity', { wrongSourceActivity: true }, '23503', 'foreign key constraint'],
  ] as const)(
    'rejects direct SQL %s in an otherwise valid assembly',
    (_name, options, code, message) => {
      const before = retainedSnapshot();
      rejected(formalAssembly(options), code, message);
      expect(retainedSnapshot()).toEqual(before);
    },
  );
  it('rejects a complete-looking confirmation that omits a required metric', () => {
    const required = `INSERT INTO "ActivityMetricDefinition" (id,code,version,name,"kindCode",unit,"configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c32-other-definition','c32_other',1,'test','boolean',NULL,'{"kindCode":"boolean","unit":null}',1,'${legacyHash}','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivityMetricSetItem" (id,"setVersionId","metricDefinitionId",key,"sortOrder",required) VALUES ('c32-other-item','c32-old-set','c32-other-definition','other',1,true);`;
    rejected(required + formalAssembly(), '23514', 'required formal metrics missing');
    expect(
      rawSql(
        `SELECT count(*) FROM "ActivityOutcomeFinalizationReceipt" WHERE id='c32-new-receipt'`,
      ),
    ).toBe('0');
  });

  it.each([
    [
      'formal-to-draft',
      `UPDATE "ActivityOutcomeRevision" SET "statusCode" = 'draft' WHERE id = 'c32-old-formal';`,
      '23514',
      'illegal outcome lifecycle transition',
    ],
    [
      'formal-without-successor',
      `UPDATE "ActivityOutcomeRevision" SET "statusCode" = 'superseded' WHERE id = 'c32-old-formal'; SET CONSTRAINTS ALL IMMEDIATE;`,
      '23514',
      'outcome transition lacks a new successor receipt',
    ],
    [
      'draft-with-only-old-receipt',
      `UPDATE "ActivityOutcomeRevision" SET "statusCode" = 'superseded' WHERE id = 'c32-old-draft'; SET CONSTRAINTS ALL IMMEDIATE;`,
      '23514',
      'outcome transition lacks a new successor receipt',
    ],
    [
      'second-formal',
      `INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","priorRevisionId","createdByUserId") VALUES ('c32-second-formal','c32-old-activity',2,'c32-old-set','${legacyHash}','confirmed','c32-old-formal','c32-old-actor');`,
      '23505',
      'outcome_one_confirmed_per_activity',
    ],
  ])(
    'rejects direct SQL %s without changing retained facts',
    (_name, statement, state, message) => {
      const before = retainedSnapshot();
      rejected(statement, state, message);
      expect(retainedSnapshot()).toEqual(before);
    },
  );
  it('seals historical formal evidence even when no C3 creation receipt was backfilled', () => {
    rejected(
      `INSERT INTO "attachments" (id,"updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES ('c32-late-attachment',CURRENT_TIMESTAMP,'attachments/c32-old/late.txt','late.txt','text/plain',1,'c32-old-actor','activity','c32-old-activity',ARRAY[]::text[]);
      INSERT INTO "ActivityMetricValueEvidence" (id,"valueRevisionId","outcomeRevisionId","activityId","setVersionId","attachmentId","sortOrder") VALUES ('c32-late-evidence','c32-old-formal-value','c32-old-formal','c32-old-activity','c32-old-set','c32-late-attachment',1); SET CONSTRAINTS ALL IMMEDIATE;`,
      '23514',
      'historical formal outcome facts are sealed',
    );
    expect(
      sql(`SELECT count(*) FROM "ActivityMetricValueEvidence" WHERE id = 'c32-late-evidence'`),
    ).toBe('0');
  });
  it.each([
    ['3', { kindCode: 'non_negative_integer', minimum: 0, maximum: 10 }, true],
    ['3.5', { kindCode: 'non_negative_integer', minimum: 0, maximum: 10 }, false],
    ['11', { kindCode: 'non_negative_integer', minimum: 0, maximum: 10 }, false],
    ['-1', { kindCode: 'non_negative_integer', minimum: 0, maximum: 10 }, false],
    ['"3"', { kindCode: 'non_negative_integer', minimum: 0, maximum: 10 }, false],
    ['"1.2"', { kindCode: 'non_negative_decimal', minimum: '0', maximum: '10', scale: 2 }, true],
    ['"1.20"', { kindCode: 'non_negative_decimal', minimum: '0', maximum: '10', scale: 2 }, false],
    ['"1.234"', { kindCode: 'non_negative_decimal', minimum: '0', maximum: '10', scale: 2 }, false],
    ['"01.2"', { kindCode: 'non_negative_decimal', minimum: '0', maximum: '10', scale: 2 }, false],
    ['1.2', { kindCode: 'non_negative_decimal', minimum: '0', maximum: '10', scale: 2 }, false],
    ['true', { kindCode: 'boolean', unit: null }, true],
    ['"true"', { kindCode: 'boolean', unit: null }, false],
    ['"yes"', { kindCode: 'single_choice', options: [{ code: 'yes', label: '是' }] }, true],
    ['"no"', { kindCode: 'single_choice', options: [{ code: 'yes', label: '是' }] }, false],
    ['"private text"', { kindCode: 'short_text', maxLength: 100 }, false],
  ] as const)('validates stored value %s against %j', (value, config, expected) => {
    expect(
      sql(
        `SELECT outcome_finalization_value_valid('${value}'::jsonb, '${JSON.stringify(config)}'::jsonb);`,
      ),
    ).toBe(expected ? 't' : 'f');
  });

  it('rejects committing a new confirmed head without values or receipt', () => {
    const hash = 'a'.repeat(64);
    rejected(
      `
      INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('c3-2-sql-actor','c3-2-sql-actor','test-only',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,"updatedAt",name,"nodeTypeCode") VALUES ('c3-2-sql-org',CURRENT_TIMESTAMP,'test','team');
      INSERT INTO "Activity" (id,"updatedAt",title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode") VALUES ('c3-2-sql-activity',CURRENT_TIMESTAMP,'test','test','c3-2-sql-org','2025-01-01','2025-01-02','test','completed');
      INSERT INTO "ActivityMetricSetVersion" (id,code,version,name,"schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('c3-2-sql-set','c3_2_sql',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivityOutcomeRevision" (id,"activityId",revision,"metricSetVersionId","metricSetDefinitionHash","statusCode","createdByUserId") VALUES ('c3-2-sql-empty','c3-2-sql-activity',1,'c3-2-sql-set','${hash}','confirmed','c3-2-sql-actor');
      SET CONSTRAINTS ALL IMMEDIATE;
    `,
      '23514',
      'new confirmed outcome requires finalization receipt',
    );
    expect(sql(`SELECT count(*) FROM "ActivityOutcomeRevision" WHERE id = 'c3-2-sql-empty';`)).toBe(
      '0',
    );
  });
});

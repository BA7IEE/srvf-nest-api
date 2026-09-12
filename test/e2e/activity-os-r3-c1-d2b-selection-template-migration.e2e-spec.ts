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
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const WORKER = 98;
const MIGRATION = '20260906114906_activity_os_r3_c1_metric_selection_template_v3';
const CURRENT_MIGRATION_COUNT = 121;
const database = () => deriveWorkerTestDbName(WORKER);
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function url() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.DATABASE_URL) throw new Error('missing test database');
  assertDroppableTestDbName(database());
  const value = new URL(process.env.DATABASE_URL);
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
function recreate() {
  url();
  dropWorkerDatabase(WORKER);
  execFileSync(
    'docker',
    ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database()],
    { stdio: 'pipe' },
  );
}
function deploy(schema?: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(schema ? ['--schema', schema] : [])],
    { env: { ...process.env, DATABASE_URL: url() }, stdio: 'pipe' },
  );
}

const hash = 'a'.repeat(64);
const pointer = {
  id: 'set',
  code: 'metric_set',
  version: 1,
  schemaVersion: 1,
  definitionHash: hash,
};
const selectionResult = {
  activityId: 'activity',
  metricRequirementCode: 'required',
  metricSetPointer: pointer,
  metricSelectionRevision: 1,
};
const templateResult = {
  id: 'template',
  code: 'global-template',
  version: 1,
  schemaVersion: 3,
  statusCode: 'draft',
  definitionHash: hash,
};
const oldOperations = [
  'create_definition',
  'update_definition',
  'activate_definition',
  'retire_definition',
  'create_set',
  'update_set',
  'activate_set',
  'retire_set',
];
const templateOperations = [
  'create_template_version',
  'update_template_version',
  'activate_template_version',
  'retire_template_version',
];
const fixtures = `INSERT INTO "User" ("id","username","passwordHash","updatedAt") VALUES ('actor','actor','test-only',CURRENT_TIMESTAMP);
INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode") VALUES ('org',CURRENT_TIMESTAMP,'test','team');
INSERT INTO "Activity" ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode")
VALUES ('activity',CURRENT_TIMESTAMP,'old activity','test','org','2099-10-01','2099-10-02','test','draft');
INSERT INTO "ActivityMetricDefinition" ("id","code","version","name","kindCode","unit","configurationJson","schemaVersion","definitionHash","statusCode","updatedAt")
VALUES ('definition','metric',1,'test','boolean',NULL,'{"kindCode":"boolean","unit":null}',1,'${hash}','draft',CURRENT_TIMESTAMP);
INSERT INTO "ActivityMetricSetVersion" ("id","code","version","name","schemaVersion","definitionHash","statusCode","updatedAt")
VALUES ('set','metric_set',1,'test',1,'${hash}','draft',CURRENT_TIMESTAMP);
INSERT INTO "ActivityTemplateFamily" ("id","updatedAt","code","name","categoryCode","scopeTypeCode","statusCode")
VALUES ('family',CURRENT_TIMESTAMP,'global-template','test','test','global','active');
INSERT INTO "ActivityTemplate" ("id","updatedAt","code","name","activityTypeCode","statusCode","version","familyId","schemaVersion","definitionJson","definitionHash")
VALUES ('template',CURRENT_TIMESTAMP,'global-template','test','test','draft',1,'family',3,'{}','${hash}');`;
function receipt(
  operation = 'select_metric_set',
  result: unknown = selectionResult,
  overrides: Record<string, unknown> = {},
) {
  const data: Record<string, unknown> = {
    id: 'receipt',
    actorUserId: 'actor',
    operationCode: operation,
    operationKey: operation,
    requestHash: hash,
    definitionId: null,
    setVersionId: null,
    templateVersionId: operation.endsWith('_template_version') ? 'template' : null,
    activityId: operation === 'select_metric_set' ? 'activity' : null,
    ...overrides,
  };
  return (
    'INSERT INTO "ActivityMetricCommandReceipt" (' +
    [...Object.keys(data), 'resultJson'].map((k) => '"' + k + '"').join(',') +
    ') VALUES (' +
    [
      ...Object.values(data).map((v) => {
        if (v === null) return 'NULL';
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
          throw new TypeError('receipt fixture accepts scalar SQL values only');
        return quote(String(v));
      }),
      quote(JSON.stringify(result)) + '::jsonb',
    ].join(',') +
    ')'
  );
}
function rejected(statement: string, constraint: string, state = '23514') {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain(state);
  expect(failure).toContain(constraint);
}
function selection(
  mode: string | null,
  id: string | null,
  definitionHash: string | null,
  revision: number,
) {
  const nullable = (v: string | null) => (v === null ? 'NULL' : quote(v));
  return (
    'UPDATE "Activity" SET "metricRequirementCode"=' +
    nullable(mode) +
    ',"selectedMetricSetVersionId"=' +
    nullable(id) +
    ',"selectedMetricSetDefinitionHash"=' +
    nullable(definitionHash) +
    ',"metricSelectionRevision"=' +
    revision +
    " WHERE id='activity'"
  );
}

describe('C1 D2b migration typed selection and receipts', () => {
  beforeAll(() => {
    recreate();
    deploy();
    sql(fixtures);
  }, 180000);
  afterAll(() => dropWorkerDatabase(WORKER));
  beforeEach(() =>
    sql('TRUNCATE "ActivityMetricCommandReceipt"; ' + selection(null, null, null, 0)),
  );
  it('cold replays all 121 current migrations', () => {
    expect(
      sql(
        'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
    ).toBe(String(CURRENT_MIGRATION_COUNT));
  });
  it('adds no Prisma schema drift beyond the checked-in nineteen-statement baseline', () => {
    expect(sql('SELECT current_database()')).toBe(database());
    const source = readFileSync(
      path.resolve('test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts'),
      'utf8',
    );
    const marker = 'const EXPECTED_PRISMA_CURRENT_DIFF = `';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const baseline = source
      .slice(start + marker.length)
      .split('`;')[0]
      .trim();
    expect(baseline.split(';').filter((s) => s.trim())).toHaveLength(19);
    let actual: string;
    try {
      // Read only. The approved w98 URL stays in env, not in command arguments/output.
      actual = execFileSync(
        'pnpm',
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-schema-datasource',
          'prisma/schema.prisma',
          '--to-schema-datamodel',
          'prisma/schema.prisma',
          '--script',
        ],
        {
          env: { ...process.env, DATABASE_URL: url() },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).trim();
    } catch {
      throw new Error('Prisma drift verification failed; connection details suppressed');
    }
    expect(actual).toBe(baseline);
  });
  it.each([
    [null, null, null, 0],
    ['not_required', null, null, 1],
    ['required', 'set', hash, 1],
  ] as const)('accepts selection %s', (mode, id, h, revision) => {
    sql(selection(mode, id, h, revision));
    expect(sql('SELECT "metricSelectionRevision" FROM "Activity" WHERE id=\'activity\'')).toBe(
      String(revision),
    );
  });
  it.each([
    [null, null, null, 1],
    ['unconfigured', null, null, 0],
    ['not_required', null, null, 0],
    ['not_required', 'set', null, 1],
    ['not_required', null, hash, 1],
    ['required', null, hash, 1],
    ['required', 'set', null, 1],
    ['required', 'set', hash, 0],
    ['required', 'set', 'A'.repeat(64), 1],
    [null, null, null, -1],
  ] as const)('rejects malformed selection %#', (mode, id, h, revision) =>
    rejected(selection(mode, id, h, revision), 'activity_metric_selection_shape_check'),
  );
  it('exact composite FK rejects existing id paired with a different valid hash', () => {
    rejected(
      selection('required', 'set', 'b'.repeat(64), 1),
      'activity_selected_metric_set_fk',
      '23503',
    );
  });
  it('NULL guards survive dropping revision NOT NULL in a rolled-back mutation', () => {
    rejected(
      'BEGIN; ALTER TABLE "Activity" ALTER COLUMN "metricSelectionRevision" DROP NOT NULL; UPDATE "Activity" SET "metricSelectionRevision"=NULL',
      'activity_metric_selection_shape_check',
    );
  });
  it.each(templateOperations)('accepts %s with exact six-key V3 receipt', (operation) => {
    sql(
      receipt(operation, {
        ...templateResult,
        statusCode: operation.startsWith('activate')
          ? 'active'
          : operation.startsWith('retire')
            ? 'retired'
            : 'draft',
      }),
    );
    expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('1');
  });
  it.each([
    selectionResult,
    { ...selectionResult, metricRequirementCode: 'not_required', metricSetPointer: null },
  ])('accepts selection receipt %#', (result) => {
    sql(receipt('select_metric_set', result));
    expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('1');
  });
  it.each([
    { templateVersionId: 'template' },
    { definitionId: 'definition' },
    { setVersionId: 'set' },
    { activityId: null },
    { operationCode: 'unknown' },
    { operationCode: 'create_definition' },
  ])('rejects cross-family or missing targets independently %#', (change) => {
    rejected(
      'BEGIN; ALTER TABLE "ActivityMetricCommandReceipt" DROP CONSTRAINT activity_metric_receipt_result_check; ' +
        receipt('select_metric_set', selectionResult, change),
      'activity_metric_receipt_target_check',
    );
  });
  it.each([
    null,
    [],
    {},
    { ...selectionResult, activityId: 'other' },
    { ...selectionResult, extra: true },
    { ...selectionResult, metricRequirementCode: null },
    { ...selectionResult, metricRequirementCode: 'not_required' },
    { ...selectionResult, metricSetPointer: null },
    ...[null, 0, -1, 1.1, '1', 2147483648].map((metricSelectionRevision) => ({
      ...selectionResult,
      metricSelectionRevision,
    })),
    ...[
      {},
      { ...pointer, id: null },
      { ...pointer, id: '' },
      { ...pointer, definitionHash: null },
      { ...pointer, schemaVersion: 3 },
      { ...pointer, version: 0 },
      { ...pointer, code: 'BAD' },
      { ...pointer, operationKey: 'extra' },
    ].map((metricSetPointer) => ({ ...selectionResult, metricSetPointer })),
  ])('rejects bad selection result independently %#', (result) =>
    rejected(receipt('select_metric_set', result), 'activity_metric_receipt_result_check'),
  );
  it.each([
    { ...templateResult, schemaVersion: 1 },
    { ...templateResult, id: 'other' },
    { ...templateResult, version: 2147483648 },
    { ...templateResult, statusCode: 'active' },
    { ...templateResult, definitionHash: null },
    { ...templateResult, definition: {} },
  ])('rejects bad V3 result %#', (result) =>
    rejected(receipt('create_template_version', result), 'activity_metric_receipt_result_check'),
  );
  it.each([
    'UPDATE "ActivityMetricCommandReceipt" SET "requestHash"=\'' + 'b'.repeat(64) + "'",
    'DELETE FROM "ActivityMetricCommandReceipt"',
  ])('append-only still rejects %s', (statement) => {
    sql(receipt());
    rejected(statement, 'activity_metric_receipt_append_only');
  });
  it.each([
    [
      'activity_metric_receipt_activity_fk',
      { activityId: 'missing' },
      { ...selectionResult, activityId: 'missing' },
      'select_metric_set',
    ],
    [
      'activity_metric_receipt_template_fk',
      { templateVersionId: 'missing' },
      { ...templateResult, id: 'missing' },
      'create_template_version',
    ],
  ] as const)('enforces new target FK %s', (constraint, change, result, operation) =>
    rejected(receipt(operation, result, change), constraint, '23503'),
  );
  it('keeps command key unique and allows mutation only when the trigger is explicitly disabled in test rollback', () => {
    sql(receipt());
    rejected(
      receipt('select_metric_set', selectionResult, { id: 'second' }),
      'activity_metric_receipt_command_key',
      '23505',
    );
    expect(
      sql(
        'BEGIN; ALTER TABLE "ActivityMetricCommandReceipt" DISABLE TRIGGER activity_metric_receipt_append_only; UPDATE "ActivityMetricCommandReceipt" SET "operationKey"=\'mutation-control\'; SELECT "operationKey" FROM "ActivityMetricCommandReceipt"; ROLLBACK',
      ),
    ).toBe('mutation-control');
    rejected('DELETE FROM "ActivityMetricCommandReceipt"', 'activity_metric_receipt_append_only');
  });
});

describe('C1 D2b nonempty 111 to 112 upgrade', () => {
  afterAll(() => dropWorkerDatabase(WORKER));
  it('keeps every old business field and all eight receipt results byte-identical; seed twice grants no roles', () => {
    recreate();
    const root = path.resolve('prisma');
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(111);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c1-d2b-pre112-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, 111))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      sql(fixtures);
      for (const operation of oldOperations) {
        const isSet = operation.endsWith('_set');
        const target = isSet ? 'set' : 'definition';
        const result = {
          id: target,
          code: isSet ? 'metric_set' : 'metric',
          version: 1,
          schemaVersion: 1,
          statusCode: operation.startsWith('activate')
            ? 'active'
            : operation.startsWith('retire')
              ? 'retired'
              : 'draft',
          definitionHash: hash,
        };
        // New target columns do not exist at the old baseline.
        sql(
          'INSERT INTO "ActivityMetricCommandReceipt" ("id","actorUserId","operationCode","operationKey","requestHash","definitionId","setVersionId","resultJson") VALUES (' +
            [
              quote(operation),
              quote('actor'),
              quote(operation),
              quote(operation),
              quote(hash),
              isSet ? 'NULL' : quote(target),
              isSet ? quote(target) : 'NULL',
              quote(JSON.stringify(result)) + '::jsonb',
            ].join(',') +
            ')',
        );
      }
      const before = sql('SELECT to_jsonb(a)::text FROM "Activity" a ORDER BY id');
      const oldReceipts = sql(
        'SELECT to_jsonb(r)::text FROM "ActivityMetricCommandReceipt" r ORDER BY id',
      );
      deploy();
      deploy();
      expect(
        sql(
          "SELECT (to_jsonb(a) - ARRAY['metricRequirementCode','selectedMetricSetVersionId','selectedMetricSetDefinitionHash','metricSelectionRevision','timePolicySelectionRevision','currentTimePolicySelectionRevisionId'])::text FROM \"Activity\" a ORDER BY id",
        ),
      ).toBe(before);
      expect(
        sql(
          'SELECT row_to_json(s)::text FROM (SELECT "timePolicySelectionRevision","currentTimePolicySelectionRevisionId" FROM "Activity" ORDER BY id) s',
        ),
      ).toBe('{"timePolicySelectionRevision":0,"currentTimePolicySelectionRevisionId":null}');
      expect(
        sql(
          "SELECT (to_jsonb(r) - ARRAY['templateVersionId','activityId'])::text FROM \"ActivityMetricCommandReceipt\" r ORDER BY id",
        ),
      ).toBe(oldReceipts);
      const snapshot = () =>
        sql(
          "SELECT (SELECT count(*) FROM permissions)::text || '/' || (SELECT count(*) FROM role_permissions)::text || '/' || (SELECT count(*) FROM roles)::text",
        );
      let seeded = '';
      for (let i = 0; i < 2; i++) {
        execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
          env: {
            ...process.env,
            DATABASE_URL: url(),
            APP_ENV: 'test',
            SUPER_ADMIN_USERNAME: 'metric-seed-root',
            SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
            SUPER_ADMIN_EMAIL: '',
            RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
          },
          stdio: 'pipe',
        });
        if (i === 0) seeded = snapshot();
        else expect(snapshot()).toBe(seeded);
      }
      expect(
        sql(
          'SELECT count(*) FROM permissions WHERE code LIKE \'activity-template.%\' AND NOT "servicePrincipalAllowed" AND NOT "delegatedAccessAllowed"',
        ),
      ).toBe('2');
      expect(
        sql(
          'SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp."permissionId" WHERE p.code LIKE \'activity-template.%\'',
        ),
      ).toBe('0');
      expect(sql('SELECT count(*) FROM permissions')).toBe('263');
      expect(
        sql(
          "SELECT (to_jsonb(r) - ARRAY['templateVersionId','activityId'])::text FROM \"ActivityMetricCommandReceipt\" r ORDER BY id",
        ),
      ).toBe(oldReceipts);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);
});

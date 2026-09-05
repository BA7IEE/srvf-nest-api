import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const WORKER = 98;
const MIGRATION = '20260905221158_activity_os_r3_c1_metric_command_receipts';
const CURRENT_MIGRATION_COUNT = 111;
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
const result = {
  id: 'metric_definition',
  code: 'metric',
  version: 1,
  schemaVersion: 1,
  statusCode: 'draft',
  definitionHash: 'a'.repeat(64),
};
function insert(
  overrides: {
    operation?: string;
    key?: string;
    hash?: string;
    actor?: string;
    definitionId?: string | null;
    setId?: string | null;
    result?: unknown;
  } = {},
) {
  const definitionId =
    overrides.definitionId === undefined ? 'metric_definition' : overrides.definitionId;
  return (
    'INSERT INTO "ActivityMetricCommandReceipt" ("id","actorUserId","operationCode","operationKey","requestHash","definitionId","setVersionId","resultJson") VALUES (' +
    [
      quote('receipt'),
      quote(overrides.actor ?? 'metric_actor'),
      quote(overrides.operation ?? 'create_definition'),
      quote(overrides.key ?? 'one'),
      quote(overrides.hash ?? 'a'.repeat(64)),
      definitionId === null ? 'NULL' : quote(definitionId),
      overrides.setId ? quote(overrides.setId) : 'NULL',
      quote(JSON.stringify(overrides.result === undefined ? result : overrides.result)) + '::jsonb',
    ].join(',') +
    ')'
  );
}
function rejected(statement: string, constraint: string, state = '23514') {
  let text = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    text = String(error.stderr);
  }
  expect(text).toContain(state);
  expect(text).toContain(constraint);
}
const fixtures = `INSERT INTO "User" ("id","username","passwordHash","updatedAt") VALUES ('metric_actor','metric_actor','test-only',CURRENT_TIMESTAMP);
INSERT INTO "ActivityMetricDefinition" ("id","code","version","name","kindCode","unit","configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('metric_definition','metric',1,'指标','boolean',NULL,'{"kindCode":"boolean","unit":null}',1,'${'a'.repeat(64)}','draft',CURRENT_TIMESTAMP);
INSERT INTO "ActivityMetricSetVersion" ("id","code","version","name","schemaVersion","definitionHash","statusCode","updatedAt") VALUES ('metric_set','metric_set',1,'集',1,'${'a'.repeat(64)}','draft',CURRENT_TIMESTAMP);`;

describe('C1 D2a receipt DB constraints', () => {
  beforeAll(() => {
    recreate();
    deploy();
    sql(fixtures);
  }, 180000);
  afterAll(() => {
    dropWorkerDatabase(WORKER);
  });
  beforeEach(() => {
    sql('TRUNCATE "ActivityMetricCommandReceipt"');
  });
  it('empty replay applies all current migrations', () => {
    expect(
      sql(
        'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
    ).toBe(String(CURRENT_MIGRATION_COUNT));
  });
  it.each([
    'create_definition',
    'update_definition',
    'activate_definition',
    'retire_definition',
    'create_set',
    'update_set',
    'activate_set',
    'retire_set',
  ])('accepts exact %s receipt', (operation) => {
    const set = operation.endsWith('_set');
    sql(
      insert({
        operation,
        definitionId: set ? null : 'metric_definition',
        setId: set ? 'metric_set' : null,
        result: {
          ...result,
          id: set ? 'metric_set' : result.id,
          statusCode: operation.startsWith('activate')
            ? 'active'
            : operation.startsWith('retire')
              ? 'retired'
              : 'draft',
        },
      }),
    );
    expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('1');
  });
  it.each([
    { operation: 'unknown' },
    { definitionId: null },
    { setId: 'metric_set' },
    { operation: 'create_set' },
  ])('rejects wrong target shape %#', (value) => {
    // Isolate the target CHECK from the independently tested result/target equality CHECK.
    // Failed psql transaction rolls back the temporary DDL; production migration is untouched.
    rejected(
      'BEGIN; ALTER TABLE "ActivityMetricCommandReceipt" DROP CONSTRAINT activity_metric_receipt_result_check; ' +
        insert(value),
      'activity_metric_receipt_target_check',
    );
  });
  it.each(['', ' leading', 'trailing ', 'x'.repeat(129)])('rejects bad key %#', (key) => {
    rejected(insert({ key }), 'activity_metric_receipt_key_check');
  });
  it('rejects bad request hash', () => {
    rejected(insert({ hash: 'A'.repeat(64) }), 'activity_metric_receipt_hash_check');
  });
  it.each([
    null,
    [],
    {},
    { ...result, operationKey: 'not_allowed' },
    { ...result, id: 'wrong_target' },
    { ...result, schemaVersion: 2 },
    { ...result, statusCode: null },
    { ...result, definitionHash: null },
    { ...result, version: 0 },
  ])('rejects non-whitelist or null result %#', (value) => {
    rejected(insert({ result: value }), 'activity_metric_receipt_result_check');
  });
  it('enforces actor FK', () => {
    rejected(insert({ actor: 'absent_actor' }), 'activity_metric_receipt_actor_fk', '23503');
  });
  it('enforces target FK', () => {
    rejected(
      insert({ definitionId: 'absent_definition', result: { ...result, id: 'absent_definition' } }),
      'activity_metric_receipt_definition_fk',
      '23503',
    );
  });
  it('prevents UPDATE', () => {
    sql(insert());
    rejected(
      'UPDATE "ActivityMetricCommandReceipt" SET "operationKey"=\'other\'',
      'activity_metric_receipt_append_only',
    );
  });
  it('prevents DELETE', () => {
    sql(insert());
    rejected('DELETE FROM "ActivityMetricCommandReceipt"', 'activity_metric_receipt_append_only');
  });
  it('unique command key remains enforced independently of primary key', () => {
    sql(insert());
    rejected(
      insert().replace("'receipt'", "'receipt_two'"),
      'activity_metric_receipt_command_key',
      '23505',
    );
  });
  it('positive control: disabling only append-only trigger permits mutation, then rollback restores guard', () => {
    sql(insert());
    expect(
      sql(
        'BEGIN; ALTER TABLE "ActivityMetricCommandReceipt" DISABLE TRIGGER activity_metric_receipt_append_only; UPDATE "ActivityMetricCommandReceipt" SET "operationKey"=\'mutated\'; SELECT "operationKey" FROM "ActivityMetricCommandReceipt"; ROLLBACK',
      ),
    ).toBe('mutated');
    rejected(
      'UPDATE "ActivityMetricCommandReceipt" SET "operationKey"=\'other\'',
      'activity_metric_receipt_append_only',
    );
  });
});

describe('C1 D2a nonempty upgrade and seed idempotency', () => {
  afterAll(() => {
    dropWorkerDatabase(WORKER);
  });
  it('110 → 111 preserves catalogue rows; seed twice creates only Human permissions without role grants', () => {
    recreate();
    const root = path.resolve('prisma');
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(110);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c1-d2a-pre111-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, 110))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      sql(fixtures);
      const before = sql('SELECT row_to_json(d)::text FROM "ActivityMetricDefinition" d');
      deploy();
      deploy();
      expect(sql('SELECT row_to_json(d)::text FROM "ActivityMetricDefinition" d')).toBe(before);
      expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('0');
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
          'SELECT count(*) FROM permissions WHERE code LIKE \'activity-metric.%\' AND NOT "servicePrincipalAllowed" AND NOT "delegatedAccessAllowed"',
        ),
      ).toBe('3');
      expect(
        sql(
          'SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp."permissionId" WHERE p.code LIKE \'activity-metric.%\'',
        ),
      ).toBe('0');
      expect(sql('SELECT row_to_json(d)::text FROM "ActivityMetricDefinition" d')).toBe(before);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);
});

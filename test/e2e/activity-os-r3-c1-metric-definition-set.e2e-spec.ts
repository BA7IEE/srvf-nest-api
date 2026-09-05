import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { fingerprintActivityMetricDefinition } from '../../src/modules/activities/activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from '../../src/modules/activities/activity-metric-set-definition';
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const SCRATCH_WORKER_ID = 97;
const CURRENT_MIGRATION_COUNT = 110;
const PREVIOUS_MIGRATION_COUNT = 109;
const MIGRATION_NAME = '20260905160133_activity_os_r3_c1_metric_definition_set';
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const databaseName = () => deriveWorkerTestDbName(SCRATCH_WORKER_ID);
const definition = {
  schemaVersion: 1,
  code: 'served',
  version: 1,
  name: '服务人数',
  configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 1000 },
};
const definitionHash = fingerprintActivityMetricDefinition(definition).definitionHash;
const setHash = fingerprintActivityMetricSetDefinition({
  schemaVersion: 1,
  code: 'support',
  version: 1,
  name: '保障成果',
  items: [
    {
      key: 'served',
      sortOrder: 0,
      required: true,
      metricDefinitionId: 'c1_definition_1',
      definitionHash,
    },
  ],
}).definitionHash;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function scratchUrl(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.DATABASE_URL) throw new Error('missing test database');
  const url = new URL(process.env.DATABASE_URL);
  assertDroppableTestDbName(databaseName());
  url.pathname = '/' + databaseName();
  return url.toString();
}

function sql(statement: string): string {
  scratchUrl();
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '--no-psqlrc',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
      '-U',
      'postgres',
      '-d',
      databaseName(),
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function rejected(statement: string, constraint: string, state = '23514'): void {
  let failure: unknown;
  try {
    sql(statement);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  // child_process errors can cross Jest's VM realm; instanceof Error is not a shape test.
  if (typeof failure !== 'object' || failure === null || !('stderr' in failure))
    throw new Error('expected psql stderr');
  const stderr: unknown = failure.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
  expect(text).toContain(state);
  expect(text).toContain(constraint);
}

function recreate(): void {
  scratchUrl();
  dropWorkerDatabase(SCRATCH_WORKER_ID);
  execFileSync(
    'docker',
    ['exec', POSTGRES_CONTAINER, 'createdb', '-U', 'postgres', databaseName()],
    { stdio: 'pipe' },
  );
}

function deploy(schemaPath?: string): void {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(schemaPath ? ['--schema', schemaPath] : [])],
    { env: { ...process.env, DATABASE_URL: scratchUrl() }, encoding: 'utf8', stdio: 'pipe' },
  );
}

function successfulMigrationCount(): number {
  return Number(
    sql(
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    ),
  );
}

function definitionSql(id: string, code: string): string {
  return (
    'INSERT INTO "ActivityMetricDefinition" ("id","code","version","name","kindCode","unit","configurationJson","schemaVersion","definitionHash","statusCode","updatedAt") VALUES (' +
    [
      quote(id),
      quote(code),
      '1',
      "'服务人数'",
      "'non_negative_integer'",
      "'人'",
      quote(JSON.stringify(definition.configuration)),
      '1',
      quote(definitionHash),
      "'draft'",
      'CURRENT_TIMESTAMP',
    ].join(',') +
    ')'
  );
}
function setSql(id: string, code: string): string {
  return (
    'INSERT INTO "ActivityMetricSetVersion" ("id","code","version","name","schemaVersion","definitionHash","statusCode","updatedAt") VALUES (' +
    [
      quote(id),
      quote(code),
      '1',
      "'保障成果'",
      '1',
      quote(setHash),
      "'draft'",
      'CURRENT_TIMESTAMP',
    ].join(',') +
    ')'
  );
}
function itemSql(
  id = 'c1_item_1',
  parent = 'c1_set_1',
  ref = 'c1_definition_1',
  key = 'served',
  order = 0,
): string {
  return (
    'INSERT INTO "ActivityMetricSetItem" ("id","setVersionId","metricDefinitionId","key","sortOrder","required") VALUES (' +
    [quote(id), quote(parent), quote(ref), quote(key), String(order), 'true'].join(',') +
    ')'
  );
}
const activateDefinition =
  'UPDATE "ActivityMetricDefinition" SET "statusCode"=\'active\',"activatedAt"=CURRENT_TIMESTAMP WHERE "id"=\'c1_definition_1\'';
const activateSet =
  'UPDATE "ActivityMetricSetVersion" SET "statusCode"=\'active\',"activatedAt"=CURRENT_TIMESTAMP WHERE "id"=\'c1_set_1\'';

describe('C1 D1 PostgreSQL catalogue invariants', () => {
  beforeAll(() => {
    recreate();
    deploy();
  }, 180_000);
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });
  beforeEach(() => {
    sql(
      'TRUNCATE "ActivityMetricSetItem","ActivityMetricSetVersion","ActivityMetricDefinition"; ' +
        definitionSql('c1_definition_1', 'served') +
        ';' +
        definitionSql('c1_definition_2', 'trained') +
        ';' +
        setSql('c1_set_1', 'support') +
        ';' +
        setSql('c1_set_2', 'training') +
        ';' +
        itemSql(),
    );
  });

  it('replays the entire current migration chain', () => {
    expect(successfulMigrationCount()).toBe(CURRENT_MIGRATION_COUNT);
  });
  it('keeps activated/retired history readable after a definition retires', () => {
    sql(
      activateDefinition +
        ';' +
        activateSet +
        '; UPDATE "ActivityMetricDefinition" SET "statusCode"=\'retired\',"retiredAt"=CURRENT_TIMESTAMP WHERE "id"=\'c1_definition_1\'',
    );
    expect(sql('SELECT "statusCode" FROM "ActivityMetricSetVersion" WHERE "id"=\'c1_set_1\'')).toBe(
      'active',
    );
    expect(
      sql('SELECT "definitionHash" FROM "ActivityMetricDefinition" WHERE "id"=\'c1_definition_1\''),
    ).toBe(definitionHash);
  });
  it.each([
    ['"version"=0', 'activity_metric_definition_shape_check'],
    ['"schemaVersion"=2', 'activity_metric_definition_shape_check'],
    ['"kindCode"=\'dynamic_script\'', 'activity_metric_definition_shape_check'],
    ['"unit"=NULL', 'activity_metric_definition_shape_check'],
    ['"configurationJson"=\'[]\'::jsonb', 'activity_metric_definition_shape_check'],
    ['"definitionHash"=\'bad\'', 'activity_metric_definition_shape_check'],
    ['"statusCode"=\'unknown\'', 'activity_metric_version_transition'],
    ['"statusCode"=\'active\'', 'activity_metric_definition_lifecycle_check'],
    [
      '"statusCode"=\'retired\',"activatedAt"=CURRENT_TIMESTAMP,"retiredAt"=CURRENT_TIMESTAMP',
      'activity_metric_version_transition',
    ],
  ])('rejects invalid definition %s', (assignment, constraint) => {
    // version is immutable even on drafts: identity guard rejects before column CHECK.
    rejected(
      'UPDATE "ActivityMetricDefinition" SET ' + assignment + ' WHERE "id"=\'c1_definition_1\'',
      assignment.startsWith('"version"') ? 'activity_metric_version_identity' : constraint,
    );
  });
  it.each(['ActivityMetricDefinition', 'ActivityMetricSetVersion'])(
    'preserves %s identity and rejects delete',
    (table) => {
      rejected(
        'UPDATE "' + table + '" SET "code"=\'replacement\'',
        'activity_metric_version_identity',
      );
      rejected('DELETE FROM "' + table + '"', 'activity_metric_version_frozen');
    },
  );
  it('requires nonempty active definition closure before set activation', () => {
    rejected(activateSet, 'activity_metric_set_activation');
  });
  it('rejects an empty set activation independently', () => {
    rejected(
      'UPDATE "ActivityMetricSetVersion" SET "statusCode"=\'active\',"activatedAt"=CURRENT_TIMESTAMP WHERE "id"=\'c1_set_2\'',
      'activity_metric_set_activation',
    );
  });
  it('rejects retired definitions for a new set activation', () => {
    sql(
      activateDefinition +
        '; UPDATE "ActivityMetricDefinition" SET "statusCode"=\'retired\',"retiredAt"=CURRENT_TIMESTAMP WHERE "id"=\'c1_definition_1\'',
    );
    rejected(activateSet, 'activity_metric_set_activation');
  });
  it.each([
    '"name"=\'changed\'',
    '"definitionHash"=repeat(\'a\',64)',
    '"configurationJson"=\'{}\'::jsonb',
    '"unit"=\'次\'',
  ])('freezes active definition %s', (assignment) => {
    sql(activateDefinition);
    rejected(
      'UPDATE "ActivityMetricDefinition" SET ' + assignment + ' WHERE "id"=\'c1_definition_1\'',
      'activity_metric_version_frozen',
    );
  });
  it('freezes active set metadata and disallows reverse transitions', () => {
    sql(activateDefinition + ';' + activateSet);
    rejected(
      'UPDATE "ActivityMetricSetVersion" SET "name"=\'changed\' WHERE "id"=\'c1_set_1\'',
      'activity_metric_version_frozen',
    );
    rejected(
      'UPDATE "ActivityMetricSetVersion" SET "statusCode"=\'draft\',"activatedAt"=NULL WHERE "id"=\'c1_set_1\'',
      'activity_metric_version_transition',
    );
  });
  it.each([
    'UPDATE "ActivityMetricSetItem" SET "required"=false',
    'DELETE FROM "ActivityMetricSetItem"',
    itemSql('c1_item_2', 'c1_set_1', 'c1_definition_2', 'trained', 1),
  ])('freezes active set child mutation %s', (statement) => {
    sql(activateDefinition + ';' + activateSet);
    rejected(statement, 'activity_metric_set_item_frozen');
  });
  it('permits draft item replacement/deletion but never moving its parent', () => {
    sql(
      'UPDATE "ActivityMetricSetItem" SET "required"=false,"metricDefinitionId"=\'c1_definition_2\'',
    );
    rejected(
      'UPDATE "ActivityMetricSetItem" SET "setVersionId"=\'c1_set_2\'',
      'activity_metric_set_item_identity',
    );
    sql('DELETE FROM "ActivityMetricSetItem"');
    expect(sql('SELECT count(*) FROM "ActivityMetricSetItem"')).toBe('0');
  });
  it.each([
    [
      itemSql('c1_item_2', 'missing_set', 'c1_definition_1'),
      'ActivityMetricSetItem_setVersionId_fkey',
      '23503',
    ],
    [
      itemSql('c1_item_2', 'c1_set_2', 'missing_definition'),
      'ActivityMetricSetItem_metricDefinitionId_fkey',
      '23503',
    ],
    [
      itemSql('c1_item_2', 'c1_set_1', 'c1_definition_2', 'served', 1),
      'ActivityMetricSetItem_setVersionId_key_key',
      '23505',
    ],
    [
      itemSql('c1_item_2', 'c1_set_1', 'c1_definition_1', 'other', 1),
      'ActivityMetricSetItem_setVersionId_metricDefinitionId_key',
      '23505',
    ],
    [
      itemSql('c1_item_2', 'c1_set_1', 'c1_definition_2', 'other', 0),
      'ActivityMetricSetItem_setVersionId_sortOrder_key',
      '23505',
    ],
  ])('rejects independent FK/unique violation %s', (statement, constraint, state) => {
    rejected(statement, constraint, state);
  });
  it('allows 100 items and rejects the 101st before admitting extra content', () => {
    sql('DELETE FROM "ActivityMetricSetItem"');
    for (let n = 0; n <= 100; n += 1) {
      sql(definitionSql('limit_definition_' + n, 'limit_' + n));
      if (n < 100)
        sql(itemSql('limit_item_' + n, 'c1_set_1', 'limit_definition_' + n, 'limit_' + n, n));
    }
    expect(sql('SELECT count(*) FROM "ActivityMetricSetItem"')).toBe('100');
    rejected(
      itemSql('limit_item_100', 'c1_set_1', 'limit_definition_100', 'limit_100', 100),
      'activity_metric_set_item_limit',
    );
  });

  it.each(['child-edit', 'definition-retirement'])(
    'serializes activation against concurrent %s',
    async (operation) => {
      sql(activateDefinition);
      const writer = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });
      const reader = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });
      let release: () => void = () => undefined;
      let ready: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let activation: Promise<unknown> | undefined;
      const editing = writer.$transaction(
        async (tx) => {
          if (operation === 'child-edit') {
            await tx.$executeRaw`UPDATE "ActivityMetricSetItem" SET "metricDefinitionId"='c1_definition_2' WHERE "id"='c1_item_1'`;
          } else {
            await tx.$executeRaw`UPDATE "ActivityMetricDefinition" SET "statusCode"='retired',"retiredAt"=CURRENT_TIMESTAMP WHERE "id"='c1_definition_1'`;
          }
          ready();
          await unblock;
        },
        { timeout: 15_000 },
      );
      try {
        await held;
        activation = reader.$executeRaw`UPDATE "ActivityMetricSetVersion" SET "statusCode"='active',"activatedAt"=CURRENT_TIMESTAMP WHERE "id"='c1_set_1'`;
        // Attach a rejection handler immediately; inspect the real wait, not an arbitrary delay.
        const outcome = activation.then(
          () => 'accepted',
          () => 'rejected',
        );
        const deadline = Date.now() + 8_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const count = Number(
            sql(
              "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE \"ActivityMetricSetVersion\"%'",
            ),
          );
          if (count > 0) {
            blocked = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        release();
        await editing;
        expect(await outcome).toBe('rejected');
        expect(
          sql('SELECT "statusCode" FROM "ActivityMetricSetVersion" WHERE "id"=\'c1_set_1\''),
        ).toBe('draft');
      } finally {
        release();
        await Promise.allSettled([editing, activation]);
        await Promise.all([writer.$disconnect(), reader.$disconnect()]);
      }
    },
  );
});

describe('C1 D1 nonempty migration rehearsal', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });
  it('replays 109 then 110 without changing a real legacy Activity, and re-deploy is idempotent', () => {
    recreate();
    const root = path.resolve('prisma');
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(names.indexOf(MIGRATION_NAME)).toBe(PREVIOUS_MIGRATION_COUNT);
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-c1-pre110-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      for (const name of names.slice(0, PREVIOUS_MIGRATION_COUNT))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      expect(successfulMigrationCount()).toBe(PREVIOUS_MIGRATION_COUNT);
      sql(
        'INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode") VALUES (\'c1_legacy_org\',CURRENT_TIMESTAMP,\'C1 legacy\',\'team\');' +
          'INSERT INTO "Activity" ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode") VALUES (\'c1_legacy_activity\',CURRENT_TIMESTAMP,\'C1 legacy\',\'legacy_c1\',\'c1_legacy_org\',TIMESTAMP \'2099-09-01 09:00:00\',TIMESTAMP \'2099-09-01 17:00:00\',\'legacy location\',\'draft\')',
      );
      const before = sql(
        'SELECT row_to_json(a)::text FROM "Activity" a WHERE "id"=\'c1_legacy_activity\'',
      );
      expect(before).toContain('legacy location');
      deploy();
      expect(successfulMigrationCount()).toBe(CURRENT_MIGRATION_COUNT);
      expect(
        sql('SELECT row_to_json(a)::text FROM "Activity" a WHERE "id"=\'c1_legacy_activity\''),
      ).toBe(before);
      expect(
        sql(
          'SELECT (SELECT count(*) FROM "ActivityMetricDefinition") + (SELECT count(*) FROM "ActivityMetricSetVersion") + (SELECT count(*) FROM "ActivityMetricSetItem")',
        ),
      ).toBe('0');
      deploy();
      expect(successfulMigrationCount()).toBe(CURRENT_MIGRATION_COUNT);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});

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

const MIGRATION = '20260911100000_activity_os_r4_d1_3_time_policy_selection';

function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('D1-3 migration test requires an isolated worker database');
  return { worker, database: deriveTestDbName() };
}

function sql(statement: string): string {
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
      '-v',
      'VERBOSITY=verbose',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function recreate(): void {
  const { worker, database } = target();
  dropWorkerDatabase(worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
}

function deploy(schema: string): void {
  target();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}

function rejected(statement: string, constraint: string): void {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain('23514');
  expect(failure).toContain(constraint);
}

function seedLegacy(activityId = 'd13-activity'): void {
  sql(`BEGIN;
    INSERT INTO "User" (id, username, "passwordHash", "updatedAt")
      VALUES ('d13-user', 'd13-user', 'test-only', CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Organization" (id, "updatedAt", name, "nodeTypeCode")
      VALUES ('d13-org', CURRENT_TIMESTAMP, 'D1-3 测试组织', 'team')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Activity" (
      id, "updatedAt", title, "activityTypeCode", "organizationId", "startAt", "endAt", location, "statusCode"
    ) VALUES (
      '${activityId}', CURRENT_TIMESTAMP, 'D1-3 测试活动', 'test', 'd13-org',
      '2099-01-01T00:00:00.000Z', '2099-01-01T02:00:00.000Z', '测试地点', 'draft'
    ) ON CONFLICT (id) DO NOTHING;
    COMMIT;`);
}

function legacyFacts() {
  return [
    sql(
      'SELECT id || chr(9) || username || chr(9) || "passwordHash" FROM "User" WHERE id = \'d13-user\'',
    ),
    sql(
      'SELECT id || chr(9) || name || chr(9) || "nodeTypeCode" FROM "Organization" WHERE id = \'d13-org\'',
    ),
    sql(
      'SELECT id || chr(9) || title || chr(9) || "organizationId" || chr(9) || "statusCode" FROM "Activity" WHERE id = \'d13-activity\'',
    ),
  ];
}

function insertValidStandaloneRevision(): void {
  const hash = 'a'.repeat(64);
  const requestHash = 'b'.repeat(64);
  const selection = JSON.stringify({
    schemaVersion: 1,
    items: {
      'activity:-:-': {
        scope: { layerCode: 'activity', sessionId: null, positionId: null },
        selection: { mode: 'inherit', pointer: null },
      },
    },
  });
  const result = JSON.stringify({
    activityId: 'd13-activity',
    selectionRevisionId: 'd13-revision-1',
    revision: 1,
    selectionHash: hash,
    createdAt: '2099-01-02T03:04:05.006Z',
  });
  sql(`BEGIN;
    INSERT INTO "ActivityTimePolicySelectionRevision" (
      id, "activityId", revision, "schemaVersion", "selectionHash", "selectionJson", "itemCount",
      "templateId", "templateDefinitionHash", "originCode", "creationReceiptId", "seriesOccurrenceId",
      "publishReviewId", "proposalSelectionHash", "createdAt", "createdByUserId"
    ) VALUES (
      'd13-revision-1', 'd13-activity', 1, 1, '${hash}', '${selection}'::jsonb, 1,
      NULL, NULL, 'select', NULL, NULL, NULL, NULL, '2099-01-02T03:04:05.006Z', 'd13-user'
    );
    INSERT INTO "ActivityTimePolicySelectionItem" (
      id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
      "policyId", "versionId", "definitionHash"
    ) VALUES (
      'd13-item-1', 'd13-revision-1', 'd13-activity', 'activity', NULL, NULL, 'inherit', NULL, NULL, NULL
    );
    UPDATE "Activity"
      SET "timePolicySelectionRevision" = 1, "currentTimePolicySelectionRevisionId" = 'd13-revision-1'
      WHERE id = 'd13-activity';
    INSERT INTO "ActivityTimePolicySelectionCommandReceipt" (
      id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
      "selectionRevisionId", "resultJson", "createdAt"
    ) VALUES (
      'd13-receipt-1', 'd13-user', 'd13-activity', 'patch_time_policy_selection', 'd13-key-001', '${requestHash}',
      'd13-revision-1', '${result}'::jsonb, '2099-01-02T03:04:05.006Z'
    );
    COMMIT;`);
}

describe('D1-3 time-policy selection migration', () => {
  const root = path.resolve('prisma');

  // Every case recreates the shared Jest worker database. Restore it even
  // when an earlier migration assertion fails, so unrelated later E2E specs
  // cannot inherit a partial historical replay.
  afterAll(() => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
  }, 120000);

  it('replays all 121 migrations from empty and exposes the immutable selection database surface', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(121);
    expect(names[118]).toBe(MIGRATION);
    expect(
      sql(
        'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
      ).split('\n'),
    ).toEqual(
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
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ActivityTimePolicySelectionRevision', 'ActivityTimePolicySelectionItem', 'ActivityTimePolicySelectionCommandReceipt')",
      ),
    ).toBe('3');
    expect(
      sql(
        "SELECT count(*) FROM pg_proc WHERE proname IN ('atps_check_item_manifest', 'atps_check_revision_complete', 'atps_check_current_revision')",
      ),
    ).toBe('3');
  }, 120000);

  it('keeps V3 template receipts legal, admits V4, and rejects a V4 receipt bound to V3', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    seedLegacy();
    const hash = 'a'.repeat(64);
    const receipt = (id: string, templateId: string, schemaVersion: 3 | 4, version: number) =>
      `INSERT INTO "ActivityMetricCommandReceipt" (
        id, "actorUserId", "operationCode", "operationKey", "requestHash", "templateVersionId", "resultJson"
      ) VALUES (
        '${id}', 'd13-user', 'create_template_version', '${id}-key', '${hash}', '${templateId}',
        '{"id":"${templateId}","code":"d13_template_${schemaVersion}","version":${version},"schemaVersion":${schemaVersion},"statusCode":"draft","definitionHash":"${hash}"}'::jsonb
      )`;
    sql(`
      INSERT INTO "ActivityTemplateFamily" (
        id, "updatedAt", code, name, "categoryCode", "scopeTypeCode", "statusCode"
      ) VALUES
        ('d13-family-v3', CURRENT_TIMESTAMP, 'd13-family-v3', 'D1-3 V3 family', 'test', 'global', 'active'),
        ('d13-family-v4', CURRENT_TIMESTAMP, 'd13-family-v4', 'D1-3 V4 family', 'test', 'global', 'active');
      INSERT INTO "ActivityTemplate" (
        id, "updatedAt", code, name, "activityTypeCode", "statusCode", version, "familyId",
        "schemaVersion", "definitionJson", "definitionHash"
      ) VALUES
        ('d13-template-v3', CURRENT_TIMESTAMP, 'd13_template_3', 'D1-3 V3 template', 'test', 'draft', 1, 'd13-family-v3', 3, '{}'::jsonb, '${hash}'),
        ('d13-template-v4', CURRENT_TIMESTAMP, 'd13_template_4', 'D1-3 V4 template', 'test', 'draft', 1, 'd13-family-v4', 4, '{}'::jsonb, '${hash}');
    `);
    sql(receipt('d13-v3-receipt', 'd13-template-v3', 3, 1));
    sql(receipt('d13-v4-receipt', 'd13-template-v4', 4, 1));
    expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('2');
    rejected(
      receipt('d13-v4-on-v3-receipt', 'd13-template-v3', 4, 1),
      'atps_template_receipt_guard',
    );
  }, 120000);

  it('preserves old Activity facts across 118 to 119 and enforces append-only current selection facts', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d13-pre119-'));
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
      expect(names.indexOf(MIGRATION)).toBe(118);
      for (const name of names.slice(0, 118)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = path.join(temporary, 'schema.prisma');
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '118',
      );
      seedLegacy();
      const before = legacyFacts();
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '119',
      );
      expect(legacyFacts()).toEqual(before);
      expect(
        sql(
          'SELECT "timePolicySelectionRevision" || chr(9) || COALESCE("currentTimePolicySelectionRevisionId", \'null\') FROM "Activity" WHERE id = \'d13-activity\'',
        ),
      ).toBe('0\tnull');

      insertValidStandaloneRevision();
      expect(
        sql(
          'SELECT "timePolicySelectionRevision" || chr(9) || "currentTimePolicySelectionRevisionId" FROM "Activity" WHERE id = \'d13-activity\'',
        ),
      ).toBe('1\td13-revision-1');
      expect(sql('SELECT count(*) FROM "ActivityTimePolicySelectionItem"')).toBe('1');
      expect(sql('SELECT count(*) FROM "ActivityTimePolicySelectionCommandReceipt"')).toBe('1');

      expect(() =>
        sql(
          'UPDATE "ActivityTimePolicySelectionRevision" SET "selectionHash" = repeat(\'c\', 64) WHERE id = \'d13-revision-1\'',
        ),
      ).toThrow();
      expect(() =>
        sql('DELETE FROM "ActivityTimePolicySelectionCommandReceipt" WHERE id = \'d13-receipt-1\''),
      ).toThrow();
      expect(() =>
        sql(`INSERT INTO "ActivityTimePolicySelectionItem" (
          id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode, "policyId", "versionId", "definitionHash"
        ) VALUES ('d13-forbidden-append', 'd13-revision-1', 'd13-activity', 'template', NULL, NULL, 'inherit', NULL, NULL, NULL)`),
      ).toThrow();
      expect(() =>
        sql(
          'UPDATE "Activity" SET "timePolicySelectionRevision" = 0, "currentTimePolicySelectionRevisionId" = NULL WHERE id = \'d13-activity\'',
        ),
      ).toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
});

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

import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260923190000_activity_os_r5_e1_3_contribution_policy_selection';
const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_E1_3_W98 === '1';

function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('E1-3 migration test requires an isolated worker database');
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

function rejectedWith(statement: string, sqlState: string, constraint: string): void {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain(sqlState);
  expect(failure).toContain(constraint);
}

function rejected(statement: string, constraint: string): void {
  rejectedWith(statement, '23514', constraint);
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function positionScopeKey(sessionId: string, positionId: string): string {
  return `position:${Buffer.from(sessionId).toString('base64')}:${Buffer.from(positionId).toString('base64')}`;
}

function inheritItem(
  layerCode: 'activity' | 'position',
  sessionId: string | null,
  positionId: string | null,
) {
  return {
    scope: { layerCode, sessionId, positionId },
    selection: { mode: 'inherit', pointer: null },
  };
}

function explicitItem(
  policyId: string,
  versionId: string,
  definitionHash: string,
  evaluatorVersion: number,
) {
  return {
    scope: { layerCode: 'activity', sessionId: null, positionId: null },
    selection: {
      mode: 'explicit',
      pointer: { policyId, versionId, definitionHash, evaluatorVersion },
    },
  };
}

function seedLegacy(activityId = 'e13-activity'): void {
  sql(`BEGIN;
    INSERT INTO "User" (id, username, "passwordHash", "updatedAt")
      VALUES ('e13-user', 'e13-user', 'test-only', CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Organization" (id, "updatedAt", name, "nodeTypeCode")
      VALUES ('e13-org', CURRENT_TIMESTAMP, 'E1-3 测试组织', 'team')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Activity" (
      id, "updatedAt", title, "activityTypeCode", "organizationId", "startAt", "endAt", location, "statusCode"
    ) VALUES (
      '${activityId}', CURRENT_TIMESTAMP, 'E1-3 测试活动', 'test', 'e13-org',
      '2099-01-01T00:00:00.000Z', '2099-01-01T02:00:00.000Z', '测试地点', 'draft'
    ) ON CONFLICT (id) DO NOTHING;
    COMMIT;`);
}

function seedReferenceFacts(): void {
  seedLegacy('e13-other-activity');
  const policyDefinition = {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
    roleRules: [],
  };
  sql(`BEGIN;
    INSERT INTO "ActivitySession" (
      id, "updatedAt", "activityId", code, name, "startAt", "endAt", "locationText",
      "checkInOpenAt", "checkInCloseAt", "checkOutOpenAt", "checkOutCloseAt",
      "locationRequired", "locationPolicySourceCode", "statusCode"
    ) VALUES (
      'e13-other-session', CURRENT_TIMESTAMP, 'e13-other-activity', 'other_session', 'Other session',
      '2099-01-01T00:00:00.000Z', '2099-01-01T02:00:00.000Z', 'Other location',
      '2098-12-31T23:30:00.000Z', '2099-01-01T00:30:00.000Z',
      '2099-01-01T01:30:00.000Z', '2099-01-01T02:00:00.000Z',
      FALSE, 'system', 'scheduled'
    );
    INSERT INTO "ActivitySessionPosition" (
      id, "updatedAt", "activityId", "sessionId", code, name, "attendanceRoleCode"
    ) VALUES (
      'e13-other-position', CURRENT_TIMESTAMP, 'e13-other-activity', 'e13-other-session',
      'other_position', 'Other position', 'service'
    );
    INSERT INTO "ContributionPolicy" (id, code, name, "updatedAt") VALUES
      ('e13-policy-a', 'e13_policy_a', 'E1-3 policy A', CURRENT_TIMESTAMP),
      ('e13-policy-b', 'e13_policy_b', 'E1-3 policy B', CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicyVersion" (
      id, "policyId", version, "schemaVersion", "definitionJson", "definitionHash",
      "evaluatorVersion", "effectiveFrom", "effectiveUntil", "statusCode",
      "createdByUserId", "updatedAt"
    ) VALUES (
      'e13-policy-version-a', 'e13-policy-a', 1, 1, ${sqlJson(policyDefinition)}, '${'d'.repeat(64)}',
      1, '2098-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', 'draft',
      'e13-user', CURRENT_TIMESTAMP
    );
    COMMIT;`);
}

function legacyFacts() {
  return [
    sql(
      'SELECT id || chr(9) || username || chr(9) || "passwordHash" FROM "User" WHERE id = \'e13-user\'',
    ),
    sql(
      'SELECT id || chr(9) || name || chr(9) || "nodeTypeCode" FROM "Organization" WHERE id = \'e13-org\'',
    ),
    sql(
      'SELECT id || chr(9) || title || chr(9) || "organizationId" || chr(9) || "statusCode" FROM "Activity" WHERE id = \'e13-activity\'',
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
    activityId: 'e13-activity',
    selectionRevisionId: 'e13-revision-1',
    revision: 1,
    selectionHash: hash,
    createdAt: '2099-01-02T03:04:05.006Z',
  });
  sql(`BEGIN;
    INSERT INTO "ActivityContributionPolicySelectionRevision" (
      id, "activityId", revision, "schemaVersion", "selectionHash", "selectionJson", "itemCount",
      "templateId", "templateDefinitionHash", "originCode", "creationReceiptId", "seriesOccurrenceId",
      "publishReviewId", "proposalSelectionHash", "createdAt", "createdByUserId"
    ) VALUES (
      'e13-revision-1', 'e13-activity', 1, 1, '${hash}', '${selection}'::jsonb, 1,
      NULL, NULL, 'select', NULL, NULL, NULL, NULL, '2099-01-02T03:04:05.006Z', 'e13-user'
    );
    INSERT INTO "ActivityContributionPolicySelectionItem" (
      id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
      "policyId", "versionId", "definitionHash", "evaluatorVersion"
    ) VALUES (
      'e13-item-1', 'e13-revision-1', 'e13-activity', 'activity', NULL, NULL, 'inherit', NULL, NULL, NULL, NULL
    );
    UPDATE "Activity"
      SET "contributionPolicySelectionRevision" = 1, "currentContributionPolicySelectionRevisionId" = 'e13-revision-1'
      WHERE id = 'e13-activity';
    INSERT INTO "ActivityContributionPolicySelectionCommandReceipt" (
      id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
      "selectionRevisionId", "resultJson", "createdAt"
    ) VALUES (
      'e13-receipt-1', 'e13-user', 'e13-activity', 'patch_contribution_policy_selection', 'e13-key-001', '${requestHash}',
      'e13-revision-1', '${result}'::jsonb, '2099-01-02T03:04:05.006Z'
    );
    COMMIT;`);
}

describe('E1-3 contribution-policy selection migration', () => {
  const root = path.resolve('prisma');
  const previousEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
  };

  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
    }
    target();
  });

  // Every case recreates the shared Jest worker database. Restore it even
  // when an earlier migration assertion fails, so unrelated later E2E specs
  // cannot inherit a partial historical replay.
  afterAll(() => {
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase(WORKER);
      } finally {
        restoreEnvironment('JEST_WORKER_ID', previousEnvironment.worker);
        restoreEnvironment('DATABASE_URL', previousEnvironment.databaseUrl);
      }
      return;
    }
    recreate();
    deploy(path.join(root, 'schema.prisma'));
  }, 120000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('replays all 131 migrations from empty and exposes the immutable selection database surface', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(131);
    expect(names[130]).toBe(MIGRATION);
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
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ActivityContributionPolicySelectionRevision', 'ActivityContributionPolicySelectionItem', 'ActivityContributionPolicySelectionCommandReceipt')",
      ),
    ).toBe('3');
    expect(
      sql(
        "SELECT count(*) FROM pg_proc WHERE proname IN ('acps_check_item_manifest', 'acps_check_revision_complete', 'acps_check_current_revision')",
      ),
    ).toBe('3');
  }, 120000);

  it('keeps V4 template receipts legal, admits V5, and rejects a V5 receipt bound to V4', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    seedLegacy();
    const hash = 'a'.repeat(64);
    const receipt = (id: string, templateId: string, schemaVersion: 4 | 5, version: number) =>
      `INSERT INTO "ActivityMetricCommandReceipt" (
        id, "actorUserId", "operationCode", "operationKey", "requestHash", "templateVersionId", "resultJson"
      ) VALUES (
        '${id}', 'e13-user', 'create_template_version', '${id}-key', '${hash}', '${templateId}',
        '{"id":"${templateId}","code":"e13_template_${schemaVersion}","version":${version},"schemaVersion":${schemaVersion},"statusCode":"draft","definitionHash":"${hash}"}'::jsonb
      )`;
    sql(`
      INSERT INTO "ActivityTemplateFamily" (
        id, "updatedAt", code, name, "categoryCode", "scopeTypeCode", "statusCode"
      ) VALUES
        ('e13-family-v4', CURRENT_TIMESTAMP, 'e13-family-v4', 'E1-3 V4 family', 'test', 'global', 'active'),
        ('e13-family-v5', CURRENT_TIMESTAMP, 'e13-family-v5', 'E1-3 V5 family', 'test', 'global', 'active');
      INSERT INTO "ActivityTemplate" (
        id, "updatedAt", code, name, "activityTypeCode", "statusCode", version, "familyId",
        "schemaVersion", "definitionJson", "definitionHash"
      ) VALUES
        ('e13-template-v4', CURRENT_TIMESTAMP, 'e13_template_4', 'E1-3 V4 template', 'test', 'draft', 1, 'e13-family-v4', 4, '{}'::jsonb, '${hash}'),
        ('e13-template-v5', CURRENT_TIMESTAMP, 'e13_template_5', 'E1-3 V5 template', 'test', 'draft', 1, 'e13-family-v5', 5, '{}'::jsonb, '${hash}');
    `);
    sql(receipt('e13-v4-receipt', 'e13-template-v4', 4, 1));
    sql(receipt('e13-v5-receipt', 'e13-template-v5', 5, 1));
    expect(sql('SELECT count(*) FROM "ActivityMetricCommandReceipt"')).toBe('2');
    rejected(
      receipt('e13-v5-on-v4-receipt', 'e13-template-v4', 5, 1),
      'atps_template_receipt_guard',
    );
  }, 120000);

  it('preserves old Activity facts across 130 to 131 and enforces append-only current selection facts', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-e13-pre131-'));
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
      expect(names.indexOf(MIGRATION)).toBe(130);
      for (const name of names.slice(0, 130)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = path.join(temporary, 'schema.prisma');
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '130',
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
        '131',
      );
      expect(legacyFacts()).toEqual(before);
      expect(
        sql(
          'SELECT "contributionPolicySelectionRevision" || chr(9) || COALESCE("currentContributionPolicySelectionRevisionId", \'null\') FROM "Activity" WHERE id = \'e13-activity\'',
        ),
      ).toBe('0\tnull');

      insertValidStandaloneRevision();
      expect(
        sql(
          'SELECT "contributionPolicySelectionRevision" || chr(9) || "currentContributionPolicySelectionRevisionId" FROM "Activity" WHERE id = \'e13-activity\'',
        ),
      ).toBe('1\te13-revision-1');
      expect(sql('SELECT count(*) FROM "ActivityContributionPolicySelectionItem"')).toBe('1');
      expect(sql('SELECT count(*) FROM "ActivityContributionPolicySelectionCommandReceipt"')).toBe(
        '1',
      );

      seedReferenceFacts();

      const crossActivityPositionSelection = {
        schemaVersion: 1,
        items: {
          [positionScopeKey('e13-other-session', 'e13-other-position')]: inheritItem(
            'position',
            'e13-other-session',
            'e13-other-position',
          ),
        },
      };
      rejectedWith(
        `BEGIN;
          INSERT INTO "ActivityContributionPolicySelectionRevision" (
            id, "activityId", revision, "selectionHash", "selectionJson", "itemCount", "originCode", "createdByUserId"
          ) VALUES (
            'e13-cross-position-revision', 'e13-activity', 2, '${'c'.repeat(64)}',
            ${sqlJson(crossActivityPositionSelection)}, 1, 'select', 'e13-user'
          );
          INSERT INTO "ActivityContributionPolicySelectionItem" (
            id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
            "policyId", "versionId", "definitionHash", "evaluatorVersion"
          ) VALUES (
            'e13-cross-position-item', 'e13-cross-position-revision', 'e13-activity', 'position',
            'e13-other-session', 'e13-other-position', 'inherit', NULL, NULL, NULL, NULL
          );
          COMMIT;`,
        '23503',
        'acps_item_position_fkey',
      );

      for (const mismatch of [
        {
          label: 'policy',
          policyId: 'e13-policy-b',
          definitionHash: 'd'.repeat(64),
          evaluatorVersion: 1,
          sqlState: '23503',
          constraint: 'acps_item_policy_version_fkey',
        },
        {
          label: 'hash',
          policyId: 'e13-policy-a',
          definitionHash: 'e'.repeat(64),
          evaluatorVersion: 1,
          sqlState: '23503',
          constraint: 'acps_item_policy_version_fkey',
        },
        {
          label: 'evaluator',
          policyId: 'e13-policy-a',
          definitionHash: 'd'.repeat(64),
          evaluatorVersion: 2,
          sqlState: '23514',
          constraint: 'acps_item_shape_check',
        },
      ]) {
        const selection = {
          schemaVersion: 1,
          items: {
            'activity:-:-': explicitItem(
              mismatch.policyId,
              'e13-policy-version-a',
              mismatch.definitionHash,
              mismatch.evaluatorVersion,
            ),
          },
        };
        rejectedWith(
          `BEGIN;
            INSERT INTO "ActivityContributionPolicySelectionRevision" (
              id, "activityId", revision, "selectionHash", "selectionJson", "itemCount", "originCode", "createdByUserId"
            ) VALUES (
              'e13-${mismatch.label}-revision', 'e13-activity', 2, '${'c'.repeat(64)}',
              ${sqlJson(selection)}, 1, 'select', 'e13-user'
            );
            INSERT INTO "ActivityContributionPolicySelectionItem" (
              id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
              "policyId", "versionId", "definitionHash", "evaluatorVersion"
            ) VALUES (
              'e13-${mismatch.label}-item', 'e13-${mismatch.label}-revision', 'e13-activity',
              'activity', NULL, NULL, 'explicit', '${mismatch.policyId}', 'e13-policy-version-a',
              '${mismatch.definitionHash}', ${mismatch.evaluatorVersion}
            );
            COMMIT;`,
          mismatch.sqlState,
          mismatch.constraint,
        );
      }

      const incompleteSelection = {
        schemaVersion: 1,
        items: {
          'activity:-:-': inheritItem('activity', null, null),
          [positionScopeKey('e13-other-session', 'e13-other-position')]: inheritItem(
            'position',
            'e13-other-session',
            'e13-other-position',
          ),
        },
      };
      const incompleteResult = {
        activityId: 'e13-activity',
        selectionRevisionId: 'e13-incomplete-revision',
        revision: 2,
        selectionHash: 'c'.repeat(64),
        createdAt: '2099-01-02T03:04:05.007Z',
      };
      rejected(
        `BEGIN;
          INSERT INTO "ActivityContributionPolicySelectionRevision" (
            id, "activityId", revision, "selectionHash", "selectionJson", "itemCount", "originCode",
            "createdAt", "createdByUserId"
          ) VALUES (
            'e13-incomplete-revision', 'e13-activity', 2, '${'c'.repeat(64)}',
            ${sqlJson(incompleteSelection)}, 2, 'select', '2099-01-02T03:04:05.007Z', 'e13-user'
          );
          INSERT INTO "ActivityContributionPolicySelectionItem" (
            id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
            "policyId", "versionId", "definitionHash", "evaluatorVersion"
          ) VALUES (
            'e13-incomplete-item', 'e13-incomplete-revision', 'e13-activity', 'activity',
            NULL, NULL, 'inherit', NULL, NULL, NULL, NULL
          );
          UPDATE "Activity" SET "contributionPolicySelectionRevision" = 2,
            "currentContributionPolicySelectionRevisionId" = 'e13-incomplete-revision'
            WHERE id = 'e13-activity';
          INSERT INTO "ActivityContributionPolicySelectionCommandReceipt" (
            id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
            "selectionRevisionId", "resultJson", "createdAt"
          ) VALUES (
            'e13-incomplete-receipt', 'e13-user', 'e13-activity',
            'patch_contribution_policy_selection', 'e13-incomplete-key', '${'b'.repeat(64)}',
            'e13-incomplete-revision', ${sqlJson(incompleteResult)}, '2099-01-02T03:04:05.007Z'
          );
          COMMIT;`,
        'acps_revision_complete_guard',
      );

      rejectedWith(
        `UPDATE "Activity" SET "contributionPolicySelectionRevision" = 1,
          "currentContributionPolicySelectionRevisionId" = 'e13-revision-1'
          WHERE id = 'e13-other-activity'`,
        '23503',
        'acps_current_revision_guard',
      );

      const receiptDriftSelection = {
        schemaVersion: 1,
        items: { 'activity:-:-': inheritItem('activity', null, null) },
      };
      const receiptDriftResult = {
        activityId: 'e13-activity',
        selectionRevisionId: 'e13-receipt-drift-revision',
        revision: 2,
        selectionHash: 'f'.repeat(64),
        createdAt: '2099-01-02T03:04:05.008Z',
      };
      rejected(
        `BEGIN;
          INSERT INTO "ActivityContributionPolicySelectionRevision" (
            id, "activityId", revision, "selectionHash", "selectionJson", "itemCount", "originCode",
            "createdAt", "createdByUserId"
          ) VALUES (
            'e13-receipt-drift-revision', 'e13-activity', 2, '${'c'.repeat(64)}',
            ${sqlJson(receiptDriftSelection)}, 1, 'select', '2099-01-02T03:04:05.008Z', 'e13-user'
          );
          INSERT INTO "ActivityContributionPolicySelectionItem" (
            id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
            "policyId", "versionId", "definitionHash", "evaluatorVersion"
          ) VALUES (
            'e13-receipt-drift-item', 'e13-receipt-drift-revision', 'e13-activity', 'activity',
            NULL, NULL, 'inherit', NULL, NULL, NULL, NULL
          );
          UPDATE "Activity" SET "contributionPolicySelectionRevision" = 2,
            "currentContributionPolicySelectionRevisionId" = 'e13-receipt-drift-revision'
            WHERE id = 'e13-activity';
          INSERT INTO "ActivityContributionPolicySelectionCommandReceipt" (
            id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
            "selectionRevisionId", "resultJson", "createdAt"
          ) VALUES (
            'e13-receipt-drift-receipt', 'e13-user', 'e13-activity',
            'patch_contribution_policy_selection', 'e13-drift-key', '${'b'.repeat(64)}',
            'e13-receipt-drift-revision', ${sqlJson(receiptDriftResult)}, '2099-01-02T03:04:05.008Z'
          );
          COMMIT;`,
        'acps_revision_complete_guard',
      );

      for (const immutable of [
        {
          statement:
            'UPDATE "ActivityContributionPolicySelectionRevision" SET "selectionHash" = repeat(\'c\', 64) WHERE id = \'e13-revision-1\'',
          trigger: 'acps_revision_immutable',
        },
        {
          statement:
            'DELETE FROM "ActivityContributionPolicySelectionRevision" WHERE id = \'e13-revision-1\'',
          trigger: 'acps_revision_immutable',
        },
        {
          statement:
            'UPDATE "ActivityContributionPolicySelectionItem" SET id = id WHERE id = \'e13-item-1\'',
          trigger: 'acps_item_immutable',
        },
        {
          statement:
            'DELETE FROM "ActivityContributionPolicySelectionItem" WHERE id = \'e13-item-1\'',
          trigger: 'acps_item_immutable',
        },
        {
          statement:
            'UPDATE "ActivityContributionPolicySelectionCommandReceipt" SET id = id WHERE id = \'e13-receipt-1\'',
          trigger: 'acps_receipt_immutable',
        },
        {
          statement:
            'DELETE FROM "ActivityContributionPolicySelectionCommandReceipt" WHERE id = \'e13-receipt-1\'',
          trigger: 'acps_receipt_immutable',
        },
        {
          statement: 'TRUNCATE "ActivityContributionPolicySelectionItem"',
          trigger: 'acps_item_no_truncate',
        },
        {
          statement: 'TRUNCATE "ActivityContributionPolicySelectionCommandReceipt"',
          trigger: 'acps_receipt_no_truncate',
        },
        {
          statement: 'TRUNCATE "ActivityContributionPolicySelectionRevision" CASCADE',
          trigger: 'acps_revision_no_truncate',
        },
      ]) {
        rejectedWith(immutable.statement, '55000', immutable.trigger);
      }

      rejected(
        'UPDATE "Activity" SET "contributionPolicySelectionRevision" = 0, "currentContributionPolicySelectionRevisionId" = NULL WHERE id = \'e13-activity\'',
        'acps_current_revision_guard',
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
});

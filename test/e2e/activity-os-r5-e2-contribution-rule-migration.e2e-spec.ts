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

const MIGRATION = '20260924180000_activity_os_r5_e2_contribution_rule_conversion';
const USE_DEDICATED_W98 = process.env.SRVF_E2_W98 === '1';
const ROOT = path.resolve('prisma');
const HASH = 'a'.repeat(64);

function target(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('E2 migration test requires worker database');
  return deriveTestDbName();
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
      target(),
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function recreate(): void {
  const database = target();
  dropWorkerDatabase(process.env.JEST_WORKER_ID!);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
}

function deploy(schema = path.join(ROOT, 'schema.prisma')): void {
  target();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}

function rejected(statement: string, marker: string): void {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain(marker);
}

function seedOldFacts(): void {
  const definition = JSON.stringify({
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'fixture_zero' },
    roleRules: [],
  });
  sql(`BEGIN;
    INSERT INTO "User" (id, username, "passwordHash", "updatedAt")
      VALUES ('e2-user', 'e2-user', 'test-only', CURRENT_TIMESTAMP);
    INSERT INTO "ContributionRule" (
      id, "activityTypeCode", "attendanceRoleCode", "durationThreshold",
      "pointsBelow", "pointsAbove", "updatedAt"
    ) VALUES ('e2-rule', 'e2_fixture_example', 'volunteer', 4.00, 1.00, NULL, CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicy" (id, code, name, "updatedAt")
      VALUES ('e2-policy', 'e2_fixture_policy', 'E2 fixture', CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicyVersion" (
      id, "policyId", version, "schemaVersion", "definitionJson", "definitionHash",
      "evaluatorVersion", "effectiveFrom", "statusCode", "createdByUserId", "updatedAt"
    ) VALUES (
      'e2-version', 'e2-policy', 1, 1, '${definition}'::jsonb, '${HASH}',
      1, '2026-09-25T00:00:00.000Z', 'draft', 'e2-user', CURRENT_TIMESTAMP
    );
    COMMIT;`);
}

function oldFacts(): string {
  return sql(`SELECT
    (SELECT "activityTypeCode" || ':' || "attendanceRoleCode" || ':' || "pointsBelow" FROM "ContributionRule" WHERE id='e2-rule') || chr(9) ||
    (SELECT code FROM "ContributionPolicy" WHERE id='e2-policy') || chr(9) ||
    (SELECT "definitionHash" FROM "ContributionPolicyVersion" WHERE id='e2-version')`);
}

function receiptInsert(id: string, versionId = 'e2-version', sourceFingerprint = HASH): string {
  const snapshot = JSON.stringify({
    id: 'e2-rule',
    activityTypeCode: 'e2_fixture_example',
    attendanceRoleCode: 'volunteer',
    durationThreshold: '4.00',
    pointsBelow: '1.00',
    pointsAbove: null,
    status: 'ACTIVE',
    deletedAt: null,
    updatedAt: '2026-09-25T00:00:00.000Z',
  });
  return `INSERT INTO "ContributionRuleConversionReceipt" (
    id, "sourceRuleId", "sourceFingerprint", "converterVersion", "mappingFingerprint",
    "batchFingerprint", "sourceSnapshotJson", "actorUserId", "policyId", "versionId",
    "definitionHash", "evaluatorVersion"
  ) VALUES (
    '${id}', 'e2-rule', '${sourceFingerprint}', 1, '${HASH}', '${HASH}', '${snapshot}'::jsonb,
    'e2-user', 'e2-policy', '${versionId}', '${HASH}', 1
  )`;
}

describe('E2 additive conversion receipt migration', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
    }
    target();
  });
  afterAll(() => {
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase('98');
      } finally {
        if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = previous.worker;
        if (previous.url === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous.url;
      }
    }
  });

  it('cold-replays 132 migrations without old-table DML', () => {
    recreate();
    deploy();
    const names = readdirSync(path.join(ROOT, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(132);
    expect(names[131]).toBe(MIGRATION);
    expect(
      sql(`SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL ORDER BY migration_name`).split('\n'),
    ).toEqual(
      names.map(
        (name) =>
          `${name}\t${createHash('sha256')
            .update(readFileSync(path.join(ROOT, 'migrations', name, 'migration.sql')))
            .digest('hex')}`,
      ),
    );
    expect(sql(`SELECT count(*) FROM "ContributionRuleConversionReceipt"`)).toBe('0');
  }, 120000);

  it('preserves nonempty 131 facts, then enforces exact FK, unique and immutability', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-e2-pre132-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(ROOT, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(ROOT, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      const names = readdirSync(path.join(ROOT, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(names.indexOf(MIGRATION)).toBe(131);
      for (const name of names.slice(0, 131)) {
        cpSync(path.join(ROOT, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = path.join(temporary, 'schema.prisma');
      deploy(schema);
      seedOldFacts();
      const before = oldFacts();
      cpSync(
        path.join(ROOT, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        { recursive: true, force: false, errorOnExist: true },
      );
      deploy(schema);
      expect(oldFacts()).toBe(before);
      expect(sql('SELECT count(*) FROM "ContributionRuleConversionReceipt"')).toBe('0');
      sql(receiptInsert('e2-receipt'));
      rejected(receiptInsert('e2-duplicate'), 'crcr_source_revision_key');
      rejected(
        receiptInsert('e2-wrong-anchor', 'e2-other-version', 'b'.repeat(64)),
        'crcr_version_anchor_fk',
      );
      rejected(
        `UPDATE "ContributionRuleConversionReceipt" SET "mappingFingerprint"='${'b'.repeat(64)}'`,
        'immutable',
      );
      rejected('DELETE FROM "ContributionRuleConversionReceipt"', 'immutable');
      rejected('TRUNCATE "ContributionRuleConversionReceipt"', 'immutable');
      expect(oldFacts()).toBe(before);
      expect(sql('SELECT count(*) FROM "ContributionRuleConversionReceipt"')).toBe('1');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
});

import { execFileSync, spawnSync } from 'node:child_process';
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
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260921180000_activity_os_r4_d8_proof_cutover';
const LATEST_MIGRATION = '20260923190000_activity_os_r5_e1_3_contribution_policy_selection';
const PREVIOUS_MIGRATION_COUNT = 128;
const D8_MIGRATION_COUNT = 129;
const CURRENT_MIGRATION_COUNT = 132;
const WORKER = 98;
const prismaRoot = path.resolve(__dirname, '..', '..', 'prisma');
const schema = path.join(prismaRoot, 'schema.prisma');

function target(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const database = deriveTestDbName();
  assertDroppableTestDbName(database);
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== `/${database}`) {
    throw new Error('D8-1 migration worker and configured database do not match');
  }
  return database;
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
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function sqlFailure(statement: string): string {
  const result = spawnSync(
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
    ],
    { input: statement, encoding: 'utf8' },
  );
  if (result.status === 0) throw new Error('Expected SQL to fail');
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function recreate(): void {
  const database = target();
  dropWorkerDatabase(WORKER);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
  if (sql('SELECT current_database()') !== database) {
    throw new Error('D8-1 migration connected target mismatch');
  }
}

function deploy(schemaPath: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    env: process.env,
    stdio: 'pipe',
  });
}

function migrationNames(): string[] {
  return readdirSync(path.join(prismaRoot, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function appliedNames(): string[] {
  const value = sql(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ' +
      'AND rolled_back_at IS NULL ORDER BY started_at, migration_name',
  );
  return value.length === 0 ? [] : value.split('\n');
}

describe('D8-1 proof cutover migration', () => {
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
  };

  beforeAll(() => {
    process.env.JEST_WORKER_ID = String(WORKER);
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  afterAll(() => {
    try {
      dropWorkerDatabase(WORKER);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
    }
  });

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('cold replays all exact SQL files and installs the immutable cutover surface', () => {
    recreate();
    deploy(schema);
    const expected = migrationNames();
    expect(expected).toHaveLength(CURRENT_MIGRATION_COUNT);
    expect(expected[D8_MIGRATION_COUNT - 1]).toBe(MIGRATION);
    expect(expected.at(-1)).toBe(LATEST_MIGRATION);
    expect(appliedNames()).toEqual(expected);
    const migrationHash = createHash('sha256')
      .update(readFileSync(path.join(prismaRoot, 'migrations', MIGRATION, 'migration.sql')))
      .digest('hex');
    expect(migrationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      sql(
        'SELECT array_agg(relname ORDER BY relname)::text FROM pg_class ' +
          "WHERE relkind='r' AND relname IN ('ActivityTimeCutoverReceipt','ParticipationTimeCutoverBinding')",
      ),
    ).toBe('{ActivityTimeCutoverReceipt,ParticipationTimeCutoverBinding}');
    expect(
      sql(
        'SELECT array_agg(tgname ORDER BY tgname)::text FROM pg_trigger WHERE tgname IN ' +
          "('atc_batch_fence','atc_bind_committed_root','atcr_insert_guard','atcr_immutable'," +
          "'atcr_no_truncate','ptcb_insert_guard','ptcb_immutable','ptcb_no_truncate')",
      ),
    ).toBe(
      '{atc_batch_fence,atc_bind_committed_root,atcr_immutable,atcr_insert_guard,' +
        'atcr_no_truncate,ptcb_immutable,ptcb_insert_guard,ptcb_no_truncate}',
    );
    expect(
      sql(
        'SELECT array_agg(proname ORDER BY proname)::text FROM pg_proc WHERE proname IN ' +
          "('atc_lock_key','atc_batch_fence_guard','atcr_content_payload','atcr_prepare_insert'," +
          "'atc_reject_mutation','ptcb_insert_guard','atc_bind_committed_root')",
      ),
    ).toBe(
      '{atc_batch_fence_guard,atc_bind_committed_root,atc_lock_key,atc_reject_mutation,' +
        'atcr_content_payload,atcr_prepare_insert,ptcb_insert_guard}',
    );
  }, 180_000);

  it('upgrades a populated 128-migration database without rewriting existing facts', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d8-1-pre129-'));
    try {
      const temporaryMigrations = path.join(temporary, 'migrations');
      mkdirSync(temporaryMigrations);
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(prismaRoot, 'migrations', 'migration_lock.toml'),
        path.join(temporaryMigrations, 'migration_lock.toml'),
      );
      const names = migrationNames();
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, PREVIOUS_MIGRATION_COUNT)) {
        cpSync(path.join(prismaRoot, 'migrations', name), path.join(temporaryMigrations, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      deploy(path.join(temporary, 'schema.prisma'));
      expect(appliedNames()).toHaveLength(PREVIOUS_MIGRATION_COUNT);
      sql(
        `INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ` +
          `('d8-pre129-user','d8-pre129-user','fixture',CURRENT_TIMESTAMP)`,
      );
      const before = sql(`SELECT id || chr(9) || username FROM "User" WHERE id='d8-pre129-user'`);
      cpSync(
        path.join(prismaRoot, 'migrations', MIGRATION),
        path.join(temporaryMigrations, MIGRATION),
        { recursive: true, errorOnExist: true, force: false },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(appliedNames()).toHaveLength(D8_MIGRATION_COUNT);
      expect(sql(`SELECT id || chr(9) || username FROM "User" WHERE id='d8-pre129-user'`)).toBe(
        before,
      );
      expect(
        sql(
          'SELECT (SELECT count(*) FROM "ActivityTimeCutoverReceipt")::text || chr(9) || ' +
            '(SELECT count(*) FROM "ParticipationTimeCutoverBinding")::text',
        ),
      ).toBe('0\t0');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);

  it('lets only the guarded singleton insert create the receipt and rejects later mutation', () => {
    recreate();
    deploy(schema);
    sql(
      `INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ` +
        `('d8-actor','d8-actor','fixture',CURRENT_TIMESTAMP)`,
    );
    sql(
      `INSERT INTO "ActivityTimeCutoverReceipt" ` +
        `(id,"operationKey","requestHash","deployedMainSha","evidenceBundleHash","actorUserId","contentHash") VALUES (` +
        `${quote('activity-time-v1')},${quote('d8-migration')},${quote('a'.repeat(64))},` +
        `${quote('b'.repeat(40))},${quote('c'.repeat(64))},${quote('d8-actor')},${quote('0'.repeat(64))})`,
    );
    expect(
      sql(
        'SELECT id || chr(9) || "formatVersion"::text || chr(9) || ' +
          '("contentHash" ~ \'^[a-f0-9]{64}$\')::text FROM "ActivityTimeCutoverReceipt"',
      ),
    ).toBe('activity-time-v1\t1\ttrue');
    expect(
      sqlFailure(
        `INSERT INTO "ActivityTimeCutoverReceipt" ` +
          `(id,"operationKey","requestHash","deployedMainSha","evidenceBundleHash","actorUserId","contentHash") VALUES (` +
          `${quote('activity-time-v1')},${quote('d8-second')},${quote('d'.repeat(64))},` +
          `${quote('e'.repeat(40))},${quote('f'.repeat(64))},${quote('d8-actor')},${quote('0'.repeat(64))})`,
      ),
    ).toContain('activity time cutover receipt already exists');
    expect(
      sqlFailure(
        `INSERT INTO "ParticipationTimeCutoverBinding" ` +
          `(id,"cutoverReceiptId","rootManifestId","postingBatchId","activityId",` +
          `"settlementRunId","settlementVersionId","rootContentHash") VALUES (` +
          `${quote('ptcb:missing')},${quote('activity-time-v1')},${quote('missing')},${quote('missing')},` +
          `${quote('missing')},${quote('missing')},${quote('missing')},${quote('0'.repeat(64))})`,
      ),
    ).toContain('cutover bindings are created only by the posting commit guard');
    expect(
      sqlFailure(`UPDATE "ActivityTimeCutoverReceipt" SET "contentHash"=${quote('1'.repeat(64))}`),
    ).toContain('activity time cutover facts are immutable');
    expect(
      sqlFailure('TRUNCATE "ParticipationTimeCutoverBinding", "ActivityTimeCutoverReceipt"'),
    ).toContain('activity time cutover facts are immutable');
  }, 180_000);
});

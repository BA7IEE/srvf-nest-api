import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 84;
const MIGRATION_NAME = '20260812100000_activity_v11_batch4_activity_allocation_mode';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const MIGRATION_83_COUNT = 83;
// ⚠️ 与上面的 MIGRATION_<N>_COUNT 是**两件事**:那些是固定的历史世代基线(冷库重放的起点),
// 随仓库增长**永不变**;这个是仓库当前的 migration 总数,每加一刀就要 +1。
// 混改任何一个都会把冷库重放用例的语义整个改坏(issue #1055 T1 加第 91 刀时逐个复核过)。
const CURRENT_MIGRATION_COUNT = 94;
const ALLOCATION_MODE_CONSTRAINT = 'activity_allocation_mode_code_ck';
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 300_000;

interface ActivityFixture {
  activityId: string;
  organizationId: string;
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for allocation-mode migration E2E');
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing non-derived scratch database ${databaseName}`);
  }
  const parsed = new URL(source);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function runPsql(databaseName: string, sql: string): string {
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing psql against non-derived scratch database ${databaseName}`);
  }
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
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function runPsqlFailure(databaseName: string, sql: string): string {
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing psql against non-derived scratch database ${databaseName}`);
  }
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '--no-psqlrc',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    { input: `\\set VERBOSITY verbose\n${sql}`, encoding: 'utf8' },
  );
  expect(result.status).not.toBe(0);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function successfulMigrationCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT COUNT(*)
       FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL`,
    ),
  );
}

function recreateEmptyScratchDatabase(): string {
  const databaseName = deriveWorkerTestDbName(SCRATCH_WORKER_ID);
  assertDroppableTestDbName(databaseName);
  dropWorkerDatabase(SCRATCH_WORKER_ID);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'createdb', '-U', 'postgres', databaseName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return databaseName;
}

function migrationNames(): string[] {
  return readdirSync(path.resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function deployMigrationsThrough83(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const names = migrationNames();
  const migration84Index = names.indexOf(MIGRATION_NAME);
  const baselineEnd = migration84Index === -1 ? names.length : migration84Index;
  if (baselineEnd !== MIGRATION_83_COUNT) {
    throw new Error(`expected an exact 83-migration baseline; got ${baselineEnd}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-allocation-mode-83-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const name of names.slice(0, baselineEnd)) {
      cpSync(path.join(sourceMigrationsRoot, name), path.join(temporaryMigrationsRoot, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', temporarySchemaPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(temporaryPrismaRoot, { recursive: true, force: true });
  }
}

function recreateMigration83Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough83(databaseName);
    if (successfulMigrationCount(databaseName) !== MIGRATION_83_COUNT) {
      throw new Error('failed to build a true 83-migration scratch database');
    }
  } catch (error) {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
    throw error;
  }
  return databaseName;
}

function deployCurrentMigrations(databaseName: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createActivity(databaseName: string, suffix: string): ActivityFixture {
  const fixture = {
    organizationId: `allocation-mode-organization-${suffix}`,
    activityId: `allocation-mode-activity-${suffix}`,
  };
  runPsql(
    databaseName,
    `INSERT INTO "Organization" ("id","name","nodeTypeCode","updatedAt")
     VALUES (${sqlValue(fixture.organizationId)},${sqlValue(`allocation mode ${suffix}`)},'team',CURRENT_TIMESTAMP);
     INSERT INTO "Activity"
       ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
     VALUES
       (${sqlValue(fixture.activityId)},${sqlValue(`allocation mode ${suffix}`)},'allocation-mode',
        ${sqlValue(fixture.organizationId)},TIMESTAMP '2099-08-12 08:00:00',
        TIMESTAMP '2099-08-12 10:00:00','test','draft',CURRENT_TIMESTAMP);`,
  );
  return fixture;
}

function allocationMode(databaseName: string, activityId: string): string {
  return runPsql(
    databaseName,
    `SELECT "allocationModeCode" FROM "Activity" WHERE "id" = ${sqlValue(activityId)}`,
  );
}

function activityWithoutAllocationMode(databaseName: string, activityId: string): string {
  return runPsql(
    databaseName,
    `SELECT (to_jsonb(activity) - 'allocationModeCode')::text
     FROM "Activity" activity WHERE "id" = ${sqlValue(activityId)}`,
  );
}

function activityXmin(databaseName: string, activityId: string): string {
  return runPsql(
    databaseName,
    `SELECT xmin::text FROM "Activity" WHERE "id" = ${sqlValue(activityId)}`,
  );
}

function allocationArtifactCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT
         (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'Activity'
            AND column_name = 'allocationModeCode')
       + (SELECT COUNT(*) FROM information_schema.table_constraints
          WHERE table_schema = 'public' AND table_name = 'Activity'
            AND constraint_name = ${sqlValue(ALLOCATION_MODE_CONSTRAINT)})`,
    ),
  );
}

function columnContract(databaseName: string): {
  columnDefault: string;
  dataType: string;
  isNullable: string;
} {
  return JSON.parse(
    runPsql(
      databaseName,
      `SELECT json_build_object(
         'columnDefault', column_default,
         'dataType', data_type,
         'isNullable', is_nullable
       )::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'Activity'
         AND column_name = 'allocationModeCode'`,
    ),
  );
}

function checkClause(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT check_clause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_catalog = tc.constraint_catalog
      AND cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'Activity'
       AND tc.constraint_name = ${sqlValue(ALLOCATION_MODE_CONSTRAINT)}`,
  );
}

function removeMarkedBlock(source: string, beginMarker: string, endMarker: string): string {
  const start = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`expected migration marker pair ${beginMarker} / ${endMarker}`);
  }
  return `${source.slice(0, start)}${source.slice(end + endMarker.length)}`;
}

function deployMutatedMigration(
  databaseName: string,
  mutationName: string,
  mutate: (source: string) => string,
): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const sourceMigrationPath = path.join(sourceMigrationsRoot, MIGRATION_NAME, 'migration.sql');
  const source = readFileSync(sourceMigrationPath, 'utf8');
  const mutated = mutate(source);
  if (mutated === source) {
    throw new Error(`${mutationName} did not alter the real ${MIGRATION_NAME} source`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), `srvf-allocation-${mutationName}-`));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const entry of readdirSync(sourceMigrationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      cpSync(
        path.join(sourceMigrationsRoot, entry.name),
        path.join(temporaryMigrationsRoot, entry.name),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
    }
    writeFileSync(path.join(temporaryMigrationsRoot, MIGRATION_NAME, 'migration.sql'), mutated);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', temporarySchemaPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(temporaryPrismaRoot, { recursive: true, force: true });
  }
}

describe('第 84 migration activity allocation mode', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });

  it(
    'upgrades a true 83 database and exposes every legacy activity as first_come without rewriting it',
    () => {
      const databaseName = recreateMigration83Scratch();
      try {
        const fixture = createActivity(databaseName, 'legacy-upgrade');
        const rowBefore = activityWithoutAllocationMode(databaseName, fixture.activityId);
        const xminBefore = activityXmin(databaseName, fixture.activityId);

        deployCurrentMigrations(databaseName);

        expect(allocationMode(databaseName, fixture.activityId)).toBe('first_come');
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(activityWithoutAllocationMode(databaseName, fixture.activityId)).toBe(rowBefore);
        expect(activityXmin(databaseName, fixture.activityId)).toBe(xminBefore);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it('contains one atomic additive migration and an exact Prisma scalar default', async () => {
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/im);
    expect(executable).not.toMatch(/\b(?:UNIQUE|FOREIGN KEY)\b/i);
    expect(migration).toContain(
      `ADD COLUMN "allocationModeCode" TEXT NOT NULL DEFAULT 'first_come'`,
    );
    expect(migration).toContain(
      `CHECK ("allocationModeCode" IN ('first_come', 'qualification_rank', 'lottery'))`,
    );

    const schema = await readFile(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const activityModel = /model Activity \{([\s\S]*?)\n\}/.exec(schema)?.[1];
    expect(activityModel).toBeDefined();
    expect(activityModel).toMatch(/^\s*allocationModeCode\s+String\s+@default\("first_come"\)/m);
    expect(activityModel).not.toMatch(/@@unique\(\[allocationModeCode\]/);
  });

  it(
    `replays all current ${CURRENT_MIGRATION_COUNT} migrations from an empty database and enforces the exact column contract`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(allocationArtifactCount(databaseName)).toBe(2);
        expect(columnContract(databaseName)).toEqual({
          columnDefault: "'first_come'::text",
          dataType: 'text',
          isNullable: 'NO',
        });
        const clause = checkClause(databaseName);
        for (const value of ['first_come', 'qualification_rank', 'lottery']) {
          expect(clause).toContain(value);
        }

        const fixture = createActivity(databaseName, 'closed-set');
        expect(allocationMode(databaseName, fixture.activityId)).toBe('first_come');
        for (const value of ['first_come', 'qualification_rank', 'lottery']) {
          runPsql(
            databaseName,
            `UPDATE "Activity" SET "allocationModeCode" = ${sqlValue(value)}
             WHERE "id" = ${sqlValue(fixture.activityId)}`,
          );
          expect(allocationMode(databaseName, fixture.activityId)).toBe(value);
        }

        const invalidFailure = runPsqlFailure(
          databaseName,
          `UPDATE "Activity" SET "allocationModeCode" = 'manual'
           WHERE "id" = ${sqlValue(fixture.activityId)};`,
        );
        expect(invalidFailure).toContain('23514');
        expect(invalidFailure).toContain(ALLOCATION_MODE_CONSTRAINT);

        const nullFailure = runPsqlFailure(
          databaseName,
          `UPDATE "Activity" SET "allocationModeCode" = NULL
           WHERE "id" = ${sqlValue(fixture.activityId)};`,
        );
        expect(nullFailure).toContain('23502');
        expect(nullFailure).toContain('allocationModeCode');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    'rolls back the new column and CHECK together when the final DDL step fails',
    async () => {
      const databaseName = recreateMigration83Scratch();
      try {
        const fixture = createActivity(databaseName, 'late-failure');
        const rowBefore = activityWithoutAllocationMode(databaseName, fixture.activityId);
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        const failingMigration = migration.replace(
          /\nCOMMIT;\s*$/,
          `\nDO $allocation_mode_84_late_failure$\nBEGIN\n  RAISE EXCEPTION 'allocation mode 84 late DDL failure';\nEND\n$allocation_mode_84_late_failure$;\n\nCOMMIT;\n`,
        );
        if (failingMigration === migration) {
          throw new Error('allocation mode 84 COMMIT marker disappeared before failure injection');
        }

        const failure = runPsqlFailure(databaseName, failingMigration);
        expect(failure).toContain('allocation mode 84 late DDL failure');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_83_COUNT);
        expect(allocationArtifactCount(databaseName)).toBe(0);
        expect(activityWithoutAllocationMode(databaseName, fixture.activityId)).toBe(rowBefore);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    'CHECK deletion mutation first proves 23514 on the real migration, then lets only the invalid probe pass',
    () => {
      let databaseName = recreateMigration83Scratch();
      try {
        let fixture = createActivity(databaseName, 'check-control');
        deployCurrentMigrations(databaseName);
        expect(
          runPsqlFailure(
            databaseName,
            `UPDATE "Activity" SET "allocationModeCode" = 'manual'
             WHERE "id" = ${sqlValue(fixture.activityId)};`,
          ),
        ).toContain('23514');

        databaseName = recreateMigration83Scratch();
        fixture = createActivity(databaseName, 'check-mutated');
        deployMutatedMigration(databaseName, 'without-check', (source) =>
          removeMarkedBlock(
            source,
            '-- allocation-mode-84:check:begin',
            '-- allocation-mode-84:check:end',
          ),
        );
        runPsql(
          databaseName,
          `UPDATE "Activity" SET "allocationModeCode" = 'manual'
           WHERE "id" = ${sqlValue(fixture.activityId)};`,
        );
        expect(allocationMode(databaseName, fixture.activityId)).toBe('manual');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    'NULL mutation first proves 23502 on the real migration, then lets only the NULL probe pass',
    () => {
      let databaseName = recreateMigration83Scratch();
      try {
        let fixture = createActivity(databaseName, 'null-control');
        deployCurrentMigrations(databaseName);
        expect(
          runPsqlFailure(
            databaseName,
            `UPDATE "Activity" SET "allocationModeCode" = NULL
             WHERE "id" = ${sqlValue(fixture.activityId)};`,
          ),
        ).toContain('23502');

        databaseName = recreateMigration83Scratch();
        fixture = createActivity(databaseName, 'null-mutated');
        deployMutatedMigration(databaseName, 'nullable-column', (source) => {
          const target = `TEXT NOT NULL DEFAULT 'first_come'`;
          if (!source.includes(target))
            throw new Error('NOT NULL source disappeared before mutation');
          return source.replace(target, `TEXT DEFAULT 'first_come'`);
        });
        runPsql(
          databaseName,
          `UPDATE "Activity" SET "allocationModeCode" = NULL
           WHERE "id" = ${sqlValue(fixture.activityId)};`,
        );
        expect(
          runPsql(
            databaseName,
            `SELECT "allocationModeCode" IS NULL FROM "Activity"
             WHERE "id" = ${sqlValue(fixture.activityId)}`,
          ),
        ).toBe('t');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    'default mutation first proves legacy first_come on the real migration, then exposes lottery',
    () => {
      let databaseName = recreateMigration83Scratch();
      try {
        let fixture = createActivity(databaseName, 'default-control');
        deployCurrentMigrations(databaseName);
        expect(allocationMode(databaseName, fixture.activityId)).toBe('first_come');

        databaseName = recreateMigration83Scratch();
        fixture = createActivity(databaseName, 'default-mutated');
        deployMutatedMigration(databaseName, 'lottery-default', (source) => {
          const target = `TEXT NOT NULL DEFAULT 'first_come'`;
          if (!source.includes(target))
            throw new Error('default source disappeared before mutation');
          return source.replace(target, `TEXT NOT NULL DEFAULT 'lottery'`);
        });
        expect(allocationMode(databaseName, fixture.activityId)).toBe('lottery');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

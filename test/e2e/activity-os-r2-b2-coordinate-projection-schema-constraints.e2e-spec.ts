import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

// B2 只为 B1 两张地点表补齐坐标合同，并提供不接线的纯投影策略。当前库验证六条
// CHECK 的正反例；scratch 库分别验证 107 条冷重放、106→107 的合法非空升级，以及
// B1 时代脏坐标让整条 migration fail-closed、零部分约束残留。
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 94;
const PREVIOUS_MIGRATION_COUNT = 106;
const CURRENT_MIGRATION_COUNT = 107;
const MIGRATION_NAME = '20260903150000_activity_os_r2_b2_coordinate_projection';
const MIGRATION_PATH = 'prisma/migrations/' + MIGRATION_NAME + '/migration.sql';
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;

const EXPECTED_CONSTRAINTS = [
  { tableName: 'ActivityPlace', name: 'activity_place_coordinate_pair_check' },
  { tableName: 'ActivityPlace', name: 'activity_place_coordinate_range_check' },
  { tableName: 'ActivityPlace', name: 'activity_place_coordinate_system_check' },
  { tableName: 'PlacePreset', name: 'place_preset_coordinate_pair_check' },
  { tableName: 'PlacePreset', name: 'place_preset_coordinate_range_check' },
  { tableName: 'PlacePreset', name: 'place_preset_coordinate_system_check' },
] as const;

const EXPECTED_CONSTRAINT_NAMES = EXPECTED_CONSTRAINTS.map((item) => item.name);

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

type RawCoordinateOptions = {
  longitude?: string | null;
  latitude?: string | null;
  coordinateSystemCode?: string | null;
};

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : "'" + value.replaceAll("'", "''") + "'";
}

function sqlDecimal(value: string | null): string {
  return value === null ? 'NULL' : sqlText(value) + '::decimal(10,7)';
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for B2 migration E2E');
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error('refusing non-derived scratch database ' + databaseName);
  }
  const parsed = new URL(source);
  parsed.pathname = '/' + databaseName;
  return parsed.toString();
}

function runPsql(databaseName: string, sql: string): string {
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error('refusing psql against non-derived scratch database ' + databaseName);
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

function successfulMigrationCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
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

function deployMigrationsThroughB1(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const b2Index = migrationNames.indexOf(MIGRATION_NAME);
  if (b2Index !== PREVIOUS_MIGRATION_COUNT) {
    throw new Error(
      'expected ' +
        MIGRATION_NAME +
        ' at migration index ' +
        PREVIOUS_MIGRATION_COUNT +
        '; got ' +
        b2Index,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-activity-place-b1-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, b2Index)) {
      cpSync(
        path.join(sourceMigrationsRoot, migrationName),
        path.join(temporaryMigrationsRoot, migrationName),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
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

function deployCurrentMigrations(databaseName: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function constraintCountSql(): string {
  return (
    'SELECT COUNT(*) FROM pg_constraint WHERE conname = ANY (ARRAY[' +
    EXPECTED_CONSTRAINT_NAMES.map((name) => sqlText(name)).join(',') +
    ']::text[])'
  );
}

function b1FixtureSql(
  prefix: string,
  presetCoordinate: Required<RawCoordinateOptions>,
  activityPlaceCoordinate: Required<RawCoordinateOptions>,
): string {
  const organizationId = prefix + '-organization';
  const activityId = prefix + '-activity';
  return (
    'INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode") VALUES (' +
    sqlText(organizationId) +
    ',CURRENT_TIMESTAMP,' +
    sqlText(prefix + ' organization') +
    ",'team');\n" +
    'INSERT INTO "Activity" ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode") VALUES (' +
    sqlText(activityId) +
    ',CURRENT_TIMESTAMP,' +
    sqlText(prefix + ' activity') +
    ',' +
    sqlText(prefix + ' type') +
    ',' +
    sqlText(organizationId) +
    ",'2099-09-01T09:00:00.000Z','2099-09-01T17:00:00.000Z'," +
    sqlText(prefix + ' location') +
    ",'draft');\n" +
    'INSERT INTO "PlacePreset" ("id","updatedAt","name","addressText","longitude","latitude","coordinateSystemCode","checkInEligible") VALUES (' +
    sqlText(prefix + '-preset') +
    ',CURRENT_TIMESTAMP,' +
    sqlText(prefix + ' preset') +
    ',' +
    sqlText(prefix + ' preset address') +
    ',' +
    sqlDecimal(presetCoordinate.longitude) +
    ',' +
    sqlDecimal(presetCoordinate.latitude) +
    ',' +
    sqlText(presetCoordinate.coordinateSystemCode) +
    ',FALSE);\n' +
    'INSERT INTO "ActivityPlace" ("id","updatedAt","activityId","roleCode","name","addressText","longitude","latitude","coordinateSystemCode","visibilityCode","checkInEligible") VALUES (' +
    sqlText(prefix + '-place') +
    ',CURRENT_TIMESTAMP,' +
    sqlText(activityId) +
    ",'primary'," +
    sqlText(prefix + ' place') +
    ',' +
    sqlText(prefix + ' place address') +
    ',' +
    sqlDecimal(activityPlaceCoordinate.longitude) +
    ',' +
    sqlDecimal(activityPlaceCoordinate.latitude) +
    ',' +
    sqlText(activityPlaceCoordinate.coordinateSystemCode) +
    ",'public',FALSE);"
  );
}

describe('Activity OS R2 B2 coordinate schema constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityId: string;
  let sequence = 0;

  const uniq = (label: string) => 'activity-os-r2-b2-' + label + '-' + String((sequence += 1));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('organization'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;
    activityId = (
      await prisma.activity.create({
        data: {
          title: uniq('activity'),
          activityTypeCode: 'b2-coordinate-type',
          organizationId,
          startAt: new Date('2099-09-01T09:00:00.000Z'),
          endAt: new Date('2099-09-01T17:00:00.000Z'),
          location: 'B2 coordinate fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/u.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw error;
    }
  }

  async function expectAccepted(sql: string): Promise<void> {
    expect(await run(sql)).toBeNull();
  }

  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint: string },
  ): Promise<void> {
    const error = await run(sql);
    expect(error).not.toBeNull();
    expect(error!.sqlState).toBe(expected.sqlState);
    expect(error!.constraint).toBe(expected.constraint);
  }

  function rawPresetSql(id: string, options: RawCoordinateOptions = {}): string {
    const value = {
      longitude: null as string | null,
      latitude: null as string | null,
      coordinateSystemCode: null as string | null,
      ...options,
    };
    return (
      'INSERT INTO "PlacePreset" ("id","updatedAt","name","addressText","longitude","latitude","coordinateSystemCode","checkInEligible") VALUES (' +
      sqlText(id) +
      ',CURRENT_TIMESTAMP,' +
      sqlText('Preset ' + id) +
      ',' +
      sqlText('B2 preset address') +
      ',' +
      sqlDecimal(value.longitude) +
      ',' +
      sqlDecimal(value.latitude) +
      ',' +
      sqlText(value.coordinateSystemCode) +
      ',FALSE)'
    );
  }

  function rawActivityPlaceSql(id: string, options: RawCoordinateOptions = {}): string {
    const value = {
      longitude: null as string | null,
      latitude: null as string | null,
      coordinateSystemCode: null as string | null,
      ...options,
    };
    return (
      'INSERT INTO "ActivityPlace" ("id","updatedAt","activityId","roleCode","name","addressText","longitude","latitude","coordinateSystemCode","visibilityCode","checkInEligible") VALUES (' +
      sqlText(id) +
      ',CURRENT_TIMESTAMP,' +
      sqlText(activityId) +
      ",'primary'," +
      sqlText('Place ' + id) +
      ',' +
      sqlText('B2 place address') +
      ',' +
      sqlDecimal(value.longitude) +
      ',' +
      sqlDecimal(value.latitude) +
      ',' +
      sqlText(value.coordinateSystemCode) +
      ",'public',FALSE)"
    );
  }

  it('精确落下两张表各三条已验证 CHECK，migration 不夹带旧字段或 DML', async () => {
    const constraints = await prisma.$queryRawUnsafe<
      Array<{ tableName: string; name: string; validated: boolean; definition: string }>
    >(
      'SELECT table_meta.relname AS "tableName", con.conname AS "name", con.convalidated AS "validated", ' +
        'pg_get_constraintdef(con.oid) AS "definition" ' +
        'FROM pg_constraint con JOIN pg_class table_meta ON table_meta.oid = con.conrelid ' +
        'WHERE con.conname = ANY (ARRAY[' +
        EXPECTED_CONSTRAINT_NAMES.map((name) => sqlText(name)).join(',') +
        ']::text[]) ORDER BY table_meta.relname, con.conname',
    );
    expect(constraints.map(({ tableName, name }) => ({ tableName, name }))).toEqual(
      EXPECTED_CONSTRAINTS,
    );
    expect(constraints.every((constraint) => constraint.validated)).toBe(true);
    expect(constraints.every((constraint) => constraint.definition.startsWith('CHECK'))).toBe(true);

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect([...migration.matchAll(/ALTER TABLE "([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'PlacePreset',
      'ActivityPlace',
    ]);
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE TRIGGER|DROP TRIGGER)\b/u);
    expect(migration).not.toContain('NOT VALID');
  });

  it('允许纯文字地点与 wgs84/gcj02/bd09 的完整坐标对', async () => {
    const validCoordinates: Required<RawCoordinateOptions>[] = [
      { longitude: null, latitude: null, coordinateSystemCode: null },
      { longitude: '116.3971280', latitude: '39.9165270', coordinateSystemCode: 'wgs84' },
      { longitude: '116.4102445', latitude: '39.9164043', coordinateSystemCode: 'gcj02' },
      { longitude: '116.4103695', latitude: '39.9213370', coordinateSystemCode: 'bd09' },
    ];

    for (const [index, coordinate] of validCoordinates.entries()) {
      await expectAccepted(rawPresetSql(uniq('preset-valid-' + String(index)), coordinate));
      await expectAccepted(rawActivityPlaceSql(uniq('place-valid-' + String(index)), coordinate));
    }
  });

  it('每张表逐一拒绝单边、system-only、缺 system、未知 system、越界和 NaN', async () => {
    const invalidCases: Array<{
      label: string;
      options: RawCoordinateOptions;
      constraintSuffix: 'pair_check' | 'system_check' | 'range_check';
    }> = [
      {
        label: 'longitude-only',
        options: { longitude: '116.4', latitude: null, coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'pair_check',
      },
      {
        label: 'latitude-only',
        options: { longitude: null, latitude: '39.9', coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'pair_check',
      },
      {
        label: 'system-only',
        options: { longitude: null, latitude: null, coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'system_check',
      },
      {
        label: 'pair-without-system',
        options: { longitude: '116.4', latitude: '39.9', coordinateSystemCode: null },
        constraintSuffix: 'system_check',
      },
      {
        label: 'unknown-system',
        options: { longitude: '116.4', latitude: '39.9', coordinateSystemCode: 'future-system' },
        constraintSuffix: 'system_check',
      },
      {
        label: 'longitude-out-of-range',
        options: { longitude: '180.0000001', latitude: '39.9', coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'range_check',
      },
      {
        label: 'latitude-out-of-range',
        options: { longitude: '116.4', latitude: '90.0000001', coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'range_check',
      },
      {
        label: 'numeric-nan',
        options: { longitude: 'NaN', latitude: '39.9', coordinateSystemCode: 'wgs84' },
        constraintSuffix: 'range_check',
      },
    ];

    for (const invalid of invalidCases) {
      await expectRejected(rawPresetSql(uniq('preset-' + invalid.label), invalid.options), {
        sqlState: '23514',
        constraint: 'place_preset_coordinate_' + invalid.constraintSuffix,
      });
      await expectRejected(rawActivityPlaceSql(uniq('place-' + invalid.label), invalid.options), {
        sqlState: '23514',
        constraint: 'activity_place_coordinate_' + invalid.constraintSuffix,
      });
    }
  });
});

describe('Activity OS R2 B2 migration replay / non-empty rehearsal', () => {
  it(
    '从空库完整重放 107 条 migration，并得到六条坐标约束',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, constraintCountSql()))).toBe(
          EXPECTED_CONSTRAINTS.length,
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '106→107 对合法非空 B1 地点直接升级，保留数据并落下全部约束',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughB1(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        runPsql(
          databaseName,
          b1FixtureSql(
            'b2-valid-upgrade',
            {
              longitude: '116.4102445',
              latitude: '39.9164043',
              coordinateSystemCode: 'gcj02',
            },
            {
              longitude: '116.3971280',
              latitude: '39.9165270',
              coordinateSystemCode: 'wgs84',
            },
          ),
        );

        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        runPsql(databaseName, migration);

        // 手工执行 migration 只验证 DDL 事务性，不伪造 Prisma receipt。
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, constraintCountSql()))).toBe(
          EXPECTED_CONSTRAINTS.length,
        );
        expect(
          runPsql(
            databaseName,
            'SELECT (SELECT COUNT(*) FROM "PlacePreset") || \'|\' || (SELECT COUNT(*) FROM "ActivityPlace")',
          ),
        ).toBe('1|1');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '106 时代的非法非空地点让 107 整体失败，migration 计数和六条约束均不部分前进',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughB1(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        runPsql(
          databaseName,
          b1FixtureSql(
            'b2-invalid-upgrade',
            {
              longitude: '116.4102445',
              latitude: null,
              coordinateSystemCode: 'gcj02',
            },
            {
              longitude: '116.3971280',
              latitude: '39.9165270',
              coordinateSystemCode: 'wgs84',
            },
          ),
        );

        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        expect(() => runPsql(databaseName, migration)).toThrow();

        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, constraintCountSql()))).toBe(0);
        expect(
          runPsql(
            databaseName,
            'SELECT "longitude"::text || \'|\' || coalesce("latitude"::text, \'NULL\') || \'|\' || "coordinateSystemCode" FROM "PlacePreset" WHERE "id" = \'b2-invalid-upgrade-preset\'',
          ),
        ).toBe('116.4102445|NULL|gcj02');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

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

// B1 只建设地点预设与活动地点快照的存储地基。当前库验证精确 DDL、约束与快照独立性；
// 独立 scratch 库分别验证空库完整重放，以及 105 条既有 migration 的非空库纯 expand。
// 它刻意不测试 B2 投影、B4 发布就绪、地图接入或任何 API / writer——那些不属于 B1。
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 93;
const PREVIOUS_MIGRATION_COUNT = 105;
const CURRENT_MIGRATION_COUNT = 109;
const MIGRATION_NAME = '20260903131800_activity_os_r2_b1_place_expand';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

type PlaceOptions = {
  activityId?: string;
  sessionId?: string | null;
  roleCode?: string;
  name?: string;
  addressText?: string;
  instruction?: string | null;
  visibilityCode?: string;
  checkInEligible?: boolean;
  radiusMeters?: number | null;
  sourcePresetId?: string | null;
};

type RawPlaceOptions = {
  activityId?: string;
  sessionId?: string | null;
  roleCode?: string;
  visibilityCode?: string;
  longitude?: string | null;
  latitude?: string | null;
  coordinateSystemCode?: string | null;
  providerCode?: string | null;
  providerPlaceId?: string | null;
  checkInEligible?: boolean;
  radiusMeters?: number | null;
  sourcePresetId?: string | null;
};

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function sqlDecimal(value: string | null): string {
  return value === null ? 'NULL' : `${sqlText(value)}::decimal(10,7)`;
}

function sqlInteger(value: number | null): string {
  return value === null ? 'NULL' : String(value);
}

function sqlBoolean(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for B1 migration E2E');
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

function deployMigrationsThroughPrevious(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const b1Index = migrationNames.indexOf(MIGRATION_NAME);
  if (b1Index !== PREVIOUS_MIGRATION_COUNT) {
    throw new Error(
      `expected ${MIGRATION_NAME} at migration index ${PREVIOUS_MIGRATION_COUNT}; got ${b1Index}`,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-activity-place-b0-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, b1Index)) {
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

describe('Activity OS R2 B1 PlacePreset / ActivityPlace schema constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let defaultActivityId: string;
  let seq = 0;

  const uniq = (label: string) => `activity-os-r2-b1-${label}-${(seq += 1)}`;

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
    defaultActivityId = (await createActivity('default')).id;
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
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
  ): Promise<RawDbError> {
    const error = await run(sql);
    expect(error).not.toBeNull();
    expect(error!.sqlState).toBe(expected.sqlState);
    expect(error!.constraint).toBe(expected.constraint);
    return error!;
  }

  async function createActivity(label: string): Promise<{ id: string }> {
    return prisma.activity.create({
      data: {
        title: uniq(`activity-${label}`),
        activityTypeCode: 'b1-place-type',
        organizationId,
        startAt: new Date('2099-09-01T09:00:00.000Z'),
        endAt: new Date('2099-09-01T17:00:00.000Z'),
        location: 'B1 place fixture',
        statusCode: 'draft',
      },
      select: { id: true },
    });
  }

  async function createSession(activityId = defaultActivityId): Promise<{ id: string }> {
    return prisma.activitySession.create({
      data: {
        activityId,
        code: uniq('session-code'),
        name: uniq('session-name'),
        startAt: new Date('2099-09-01T09:00:00.000Z'),
        endAt: new Date('2099-09-01T17:00:00.000Z'),
        locationText: 'B1 session location',
        checkInOpenAt: new Date('2099-09-01T08:00:00.000Z'),
        checkInCloseAt: new Date('2099-09-01T09:30:00.000Z'),
        checkOutOpenAt: new Date('2099-09-01T16:30:00.000Z'),
        checkOutCloseAt: new Date('2099-09-01T18:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
  }

  async function createPreset(label: string): Promise<{ id: string }> {
    return prisma.placePreset.create({
      data: {
        name: uniq(`preset-${label}`),
        addressText: 'B1 preset address',
        instruction: 'B1 preset instruction',
        checkInEligible: true,
        radiusMeters: 120,
      },
      select: { id: true },
    });
  }

  async function createPlace(
    label: string,
    {
      activityId = defaultActivityId,
      sessionId,
      roleCode = 'primary',
      name = uniq(`place-${label}`),
      addressText = 'B1 local address',
      instruction = null,
      visibilityCode = 'public',
      checkInEligible = false,
      radiusMeters = null,
      sourcePresetId,
    }: PlaceOptions = {},
  ) {
    return prisma.activityPlace.create({
      data: {
        activityId,
        ...(sessionId === undefined ? {} : { sessionId }),
        roleCode,
        name,
        addressText,
        instruction,
        visibilityCode,
        checkInEligible,
        radiusMeters,
        ...(sourcePresetId === undefined ? {} : { sourcePresetId }),
      },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        roleCode: true,
        visibilityCode: true,
        workflowRevision: true,
      },
    });
  }

  function rawPlaceSql(id: string, options: RawPlaceOptions = {}): string {
    const value = {
      activityId: defaultActivityId,
      sessionId: null as string | null,
      roleCode: 'primary',
      visibilityCode: 'public',
      longitude: null as string | null,
      latitude: null as string | null,
      coordinateSystemCode: null as string | null,
      providerCode: null as string | null,
      providerPlaceId: null as string | null,
      checkInEligible: false,
      radiusMeters: null as number | null,
      sourcePresetId: null as string | null,
      ...options,
    };
    return `INSERT INTO "ActivityPlace"
      ("id","updatedAt","activityId","sessionId","roleCode","name","addressText",
       "longitude","latitude","coordinateSystemCode","providerCode","providerPlaceId",
       "visibilityCode","checkInEligible","radiusMeters","sourcePresetId")
      VALUES (${sqlText(id)}, CURRENT_TIMESTAMP, ${sqlText(value.activityId)},
        ${sqlText(value.sessionId)}, ${sqlText(value.roleCode)}, ${sqlText(`Raw ${id}`)},
        ${sqlText('B1 raw address')}, ${sqlDecimal(value.longitude)}, ${sqlDecimal(value.latitude)},
        ${sqlText(value.coordinateSystemCode)}, ${sqlText(value.providerCode)},
        ${sqlText(value.providerPlaceId)}, ${sqlText(value.visibilityCode)},
        ${sqlBoolean(value.checkInEligible)}, ${sqlInteger(value.radiusMeters)},
        ${sqlText(value.sourcePresetId)})`;
  }

  it('精确提供两张表、B1 字段类型、默认 revision、三项索引和三条 Restrict FK', async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{
        tableName: string;
        columnName: string;
        nullable: string;
        dataType: string;
        udtName: string;
        numericPrecision: number | null;
        numericScale: number | null;
        columnDefault: string | null;
      }>
    >(
      `SELECT table_name AS "tableName", column_name AS "columnName", is_nullable AS "nullable",
              data_type AS "dataType", udt_name AS "udtName",
              numeric_precision AS "numericPrecision", numeric_scale AS "numericScale",
              column_default AS "columnDefault"
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('PlacePreset', 'ActivityPlace')
       ORDER BY table_name, ordinal_position`,
    );
    const activityPlaceColumns = columns.filter((column) => column.tableName === 'ActivityPlace');
    const placePresetColumns = columns.filter((column) => column.tableName === 'PlacePreset');
    expect(activityPlaceColumns.map((column) => column.columnName)).toEqual([
      'id',
      'createdAt',
      'updatedAt',
      'activityId',
      'sessionId',
      'roleCode',
      'name',
      'addressText',
      'instruction',
      'longitude',
      'latitude',
      'coordinateSystemCode',
      'providerCode',
      'providerPlaceId',
      'visibilityCode',
      'checkInEligible',
      'radiusMeters',
      'sourcePresetId',
      'workflowRevision',
    ]);
    expect(placePresetColumns.map((column) => column.columnName)).toEqual([
      'id',
      'createdAt',
      'updatedAt',
      'name',
      'addressText',
      'instruction',
      'longitude',
      'latitude',
      'coordinateSystemCode',
      'providerCode',
      'providerPlaceId',
      'checkInEligible',
      'radiusMeters',
    ]);
    const byColumn = Object.fromEntries(
      columns.map((column) => [`${column.tableName}.${column.columnName}`, column]),
    );
    expect(byColumn).toMatchObject({
      'PlacePreset.name': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'PlacePreset.addressText': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'PlacePreset.checkInEligible': { nullable: 'NO', dataType: 'boolean', udtName: 'bool' },
      'PlacePreset.longitude': {
        nullable: 'YES',
        dataType: 'numeric',
        udtName: 'numeric',
        numericPrecision: 10,
        numericScale: 7,
      },
      'PlacePreset.latitude': {
        nullable: 'YES',
        dataType: 'numeric',
        udtName: 'numeric',
        numericPrecision: 10,
        numericScale: 7,
      },
      'ActivityPlace.activityId': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityPlace.sessionId': { nullable: 'YES', dataType: 'text', udtName: 'text' },
      'ActivityPlace.roleCode': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityPlace.visibilityCode': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityPlace.checkInEligible': { nullable: 'NO', dataType: 'boolean', udtName: 'bool' },
      'ActivityPlace.longitude': {
        nullable: 'YES',
        dataType: 'numeric',
        udtName: 'numeric',
        numericPrecision: 10,
        numericScale: 7,
      },
      'ActivityPlace.latitude': {
        nullable: 'YES',
        dataType: 'numeric',
        udtName: 'numeric',
        numericPrecision: 10,
        numericScale: 7,
      },
      'ActivityPlace.workflowRevision': {
        nullable: 'NO',
        dataType: 'integer',
        udtName: 'int4',
        columnDefault: '0',
      },
    });

    const indexes = await prisma.$queryRawUnsafe<
      Array<{ name: string; columns: string[]; isUnique: boolean }>
    >(
      `SELECT index_table.relname AS "name",
              array_agg(column_attr.attname ORDER BY key_column.ordinality) AS "columns",
              index_meta.indisunique AS "isUnique"
       FROM pg_index index_meta
       JOIN pg_class table_meta ON table_meta.oid = index_meta.indrelid
       JOIN pg_class index_table ON index_table.oid = index_meta.indexrelid
       JOIN unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON TRUE
       JOIN pg_attribute column_attr
         ON column_attr.attrelid = index_meta.indrelid AND column_attr.attnum = key_column.attnum
       WHERE table_meta.oid = '"ActivityPlace"'::regclass
         AND index_table.relname IN (
           'ActivityPlace_activityId_idx',
           'ActivityPlace_sessionId_idx',
           'ActivityPlace_sourcePresetId_idx'
         )
       GROUP BY index_table.relname, index_meta.indisunique
       ORDER BY index_table.relname`,
    );
    expect(indexes).toEqual([
      { name: 'ActivityPlace_activityId_idx', columns: ['activityId'], isUnique: false },
      { name: 'ActivityPlace_sessionId_idx', columns: ['sessionId'], isUnique: false },
      { name: 'ActivityPlace_sourcePresetId_idx', columns: ['sourcePresetId'], isUnique: false },
    ]);

    const foreignKeys = await prisma.$queryRawUnsafe<
      Array<{
        name: string;
        sourceColumns: string[];
        targetTable: string;
        targetColumns: string[];
        deleteAction: string;
        updateAction: string;
      }>
    >(
      `SELECT con.conname AS "name",
              array_agg(source_attr.attname ORDER BY source_key.ordinality) AS "sourceColumns",
              target_table.relname AS "targetTable",
              array_agg(target_attr.attname ORDER BY source_key.ordinality) AS "targetColumns",
              con.confdeltype AS "deleteAction", con.confupdtype AS "updateAction"
       FROM pg_constraint con
       JOIN pg_class target_table ON target_table.oid = con.confrelid
       JOIN unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinality) ON TRUE
       JOIN unnest(con.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
         ON target_key.ordinality = source_key.ordinality
       JOIN pg_attribute source_attr
         ON source_attr.attrelid = con.conrelid AND source_attr.attnum = source_key.attnum
       JOIN pg_attribute target_attr
         ON target_attr.attrelid = con.confrelid AND target_attr.attnum = target_key.attnum
       WHERE con.conrelid = '"ActivityPlace"'::regclass
         AND con.contype = 'f'
       GROUP BY con.conname, target_table.relname, con.confdeltype, con.confupdtype
       ORDER BY con.conname`,
    );
    expect(foreignKeys).toEqual([
      {
        name: 'ActivityPlace_activityId_fkey',
        sourceColumns: ['activityId'],
        targetTable: 'Activity',
        targetColumns: ['id'],
        deleteAction: 'r',
        updateAction: 'c',
      },
      {
        name: 'ActivityPlace_activityId_sessionId_fkey',
        sourceColumns: ['activityId', 'sessionId'],
        targetTable: 'ActivitySession',
        targetColumns: ['activityId', 'id'],
        deleteAction: 'r',
        updateAction: 'c',
      },
      {
        name: 'ActivityPlace_sourcePresetId_fkey',
        sourceColumns: ['sourcePresetId'],
        targetTable: 'PlacePreset',
        targetColumns: ['id'],
        deleteAction: 'r',
        updateAction: 'c',
      },
    ]);
  });

  it('只冻结六类地点角色与四档可见范围，允许文本地点与多个 other', async () => {
    const roles = ['primary', 'meeting', 'execution', 'evacuation', 'parking', 'other'];
    const visibilities = ['public', 'accepted', 'staff', 'command'];

    for (const roleCode of roles) {
      const place = await createPlace(`role-${roleCode}`, { roleCode });
      expect(place.roleCode).toBe(roleCode);
      expect(place.sessionId).toBeNull();
      expect(place.workflowRevision).toBe(0);
    }
    for (const visibilityCode of visibilities) {
      const place = await createPlace(`visibility-${visibilityCode}`, {
        roleCode: 'other',
        visibilityCode,
      });
      expect(place.visibilityCode).toBe(visibilityCode);
    }

    const textOnly = await prisma.activityPlace.findFirstOrThrow({
      where: { activityId: defaultActivityId, roleCode: 'primary' },
      select: { longitude: true, latitude: true },
    });
    expect(textOnly).toEqual({ longitude: null, latitude: null });
  });

  it('拒绝未知 role / visibility，并保留 B4 才收紧的半径规则', async () => {
    await expectRejected(rawPlaceSql(uniq('invalid-role'), { roleCode: 'temporary-role' }), {
      sqlState: '23514',
      constraint: 'activity_place_role_code_check',
    });
    await expectRejected(rawPlaceSql(uniq('invalid-visibility'), { visibilityCode: 'temporary' }), {
      sqlState: '23514',
      constraint: 'activity_place_visibility_code_check',
    });

    await expectAccepted(
      rawPlaceSql(uniq('deferred-b4-radius'), {
        // B2 已在当前库收紧坐标三元组；B1 的文字地点仍允许，B4 的半径语义则尚未落地。
        longitude: null,
        latitude: null,
        coordinateSystemCode: null,
        providerCode: 'future-provider',
        providerPlaceId: 'future-provider-place',
        checkInEligible: false,
        radiusMeters: -1,
      }),
    );
  });

  it('以复合 FK 锚定活动与场次，不接受孤儿或跨活动场次，并 Restrict 被引用父行', async () => {
    const secondActivity = await createActivity('second');
    const secondSession = await createSession(secondActivity.id);
    const preset = await createPreset('referenced');
    const activityPlace = await createPlace('activity-anchor', { sourcePresetId: preset.id });
    const sessionPlace = await createPlace('session-anchor', {
      activityId: secondActivity.id,
      sessionId: secondSession.id,
    });

    await expectRejected(
      rawPlaceSql(uniq('orphan-activity'), { activityId: 'activity-does-not-exist' }),
      { sqlState: '23503', constraint: 'ActivityPlace_activityId_fkey' },
    );
    await expectRejected(
      rawPlaceSql(uniq('cross-activity-session'), {
        activityId: defaultActivityId,
        sessionId: secondSession.id,
      }),
      { sqlState: '23503', constraint: 'ActivityPlace_activityId_sessionId_fkey' },
    );
    await expectRejected(
      rawPlaceSql(uniq('orphan-preset'), { sourcePresetId: 'preset-does-not-exist' }),
      { sqlState: '23503', constraint: 'ActivityPlace_sourcePresetId_fkey' },
    );

    await expectRejected(
      `DELETE FROM "Activity" WHERE "id" = ${sqlText(activityPlace.activityId)}`,
      { sqlState: '23503', constraint: 'ActivityPlace_activityId_fkey' },
    );
    await expectRejected(`DELETE FROM "PlacePreset" WHERE "id" = ${sqlText(preset.id)}`, {
      sqlState: '23503',
      constraint: 'ActivityPlace_sourcePresetId_fkey',
    });
    await expectRejected(
      `DELETE FROM "ActivitySession" WHERE "id" = ${sqlText(sessionPlace.sessionId)}`,
      { sqlState: '23503', constraint: 'ActivityPlace_activityId_sessionId_fkey' },
    );
  });

  it('从预设建立来源时保存本地快照，后续改预设不会覆盖 ActivityPlace', async () => {
    const preset = await prisma.placePreset.create({
      data: {
        name: 'Preset before change',
        addressText: 'Preset address before change',
        instruction: 'Preset instruction before change',
        checkInEligible: true,
        radiusMeters: 300,
      },
      select: { id: true },
    });
    const place = await prisma.activityPlace.create({
      data: {
        activityId: defaultActivityId,
        roleCode: 'meeting',
        name: 'Local snapshot name',
        addressText: 'Local snapshot address',
        instruction: 'Local snapshot instruction',
        checkInEligible: false,
        radiusMeters: 60,
        sourcePresetId: preset.id,
        visibilityCode: 'staff',
      },
      select: { id: true },
    });

    await prisma.placePreset.update({
      where: { id: preset.id },
      data: {
        name: 'Preset after change',
        addressText: 'Preset address after change',
        instruction: 'Preset instruction after change',
        checkInEligible: false,
        radiusMeters: 999,
      },
    });

    const persisted = await prisma.activityPlace.findUniqueOrThrow({
      where: { id: place.id },
      select: {
        name: true,
        addressText: true,
        instruction: true,
        checkInEligible: true,
        radiusMeters: true,
        sourcePresetId: true,
      },
    });
    expect(persisted).toEqual({
      name: 'Local snapshot name',
      addressText: 'Local snapshot address',
      instruction: 'Local snapshot instruction',
      checkInEligible: false,
      radiusMeters: 60,
      sourcePresetId: preset.id,
    });
  });
});

describe('Activity OS R2 B1 migration replay / non-empty rehearsal', () => {
  it(
    `replays all current ${CURRENT_MIGRATION_COUNT} migrations from an empty database`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(
          runPsql(
            databaseName,
            `SELECT to_regclass('public."PlacePreset"')::text || '|' ||
                    to_regclass('public."ActivityPlace"')::text`,
          ),
        ).toBe('"PlacePreset"|"ActivityPlace"');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '在第 106 条 migration 前的非空库执行纯 expand，不改写既有 Activity 且新表为空',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughPrevious(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        runPsql(
          databaseName,
          `INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode")
           VALUES ('b1-preflight-organization',CURRENT_TIMESTAMP,'B1 preflight organization','team');
           INSERT INTO "Activity"
             ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode")
           VALUES
             ('b1-preflight-activity',CURRENT_TIMESTAMP,'B1 preflight activity','b1-preflight-type',
              'b1-preflight-organization','2099-09-01T09:00:00.000Z','2099-09-01T17:00:00.000Z',
              'B1 preflight location','draft');`,
        );

        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        runPsql(databaseName, migration);

        // 直接执行 SQL 是为了把「旧库带真实行」放在 migration 运行时；它不应伪造
        // Prisma 的 migration receipt，因此登记数仍为 105。
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(
          runPsql(
            databaseName,
            `SELECT "title" || '|' || "activityTypeCode" || '|' || "organizationId" || '|' ||
                    "location" || '|' || "statusCode"
             FROM "Activity" WHERE "id" = 'b1-preflight-activity'`,
          ),
        ).toBe(
          'B1 preflight activity|b1-preflight-type|b1-preflight-organization|B1 preflight location|draft',
        );
        expect(
          runPsql(
            databaseName,
            `SELECT (SELECT COUNT(*) FROM "PlacePreset") || '|' ||
                    (SELECT COUNT(*) FROM "ActivityPlace")`,
          ),
        ).toBe('0|0');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

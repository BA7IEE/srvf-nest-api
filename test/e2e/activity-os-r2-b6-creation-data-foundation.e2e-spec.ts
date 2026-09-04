import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 96;
const PREVIOUS_MIGRATION_COUNT = 108;
const CURRENT_MIGRATION_COUNT = 109;
const MIGRATION_NAME = '20260904195000_activity_os_r2_b6_creation_data_foundation';
const MIGRATION_PATH = 'prisma/migrations/' + MIGRATION_NAME + '/migration.sql';
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;
const RECEIPT_COMMAND_CHECK = 'activity_creation_command_receipt_command_code_check';
const FOLLOW_UP_CODE_CHECK = 'activity_emergency_follow_up_item_code_check';
const FOLLOW_UP_STATUS_CHECK = 'activity_emergency_follow_up_item_status_check';
const FOLLOW_UP_RESOLUTION_SHAPE_CHECK = 'activity_emergency_follow_up_item_resolution_shape_check';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

interface SeedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : "'" + value.replaceAll("'", "''") + "'";
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for B6 D1 migration E2E');
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
      '-v',
      'VERBOSITY=verbose',
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function runPsqlFailure(databaseName: string, sql: string): string {
  try {
    runPsql(databaseName, sql);
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    const stderr = failure.stderr;
    return (
      typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? failure.message ?? '')
    ).trim();
  }
  throw new Error('expected psql command to fail');
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

function deployMigrationsThroughPrevious(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const currentIndex = migrationNames.indexOf(MIGRATION_NAME);
  if (currentIndex !== PREVIOUS_MIGRATION_COUNT) {
    throw new Error(
      'expected ' +
        MIGRATION_NAME +
        ' at migration index ' +
        PREVIOUS_MIGRATION_COUNT +
        '; got ' +
        currentIndex,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-b6-d1-pre109-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, currentIndex)) {
      cpSync(
        path.join(sourceMigrationsRoot, migrationName),
        path.join(temporaryMigrationsRoot, migrationName),
        { recursive: true, force: false, errorOnExist: true },
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

function insertLegacyActivityFixture(databaseName: string, suffix: string): string {
  const organizationId = 'b6-d1-legacy-org-' + suffix;
  const activityId = 'b6-d1-legacy-activity-' + suffix;
  runPsql(
    databaseName,
    'INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode") VALUES (' +
      sqlText(organizationId) +
      ",CURRENT_TIMESTAMP,'B6 D1 legacy organization','team'); " +
      'INSERT INTO "Activity" ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode") VALUES (' +
      sqlText(activityId) +
      ",CURRENT_TIMESTAMP,'B6 D1 legacy activity','b6-d1-legacy'," +
      sqlText(organizationId) +
      ",TIMESTAMP '2099-09-01 09:00:00',TIMESTAMP '2099-09-01 17:00:00','B6 D1 legacy location','draft');",
  );
  return activityId;
}

function runSeed(): SeedRunResult {
  const databaseUrl: string | undefined = process.env.DATABASE_URL;
  assertTestDatabaseUrl(databaseUrl);
  const env = {
    ...process.env,
    APP_ENV: 'test',
    SUPER_ADMIN_USERNAME: 'b6-d1-seed-su',
    SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
    SUPER_ADMIN_EMAIL: '',
    RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  };
  try {
    const stdout = execFileSync('pnpm', ['tsx', 'prisma/seed.ts'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      code: failure.status ?? -1,
      stdout:
        typeof failure.stdout === 'string'
          ? failure.stdout
          : (failure.stdout?.toString('utf8') ?? ''),
      stderr:
        typeof failure.stderr === 'string'
          ? failure.stderr
          : (failure.stderr?.toString('utf8') ?? ''),
    };
  }
}

function receiptSql(input: {
  id: string;
  actorUserId: string;
  commandCode: string;
  operationKey: string;
  activityId: string;
}): string {
  return (
    'INSERT INTO "ActivityCreationCommandReceipt" ' +
    '("id","createdAt","actorUserId","commandCode","operationKey","requestHash","activityId") VALUES (' +
    [
      sqlText(input.id),
      'CURRENT_TIMESTAMP',
      sqlText(input.actorUserId),
      sqlText(input.commandCode),
      sqlText(input.operationKey),
      sqlText('sha256:fixed-test-hash'),
      sqlText(input.activityId),
    ].join(',') +
    ')'
  );
}

function initiationSql(input: {
  id: string;
  activityId: string;
  creationReceiptId: string;
}): string {
  return (
    'INSERT INTO "ActivityEmergencyInitiation" ' +
    '("id","createdAt","activityId","creationReceiptId","callQueuedAt") VALUES (' +
    [
      sqlText(input.id),
      'CURRENT_TIMESTAMP',
      sqlText(input.activityId),
      sqlText(input.creationReceiptId),
      'CURRENT_TIMESTAMP',
    ].join(',') +
    ')'
  );
}

function followUpSql(input: {
  id: string;
  emergencyInitiationId: string;
  itemCode: string;
  statusCode: string;
  resolvedAt?: string | null;
  resolvedByUserId?: string | null;
}): string {
  return (
    'INSERT INTO "ActivityEmergencyFollowUpItem" ' +
    '("id","createdAt","updatedAt","emergencyInitiationId","itemCode","statusCode","resolvedAt","resolvedByUserId") VALUES (' +
    [
      sqlText(input.id),
      'CURRENT_TIMESTAMP',
      'CURRENT_TIMESTAMP',
      sqlText(input.emergencyInitiationId),
      sqlText(input.itemCode),
      sqlText(input.statusCode),
      input.resolvedAt === undefined || input.resolvedAt === null
        ? 'NULL'
        : "TIMESTAMP '" + input.resolvedAt + "'",
      sqlText(input.resolvedByUserId ?? null),
    ].join(',') +
    ')'
  );
}

describe('Activity OS R2 B6 D1 creation data foundation schema', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actorUserId: string;
  let otherUserId: string;
  let activityIds: string[];
  let sequence = 0;

  const unique = (label: string) => 'activity-os-r2-b6-d1-' + label + '-' + (sequence += 1);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createActivity(label: string, organizationId: string): Promise<string> {
    return (
      await prisma.activity.create({
        data: {
          title: unique(label),
          activityTypeCode: 'b6-d1-schema',
          organizationId,
          startAt: new Date('2099-09-01T09:00:00.000Z'),
          endAt: new Date('2099-09-01T17:00:00.000Z'),
          location: 'B6 D1 schema fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
  }

  beforeEach(async () => {
    await resetDb(app);
    const [actor, otherActor] = await Promise.all([
      prisma.user.create({
        data: { username: unique('actor'), passwordHash: 'not-a-login-secret' },
        select: { id: true },
      }),
      prisma.user.create({
        data: { username: unique('other-actor'), passwordHash: 'not-a-login-secret' },
        select: { id: true },
      }),
    ]);
    actorUserId = actor.id;
    otherUserId = otherActor.id;
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityIds = await Promise.all(
      ['one', 'two', 'three', 'four', 'five'].map((label) =>
        createActivity(label, organization.id),
      ),
    );
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        // Prisma 的 raw-query 驱动版本会交替给出带空格或冒号的约束名；两种都必须保留
        // PostgreSQL 的具名约束证明。
        const matched = /constraint(?:\s+|:\s*)"?([^"\s]+)"?/u.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw error;
    }
  }

  async function expectAccepted(sql: string): Promise<void> {
    expect(await run(sql)).toBeNull();
  }

  async function expectRejected(sql: string, sqlState: string, constraint?: string): Promise<void> {
    const error = await run(sql);
    expect(error).not.toBeNull();
    expect(error!.sqlState).toBe(sqlState);
    if (constraint !== undefined) {
      expect(error!.constraint).toBe(constraint);
    }
  }

  it('把专业/紧急收据、同活动起源与七项后续义务精确锁进数据库', async () => {
    await expectAccepted(
      receiptSql({
        id: 'receipt-professional',
        actorUserId,
        commandCode: 'create_professional',
        operationKey: 'professional-key',
        activityId: activityIds[0],
      }),
    );
    await expectRejected(
      receiptSql({
        id: 'receipt-invalid-command',
        actorUserId,
        commandCode: 'create-anything',
        operationKey: 'invalid-command-key',
        activityId: activityIds[1],
      }),
      '23514',
      RECEIPT_COMMAND_CHECK,
    );
    await expectRejected(
      receiptSql({
        id: 'receipt-duplicate-operation',
        actorUserId,
        commandCode: 'create_professional',
        operationKey: 'professional-key',
        activityId: activityIds[1],
      }),
      '23505',
    );
    await expectAccepted(
      receiptSql({
        id: 'receipt-same-key-other-actor',
        actorUserId: otherUserId,
        commandCode: 'create_professional',
        operationKey: 'professional-key',
        activityId: activityIds[1],
      }),
    );
    await expectRejected(
      receiptSql({
        id: 'receipt-duplicate-activity',
        actorUserId,
        commandCode: 'create_emergency',
        operationKey: 'other-key',
        activityId: activityIds[0],
      }),
      '23505',
    );

    await expectAccepted(
      receiptSql({
        id: 'receipt-emergency',
        actorUserId,
        commandCode: 'create_emergency',
        operationKey: 'emergency-key',
        activityId: activityIds[2],
      }),
    );
    await expectAccepted(
      initiationSql({
        id: 'emergency-initiation',
        activityId: activityIds[2],
        creationReceiptId: 'receipt-emergency',
      }),
    );
    await expectAccepted(
      receiptSql({
        id: 'receipt-for-mismatch',
        actorUserId,
        commandCode: 'create_emergency',
        operationKey: 'mismatch-key',
        activityId: activityIds[3],
      }),
    );
    await expectRejected(
      initiationSql({
        id: 'emergency-initiation-mismatch',
        activityId: activityIds[4],
        creationReceiptId: 'receipt-for-mismatch',
      }),
      '23503',
    );

    await expectAccepted(
      followUpSql({
        id: 'follow-up-pending',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'session',
        statusCode: 'pending',
      }),
    );
    await expectRejected(
      followUpSql({
        id: 'follow-up-invalid-code',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'unapproved_item',
        statusCode: 'pending',
      }),
      '23514',
      FOLLOW_UP_CODE_CHECK,
    );
    await expectRejected(
      followUpSql({
        id: 'follow-up-invalid-status',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'position',
        statusCode: 'completed',
      }),
      '23514',
      FOLLOW_UP_STATUS_CHECK,
    );
    await expectRejected(
      followUpSql({
        id: 'follow-up-pending-with-facts',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'detailed_location',
        statusCode: 'pending',
        resolvedAt: '2099-09-01 09:05:00',
        resolvedByUserId: actorUserId,
      }),
      '23514',
      FOLLOW_UP_RESOLUTION_SHAPE_CHECK,
    );
    await expectRejected(
      followUpSql({
        id: 'follow-up-verified-without-facts',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'equipment',
        statusCode: 'verified',
      }),
      '23514',
      FOLLOW_UP_RESOLUTION_SHAPE_CHECK,
    );
    await expectAccepted(
      followUpSql({
        id: 'follow-up-verified',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'position',
        statusCode: 'verified',
        resolvedAt: '2099-09-01 09:05:00',
        resolvedByUserId: actorUserId,
      }),
    );
    await expectAccepted(
      followUpSql({
        id: 'follow-up-unrepresentable',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'attendance',
        statusCode: 'unrepresentable',
        resolvedAt: '2099-09-01 09:06:00',
        resolvedByUserId: otherUserId,
      }),
    );
    await expectRejected(
      followUpSql({
        id: 'follow-up-duplicate-code',
        emergencyInitiationId: 'emergency-initiation',
        itemCode: 'session',
        statusCode: 'pending',
      }),
      '23505',
    );
  });

  it('只落下三张最小事实表；不携带伪事故编号、自由文本或运行时 DML', async () => {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY (ARRAY['ActivityCreationCommandReceipt','ActivityEmergencyInitiation','ActivityEmergencyFollowUpItem']) ORDER BY table_name",
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'ActivityCreationCommandReceipt',
      'ActivityEmergencyFollowUpItem',
      'ActivityEmergencyInitiation',
    ]);
    const incidentColumns = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY (ARRAY['ActivityCreationCommandReceipt','ActivityEmergencyInitiation','ActivityEmergencyFollowUpItem']) AND column_name = 'incidentId'",
    );
    expect(incidentColumns).toEqual([]);

    const constraints = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT conname AS name FROM pg_constraint WHERE conname = ANY (ARRAY['activity_creation_command_receipt_command_code_check','activity_creation_command_receipt_activity_fkey','activity_creation_command_receipt_actor_fkey','activity_emergency_initiation_activity_fkey','activity_emergency_initiation_receipt_activity_fkey','activity_emergency_follow_up_item_code_check','activity_emergency_follow_up_item_status_check','activity_emergency_follow_up_item_resolution_shape_check','activity_emergency_follow_up_item_initiation_fkey','activity_emergency_follow_up_item_resolved_by_fkey']::text[]) ORDER BY conname",
    );
    expect(constraints.map((row) => row.name)).toEqual([
      'activity_creation_command_receipt_activity_fkey',
      'activity_creation_command_receipt_actor_fkey',
      'activity_creation_command_receipt_command_code_check',
      'activity_emergency_follow_up_item_code_check',
      'activity_emergency_follow_up_item_initiation_fkey',
      'activity_emergency_follow_up_item_resolution_shape_check',
      'activity_emergency_follow_up_item_resolved_by_fkey',
      'activity_emergency_follow_up_item_status_check',
      'activity_emergency_initiation_activity_fkey',
      'activity_emergency_initiation_receipt_activity_fkey',
    ]);
    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY (ARRAY['activity_creation_command_receipt_activity_id_key','activity_creation_command_receipt_actor_command_key','activity_creation_command_receipt_id_activity_key','activity_creation_command_receipt_actor_created_idx','activity_emergency_initiation_activity_id_key','activity_emergency_initiation_receipt_id_key','activity_emergency_initiation_receipt_activity_key','activity_emergency_follow_up_item_initiation_code_key','activity_emergency_follow_up_item_status_idx']::text[]) ORDER BY indexname",
    );
    expect(indexes.map((row) => row.name)).toEqual([
      'activity_creation_command_receipt_activity_id_key',
      'activity_creation_command_receipt_actor_command_key',
      'activity_creation_command_receipt_actor_created_idx',
      'activity_creation_command_receipt_id_activity_key',
      'activity_emergency_follow_up_item_initiation_code_key',
      'activity_emergency_follow_up_item_status_idx',
      'activity_emergency_initiation_activity_id_key',
      'activity_emergency_initiation_receipt_activity_key',
      'activity_emergency_initiation_receipt_id_key',
    ]);

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect(migration).toMatch(/^BEGIN;/mu);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/gmu);
    expect(migration).not.toContain('incidentId');
  });
});

describe('Activity OS R2 B6 D1 emergency permission seed', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  it('幂等入库紧急创建码，但不向任何普通角色绑定', async () => {
    expect(runSeed().code).toBe(0);
    const first = await prisma.permission.findUniqueOrThrow({
      where: { code: 'activity.create.emergency.record' },
      select: { id: true, module: true, action: true, resourceType: true, description: true },
    });
    expect(first).toMatchObject({
      module: 'activity',
      action: 'create',
      resourceType: 'emergency',
    });
    expect(first.description).toContain('紧急');
    expect(await prisma.rolePermission.count({ where: { permissionId: first.id } })).toBe(0);

    expect(runSeed().code).toBe(0);
    const second = await prisma.permission.findUniqueOrThrow({
      where: { code: 'activity.create.emergency.record' },
      select: { id: true },
    });
    expect(second.id).toBe(first.id);
    expect(await prisma.rolePermission.count({ where: { permissionId: second.id } })).toBe(0);
  });
});

describe('Activity OS R2 B6 D1 migration replay / non-empty rehearsal', () => {
  it(
    '从空库完整重放 109 条 migration，并取得三张 D1 事实表',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(
          Number(
            runPsql(
              databaseName,
              "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY (ARRAY['ActivityCreationCommandReceipt','ActivityEmergencyInitiation','ActivityEmergencyFollowUpItem'])",
            ),
          ),
        ).toBe(3);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '108→109 直接升级非空 legacy Activity；既有活动不被重解释，新表保持空',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughPrevious(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        const legacyActivityId = insertLegacyActivityFixture(databaseName, 'upgrade');
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        runPsql(databaseName, migration);

        // 手工执行只验证 DDL 事务性；不伪造 Prisma migration receipt。
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(
          runPsql(
            databaseName,
            'SELECT "statusCode" || ' +
              sqlText('|') +
              ' || "location" FROM "Activity" WHERE "id" = ' +
              sqlText(legacyActivityId),
          ),
        ).toBe('draft|B6 D1 legacy location');
        expect(
          runPsql(
            databaseName,
            'SELECT (SELECT COUNT(*) FROM "ActivityCreationCommandReceipt") || ' +
              sqlText('|') +
              ' || (SELECT COUNT(*) FROM "ActivityEmergencyInitiation") || ' +
              sqlText('|') +
              ' || (SELECT COUNT(*) FROM "ActivityEmergencyFollowUpItem")',
          ),
        ).toBe('0|0|0');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '首表冲突时整条 migration 回滚，不留下后两张半成品表',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughPrevious(databaseName);
        runPsql(
          databaseName,
          'CREATE TABLE "ActivityCreationCommandReceipt" ("id" TEXT PRIMARY KEY)',
        );
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        const failure = runPsqlFailure(databaseName, migration);
        expect(failure).toContain('42P07');
        expect(
          Number(
            runPsql(
              databaseName,
              "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY (ARRAY['ActivityEmergencyInitiation','ActivityEmergencyFollowUpItem'])",
            ),
          ),
        ).toBe(0);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

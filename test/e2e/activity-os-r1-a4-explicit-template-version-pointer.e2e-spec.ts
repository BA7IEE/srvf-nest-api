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

// A4 只建立「活动选择了哪一个版本」这一持久化事实。当前库的用例验证准确 DDL 与
// FK 行为；独立 scratch 库分别验证空库全量 replay，以及 A3 非空库升级不改写旧数据。
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 92;
const A3_MIGRATION_COUNT = 102;
const CURRENT_MIGRATION_COUNT = 104;
const MIGRATION_NAME = '20260901120000_activity_os_r1_a4_explicit_template_version';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for A4 migration E2E');
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

function deployMigrationsThroughA3(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const a4Index = migrationNames.indexOf(MIGRATION_NAME);
  if (a4Index !== A3_MIGRATION_COUNT) {
    throw new Error(
      `expected ${MIGRATION_NAME} at migration index ${A3_MIGRATION_COUNT}; got ${a4Index}`,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-activity-template-a3-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, a4Index)) {
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

describe('Activity OS R1 A4 Activity 显式 Template Version 指针', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let seq = 0;

  const uniq = (label: string) => `activity-os-r1-a4-${label}-${(seq += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    // resetDb 已清当前 worker 的 Activity；公共清表不负责可独立存在的 Template，故本 spec
    // 只在 reset 之后清自己的 Template / Family fixture，避免跨 it 残留。
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivityTemplate", "ActivityTemplateFamily" RESTART IDENTITY CASCADE',
    );
    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('org'), nodeTypeCode: 'team' },
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
        const matched = /constraint "([^"]+)"/.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw error;
    }
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

  async function createFutureTemplateVersion(label: string): Promise<string> {
    const familyId = uniq(`${label}-family`);
    const templateId = uniq(`${label}-version`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ActivityTemplateFamily"
       ("id","updatedAt","code","name","categoryCode","scopeTypeCode","statusCode")
       VALUES (${sqlText(familyId)}, CURRENT_TIMESTAMP, ${sqlText(`family-${familyId}`)},
         ${sqlText(`Family ${familyId}`)}, 'volunteer', 'organization', 'draft')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ActivityTemplate"
       ("id","updatedAt","code","name","activityTypeCode","statusCode","version","familyId",
        "schemaVersion","definitionJson","definitionHash")
       VALUES (${sqlText(templateId)}, CURRENT_TIMESTAMP, ${sqlText(`template-${templateId}`)},
         ${sqlText(`Template ${templateId}`)}, 'a4-template-type', 'draft', 1,
         ${sqlText(familyId)}, 1, '{"kind":"a4-fixture"}'::jsonb, ${sqlText('a'.repeat(64))})`,
    );
    return templateId;
  }

  async function createActivity(
    label: string,
    selectedTemplateVersionId?: string,
  ): Promise<{ id: string; selectedTemplateVersionId: string | null }> {
    return prisma.activity.create({
      data: {
        title: uniq(`activity-${label}`),
        activityTypeCode: 'a4-legacy-type',
        organizationId,
        startAt: new Date('2099-09-01T09:00:00.000Z'),
        endAt: new Date('2099-09-01T17:00:00.000Z'),
        location: 'A4 pointer fixture',
        statusCode: 'draft',
        ...(selectedTemplateVersionId === undefined ? {} : { selectedTemplateVersionId }),
      },
      select: { id: true, selectedTemplateVersionId: true },
    });
  }

  it('提供准确的 nullable 指针、单列索引与 Restrict FK', async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{ isNullable: string; dataType: string; udtName: string; columnDefault: string | null }>
    >(
      `SELECT is_nullable AS "isNullable", data_type AS "dataType", udt_name AS "udtName",
              column_default AS "columnDefault"
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'Activity'
         AND column_name = 'selectedTemplateVersionId'`,
    );
    expect(columns).toEqual([
      {
        isNullable: 'YES',
        dataType: 'text',
        udtName: 'text',
        columnDefault: null,
      },
    ]);

    const foreignKeys = await prisma.$queryRawUnsafe<
      Array<{
        name: string;
        sourceColumn: string;
        targetTable: string;
        targetColumn: string;
        sourceArity: number;
        targetArity: number;
        deleteAction: string;
        updateAction: string;
      }>
    >(
      `SELECT con.conname AS "name", source_attr.attname AS "sourceColumn",
              target_table.relname AS "targetTable", target_attr.attname AS "targetColumn",
              array_length(con.conkey, 1) AS "sourceArity",
              array_length(con.confkey, 1) AS "targetArity",
              con.confdeltype AS "deleteAction", con.confupdtype AS "updateAction"
       FROM pg_constraint con
       JOIN pg_attribute source_attr
         ON source_attr.attrelid = con.conrelid AND source_attr.attnum = con.conkey[1]
       JOIN pg_class target_table ON target_table.oid = con.confrelid
       JOIN pg_attribute target_attr
         ON target_attr.attrelid = con.confrelid AND target_attr.attnum = con.confkey[1]
       WHERE con.conrelid = '"Activity"'::regclass
         AND con.contype = 'f'
         AND con.conname = 'Activity_selectedTemplateVersionId_fkey'`,
    );
    expect(foreignKeys).toEqual([
      {
        name: 'Activity_selectedTemplateVersionId_fkey',
        sourceColumn: 'selectedTemplateVersionId',
        targetTable: 'ActivityTemplate',
        targetColumn: 'id',
        sourceArity: 1,
        targetArity: 1,
        deleteAction: 'r',
        updateAction: 'c',
      },
    ]);

    const indexes = await prisma.$queryRawUnsafe<
      Array<{ name: string; columnName: string; keyCount: number; isUnique: boolean }>
    >(
      `SELECT index_table.relname AS "name", column_attr.attname AS "columnName",
              index_meta.indnkeyatts AS "keyCount", index_meta.indisunique AS "isUnique"
       FROM pg_index index_meta
       JOIN pg_class table_meta ON table_meta.oid = index_meta.indrelid
       JOIN pg_class index_table ON index_table.oid = index_meta.indexrelid
       JOIN pg_attribute column_attr
         ON column_attr.attrelid = index_meta.indrelid AND column_attr.attnum = index_meta.indkey[0]
       WHERE table_meta.oid = '"Activity"'::regclass
         AND index_table.relname = 'Activity_selectedTemplateVersionId_idx'`,
    );
    expect(indexes).toEqual([
      {
        name: 'Activity_selectedTemplateVersionId_idx',
        columnName: 'selectedTemplateVersionId',
        keyCount: 1,
        isUnique: false,
      },
    ]);
  });

  it('legacy Activity 保持 NULL，多个 Activity 可指向同一 future Template Version', async () => {
    const templateVersionId = await createFutureTemplateVersion('shared');
    const legacy = await createActivity('legacy');
    const first = await createActivity('first-selected', templateVersionId);
    const second = await createActivity('second-selected', templateVersionId);

    expect(legacy.selectedTemplateVersionId).toBeNull();
    expect(first.selectedTemplateVersionId).toBe(templateVersionId);
    expect(second.selectedTemplateVersionId).toBe(templateVersionId);
  });

  it('拒绝孤儿指针，并以 FK 拒绝删除仍被 Activity 引用的 future Version', async () => {
    const templateVersionId = await createFutureTemplateVersion('referenced');
    const activity = await createActivity('referenced', templateVersionId);

    await expectRejected(
      `UPDATE "Activity" SET "selectedTemplateVersionId" = ${sqlText('version-does-not-exist')}
       WHERE "id" = ${sqlText(activity.id)}`,
      { sqlState: '23503', constraint: 'Activity_selectedTemplateVersionId_fkey' },
    );
    await expectRejected(
      `DELETE FROM "ActivityTemplate" WHERE "id" = ${sqlText(templateVersionId)}`,
      { sqlState: '23503', constraint: 'Activity_selectedTemplateVersionId_fkey' },
    );

    const persisted = await prisma.activity.findUniqueOrThrow({
      where: { id: activity.id },
      select: { selectedTemplateVersionId: true },
    });
    expect(persisted.selectedTemplateVersionId).toBe(templateVersionId);
  });
});

describe('Activity OS R1 A4 migration replay / non-empty rehearsal', () => {
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
            `SELECT is_nullable || '|' || COALESCE(column_default, '<null>')
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'Activity'
               AND column_name = 'selectedTemplateVersionId'`,
          ),
        ).toBe('YES|<null>');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '在 A3 非空库执行第 103 条 migration 时保留既有 Activity / Template，新增指针为 NULL',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughA3(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(A3_MIGRATION_COUNT);
        runPsql(
          databaseName,
          `INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode")
           VALUES ('a4-preflight-organization',CURRENT_TIMESTAMP,'A4 preflight organization','team');
           INSERT INTO "Activity" ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode")
           VALUES ('a4-preflight-activity',CURRENT_TIMESTAMP,'A4 preflight activity','a4-preflight-type',
             'a4-preflight-organization','2099-09-01T09:00:00.000Z','2099-09-01T17:00:00.000Z',
             'A4 preflight location','draft');
           INSERT INTO "ActivityTemplate" ("id","updatedAt","code","name","activityTypeCode","statusCode","version")
           VALUES ('a4-preflight-template',CURRENT_TIMESTAMP,'a4-preflight-template-code','A4 preflight template',
             'a4-preflight-type','legacy-preflight',1);`,
        );

        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        runPsql(databaseName, migration);

        expect(successfulMigrationCount(databaseName)).toBe(A3_MIGRATION_COUNT);
        expect(
          runPsql(
            databaseName,
            `SELECT "title" || '|' || "activityTypeCode" || '|' || "organizationId" || '|' ||
                    COALESCE("selectedTemplateVersionId", '<null>')
             FROM "Activity" WHERE "id" = 'a4-preflight-activity'`,
          ),
        ).toBe('A4 preflight activity|a4-preflight-type|a4-preflight-organization|<null>');
        expect(
          runPsql(
            databaseName,
            `SELECT "code" || '|' || "name" || '|' || "activityTypeCode" || '|' || "statusCode" || '|' || "version"
             FROM "ActivityTemplate" WHERE "id" = 'a4-preflight-template'`,
          ),
        ).toBe(
          'a4-preflight-template-code|A4 preflight template|a4-preflight-type|legacy-preflight|1',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

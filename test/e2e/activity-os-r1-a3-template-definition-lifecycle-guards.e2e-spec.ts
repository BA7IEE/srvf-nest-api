import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { resetDb } from '../setup/reset-db';
import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

// A3 的两类证明必须彼此独立：第一组在当前 DB 验证持久层合同；第二组真实重放 A2 世代，
// 验证 preflight 不会把非空未知 Family Version 静默纳入新生命周期。
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 91;
const A2_MIGRATION_COUNT = 101;
const CURRENT_MIGRATION_COUNT = 103;
const MIGRATION_NAME = '20260901110000_activity_os_r1_a3_template_definition_lifecycle_guards';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

type TemplateOptions = {
  code?: string;
  name?: string;
  statusCode?: string;
  version?: number;
  familyId?: string | null;
  schemaVersion?: number | null;
  definitionJson?: string | null;
  definitionHash?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function sqlInteger(value: number | null): string {
  return value === null ? 'NULL' : String(value);
}

function sqlJson(value: string | null): string {
  return value === null ? 'NULL' : `${sqlText(value)}::jsonb`;
}

function sqlTimestamp(value: string | null): string {
  return value === null ? 'NULL' : `${sqlText(value)}::timestamp`;
}

function hashFor(definition: Record<string, unknown>, schemaVersion = 1): string {
  return computeActivityTemplateDefinitionHash({ schemaVersion, definition });
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for A3 migration E2E');
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
    {
      input: `\\set VERBOSITY verbose\n${sql}`,
      encoding: 'utf8',
    },
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

function deployMigrationsThroughA2(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const a3Index = migrationNames.indexOf(MIGRATION_NAME);
  if (a3Index !== A2_MIGRATION_COUNT) {
    throw new Error(
      `expected ${MIGRATION_NAME} at migration index ${A2_MIGRATION_COUNT}; got ${a3Index}`,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-activity-template-a2-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, a3Index)) {
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

function currentA3ArtifactNames(databaseName: string): string[] {
  return JSON.parse(
    runPsql(
      databaseName,
      `SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json)::text
       FROM (
         SELECT conname AS name
         FROM pg_constraint
         WHERE conrelid = '"ActivityTemplate"'::regclass
           AND conname LIKE 'activity_template_family_version_%'
         UNION ALL
         SELECT tgname AS name
         FROM pg_trigger
         WHERE tgrelid = '"ActivityTemplate"'::regclass
           AND NOT tgisinternal
           AND tgname = 'trg_activity_template_10_family_version_freeze'
       ) AS artifacts`,
    ),
  ) as string[];
}

describe('Activity OS R1 A3 TemplateDefinition / lifecycle DB guards', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;

  const fixtureTimestamp = "'2099-09-01T09:00:00.000Z'::timestamp";
  const uniq = (label: string) => `activity-os-r1-a3-${label}-${(seq += 1)}`;

  const familySql = (id: string) =>
    [
      'INSERT INTO "ActivityTemplateFamily"',
      '("id","updatedAt","code","name","categoryCode","scopeTypeCode","statusCode")',
      `VALUES (${sqlText(id)}, ${fixtureTimestamp}, ${sqlText(`family-${id}`)}, `,
      `${sqlText(`Family ${id}`)}, 'volunteer', 'organization', 'family-unconstrained')`,
    ].join(' ');

  const templateSql = (id: string, options: TemplateOptions = {}) => {
    const value = {
      code: `template-${id}`,
      name: `Template ${id}`,
      statusCode: 'legacy-status',
      version: 1,
      familyId: null as string | null,
      schemaVersion: null as number | null,
      definitionJson: null as string | null,
      definitionHash: null as string | null,
      effectiveFrom: null as string | null,
      effectiveTo: null as string | null,
      ...options,
    };
    return [
      'INSERT INTO "ActivityTemplate"',
      '("id","updatedAt","code","name","activityTypeCode","statusCode","version","familyId",',
      '"schemaVersion","definitionJson","definitionHash","effectiveFrom","effectiveTo")',
      'VALUES (' +
        sqlText(id) +
        ', ' +
        fixtureTimestamp +
        ', ' +
        sqlText(value.code) +
        ', ' +
        sqlText(value.name) +
        ", 'legacy-activity-type', " +
        sqlText(value.statusCode) +
        ', ' +
        value.version +
        ', ' +
        sqlText(value.familyId) +
        ', ' +
        sqlInteger(value.schemaVersion) +
        ', ' +
        sqlJson(value.definitionJson) +
        ', ' +
        sqlText(value.definitionHash) +
        ', ' +
        sqlTimestamp(value.effectiveFrom) +
        ', ' +
        sqlTimestamp(value.effectiveTo) +
        ')',
    ].join(' ');
  };

  const validDraft = (familyId: string, overrides: TemplateOptions = {}): TemplateOptions => {
    const schemaVersion = overrides.schemaVersion === undefined ? 1 : overrides.schemaVersion;
    const definition =
      overrides.definitionJson === undefined
        ? JSON.stringify({ template: familyId, v: 1 })
        : overrides.definitionJson;
    const parsedDefinition = definition === null ? null : (JSON.parse(definition) as unknown);
    const validSchemaVersion =
      typeof schemaVersion === 'number' && Number.isSafeInteger(schemaVersion) && schemaVersion > 0
        ? schemaVersion
        : null;
    const generatedHash =
      validSchemaVersion !== null &&
      parsedDefinition !== null &&
      typeof parsedDefinition === 'object' &&
      !Array.isArray(parsedDefinition)
        ? hashFor(parsedDefinition as Record<string, unknown>, validSchemaVersion)
        : 'a'.repeat(64);
    return {
      familyId,
      statusCode: 'draft',
      schemaVersion,
      definitionJson: definition,
      definitionHash: generatedHash,
      ...overrides,
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivityTemplate", "ActivityTemplateFamily" RESTART IDENTITY CASCADE',
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
        const matched = /constraint "([^"]+)"/.exec(message);
        const triggerConstraint = /(activity_template_family_version_[a-z_]+)/.exec(message);
        return {
          sqlState: meta?.code ?? '',
          constraint: matched?.[1] ?? triggerConstraint?.[1] ?? '',
          message,
        };
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

  it('不改变 legacy Template 的 status、空元数据和可写删除语义', async () => {
    const legacyId = uniq('legacy');
    await expectAccepted(templateSql(legacyId, { statusCode: 'legacy-unclassified' }));
    await expectAccepted(
      `UPDATE "ActivityTemplate" SET "name" = 'legacy still editable', "statusCode" = 'active'
       WHERE "id" = ${sqlText(legacyId)}`,
    );
    await expectAccepted(`DELETE FROM "ActivityTemplate" WHERE "id" = ${sqlText(legacyId)}`);
  });

  it('future Family Version 必须从完整 draft 定义开始，并由 DB 拒绝坏形状', async () => {
    const familyId = uniq('shape-family');
    await expectAccepted(familySql(familyId));

    await expectAccepted(templateSql(uniq('valid-draft'), validDraft(familyId)));
    for (const [label, options, constraint] of [
      [
        'missing-schema',
        validDraft(familyId, { schemaVersion: null }),
        'activity_template_family_version_required_fields',
      ],
      [
        'zero-version',
        validDraft(familyId, { version: 0 }),
        'activity_template_family_version_required_fields',
      ],
      [
        'zero-schema',
        validDraft(familyId, { schemaVersion: 0 }),
        'activity_template_family_version_required_fields',
      ],
      [
        'missing-definition',
        validDraft(familyId, { definitionJson: null }),
        'activity_template_family_version_required_fields',
      ],
      [
        'array-definition',
        validDraft(familyId, { definitionJson: '[]' }),
        'activity_template_family_version_required_fields',
      ],
      [
        'uppercase-hash',
        validDraft(familyId, { definitionHash: 'A'.repeat(64) }),
        'activity_template_family_version_required_fields',
      ],
      [
        'missing-hash',
        validDraft(familyId, { definitionHash: null }),
        'activity_template_family_version_required_fields',
      ],
      [
        'end-without-start',
        validDraft(familyId, { effectiveTo: '2099-10-01T00:00:00.000Z' }),
        'activity_template_family_version_effective_period',
      ],
      [
        'end-not-after-start',
        validDraft(familyId, {
          effectiveFrom: '2099-10-01T00:00:00.000Z',
          effectiveTo: '2099-10-01T00:00:00.000Z',
        }),
        'activity_template_family_version_effective_period',
      ],
    ] as Array<[string, TemplateOptions, string]>) {
      await expectRejected(templateSql(uniq(label), options), { sqlState: '23514', constraint });
    }

    await expectRejected(
      templateSql(
        uniq('direct-active'),
        validDraft(familyId, { statusCode: 'active', effectiveFrom: '2099-10-01T00:00:00.000Z' }),
      ),
      { sqlState: '55000', constraint: 'activity_template_family_version_lifecycle' },
    );
    const activationNeedsStartId = uniq('activation-needs-start');
    await expectAccepted(templateSql(activationNeedsStartId, validDraft(familyId, { version: 2 })));
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "statusCode" = 'active'
       WHERE "id" = ${sqlText(activationNeedsStartId)}`,
      { sqlState: '23514', constraint: 'activity_template_family_version_effective_period' },
    );
  });

  it('draft 可编辑、只能激活；active 只允许退役，retired 永久冻结', async () => {
    const familyId = uniq('lifecycle-family');
    const templateId = uniq('lifecycle-template');
    await expectAccepted(familySql(familyId));
    await expectAccepted(
      templateSql(templateId, validDraft(familyId, { effectiveFrom: '2099-10-01T00:00:00.000Z' })),
    );

    const editedDefinition = JSON.stringify({ template: familyId, v: 2, positions: ['lead'] });
    await expectAccepted(
      `UPDATE "ActivityTemplate"
       SET "name" = 'Draft can change',
           "definitionJson" = ${sqlJson(editedDefinition)},
           "definitionHash" = ${sqlText(hashFor(JSON.parse(editedDefinition) as Record<string, unknown>))},
           "defaultArchiveWaitingDays" = 3
       WHERE "id" = ${sqlText(templateId)}`,
    );
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "statusCode" = 'retired' WHERE "id" = ${sqlText(templateId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_lifecycle' },
    );
    await expectAccepted(
      `UPDATE "ActivityTemplate" SET "statusCode" = 'active' WHERE "id" = ${sqlText(templateId)}`,
    );

    await expectRejected(
      `UPDATE "ActivityTemplate" SET "definitionHash" = ${sqlText('b'.repeat(64))}
       WHERE "id" = ${sqlText(templateId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_frozen' },
    );
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "defaultArchiveWaitingDays" = 4
       WHERE "id" = ${sqlText(templateId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_frozen' },
    );
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "statusCode" = 'active' WHERE "id" = ${sqlText(templateId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_frozen' },
    );
    await expectAccepted(
      `UPDATE "ActivityTemplate" SET "statusCode" = 'retired' WHERE "id" = ${sqlText(templateId)}`,
    );
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "name" = 'must stay frozen' WHERE "id" = ${sqlText(templateId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_frozen' },
    );
    await expectRejected(`DELETE FROM "ActivityTemplate" WHERE "id" = ${sqlText(templateId)}`, {
      sqlState: '55000',
      constraint: 'activity_template_family_version_frozen',
    });

    const disposableDraft = uniq('disposable-draft');
    await expectAccepted(templateSql(disposableDraft, validDraft(familyId, { version: 2 })));
    await expectAccepted(`DELETE FROM "ActivityTemplate" WHERE "id" = ${sqlText(disposableDraft)}`);
  });

  it('legacy 行与 Family Version 的身份边界不能用 UPDATE 偷换', async () => {
    const familyId = uniq('boundary-family');
    const legacyId = uniq('boundary-legacy');
    const draftId = uniq('boundary-draft');
    await expectAccepted(familySql(familyId));
    await expectAccepted(templateSql(legacyId));
    await expectRejected(
      `UPDATE "ActivityTemplate"
       SET "familyId" = ${sqlText(familyId)}, "statusCode" = 'draft', "schemaVersion" = 1,
           "definitionJson" = '{"template":"converted"}'::jsonb,
           "definitionHash" = ${sqlText(hashFor({ template: 'converted' }))}
       WHERE "id" = ${sqlText(legacyId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_legacy_boundary' },
    );
    await expectAccepted(templateSql(draftId, validDraft(familyId)));
    await expectRejected(
      `UPDATE "ActivityTemplate" SET "familyId" = NULL WHERE "id" = ${sqlText(draftId)}`,
      { sqlState: '55000', constraint: 'activity_template_family_version_legacy_boundary' },
    );
  });
});

describe('Activity OS R1 A3 migration replay / non-empty preflight', () => {
  it(
    `replays all current ${CURRENT_MIGRATION_COUNT} migrations from an empty database and installs A3 artifacts`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(currentA3ArtifactNames(databaseName)).toEqual([
          'activity_template_family_version_effective_period',
          'activity_template_family_version_required_fields',
          'trg_activity_template_10_family_version_freeze',
        ]);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '在 A2 世代已存在 Family Version 时 fail-closed，且不留下部分 DDL 或改写原行',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughA2(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(A2_MIGRATION_COUNT);
        runPsql(
          databaseName,
          `INSERT INTO "ActivityTemplateFamily"
           ("id","updatedAt","code","name","categoryCode","scopeTypeCode","statusCode")
           VALUES ('a3-preflight-family',CURRENT_TIMESTAMP,'a3-preflight-family-code','A3 preflight family',
             'volunteer','organization','manual-before-a3')`,
        );
        runPsql(
          databaseName,
          `INSERT INTO "ActivityTemplate"
           ("id","updatedAt","code","name","activityTypeCode","statusCode","version","familyId")
           VALUES ('a3-preflight-version',CURRENT_TIMESTAMP,'a3-preflight-code','A3 preflight version',
             'legacy-activity-type','manual-before-a3',1,'a3-preflight-family')`,
        );
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        const failure = runPsqlFailure(databaseName, migration);

        expect(failure).toContain('55000');
        expect(failure).toContain('activity_template_family_version_preflight');
        expect(successfulMigrationCount(databaseName)).toBe(A2_MIGRATION_COUNT);
        expect(currentA3ArtifactNames(databaseName)).toEqual([]);
        expect(
          runPsql(
            databaseName,
            `SELECT "statusCode" || '|' || COALESCE("definitionHash", '<null>')
             FROM "ActivityTemplate" WHERE "id" = 'a3-preflight-version'`,
          ),
        ).toBe('manual-before-a3|<null>');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

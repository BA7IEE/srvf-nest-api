import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import type { CreateActivityFromTemplateCommand } from '../../src/modules/activities/activity-from-template.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import {
  ActivitySeriesService,
  type CreateActivitySeriesCommand,
  type GenerateActivitySeriesInstancesCommand,
} from '../../src/modules/activities/activity-series.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 95;
const PREVIOUS_MIGRATION_COUNT = 107;
const CURRENT_MIGRATION_COUNT = 111;
const MIGRATION_NAME = '20260904090000_activity_os_r2_b3_form_blueprint_governance';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const GOVERNANCE_CONSTRAINT = 'registration_form_field_governance_shape_check';
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;
const META: AuditMeta = { requestId: 'activity-os-r2-b3-e2e', ip: '127.0.0.1', ua: 'jest' };

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

type RawGovernance = {
  purposeCode?: string | null;
  dataClassCode?: string | null;
  retentionPolicyCode?: string | null;
  maskingPolicyCode?: string | null;
  prefillSourceCode?: string | null;
};

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for B3 migration E2E');
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

function governanceColumnCountSql(): string {
  return (
    "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' " +
    "AND table_name = 'RegistrationFormField' AND column_name = ANY (ARRAY[" +
    [
      'purposeCode',
      'dataClassCode',
      'retentionPolicyCode',
      'maskingPolicyCode',
      'prefillSourceCode',
    ]
      .map((name) => sqlText(name))
      .join(',') +
    ']::text[])'
  );
}

function governanceConstraintCountSql(): string {
  return `SELECT COUNT(*) FROM pg_constraint WHERE conname = ${sqlText(GOVERNANCE_CONSTRAINT)}`;
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
      `expected ${MIGRATION_NAME} at migration index ${PREVIOUS_MIGRATION_COUNT}; got ${currentIndex}`,
    );
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-b3-pre108-prisma-'));
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

function memberIdentityColumns(databaseName: string): {
  columns: string;
  values: (name: string) => string;
} {
  const hasRealName =
    runPsql(
      databaseName,
      "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Member' AND column_name = 'realName'",
    ) === '1';
  return hasRealName
    ? {
        columns: '"realName","memberSinceDate","memberOriginCode"',
        values: (name) => `${sqlText(name)},DATE '2020-01-01','manual'`,
      }
    : { columns: '"displayName"', values: (name) => sqlText(name) };
}

/** A pre-108 legacy Form / Field / Answer fixture, deliberately without the five future columns. */
function insertLegacyFormFixture(databaseName: string, suffix: string): void {
  const memberIdentity = memberIdentityColumns(databaseName);
  const organizationId = `b3-legacy-org-${suffix}`;
  const activityId = `b3-legacy-activity-${suffix}`;
  const memberId = `b3-legacy-member-${suffix}`;
  const formId = `b3-legacy-form-${suffix}`;
  const fieldId = `b3-legacy-field-${suffix}`;
  const registrationId = `b3-legacy-registration-${suffix}`;
  const revisionId = `b3-legacy-revision-${suffix}`;
  runPsql(
    databaseName,
    `INSERT INTO "Organization" ("id","updatedAt","name","nodeTypeCode") VALUES
       (${sqlText(organizationId)},CURRENT_TIMESTAMP,'B3 legacy organization','team');
     INSERT INTO "Activity"
       ("id","updatedAt","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode") VALUES
       (${sqlText(activityId)},CURRENT_TIMESTAMP,'B3 legacy activity','b3-legacy',${sqlText(organizationId)},
        TIMESTAMP '2099-09-01 09:00:00',TIMESTAMP '2099-09-01 17:00:00','B3 legacy location','draft');
     INSERT INTO "Member" ("id","memberNo",${memberIdentity.columns},"updatedAt") VALUES
       (${sqlText(memberId)},'B3-LEGACY-${suffix}',${memberIdentity.values('B3 legacy member')},CURRENT_TIMESTAMP);
     INSERT INTO "RegistrationFormVersion"
       ("id","updatedAt","activityId","version","statusCode","workflowRevision","schemaHash") VALUES
       (${sqlText(formId)},CURRENT_TIMESTAMP,${sqlText(activityId)},1,'draft',0,NULL);
     INSERT INTO "RegistrationFormField"
       ("id","updatedAt","formVersionId","fieldCode","label","typeCode","visibilityCode","exportable","sortOrder") VALUES
       (${sqlText(fieldId)},CURRENT_TIMESTAMP,${sqlText(formId)},'legacy_note','Legacy note','short_text','self_only',FALSE,0);
     INSERT INTO "ActivityRegistration"
       ("id","updatedAt","activityId","memberId","statusCode") VALUES
       (${sqlText(registrationId)},CURRENT_TIMESTAMP,${sqlText(activityId)},${sqlText(memberId)},'pending');
     INSERT INTO "ActivityRegistrationRevision"
       ("id","registrationId","revision","formVersionId","sourceCode","submittedAt") VALUES
       (${sqlText(revisionId)},${sqlText(registrationId)},1,${sqlText(formId)},'self',TIMESTAMP '2099-09-01 09:01:00');
     INSERT INTO "RegistrationFormAnswer"
       ("id","registrationRevisionId","fieldId","valueText") VALUES
       ('b3-legacy-answer-${suffix}',${sqlText(revisionId)},${sqlText(fieldId)},'legacy answer');`,
  );
}

function templateDefinitionBase(): Record<string, unknown> {
  return {
    activity: {
      allocationModeCode: 'first_come',
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: null,
      archiveWaitingDays: 7,
    },
    sessions: [],
  };
}

function governedField(dataClassCode: 'ordinary' | 'sensitive' = 'ordinary') {
  return {
    fieldCode: 'travel_note',
    typeCode: 'short_text',
    label: '出行说明',
    required: false,
    visibilityCode: 'self_only',
    exportable: false,
    sortOrder: 0,
    governance: {
      purposeCode: 'transport_logistics',
      dataClassCode,
      retentionPolicyCode: 'activity_lifecycle',
      maskingPolicyCode: 'none',
      prefillSourceCode: null,
    },
  };
}

function templateDefinitionV2(
  registrationForm: Record<string, unknown> | null = { fields: [governedField()] },
): Record<string, unknown> {
  return { ...templateDefinitionBase(), registrationForm };
}

describe('Activity OS R2 B3 form blueprint governance schema', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let activityId: string;
  let formVersionId: string;
  let sequence = 0;

  const unique = (label: string) => `activity-os-r2-b3-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityId = (
      await prisma.activity.create({
        data: {
          title: unique('activity'),
          activityTypeCode: 'b3-form-blueprint',
          organizationId: organization.id,
          startAt: new Date('2099-09-01T09:00:00.000Z'),
          endAt: new Date('2099-09-01T17:00:00.000Z'),
          location: 'B3 schema fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
    formVersionId = (
      await prisma.registrationFormVersion.create({
        data: { activityId, version: 1, statusCode: 'draft', workflowRevision: 0 },
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

  async function expectRejected(sql: string): Promise<void> {
    const error = await run(sql);
    expect(error).not.toBeNull();
    expect(error!.sqlState).toBe('23514');
    expect(error!.constraint).toBe(GOVERNANCE_CONSTRAINT);
  }

  function rawFieldSql(id: string, governance: RawGovernance = {}): string {
    const value = {
      purposeCode: null as string | null,
      dataClassCode: null as string | null,
      retentionPolicyCode: null as string | null,
      maskingPolicyCode: null as string | null,
      prefillSourceCode: null as string | null,
      ...governance,
    };
    return (
      'INSERT INTO "RegistrationFormField" ' +
      '("id","updatedAt","formVersionId","fieldCode","label","typeCode","visibilityCode",' +
      '"purposeCode","dataClassCode","retentionPolicyCode","maskingPolicyCode","prefillSourceCode") VALUES (' +
      [
        sqlText(id),
        'CURRENT_TIMESTAMP',
        sqlText(formVersionId),
        sqlText(`field-${id}`),
        sqlText('B3 governance field'),
        "'short_text'",
        "'self_only'",
        sqlText(value.purposeCode),
        sqlText(value.dataClassCode),
        sqlText(value.retentionPolicyCode),
        sqlText(value.maskingPolicyCode),
        sqlText(value.prefillSourceCode),
      ].join(',') +
      ')'
    );
  }

  it('精确落下五个 nullable 列和一个二值 all-or-none CHECK，migration 不夹带 DML', async () => {
    const columns = await prisma.$queryRawUnsafe<Array<{ name: string; nullable: string }>>(
      "SELECT column_name AS name, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'RegistrationFormField' AND column_name = ANY (ARRAY['purposeCode','dataClassCode','retentionPolicyCode','maskingPolicyCode','prefillSourceCode']) ORDER BY ordinal_position",
    );
    expect(columns).toEqual([
      { name: 'purposeCode', nullable: 'YES' },
      { name: 'dataClassCode', nullable: 'YES' },
      { name: 'retentionPolicyCode', nullable: 'YES' },
      { name: 'maskingPolicyCode', nullable: 'YES' },
      { name: 'prefillSourceCode', nullable: 'YES' },
    ]);
    const constraints = await prisma.$queryRawUnsafe<
      Array<{ name: string; validated: boolean; definition: string }>
    >(
      `SELECT conname AS name, convalidated AS validated, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ${sqlText(GOVERNANCE_CONSTRAINT)}`,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ name: GOVERNANCE_CONSTRAINT, validated: true });
    expect(constraints[0]?.definition).toContain('"prefillSourceCode" IS NULL');

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect(migration).toMatch(/^BEGIN;/mu);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(
      new Set([...migration.matchAll(/ALTER TABLE "([^"]+)"/gu)].map((match) => match[1])),
    ).toEqual(new Set(['RegistrationFormField']));
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE TRIGGER|DROP TRIGGER)\b/u);
    expect(migration).not.toContain('DEFAULT');
  });

  it('只接受 legacy 全 NULL 或 governed 四项非空 + NULL prefill，并逐一拒绝部分治理形状', async () => {
    await expectAccepted(rawFieldSql(unique('legacy')));
    await expectAccepted(
      rawFieldSql(unique('governed'), {
        purposeCode: 'transport_logistics',
        dataClassCode: 'ordinary',
        retentionPolicyCode: 'activity_lifecycle',
        maskingPolicyCode: 'none',
        prefillSourceCode: null,
      }),
    );
    await expectRejected(
      rawFieldSql(unique('purpose-only'), { purposeCode: 'transport_logistics' }),
    );
    await expectRejected(
      rawFieldSql(unique('missing-mask'), {
        purposeCode: 'transport_logistics',
        dataClassCode: 'ordinary',
        retentionPolicyCode: 'activity_lifecycle',
      }),
    );
    await expectRejected(
      rawFieldSql(unique('prefill'), {
        purposeCode: 'transport_logistics',
        dataClassCode: 'ordinary',
        retentionPolicyCode: 'activity_lifecycle',
        maskingPolicyCode: 'none',
        prefillSourceCode: 'member_profile',
      }),
    );
  });
});

describe('Activity OS R2 B3 migration replay / non-empty rehearsal', () => {
  it(
    '从空库完整重放 108 条 migration，并得到五列与具名治理约束',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, governanceColumnCountSql()))).toBe(5);
        expect(Number(runPsql(databaseName, governanceConstraintCountSql()))).toBe(1);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '107→108 对非空 legacy Form / Field / Answer 直接升级；旧行保持全 NULL、答案不受触碰',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughPrevious(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        insertLegacyFormFixture(databaseName, 'upgrade');
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        runPsql(databaseName, migration);

        // 手工执行只验证 DDL 事务性；不伪造 Prisma migration receipt。
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, governanceColumnCountSql()))).toBe(5);
        expect(Number(runPsql(databaseName, governanceConstraintCountSql()))).toBe(1);
        expect(
          runPsql(
            databaseName,
            "SELECT coalesce(\"purposeCode\",'NULL') || '|' || coalesce(\"dataClassCode\",'NULL') || '|' || coalesce(\"retentionPolicyCode\",'NULL') || '|' || coalesce(\"maskingPolicyCode\",'NULL') || '|' || coalesce(\"prefillSourceCode\",'NULL') FROM \"RegistrationFormField\" WHERE \"id\" = 'b3-legacy-field-upgrade'",
          ),
        ).toBe('NULL|NULL|NULL|NULL|NULL');
        expect(
          runPsql(
            databaseName,
            'SELECT (SELECT COUNT(*) FROM "RegistrationFormVersion") || \'|\' || (SELECT COUNT(*) FROM "RegistrationFormField") || \'|\' || (SELECT COUNT(*) FROM "ActivityRegistrationRevision") || \'|\' || (SELECT COUNT(*) FROM "RegistrationFormAnswer")',
          ),
        ).toBe('1|1|1|1');
        expect(
          runPsql(
            databaseName,
            'SELECT "valueText" FROM "RegistrationFormAnswer" WHERE "id" = \'b3-legacy-answer-upgrade\'',
          ),
        ).toBe('legacy answer');

        for (const sql of [
          `INSERT INTO "RegistrationFormField" ("id","updatedAt","formVersionId","fieldCode","label","typeCode","visibilityCode","purposeCode") VALUES ('b3-partial-field',CURRENT_TIMESTAMP,'b3-legacy-form-upgrade','partial','partial','short_text','self_only','transport_logistics')`,
          `INSERT INTO "RegistrationFormField" ("id","updatedAt","formVersionId","fieldCode","label","typeCode","visibilityCode","purposeCode","dataClassCode","retentionPolicyCode","maskingPolicyCode","prefillSourceCode") VALUES ('b3-prefill-field',CURRENT_TIMESTAMP,'b3-legacy-form-upgrade','prefill','prefill','short_text','self_only','transport_logistics','ordinary','activity_lifecycle','none','member_profile')`,
        ]) {
          const failure = runPsqlFailure(databaseName, sql);
          expect(failure).toContain('23514');
          expect(failure).toContain(GOVERNANCE_CONSTRAINT);
        }
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(runPsql(databaseName, 'SELECT COUNT(*) FROM "RegistrationFormField"')).toBe('1');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    '第 108 条中途遇到同名约束冲突时整笔回滚：107 receipt、零新增列、旧数据均不部分前进',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployMigrationsThroughPrevious(databaseName);
        insertLegacyFormFixture(databaseName, 'rollback');
        runPsql(
          databaseName,
          `ALTER TABLE "RegistrationFormField" ADD CONSTRAINT "${GOVERNANCE_CONSTRAINT}" CHECK (TRUE)`,
        );
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        const failure = runPsqlFailure(databaseName, migration);
        expect(failure).toMatch(/42710|already exists|duplicate object/u);
        expect(successfulMigrationCount(databaseName)).toBe(PREVIOUS_MIGRATION_COUNT);
        expect(Number(runPsql(databaseName, governanceColumnCountSql()))).toBe(0);
        expect(Number(runPsql(databaseName, governanceConstraintCountSql()))).toBe(1);
        expect(runPsql(databaseName, 'SELECT COUNT(*) FROM "RegistrationFormAnswer"')).toBe('1');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});

describe('Activity OS R2 B3 template Form materialization', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let activities: ActivitiesService;
  let series: ActivitySeriesService;
  let currentUser: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const unique = (label: string) => `activity-os-r2-b3-template-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    activities = app.get(ActivitiesService);
    series = app.get(ActivitySeriesService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivityTemplate", "ActivityTemplateFamily" RESTART IDENTITY CASCADE',
    );
    const admin = await prisma.user.create({
      data: {
        username: unique('admin'),
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizAdmin.bizAdminRoleId);
    currentUser = {
      id: admin.id,
      username: admin.username,
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const nodeType = await prisma.dictType.create({
      data: { code: unique('node-type'), label: '组织节点类型' },
      select: { id: true },
    });
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const rootCode = unique('root-node');
    const childCode = unique('child-node');
    await prisma.dictItem.createMany({
      data: [
        { typeId: nodeType.id, code: rootCode, label: '根' },
        { typeId: nodeType.id, code: childCode, label: '子' },
        { typeId: activityType.id, code: 'b3-template-training', label: '模板训练' },
      ],
    });
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: rootCode },
      select: { id: true },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: unique('child'), nodeTypeCode: childCode, parentId: root.id },
        select: { id: true },
      })
    ).id;
  });

  async function createTemplate(options: {
    definitionJson: Record<string, unknown>;
    schemaVersion: 1 | 2;
    status?: 'draft' | 'active' | 'retired';
  }): Promise<{ id: string; definitionHash: string }> {
    const family = await prisma.activityTemplateFamily.create({
      data: {
        code: unique('family-code'),
        name: unique('family-name'),
        categoryCode: 'training',
        scopeTypeCode: 'organization',
        statusCode: 'inventory',
      },
      select: { id: true },
    });
    const definitionHash = computeActivityTemplateDefinitionHash({
      schemaVersion: options.schemaVersion,
      definition: options.definitionJson,
    });
    const template = await prisma.activityTemplate.create({
      data: {
        code: unique('template-code'),
        name: unique('template-name'),
        activityTypeCode: 'b3-template-training',
        statusCode: 'draft',
        version: 1,
        familyId: family.id,
        schemaVersion: options.schemaVersion,
        definitionJson: options.definitionJson as Prisma.InputJsonValue,
        definitionHash,
        effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    if (options.status === 'active' || options.status === 'retired') {
      await prisma.activityTemplate.update({
        where: { id: template.id },
        data: { statusCode: 'active' },
      });
    }
    if (options.status === 'retired') {
      await prisma.activityTemplate.update({
        where: { id: template.id },
        data: { statusCode: 'retired' },
      });
    }
    return { id: template.id, definitionHash };
  }

  function createCommand(
    templateVersionId: string,
    operationKey = unique('create-operation'),
  ): CreateActivityFromTemplateCommand {
    return {
      templateVersionId,
      title: 'B3 模板活动',
      organizationId,
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T12:00:00.000Z',
      location: 'B3 模板集合点',
      registrationDeadline: '2099-09-01T07:30:00.000Z',
      operationKey,
    };
  }

  function createSeriesCommand(templateVersionId: string): CreateActivitySeriesCommand {
    return {
      code: unique('series-code'),
      templateVersionId,
      frequencyCode: 'daily',
      interval: 1,
      timeZone: 'Asia/Shanghai',
      localStartDate: '2099-09-01',
      localStartMinute: 9 * 60,
      durationMinutes: 120,
      title: 'B3 周期活动',
      organizationId,
      location: 'B3 周期集合点',
      registrationDeadlineOffsetMinutes: 60,
      effectiveFromLocalDate: '2099-09-01',
      effectiveToLocalDate: '2099-09-03',
      generationWindowDays: 7,
      operationKey: unique('series-create'),
    };
  }

  it('V2 复制独立 governed draft Form v1；重放不重复；V1 与 V2 null 都不建 Form', async () => {
    const governedTemplate = await createTemplate({
      schemaVersion: 2,
      definitionJson: templateDefinitionV2(),
      status: 'active',
    });
    const command = createCommand(governedTemplate.id);
    const first = await activities.createFromTemplate(command, currentUser, META);
    const replay = await activities.createFromTemplate(command, currentUser, META);
    expect(replay.id).toBe(first.id);

    const forms = await prisma.registrationFormVersion.findMany({
      where: { activityId: first.id },
      select: {
        activityId: true,
        version: true,
        statusCode: true,
        workflowRevision: true,
        schemaHash: true,
        fields: {
          select: {
            purposeCode: true,
            dataClassCode: true,
            retentionPolicyCode: true,
            maskingPolicyCode: true,
            prefillSourceCode: true,
          },
        },
      },
    });
    expect(forms).toEqual([
      {
        activityId: first.id,
        version: 1,
        statusCode: 'draft',
        workflowRevision: 0,
        schemaHash: null,
        fields: [
          {
            purposeCode: 'transport_logistics',
            dataClassCode: 'ordinary',
            retentionPolicyCode: 'activity_lifecycle',
            maskingPolicyCode: 'none',
            prefillSourceCode: null,
          },
        ],
      },
    ]);
    const createAudit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceType: 'activity', resourceId: first.id, event: 'activity.publish' },
      select: { context: true },
    });
    expect(JSON.stringify(createAudit.context)).not.toMatch(
      /purposeCode|dataClassCode|retentionPolicyCode|maskingPolicyCode|prefillSourceCode|travel_note/i,
    );

    const nullTemplate = await createTemplate({
      schemaVersion: 2,
      definitionJson: templateDefinitionV2(null),
      status: 'active',
    });
    const nullActivity = await activities.createFromTemplate(
      createCommand(nullTemplate.id),
      currentUser,
      META,
    );
    const v1Template = await createTemplate({
      schemaVersion: 1,
      definitionJson: templateDefinitionBase(),
      status: 'active',
    });
    const v1Activity = await activities.createFromTemplate(
      createCommand(v1Template.id),
      currentUser,
      META,
    );
    expect(
      await prisma.registrationFormVersion.count({
        where: { activityId: { in: [nullActivity.id, v1Activity.id] } },
      }),
    ).toBe(0);
  });

  it('sensitive V2 grammar can be hashed but cannot materialize, so Activity / Form / audit 都整根回滚', async () => {
    const sensitiveTemplate = await createTemplate({
      schemaVersion: 2,
      definitionJson: templateDefinitionV2({ fields: [governedField('sensitive')] }),
      status: 'active',
    });
    const before = await Promise.all([
      prisma.activity.count(),
      prisma.registrationFormVersion.count(),
      prisma.auditLog.count(),
    ]);

    await expect(
      activities.createFromTemplate(createCommand(sensitiveTemplate.id), currentUser, META),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });

    await expect(
      Promise.all([
        prisma.activity.count(),
        prisma.registrationFormVersion.count(),
        prisma.auditLog.count(),
      ]),
    ).resolves.toEqual(before);
  });

  it('A7 沿同一 V2 materializer 为每一期各建独立 Form v1，且没有 Answer / UploadSession', async () => {
    const template = await createTemplate({
      schemaVersion: 2,
      definitionJson: templateDefinitionV2(),
      status: 'active',
    });
    const createdSeries = await series.create(createSeriesCommand(template.id), currentUser, META);
    const generate: GenerateActivitySeriesInstancesCommand = {
      seriesId: createdSeries.seriesId,
      revision: 1,
      fromLocalDate: '2099-09-01',
      count: 2,
      operationKey: unique('series-generate'),
    };
    const generated = await series.generate(generate, currentUser, META);
    expect(generated.activityIds).toHaveLength(2);

    const forms = await prisma.registrationFormVersion.findMany({
      where: { activityId: { in: [...generated.activityIds] } },
      select: {
        activityId: true,
        version: true,
        statusCode: true,
        schemaHash: true,
        fields: {
          select: {
            purposeCode: true,
            dataClassCode: true,
            retentionPolicyCode: true,
            maskingPolicyCode: true,
            prefillSourceCode: true,
          },
        },
      },
      orderBy: { activityId: 'asc' },
    });
    expect(forms).toHaveLength(2);
    expect(new Set(forms.map((form) => form.activityId)).size).toBe(2);
    for (const form of forms) {
      expect(form).toMatchObject({ version: 1, statusCode: 'draft', schemaHash: null });
      expect(form.fields).toEqual([
        {
          purposeCode: 'transport_logistics',
          dataClassCode: 'ordinary',
          retentionPolicyCode: 'activity_lifecycle',
          maskingPolicyCode: 'none',
          prefillSourceCode: null,
        },
      ]);
    }
    expect(await prisma.registrationFormAnswer.count()).toBe(0);
    expect(await prisma.registrationUploadSession.count()).toBe(0);
  });
});

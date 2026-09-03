import type { INestApplication } from '@nestjs/common';
import { PrismaClient, Role, UserStatus } from '@prisma/client';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 82;
// 仓库当前 migration 总数。每加一刀就要 +1。
//
// ⚠️ 与本文件里的 **81** 是两件事:81 是「第 82 刀之前」的历史世代基线(冷库重放起点),
// 出现在 `!== 81` ×2 与 `toBe(81)` ×2,**随仓库增长永不变**。见 81 就改 = 把基线改坏。
//
// 命名刻意与 `activity-v11-batch4-*-migration.e2e-spec.ts` 那 5 支一致:此前本支用的是
// 裸 `toBe(90)`,于是「按 CURRENT_MIGRATION_COUNT 搜」找不到它 —— 加 migration 的人
// 修完那 5 支、推上去被本支再咬一轮。已连续发生两次(#1048 / #1055),故统一。
const CURRENT_MIGRATION_COUNT = 107;
const MIGRATION_NAME =
  '20260809180000_activity_v11_batch4_registration_revision_insurance_evidence';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;

interface LegacyFixture {
  evidenceId: string;
  registrationId: string;
  memberInsuranceId: string;
  reviewerId: string;
}

function sqlValue(value: string | Date): string {
  const text = value instanceof Date ? value.toISOString() : value;
  return `'${text.replaceAll("'", "''")}'`;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for migration E2E');
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
  // 复用统一护栏先核本机 Docker/Postgres 与精确派生库名，再创建真正空库。
  dropWorkerDatabase(SCRATCH_WORKER_ID);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'createdb', '-U', 'postgres', databaseName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return databaseName;
}

function deployMigrationsThrough81(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migration82Index = migrationNames.indexOf(MIGRATION_NAME);
  if (migration82Index !== 81) {
    throw new Error(`expected ${MIGRATION_NAME} at migration index 81; got ${migration82Index}`);
  }
  const priorMigrationNames = migrationNames.slice(0, migration82Index);

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-migration81-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of priorMigrationNames) {
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

function recreateMigration81Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough81(databaseName);
    const migration82Count = runPsql(
      databaseName,
      `SELECT COUNT(*)
       FROM "_prisma_migrations"
       WHERE migration_name = ${sqlValue(MIGRATION_NAME)}`,
    );
    if (
      successfulMigrationCount(databaseName) !== 81 ||
      migration82Count !== '0' ||
      newArtifactCount(databaseName) !== 0
    ) {
      throw new Error('failed to build a true empty-database 81-migration scratch database');
    }
  } catch (error) {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
    throw error;
  }
  return databaseName;
}

async function createLegacyFixture(databaseName: string, suffix: string): Promise<LegacyFixture> {
  const prisma = new PrismaClient({ datasourceUrl: scratchDatabaseUrl(databaseName) });
  const timestamp = new Date('2099-01-02T00:00:00.000Z');
  try {
    const reviewer = await prisma.user.create({
      data: {
        username: `migration82-reviewer-${suffix}`,
        passwordHash: '$2a$10$migration82-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    // issue #1048 T1:本夹具服务的是 **81-migration 历史库**(三个调用点都是
    // `recreateMigration81Scratch()`),那时 `Member` 还是 `displayName`。
    // 生成的 Prisma client 是**当前** schema 的,`prisma.member.create` 只会发 `realName`,
    // 打到历史库上必然「column realName does not exist」—— client 根本表达不了历史形状,
    // 只能走裸 SQL;并按库里实际存在的列选,免得下次列名再动又炸一次。
    const memberId = `migration82-member-id-${suffix}`;
    const memberName = `Migration 82 Member ${suffix}`;
    const memberNo = `migration82-member-${suffix}`;
    const realNameProbe = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Member' AND column_name = 'realName';`,
    );
    if (Number(realNameProbe[0]?.count ?? 0) === 1) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Member" ("id","memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
         VALUES ($1,$2,$3,DATE '2020-01-01','manual',CURRENT_TIMESTAMP)`,
        memberId,
        memberNo,
        memberName,
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Member" ("id","memberNo","displayName","updatedAt")
         VALUES ($1,$2,$3,CURRENT_TIMESTAMP)`,
        memberId,
        memberNo,
        memberName,
      );
    }
    const member = { id: memberId };
    const organization = await prisma.organization.create({
      data: {
        name: `Migration 82 Organization ${suffix}`,
        nodeTypeCode: 'migration-82',
      },
      select: { id: true },
    });
    const activity = { id: `migration82-activity-${suffix}` };
    runPsql(
      databaseName,
      `INSERT INTO "Activity"
         ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
       VALUES (${sqlValue(activity.id)},${sqlValue(`Migration 82 Activity ${suffix}`)},
         'migration-82',${sqlValue(organization.id)},TIMESTAMP '2099-06-10 00:00:00',
         TIMESTAMP '2099-06-11 00:00:00','migration-82','published',CURRENT_TIMESTAMP);`,
    );
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: activity.id,
        memberId: member.id,
        statusCode: 'pending',
      },
      select: { id: true },
    });
    const memberInsurance = await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: 'Migration 82 Insurer',
        policyNumber: `migration82-policy-${suffix}`,
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        version: 1,
        reviewedByUserId: reviewer.id,
        reviewedAt: timestamp,
      },
      select: { id: true },
    });
    const evidenceId = `migration82-legacy-evidence-${suffix}`;
    runPsql(
      databaseName,
      `INSERT INTO "insurance_eligibility_evidences" (
         "id", "sourceKind", "memberInsuranceId", "teamInsuranceCoverageId",
         "ownerKind", "activityRegistrationId", "teamJoinApplicationId",
         "sourceRevision", "sourceReviewedByUserId", "sourceReviewedAt",
         "requiredFrom", "requiredThrough", "sourceCoverageStart", "sourceCoverageEnd"
       ) VALUES (
         ${sqlValue(evidenceId)}, 'member_insurance', ${sqlValue(memberInsurance.id)}, NULL,
         'activity_registration', ${sqlValue(registration.id)}, NULL,
         1, ${sqlValue(reviewer.id)}, ${sqlValue(timestamp)},
         '2099-06-10', '2099-06-11', '2099-01-01', '2099-12-31'
       )`,
    );
    return {
      evidenceId,
      registrationId: registration.id,
      memberInsuranceId: memberInsurance.id,
      reviewerId: reviewer.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

function insertLegacyEvidence(
  databaseName: string,
  fixture: LegacyFixture,
  evidenceId: string,
): void {
  runPsql(
    databaseName,
    `INSERT INTO "insurance_eligibility_evidences" (
       "id", "sourceKind", "memberInsuranceId", "teamInsuranceCoverageId",
       "ownerKind", "activityRegistrationId", "teamJoinApplicationId",
       "sourceRevision", "sourceReviewedByUserId", "sourceReviewedAt",
       "requiredFrom", "requiredThrough", "sourceCoverageStart", "sourceCoverageEnd"
     ) VALUES (
       ${sqlValue(evidenceId)}, 'member_insurance', ${sqlValue(fixture.memberInsuranceId)}, NULL,
       'activity_registration', ${sqlValue(fixture.registrationId)}, NULL,
       1, ${sqlValue(fixture.reviewerId)}, '2099-01-02',
       '2099-06-10', '2099-06-11', '2099-01-01', '2099-12-31'
     )`,
  );
}

function newArtifactCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT COUNT(*)
       FROM (
         SELECT column_name AS artifact_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'insurance_eligibility_evidences'
           AND column_name = 'activityRegistrationRevisionId'
         UNION ALL
         SELECT conname
         FROM pg_constraint
         WHERE conname IN (
           'activity_registration_revisions_registration_id_id_unique',
           'insurance_evidence_registration_revision_owner_ck',
           'insurance_evidence_registration_revision_same_head_fkey'
         )
         UNION ALL
         SELECT relname
         FROM pg_class
         WHERE relname = 'insurance_evidence_activity_registration_revision_unique'
       ) AS artifacts`,
    ),
  );
}

describe('第 82 migration registration revision bridge', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });

  it('installs the exact nullable same-head registration revision bridge', async () => {
    const [schemaSource, migrationSource] = await Promise.all([
      readFile(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8'),
      readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8'),
    ]);
    expect(
      schemaSource.match(/map: "insurance_evidence_registration_revision_same_head_fkey"/g),
    ).toHaveLength(1);
    expect(
      migrationSource.match(
        /ADD CONSTRAINT "insurance_evidence_registration_revision_same_head_fkey"/g,
      ),
    ).toHaveLength(1);

    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: string }>
    >`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (
          (
            table_name = 'insurance_eligibility_evidences'
            AND column_name = 'activityRegistrationRevisionId'
          )
          OR (
            table_name = 'ActivityRegistrationRevision'
            AND column_name IN ('registrationId', 'id')
          )
        )
      ORDER BY table_name, column_name
    `;
    expect(columns).toEqual([
      {
        table_name: 'ActivityRegistrationRevision',
        column_name: 'id',
        is_nullable: 'NO',
      },
      {
        table_name: 'ActivityRegistrationRevision',
        column_name: 'registrationId',
        is_nullable: 'NO',
      },
      {
        table_name: 'insurance_eligibility_evidences',
        column_name: 'activityRegistrationRevisionId',
        is_nullable: 'YES',
      },
    ]);

    const constraints = await prisma.$queryRaw<
      Array<{
        constraint_name: string;
        constraint_type: string;
        definition: string;
        match_type: string | null;
        delete_action: string | null;
        update_action: string | null;
      }>
    >`
      SELECT
        constraint_meta.conname AS constraint_name,
        constraint_meta.contype::text AS constraint_type,
        pg_get_constraintdef(constraint_meta.oid) AS definition,
        CASE constraint_meta.confmatchtype WHEN 's' THEN 'SIMPLE' ELSE NULL END AS match_type,
        CASE constraint_meta.confdeltype WHEN 'r' THEN 'RESTRICT' ELSE NULL END AS delete_action,
        CASE constraint_meta.confupdtype WHEN 'r' THEN 'RESTRICT' ELSE NULL END AS update_action
      FROM pg_constraint constraint_meta
      WHERE constraint_meta.connamespace = current_schema()::regnamespace
        AND constraint_meta.conname IN (
          'activity_registration_revisions_registration_id_id_unique',
          'insurance_evidence_registration_revision_same_head_fkey',
          'insurance_evidence_registration_revision_owner_ck'
        )
      ORDER BY constraint_meta.conname
    `;
    expect(constraints).toHaveLength(3);
    expect(constraints[0]).toMatchObject({
      constraint_name: 'activity_registration_revisions_registration_id_id_unique',
      constraint_type: 'u',
    });
    expect(constraints[0]?.definition).toContain('UNIQUE ("registrationId", id)');
    expect(constraints[1]).toMatchObject({
      constraint_name: 'insurance_evidence_registration_revision_owner_ck',
      constraint_type: 'c',
    });
    expect(constraints[2]).toMatchObject({
      constraint_name: 'insurance_evidence_registration_revision_same_head_fkey',
      constraint_type: 'f',
      match_type: 'SIMPLE',
      delete_action: 'RESTRICT',
      update_action: 'RESTRICT',
    });
    expect(constraints[2]?.definition).toContain(
      'FOREIGN KEY ("activityRegistrationId", "activityRegistrationRevisionId")',
    );
    expect(constraints[2]?.definition).toContain(
      'REFERENCES "ActivityRegistrationRevision"("registrationId", id)',
    );

    const uniqueIndexes = await prisma.$queryRaw<
      Array<{ index_name: string; predicate: string | null }>
    >`
      SELECT
        index_class.relname AS index_name,
        pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
      FROM pg_index index_meta
      JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
      WHERE index_meta.indrelid = 'insurance_eligibility_evidences'::regclass
        AND index_meta.indisunique
        AND index_class.relname IN (
          'insurance_evidence_activity_registration_unique',
          'insurance_evidence_activity_registration_revision_unique'
        )
      ORDER BY index_class.relname
    `;
    expect(uniqueIndexes).toHaveLength(2);
    const uniqueIndexPredicates = new Map(
      uniqueIndexes.map((index) => [index.index_name, index.predicate]),
    );
    expect(uniqueIndexPredicates.get('insurance_evidence_activity_registration_unique')).toContain(
      '"activityRegistrationId" IS NOT NULL',
    );
    expect(uniqueIndexPredicates.get('insurance_evidence_activity_registration_unique')).toContain(
      '"activityRegistrationRevisionId" IS NULL',
    );
    expect(
      uniqueIndexPredicates.get('insurance_evidence_activity_registration_revision_unique'),
    ).toContain('"activityRegistrationRevisionId" IS NOT NULL');

    const triggers = await prisma.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT tgname AS trigger_name
      FROM pg_trigger
      WHERE tgrelid = 'insurance_eligibility_evidences'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `;
    expect(triggers.map((row) => row.trigger_name)).toEqual([
      'trg_insurance_evidence_10_member_match',
      'trg_insurance_evidence_20_immutable',
    ]);
  });

  it('upgrades a clean 81-migration database and preserves every legacy evidence field', async () => {
    const databaseName = recreateMigration81Scratch();
    try {
      const fixture = await createLegacyFixture(databaseName, 'clean');
      const rowBefore = runPsql(
        databaseName,
        `SELECT (to_jsonb(e) - 'activityRegistrationRevisionId')::text
         FROM "insurance_eligibility_evidences" e
         WHERE "id" = ${sqlValue(fixture.evidenceId)}`,
      );
      const xminBefore = runPsql(
        databaseName,
        `SELECT xmin::text FROM "insurance_eligibility_evidences"
         WHERE "id" = ${sqlValue(fixture.evidenceId)}`,
      );

      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
      expect(
        runPsql(
          databaseName,
          `SELECT (to_jsonb(e) - 'activityRegistrationRevisionId')::text
           FROM "insurance_eligibility_evidences" e
           WHERE "id" = ${sqlValue(fixture.evidenceId)}`,
        ),
      ).toBe(rowBefore);
      expect(
        runPsql(
          databaseName,
          `SELECT xmin::text FROM "insurance_eligibility_evidences"
           WHERE "id" = ${sqlValue(fixture.evidenceId)}`,
        ),
      ).toBe(xminBefore);
      expect(
        runPsql(
          databaseName,
          `SELECT "activityRegistrationRevisionId" IS NULL
           FROM "insurance_eligibility_evidences"
           WHERE "id" = ${sqlValue(fixture.evidenceId)}`,
        ),
      ).toBe('t');
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });

  it('fails schema-drift duplicate legacy owners as controlled 23505 and rolls back fully', async () => {
    const databaseName = recreateMigration81Scratch();
    try {
      const fixture = await createLegacyFixture(databaseName, 'drift');
      runPsql(
        databaseName,
        `DROP INDEX "insurance_evidence_activity_registration_unique";
         CREATE INDEX "insurance_evidence_activity_registration_unique"
           ON "insurance_eligibility_evidences" ("activityRegistrationId")
           WHERE "activityRegistrationId" IS NOT NULL;`,
      );
      insertLegacyEvidence(databaseName, fixture, 'migration82-legacy-evidence-drift-2');

      const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
      const failure = runPsqlFailure(databaseName, migration);
      expect(failure).toContain('23505');
      expect(failure).toContain('insurance evidence legacy owner preflight violation');
      expect(failure).toContain('insurance_evidence_activity_registration_unique');

      expect(successfulMigrationCount(databaseName)).toBe(81);
      expect(newArtifactCount(databaseName)).toBe(0);
      expect(
        runPsql(
          databaseName,
          `SELECT COUNT(*) FROM "insurance_eligibility_evidences"
           WHERE "activityRegistrationId" = ${sqlValue(fixture.registrationId)}`,
        ),
      ).toBe('2');
      expect(
        runPsql(
          databaseName,
          `SELECT indisunique
           FROM pg_index
           WHERE indexrelid = 'insurance_evidence_activity_registration_unique'::regclass`,
        ),
      ).toBe('f');
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });

  it('rolls back every new DDL and restores the exact old index after a late failure', async () => {
    const databaseName = recreateMigration81Scratch();
    try {
      await createLegacyFixture(databaseName, 'late-failure');
      const oldIndexDefinition = runPsql(
        databaseName,
        `SELECT pg_get_indexdef('insurance_evidence_activity_registration_unique'::regclass)`,
      );
      const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
      const failingMigration = migration.replace(
        /\nCOMMIT;\s*$/,
        `\nDO $migration82_late_failure$\nBEGIN\n  RAISE EXCEPTION 'migration 82 late DDL failure';\nEND\n$migration82_late_failure$;\n\nCOMMIT;\n`,
      );
      if (failingMigration === migration) {
        throw new Error('migration 82 COMMIT marker disappeared before late-failure injection');
      }

      const failure = runPsqlFailure(databaseName, failingMigration);
      expect(failure).toContain('migration 82 late DDL failure');
      expect(successfulMigrationCount(databaseName)).toBe(81);
      expect(newArtifactCount(databaseName)).toBe(0);
      expect(
        runPsql(
          databaseName,
          `SELECT pg_get_indexdef('insurance_evidence_activity_registration_unique'::regclass)`,
        ),
      ).toBe(oldIndexDefinition);
      expect(oldIndexDefinition).toContain('CREATE UNIQUE INDEX');
      expect(oldIndexDefinition).not.toContain('activityRegistrationRevisionId');
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });
});

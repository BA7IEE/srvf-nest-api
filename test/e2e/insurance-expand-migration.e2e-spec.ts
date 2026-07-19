import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION_PATH = 'prisma/migrations/20260719071116_insurance_expand/migration.sql';
const BACKFILL_START = '-- insurance-expand:legacy-backfill:begin';
const BACKFILL_END = '-- insurance-expand:legacy-backfill:end';
const POSTGRES_CONTAINER = 'u-nest-api-postgres';

function runPsqlInDerivedTestDatabase(sql: string): void {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
    ],
    {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

describe('D-INSURANCE v3 PR1 expand migration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  async function createMember(label: string): Promise<string> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `insurance-expand-${label}-${sequence}`,
        displayName: `Insurance Expand ${label}`,
      },
      select: { id: true },
    });
    return member.id;
  }

  async function readMemberInsuranceXmin(id: string): Promise<string> {
    const [row] = await prisma.$queryRaw<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin
      FROM "member_insurances"
      WHERE "id" = ${id}
    `;
    if (!row) {
      throw new Error(`member insurance ${id} disappeared while checking backfill rewrite`);
    }
    return row.xmin;
  }

  it('actual backfill resets only anomalous legacy rows, including soft-deleted history, without rewriting normal rows', async () => {
    const reviewer = await prisma.user.create({
      data: {
        username: 'insurance-expand-reviewer',
        passwordHash: '$2a$10$insurance-expand-migration-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const memberId = await createMember('legacy');
    const reviewedAt = new Date('2026-07-18T00:00:00.000Z');

    const live = await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'legacy-live-insurer',
        policyNumber: 'legacy-live-policy',
        coverageEnd: new Date('2027-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        version: 9,
        reviewedByUserId: reviewer.id,
        reviewedAt,
      },
      select: { id: true },
    });
    const deleted = await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'legacy-deleted-insurer',
        policyNumber: 'legacy-deleted-policy',
        coverageEnd: new Date('2027-06-30T00:00:00.000Z'),
        reviewStatusCode: 'rejected',
        version: 4,
        reviewedByUserId: reviewer.id,
        reviewedAt,
        deletedAt: new Date('2026-07-18T01:00:00.000Z'),
      },
      select: { id: true },
    });
    const normal = await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'legacy-normal-insurer',
        policyNumber: 'legacy-normal-policy',
        coverageEnd: new Date('2027-03-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const normalXminBefore = await readMemberInsuranceXmin(normal.id);

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const start = migration.indexOf(BACKFILL_START);
    const end = migration.indexOf(BACKFILL_END, start + BACKFILL_START.length);
    if (start < 0 || end < 0) {
      throw new Error('insurance legacy backfill statement markers disappeared');
    }
    const backfill = migration.slice(start + BACKFILL_START.length, end).trim();
    expect(backfill).toContain('"reviewStatusCode" <> \'pending\'');
    expect(backfill).toContain('"version" <> 0');
    expect(backfill).toContain('"reviewedByUserId" IS NOT NULL');
    expect(backfill).toContain('"reviewedAt" IS NOT NULL');
    expect(backfill).not.toContain('"deletedAt"');
    await prisma.$executeRawUnsafe(backfill);

    const rows = await prisma.memberInsurance.findMany({
      where: { id: { in: [live.id, deleted.id, normal.id] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        deletedAt: true,
        reviewStatusCode: true,
        version: true,
        reviewedByUserId: true,
        reviewedAt: true,
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.deletedAt !== null)).toBe(true);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: live.id,
          reviewStatusCode: 'pending',
          version: 0,
          reviewedByUserId: null,
          reviewedAt: null,
        }),
        expect.objectContaining({
          id: deleted.id,
          reviewStatusCode: 'pending',
          version: 0,
          reviewedByUserId: null,
          reviewedAt: null,
        }),
        expect.objectContaining({
          id: normal.id,
          reviewStatusCode: 'pending',
          version: 0,
          reviewedByUserId: null,
          reviewedAt: null,
        }),
      ]),
    );
    await expect(readMemberInsuranceXmin(normal.id)).resolves.toBe(normalXminBefore);
  });

  it('rolls back every expand step when a later statement fails in an isolated schema', async () => {
    sequence += 1;
    const schemaName = `insurance_expand_rollback_${process.pid}_${Date.now()}_${sequence}`;
    if (!/^insurance_expand_rollback_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`unsafe rollback fixture schema name: ${schemaName}`);
    }

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect(migration).toMatch(/(?:^|\n)BEGIN;\n/);
    expect(migration).toMatch(/\nCOMMIT;\s*$/);

    const anomalyInjection = `UPDATE "member_insurances"
SET
  "reviewStatusCode" = 'verified',
  "version" = 7
WHERE "id" = 'legacy-row';
${BACKFILL_START}`;
    const migrationWithAnomaly = migration.replace(BACKFILL_START, anomalyInjection);
    if (migrationWithAnomaly === migration) {
      throw new Error('insurance legacy backfill marker disappeared before rollback injection');
    }

    const lateFailure = `DO $insurance_expand_failure$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "member_insurances"
    WHERE "id" = 'legacy-row'
      AND "reviewStatusCode" = 'pending'
      AND "version" = 0
      AND "reviewedByUserId" IS NULL
      AND "reviewedAt" IS NULL
      AND "touchCount" = 2
  ) THEN
    RAISE EXCEPTION 'insurance expand rollback fixture did not observe backfill';
  END IF;
  RAISE EXCEPTION 'insurance expand rollback late failure';
END;
$insurance_expand_failure$;`;
    const failingMigration = migrationWithAnomaly.replace(
      /\nCOMMIT;\s*$/,
      `\n${lateFailure}\nCOMMIT;\n`,
    );
    if (failingMigration === migrationWithAnomaly) {
      throw new Error('insurance migration COMMIT disappeared before rollback injection');
    }

    const fixtureSql = `
CREATE SCHEMA "${schemaName}";
SET search_path TO "${schemaName}";

CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
CREATE TABLE "member_insurances" (
  "id" TEXT PRIMARY KEY,
  "touchCount" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "team_join_cycles" ("id" TEXT PRIMARY KEY);
CREATE TABLE "team_insurance_coverages" ("id" TEXT PRIMARY KEY);
CREATE TABLE "ActivityRegistration" ("id" TEXT PRIMARY KEY);
CREATE TABLE "team_join_applications" ("id" TEXT PRIMARY KEY);

CREATE FUNCTION count_member_insurance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $insurance_expand_fixture$
BEGIN
  NEW."touchCount" := OLD."touchCount" + 1;
  RETURN NEW;
END;
$insurance_expand_fixture$;

CREATE TRIGGER count_member_insurance_update
BEFORE UPDATE ON "member_insurances"
FOR EACH ROW EXECUTE FUNCTION count_member_insurance_update();

INSERT INTO "member_insurances" ("id") VALUES ('legacy-row');

${failingMigration}`;

    try {
      // Mutation killed:without the migration-level BEGIN, earlier DDL/backfill survives the late failure.
      let psqlFailure:
        | {
            message?: string;
            stderr?: string | Buffer;
          }
        | undefined;
      try {
        runPsqlInDerivedTestDatabase(fixtureSql);
      } catch (error) {
        psqlFailure = error as typeof psqlFailure;
      }
      expect(psqlFailure).toBeDefined();
      const failureText = [
        psqlFailure?.message ?? '',
        typeof psqlFailure?.stderr === 'string'
          ? psqlFailure.stderr
          : (psqlFailure?.stderr?.toString() ?? ''),
      ].join('\n');
      expect(failureText).toContain('insurance expand rollback late failure');

      const addedColumns = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string }>
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = ${schemaName}
          AND (
            (
              table_name = 'member_insurances'
              AND column_name IN (
                'reviewStatusCode',
                'version',
                'reviewedByUserId',
                'reviewedAt'
              )
            )
            OR (
              table_name = 'team_join_cycles'
              AND column_name = 'requiresInsurance'
            )
          )
        ORDER BY table_name, column_name
      `;
      expect(addedColumns).toEqual([]);

      const [evidenceTable] = await prisma.$queryRaw<Array<{ relation_name: string | null }>>`
        SELECT to_regclass(${`${schemaName}.insurance_eligibility_evidences`})::text
          AS relation_name
      `;
      expect(evidenceTable?.relation_name).toBeNull();

      const baselineRows = await prisma.$queryRawUnsafe<Array<{ id: string; touchCount: number }>>(
        `SELECT "id", "touchCount" FROM "${schemaName}"."member_insurances" WHERE "id" = $1`,
        'legacy-row',
      );
      expect(baselineRows).toEqual([{ id: 'legacy-row', touchCount: 0 }]);
    } finally {
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });

  it('keeps new defaults additive and the evidence compatibility skeleton nullable', async () => {
    const memberId = await createMember('defaults');
    const insurance = await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'default-insurer',
        policyNumber: 'default-policy',
        coverageEnd: new Date('2027-12-31T00:00:00.000Z'),
      },
    });
    expect(insurance).toMatchObject({
      reviewStatusCode: 'pending',
      version: 0,
      reviewedByUserId: null,
      reviewedAt: null,
    });

    const cycle = await prisma.teamJoinCycle.create({
      data: {
        year: 2027,
        name: 'Insurance Expand Default Cycle',
        statusCode: 'closed',
      },
    });
    expect(cycle.requiresInsurance).toBe(false);

    // Mutation killed:premature PR4 NOT NULL/CHECK constraints would reject this row.
    const evidence = await prisma.insuranceEligibilityEvidence.create({ data: {} });
    expect(evidence).toMatchObject({
      sourceKind: null,
      memberInsuranceId: null,
      teamInsuranceCoverageId: null,
      ownerKind: null,
      activityRegistrationId: null,
      teamJoinApplicationId: null,
      sourceRevision: null,
      sourceReviewedByUserId: null,
      sourceReviewedAt: null,
      requiredFrom: null,
      requiredThrough: null,
      sourceCoverageStart: null,
      sourceCoverageEnd: null,
    });
  });

  it('installs only nullable RESTRICT evidence/reviewer FKs in PR1', async () => {
    const constraints = await prisma.$queryRaw<
      Array<{ table_name: string; constraint_name: string; delete_action: string }>
    >`
      SELECT
        tc.table_name,
        tc.constraint_name,
        rc.delete_rule AS delete_action
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = current_schema()
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name IN (
          'member_insurances_reviewedByUserId_fkey',
          'insurance_eligibility_evidences_memberInsuranceId_fkey',
          'insurance_eligibility_evidences_teamInsuranceCoverageId_fkey',
          'insurance_eligibility_evidences_activityRegistrationId_fkey',
          'insurance_eligibility_evidences_teamJoinApplicationId_fkey',
          'insurance_eligibility_evidences_sourceReviewedByUserId_fkey'
        )
      ORDER BY tc.constraint_name
    `;

    expect(constraints).toHaveLength(6);
    expect(constraints.map((row) => row.delete_action)).toEqual(Array(6).fill('RESTRICT'));
  });

  it('does not install PR4 owner uniqueness, business CHECKs, or user triggers', async () => {
    const uniqueIndexes = await prisma.$queryRaw<
      Array<{ index_name: string; is_primary: boolean }>
    >`
      SELECT index_class.relname AS index_name, index_meta.indisprimary AS is_primary
      FROM pg_index index_meta
      JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
      WHERE index_meta.indrelid = '"insurance_eligibility_evidences"'::regclass
        AND index_meta.indisunique
      ORDER BY index_class.relname
    `;
    expect(uniqueIndexes).toEqual([
      {
        index_name: 'insurance_eligibility_evidences_pkey',
        is_primary: true,
      },
    ]);

    const businessChecks = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE conrelid = '"insurance_eligibility_evidences"'::regclass
        AND contype = 'c'
      ORDER BY conname
    `;
    expect(businessChecks).toEqual([]);

    const userTriggers = await prisma.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT tgname AS trigger_name
      FROM pg_trigger
      WHERE tgrelid = '"insurance_eligibility_evidences"'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `;
    expect(userTriggers).toEqual([]);

    const reviewer = await prisma.user.create({
      data: {
        username: 'insurance-expand-no-pr4-trigger',
        passwordHash: '$2a$10$insurance-expand-no-pr4-trigger',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const memberId = await createMember('no-pr4-constraints');
    const memberInsurance = await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: 'no-pr4-constraint-insurer',
        policyNumber: 'no-pr4-constraint-policy',
        coverageStart: new Date('2027-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2027-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        version: 1,
        reviewedByUserId: reviewer.id,
        reviewedAt: new Date('2027-01-02T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'Insurance Expand No PR4 Organization',
        nodeTypeCode: 'insurance-expand',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: 'Insurance Expand No PR4 Activity',
        activityTypeCode: 'insurance-expand',
        organizationId: organization.id,
        startAt: new Date('2027-01-10T00:00:00.000Z'),
        endAt: new Date('2027-01-10T08:00:00.000Z'),
        location: 'insurance-expand',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: activity.id,
        memberId,
        statusCode: 'pass',
      },
      select: { id: true },
    });
    const evidenceData = {
      sourceKind: 'member_insurance',
      memberInsuranceId: memberInsurance.id,
      ownerKind: 'activity_registration',
      activityRegistrationId: registration.id,
      sourceRevision: 1,
      sourceReviewedByUserId: reviewer.id,
      sourceReviewedAt: new Date('2027-01-02T00:00:00.000Z'),
      requiredFrom: new Date('2027-01-10T00:00:00.000Z'),
      requiredThrough: new Date('2027-01-10T00:00:00.000Z'),
      sourceCoverageStart: new Date('2027-01-01T00:00:00.000Z'),
      sourceCoverageEnd: new Date('2027-12-31T00:00:00.000Z'),
    };

    const first = await prisma.insuranceEligibilityEvidence.create({
      data: evidenceData,
      select: { id: true },
    });
    // Mutation killed:a premature partial unique owner index rejects this second row.
    const second = await prisma.insuranceEligibilityEvidence.create({
      data: evidenceData,
      select: { id: true },
    });
    expect(first.id).not.toBe(second.id);

    // Mutation killed:premature immutable UPDATE/DELETE triggers reject either operation.
    const updated = await prisma.insuranceEligibilityEvidence.update({
      where: { id: first.id },
      data: { requiredThrough: new Date('2027-01-11T00:00:00.000Z') },
      select: { requiredThrough: true },
    });
    expect(updated.requiredThrough?.toISOString()).toBe('2027-01-11T00:00:00.000Z');

    await expect(
      prisma.insuranceEligibilityEvidence.delete({ where: { id: second.id } }),
    ).resolves.toMatchObject({ id: second.id });
  });
});

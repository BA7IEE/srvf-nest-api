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

const MIGRATION_PATH = 'prisma/migrations/20260719160335_insurance_constraints/migration.sql';
const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const REQUIRED_FROM = new Date('2027-06-10T00:00:00.000Z');
const REQUIRED_THROUGH = new Date('2027-06-11T00:00:00.000Z');
const COVERAGE_START = new Date('2027-01-01T00:00:00.000Z');
const COVERAGE_END = new Date('2027-12-31T00:00:00.000Z');
const REVIEWED_AT = new Date('2027-01-02T00:00:00.000Z');

interface DatabaseErrorIdentity {
  sqlState: string;
  constraint: string;
}

interface ConstraintFixture {
  reviewerId: string;
  memberAId: string;
  memberBId: string;
  memberInsuranceAId: string;
  memberInsuranceBId: string;
  teamPolicyAId: string;
  teamCoverageAId: string;
  teamCoverageBId: string;
  registrationA1Id: string;
  registrationA2Id: string;
  registrationBId: string;
  joinA1Id: string;
  joinA2Id: string;
  joinBId: string;
}

interface EvidenceSqlRow {
  id: string;
  sourceKind: string;
  memberInsuranceId: string | null;
  teamInsuranceCoverageId: string | null;
  ownerKind: string;
  activityRegistrationId: string | null;
  teamJoinApplicationId: string | null;
  sourceRevision: number | null;
  sourceReviewedByUserId: string | null;
  sourceReviewedAt: Date | null;
  requiredFrom: Date;
  requiredThrough: Date;
  sourceCoverageStart: Date | null;
  sourceCoverageEnd: Date;
}

function sqlValue(value: string | number | Date | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  const text = value instanceof Date ? value.toISOString() : value;
  return `'${text.replaceAll("'", "''")}'`;
}

function evidenceInsertSql(row: EvidenceSqlRow): string {
  return `INSERT INTO "insurance_eligibility_evidences" (
    "id",
    "sourceKind",
    "memberInsuranceId",
    "teamInsuranceCoverageId",
    "ownerKind",
    "activityRegistrationId",
    "teamJoinApplicationId",
    "sourceRevision",
    "sourceReviewedByUserId",
    "sourceReviewedAt",
    "requiredFrom",
    "requiredThrough",
    "sourceCoverageStart",
    "sourceCoverageEnd"
  ) VALUES (
    ${sqlValue(row.id)},
    ${sqlValue(row.sourceKind)},
    ${sqlValue(row.memberInsuranceId)},
    ${sqlValue(row.teamInsuranceCoverageId)},
    ${sqlValue(row.ownerKind)},
    ${sqlValue(row.activityRegistrationId)},
    ${sqlValue(row.teamJoinApplicationId)},
    ${sqlValue(row.sourceRevision)},
    ${sqlValue(row.sourceReviewedByUserId)},
    ${sqlValue(row.sourceReviewedAt)},
    ${sqlValue(row.requiredFrom)},
    ${sqlValue(row.requiredThrough)},
    ${sqlValue(row.sourceCoverageStart)},
    ${sqlValue(row.sourceCoverageEnd)}
  )`;
}

function runPsql(sql: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
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
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

let captureSequence = 0;

function captureDatabaseError(statement: string): DatabaseErrorIdentity {
  captureSequence += 1;
  const statementTag = `$insurance_statement_${process.pid}_${captureSequence}$`;
  const output = runPsql(`
CREATE OR REPLACE FUNCTION pg_temp.capture_insurance_constraint_error()
RETURNS TABLE (sql_state TEXT, constraint_name TEXT)
LANGUAGE plpgsql
AS $insurance_capture$
DECLARE
  captured_state TEXT;
  captured_constraint TEXT;
BEGIN
  BEGIN
    EXECUTE ${statementTag}${statement}${statementTag};
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      captured_state = RETURNED_SQLSTATE,
      captured_constraint = CONSTRAINT_NAME;
    sql_state := captured_state;
    constraint_name := COALESCE(captured_constraint, '');
    RETURN NEXT;
    RETURN;
  END;

  RAISE EXCEPTION 'expected database statement to fail';
END;
$insurance_capture$;

SELECT sql_state, constraint_name
FROM pg_temp.capture_insurance_constraint_error();
`);
  const resultLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!resultLine) throw new Error('psql error capture returned no row');
  const [sqlState, constraint = ''] = resultLine.split('|');
  if (!sqlState) throw new Error(`psql error capture returned malformed row: ${resultLine}`);
  return { sqlState, constraint };
}

describe('D-INSURANCE v3 PR4 evidence constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fixture: ConstraintFixture;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    fixture = await createFixture();
  });

  function nextId(label: string): string {
    sequence += 1;
    return `insurance-constraint-${label}-${sequence}`;
  }

  function selfRegistrationRow(overrides: Partial<EvidenceSqlRow> = {}): EvidenceSqlRow {
    return {
      id: nextId('self-registration'),
      sourceKind: 'member_insurance',
      memberInsuranceId: fixture.memberInsuranceAId,
      teamInsuranceCoverageId: null,
      ownerKind: 'activity_registration',
      activityRegistrationId: fixture.registrationA1Id,
      teamJoinApplicationId: null,
      sourceRevision: 1,
      sourceReviewedByUserId: fixture.reviewerId,
      sourceReviewedAt: REVIEWED_AT,
      requiredFrom: REQUIRED_FROM,
      requiredThrough: REQUIRED_THROUGH,
      sourceCoverageStart: COVERAGE_START,
      sourceCoverageEnd: COVERAGE_END,
      ...overrides,
    };
  }

  function teamRegistrationRow(overrides: Partial<EvidenceSqlRow> = {}): EvidenceSqlRow {
    return {
      id: nextId('team-registration'),
      sourceKind: 'team_insurance_coverage',
      memberInsuranceId: null,
      teamInsuranceCoverageId: fixture.teamCoverageAId,
      ownerKind: 'activity_registration',
      activityRegistrationId: fixture.registrationA2Id,
      teamJoinApplicationId: null,
      sourceRevision: null,
      sourceReviewedByUserId: null,
      sourceReviewedAt: null,
      requiredFrom: REQUIRED_FROM,
      requiredThrough: REQUIRED_THROUGH,
      sourceCoverageStart: COVERAGE_START,
      sourceCoverageEnd: COVERAGE_END,
      ...overrides,
    };
  }

  function selfJoinRow(overrides: Partial<EvidenceSqlRow> = {}): EvidenceSqlRow {
    return {
      ...selfRegistrationRow(),
      id: nextId('self-join'),
      ownerKind: 'team_join_application',
      activityRegistrationId: null,
      teamJoinApplicationId: fixture.joinA1Id,
      ...overrides,
    };
  }

  function teamJoinRow(overrides: Partial<EvidenceSqlRow> = {}): EvidenceSqlRow {
    return {
      ...teamRegistrationRow(),
      id: nextId('team-join'),
      ownerKind: 'team_join_application',
      activityRegistrationId: null,
      teamJoinApplicationId: fixture.joinA2Id,
      ...overrides,
    };
  }

  async function createFixture(): Promise<ConstraintFixture> {
    const reviewer = await prisma.user.create({
      data: {
        username: nextId('reviewer'),
        passwordHash: '$2a$10$insurance-constraints-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const memberA = await prisma.member.create({
      data: { memberNo: nextId('member-a'), displayName: 'Insurance Constraint A' },
      select: { id: true },
    });
    const memberB = await prisma.member.create({
      data: { memberNo: nextId('member-b'), displayName: 'Insurance Constraint B' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: { name: nextId('organization'), nodeTypeCode: 'insurance-constraint' },
      select: { id: true },
    });

    const createRegistration = async (memberId: string, label: string): Promise<string> => {
      const activity = await prisma.activity.create({
        data: {
          title: nextId(`activity-${label}`),
          activityTypeCode: 'insurance-constraint',
          organizationId: organization.id,
          startAt: REQUIRED_FROM,
          endAt: REQUIRED_THROUGH,
          location: 'insurance-constraint',
          statusCode: 'published',
        },
        select: { id: true },
      });
      return (
        await prisma.activityRegistration.create({
          data: { activityId: activity.id, memberId, statusCode: 'pass' },
          select: { id: true },
        })
      ).id;
    };

    const createJoin = async (memberId: string, label: string, year: number): Promise<string> => {
      const cycle = await prisma.teamJoinCycle.create({
        data: { year, name: nextId(`cycle-${label}`), statusCode: 'closed' },
        select: { id: true },
      });
      return (
        await prisma.teamJoinApplication.create({
          data: {
            cycleId: cycle.id,
            memberId,
            statusCode: 'approved',
            targetOrganizationIds: [],
          },
          select: { id: true },
        })
      ).id;
    };

    const registrationA1Id = await createRegistration(memberA.id, 'a1');
    const registrationA2Id = await createRegistration(memberA.id, 'a2');
    const registrationBId = await createRegistration(memberB.id, 'b');
    const joinA1Id = await createJoin(memberA.id, 'a1', 2027);
    const joinA2Id = await createJoin(memberA.id, 'a2', 2028);
    const joinBId = await createJoin(memberB.id, 'b', 2029);

    const memberInsuranceA = await prisma.memberInsurance.create({
      data: {
        memberId: memberA.id,
        insurerName: 'Constraint Self A',
        policyNumber: nextId('self-a'),
        coverageStart: COVERAGE_START,
        coverageEnd: COVERAGE_END,
        reviewStatusCode: 'verified',
        version: 1,
        reviewedByUserId: reviewer.id,
        reviewedAt: REVIEWED_AT,
      },
      select: { id: true },
    });
    const memberInsuranceB = await prisma.memberInsurance.create({
      data: {
        memberId: memberB.id,
        insurerName: 'Constraint Self B',
        policyNumber: nextId('self-b'),
        coverageStart: COVERAGE_START,
        coverageEnd: COVERAGE_END,
        reviewStatusCode: 'verified',
        version: 2,
        reviewedByUserId: reviewer.id,
        reviewedAt: REVIEWED_AT,
      },
      select: { id: true },
    });
    const teamPolicyA = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: 'Constraint Team',
        policyNumber: nextId('team-policy'),
        coverageStart: COVERAGE_START,
        coverageEnd: COVERAGE_END,
      },
      select: { id: true },
    });
    const teamCoverageA = await prisma.teamInsuranceCoverage.create({
      data: { policyId: teamPolicyA.id, memberId: memberA.id },
      select: { id: true },
    });
    const teamCoverageB = await prisma.teamInsuranceCoverage.create({
      data: { policyId: teamPolicyA.id, memberId: memberB.id },
      select: { id: true },
    });

    return {
      reviewerId: reviewer.id,
      memberAId: memberA.id,
      memberBId: memberB.id,
      memberInsuranceAId: memberInsuranceA.id,
      memberInsuranceBId: memberInsuranceB.id,
      teamPolicyAId: teamPolicyA.id,
      teamCoverageAId: teamCoverageA.id,
      teamCoverageBId: teamCoverageB.id,
      registrationA1Id,
      registrationA2Id,
      registrationBId,
      joinA1Id,
      joinA2Id,
      joinBId,
    };
  }

  function expectDatabaseError(statement: string, sqlState: string, constraint: string): void {
    expect(captureDatabaseError(statement)).toEqual({ sqlState, constraint });
  }

  it('installs the final named checks, partial uniques, required columns, and only the two frozen user triggers', async () => {
    const requiredColumns = await prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string }>
    >`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'insurance_eligibility_evidences'
        AND column_name IN (
          'sourceKind',
          'ownerKind',
          'requiredFrom',
          'requiredThrough',
          'sourceCoverageEnd'
        )
      ORDER BY column_name
    `;
    expect(requiredColumns).toHaveLength(5);
    expect(requiredColumns.every((column) => column.is_nullable === 'NO')).toBe(true);

    const checks = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE conrelid IN (
        '"insurance_eligibility_evidences"'::regclass,
        '"member_insurances"'::regclass
      )
        AND contype = 'c'
        AND (
          conname LIKE 'insurance_evidence_%'
          OR conname LIKE 'member_insurances_%_ck'
        )
      ORDER BY conname
    `;
    expect(checks.map((row) => row.constraint_name)).toEqual([
      'insurance_evidence_exactly_one_owner_ck',
      'insurance_evidence_exactly_one_source_ck',
      'insurance_evidence_owner_kind_ck',
      'insurance_evidence_required_interval_ck',
      'insurance_evidence_review_snapshot_ck',
      'insurance_evidence_source_interval_ck',
      'insurance_evidence_source_kind_ck',
      'member_insurances_review_snapshot_ck',
      'member_insurances_version_nonnegative_ck',
    ]);

    const uniqueIndexes = await prisma.$queryRaw<Array<{ index_name: string }>>`
      SELECT index_class.relname AS index_name
      FROM pg_index index_meta
      JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
      WHERE index_meta.indrelid = '"insurance_eligibility_evidences"'::regclass
        AND index_meta.indisunique
        AND NOT index_meta.indisprimary
      ORDER BY index_class.relname
    `;
    expect(uniqueIndexes.map((row) => row.index_name)).toEqual([
      'insurance_evidence_activity_registration_unique',
      'insurance_evidence_team_join_application_unique',
    ]);

    const triggers = await prisma.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT tgname AS trigger_name
      FROM pg_trigger
      WHERE tgrelid = '"insurance_eligibility_evidences"'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `;
    expect(triggers.map((row) => row.trigger_name)).toEqual([
      'trg_insurance_evidence_10_member_match',
      'trg_insurance_evidence_20_immutable',
    ]);
  });

  it('rejects MemberInsurance negative versions and invalid review snapshots with exact CHECK identities', () => {
    expectDatabaseError(
      `UPDATE "member_insurances" SET "version" = -1 WHERE "id" = ${sqlValue(fixture.memberInsuranceAId)}`,
      '23514',
      'member_insurances_version_nonnegative_ck',
    );
    expectDatabaseError(
      `UPDATE "member_insurances"
       SET "reviewStatusCode" = 'pending'
       WHERE "id" = ${sqlValue(fixture.memberInsuranceAId)}`,
      '23514',
      'member_insurances_review_snapshot_ck',
    );
  });

  it('rejects every frozen row-shape/interval/review CHECK with exact SQLSTATE and constraint', () => {
    const cases: Array<[EvidenceSqlRow, string]> = [
      [
        selfRegistrationRow({ memberInsuranceId: null }),
        'insurance_evidence_exactly_one_source_ck',
      ],
      [
        selfRegistrationRow({ teamInsuranceCoverageId: fixture.teamCoverageAId }),
        'insurance_evidence_exactly_one_source_ck',
      ],
      [
        selfRegistrationRow({ activityRegistrationId: null }),
        'insurance_evidence_exactly_one_owner_ck',
      ],
      [
        selfRegistrationRow({ teamJoinApplicationId: fixture.joinA1Id }),
        'insurance_evidence_exactly_one_owner_ck',
      ],
      [
        selfRegistrationRow({
          sourceKind: 'team_insurance_coverage',
          sourceRevision: null,
          sourceReviewedByUserId: null,
          sourceReviewedAt: null,
        }),
        'insurance_evidence_source_kind_ck',
      ],
      [
        selfRegistrationRow({ ownerKind: 'team_join_application' }),
        'insurance_evidence_owner_kind_ck',
      ],
      [
        selfRegistrationRow({
          requiredFrom: REQUIRED_THROUGH,
          requiredThrough: REQUIRED_FROM,
        }),
        'insurance_evidence_required_interval_ck',
      ],
      [
        selfRegistrationRow({ sourceCoverageEnd: new Date('2027-06-10T12:00:00.000Z') }),
        'insurance_evidence_source_interval_ck',
      ],
      [selfRegistrationRow({ sourceReviewedAt: null }), 'insurance_evidence_review_snapshot_ck'],
      [teamRegistrationRow({ sourceRevision: 1 }), 'insurance_evidence_review_snapshot_ck'],
    ];

    for (const [row, constraint] of cases) {
      expectDatabaseError(evidenceInsertSql(row), '23514', constraint);
    }
  });

  it('returns missing targets to all four native FKs with exact 23503 identities', () => {
    const missingId = nextId('missing-fk');
    const cases: Array<[EvidenceSqlRow, string]> = [
      [
        selfRegistrationRow({ memberInsuranceId: missingId }),
        'insurance_eligibility_evidences_memberInsuranceId_fkey',
      ],
      [
        teamRegistrationRow({ teamInsuranceCoverageId: missingId }),
        'insurance_eligibility_evidences_teamInsuranceCoverageId_fkey',
      ],
      [
        selfRegistrationRow({ activityRegistrationId: missingId }),
        'insurance_eligibility_evidences_activityRegistrationId_fkey',
      ],
      [
        selfJoinRow({ teamJoinApplicationId: missingId }),
        'insurance_eligibility_evidences_teamJoinApplicationId_fkey',
      ],
    ];

    for (const [row, constraint] of cases) {
      expectDatabaseError(evidenceInsertSql(row), '23503', constraint);
    }
  });

  it('rejects all four structurally valid cross-member INSERT combinations as member-match 23514', () => {
    const cases = [
      selfRegistrationRow({ activityRegistrationId: fixture.registrationBId }),
      teamRegistrationRow({ activityRegistrationId: fixture.registrationBId }),
      selfJoinRow({ teamJoinApplicationId: fixture.joinBId }),
      teamJoinRow({ teamJoinApplicationId: fixture.joinBId }),
    ];
    for (const row of cases) {
      expectDatabaseError(evidenceInsertSql(row), '23514', 'insurance_evidence_member_match');
    }
  });

  it('accepts all four legal combinations and preserves immutable history after source/owner edits and soft deletes', async () => {
    const rows = [selfRegistrationRow(), teamRegistrationRow(), selfJoinRow(), teamJoinRow()];
    for (const row of rows) runPsql(`${evidenceInsertSql(row)};`);

    await prisma.memberInsurance.update({
      where: { id: fixture.memberInsuranceAId },
      data: { coverageEnd: new Date('2028-12-31T00:00:00.000Z'), deletedAt: new Date() },
    });
    await prisma.teamInsurancePolicy.update({
      where: { id: fixture.teamPolicyAId },
      data: { coverageEnd: new Date('2028-12-31T00:00:00.000Z'), deletedAt: new Date() },
    });
    await prisma.teamInsuranceCoverage.update({
      where: { id: fixture.teamCoverageAId },
      data: { deletedAt: new Date() },
    });
    await prisma.activityRegistration.updateMany({
      where: { id: { in: [fixture.registrationA1Id, fixture.registrationA2Id] } },
      data: { deletedAt: new Date() },
    });
    await prisma.teamJoinApplication.updateMany({
      where: { id: { in: [fixture.joinA1Id, fixture.joinA2Id] } },
      data: { deletedAt: new Date() },
    });

    const history = await prisma.insuranceEligibilityEvidence.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      orderBy: { id: 'asc' },
    });
    expect(history).toHaveLength(4);
    expect(history.every((row) => row.sourceCoverageEnd.getTime() === COVERAGE_END.getTime())).toBe(
      true,
    );

    expectDatabaseError(
      `UPDATE "insurance_eligibility_evidences"
       SET "requiredThrough" = ${sqlValue(REQUIRED_FROM)}
       WHERE "id" = ${sqlValue(rows[0].id)}`,
      '55000',
      'insurance_evidence_immutable',
    );
    expectDatabaseError(
      `DELETE FROM "insurance_eligibility_evidences" WHERE "id" = ${sqlValue(rows[1].id)}`,
      '55000',
      'insurance_evidence_immutable',
    );
  });

  it('enforces one evidence per owner with exact 23505 partial-index identities', () => {
    const registration = selfRegistrationRow();
    runPsql(`${evidenceInsertSql(registration)};`);
    expectDatabaseError(
      evidenceInsertSql(
        teamRegistrationRow({ activityRegistrationId: registration.activityRegistrationId }),
      ),
      '23505',
      'insurance_evidence_activity_registration_unique',
    );

    const join = selfJoinRow();
    runPsql(`${evidenceInsertSql(join)};`);
    expectDatabaseError(
      evidenceInsertSql(teamJoinRow({ teamJoinApplicationId: join.teamJoinApplicationId })),
      '23505',
      'insurance_evidence_team_join_application_unique',
    );
  });

  it('applies the frozen UPDATE/DELETE priority matrix exactly', () => {
    const base = selfRegistrationRow();
    runPsql(`${evidenceInsertSql(base)};`);

    const cases: Array<[string, DatabaseErrorIdentity]> = [
      [
        `UPDATE "insurance_eligibility_evidences"
         SET "teamInsuranceCoverageId" = ${sqlValue(fixture.teamCoverageAId)}
         WHERE "id" = ${sqlValue(base.id)}`,
        { sqlState: '55000', constraint: 'insurance_evidence_immutable' },
      ],
      [
        `UPDATE "insurance_eligibility_evidences"
         SET "activityRegistrationId" = ${sqlValue(fixture.registrationBId)}
         WHERE "id" = ${sqlValue(base.id)}`,
        { sqlState: '23514', constraint: 'insurance_evidence_member_match' },
      ],
      [
        `UPDATE "insurance_eligibility_evidences"
         SET "requiredThrough" = ${sqlValue(REQUIRED_FROM)}
         WHERE "id" = ${sqlValue(base.id)}`,
        { sqlState: '55000', constraint: 'insurance_evidence_immutable' },
      ],
      [
        `UPDATE "insurance_eligibility_evidences"
         SET "memberInsuranceId" = ${sqlValue(nextId('missing-update-source'))}
         WHERE "id" = ${sqlValue(base.id)}`,
        { sqlState: '55000', constraint: 'insurance_evidence_immutable' },
      ],
      [
        `DELETE FROM "insurance_eligibility_evidences" WHERE "id" = ${sqlValue(base.id)}`,
        { sqlState: '55000', constraint: 'insurance_evidence_immutable' },
      ],
    ];

    for (const [statement, expected] of cases) {
      expect(captureDatabaseError(statement)).toEqual(expected);
    }
  });

  it('refuses a non-zero complete preflight before adding any constraint', async () => {
    sequence += 1;
    const schemaName = `insurance_constraints_preflight_${process.pid}_${Date.now()}_${sequence}`;
    if (!/^insurance_constraints_preflight_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`unsafe preflight fixture schema: ${schemaName}`);
    }
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const fixtureSql = `
CREATE SCHEMA "${schemaName}";
SET search_path TO "${schemaName}";

CREATE TABLE "member_insurances" (
  "id" TEXT PRIMARY KEY,
  "memberId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "reviewStatusCode" TEXT NOT NULL,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3)
);
CREATE TABLE "team_insurance_policies" ("id" TEXT PRIMARY KEY);
CREATE TABLE "team_insurance_coverages" (
  "id" TEXT PRIMARY KEY,
  "policyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL
);
CREATE TABLE "ActivityRegistration" ("id" TEXT PRIMARY KEY, "memberId" TEXT NOT NULL);
CREATE TABLE "team_join_applications" ("id" TEXT PRIMARY KEY, "memberId" TEXT NOT NULL);
CREATE TABLE "insurance_eligibility_evidences" (
  "id" TEXT PRIMARY KEY,
  "sourceKind" TEXT,
  "memberInsuranceId" TEXT,
  "teamInsuranceCoverageId" TEXT,
  "ownerKind" TEXT,
  "activityRegistrationId" TEXT,
  "teamJoinApplicationId" TEXT,
  "sourceRevision" INTEGER,
  "sourceReviewedByUserId" TEXT,
  "sourceReviewedAt" TIMESTAMP(3),
  "requiredFrom" TIMESTAMP(3),
  "requiredThrough" TIMESTAMP(3),
  "sourceCoverageStart" TIMESTAMP(3),
  "sourceCoverageEnd" TIMESTAMP(3)
);

INSERT INTO "member_insurances" VALUES
  ('self-a', 'member-a', 1, 'verified', 'reviewer', '2027-01-02'),
  ('invalid-member', 'member-a', -1, 'pending', 'reviewer', '2027-01-02');
INSERT INTO "team_insurance_policies" VALUES ('policy-a');
INSERT INTO "team_insurance_coverages" VALUES ('coverage-a', 'policy-a', 'member-a');
INSERT INTO "ActivityRegistration" VALUES
  ('registration-duplicate', 'member-a'),
  ('registration-b-self', 'member-b'),
  ('registration-b-team', 'member-b');
INSERT INTO "team_join_applications" VALUES
  ('join-duplicate', 'member-a'),
  ('join-b-self', 'member-b'),
  ('join-b-team', 'member-b');

INSERT INTO "insurance_eligibility_evidences" ("id") VALUES ('invalid-shape');
INSERT INTO "insurance_eligibility_evidences" VALUES
  ('duplicate-registration-1', 'member_insurance', 'self-a', NULL, 'activity_registration', 'registration-duplicate', NULL, 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('duplicate-registration-2', 'member_insurance', 'self-a', NULL, 'activity_registration', 'registration-duplicate', NULL, 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('duplicate-join-1', 'member_insurance', 'self-a', NULL, 'team_join_application', NULL, 'join-duplicate', 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('duplicate-join-2', 'member_insurance', 'self-a', NULL, 'team_join_application', NULL, 'join-duplicate', 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('mismatch-self-registration', 'member_insurance', 'self-a', NULL, 'activity_registration', 'registration-b-self', NULL, 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('mismatch-team-registration', 'team_insurance_coverage', NULL, 'coverage-a', 'activity_registration', 'registration-b-team', NULL, NULL, NULL, NULL, '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('mismatch-self-join', 'member_insurance', 'self-a', NULL, 'team_join_application', NULL, 'join-b-self', 1, 'reviewer', '2027-01-02', '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31'),
  ('mismatch-team-join', 'team_insurance_coverage', NULL, 'coverage-a', 'team_join_application', NULL, 'join-b-team', NULL, NULL, NULL, '2027-06-10', '2027-06-11', '2027-01-01', '2027-12-31');

${migration}`;

    let failure:
      | {
          message?: string;
          stderr?: string | Buffer;
        }
      | undefined;
    try {
      runPsql(fixtureSql);
    } catch (error) {
      failure = error as typeof failure;
    }

    try {
      expect(failure).toBeDefined();
      const failureText = [
        failure?.message ?? '',
        typeof failure?.stderr === 'string' ? failure.stderr : (failure?.stderr?.toString() ?? ''),
      ].join('\n');
      expect(failureText).toContain('insurance constraints preflight violation');
      for (const label of [
        'member_version',
        'member_review_snapshot',
        'evidence_exactly_one_source',
        'evidence_source_kind',
        'evidence_exactly_one_owner',
        'evidence_owner_kind',
        'evidence_required_interval',
        'evidence_source_interval',
        'evidence_review_snapshot',
        'duplicate_registration_owner',
        'duplicate_join_owner',
        'self_registration_mismatch',
        'team_registration_mismatch',
        'self_join_mismatch',
        'team_join_mismatch',
      ]) {
        expect(failureText).toMatch(new RegExp(`${label}=[1-9][0-9]*`));
      }

      const constraints = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count
         FROM pg_constraint
         WHERE connamespace = $1::regnamespace
           AND (
             conname LIKE 'insurance_evidence_%'
             OR conname IN (
               'member_insurances_version_nonnegative_ck',
               'member_insurances_review_snapshot_ck'
             )
           )`,
        schemaName,
      );
      expect(constraints).toEqual([{ count: 0n }]);
    } finally {
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });
});

import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION_PATH =
  'prisma/migrations/20260723225802_activity_responsibility_workflow_expand/migration.sql';
const BACKFILL_START =
  '-- activity-responsibility-expand:attendance-last-submission-backfill:begin';
const BACKFILL_END = '-- activity-responsibility-expand:attendance-last-submission-backfill:end';
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

describe('activity responsibility workflow PR1 expand migration', () => {
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

  async function createUser(label: string): Promise<string> {
    sequence += 1;
    const user = await prisma.user.create({
      data: {
        username: `activity-workflow-expand-${label}-${sequence}`,
        passwordHash: '$2a$10$activity-workflow-expand-migration',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    return user.id;
  }

  async function createMember(label: string): Promise<string> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `activity-workflow-expand-${label}-${sequence}`,
        displayName: `Activity Workflow Expand ${label}`,
      },
      select: { id: true },
    });
    return member.id;
  }

  async function createActivity(label: string): Promise<string> {
    sequence += 1;
    const organization = await prisma.organization.create({
      data: {
        name: `Activity Workflow Expand Org ${label} ${sequence}`,
        nodeTypeCode: 'team',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Activity Workflow Expand ${label}`,
        activityTypeCode: 'workflow-expand',
        organizationId: organization.id,
        startAt: new Date('2026-08-01T00:00:00.000Z'),
        endAt: new Date('2026-08-01T01:00:00.000Z'),
        location: 'migration fixture',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    return activity.id;
  }

  it('backfills last submission from the existing source for live and soft-deleted sheets', async () => {
    const submitterUserId = await createUser('legacy-submitter');
    const activityId = await createActivity('legacy');
    const submittedAt = new Date('2026-07-20T01:02:03.000Z');

    const live = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        submittedAt,
        statusCode: 'pending',
      },
      select: { id: true },
    });
    const deleted = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        submittedAt,
        statusCode: 'rejected',
        deletedAt: new Date('2026-07-21T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const start = migration.indexOf(BACKFILL_START);
    const end = migration.indexOf(BACKFILL_END, start + BACKFILL_START.length);
    if (start < 0 || end < 0) {
      throw new Error('attendance last-submission backfill markers disappeared');
    }
    const backfill = migration.slice(start + BACKFILL_START.length, end).trim();
    expect(backfill).not.toContain('"deletedAt"');
    await prisma.$executeRawUnsafe(backfill);

    const rows = await prisma.attendanceSheet.findMany({
      where: { id: { in: [live.id, deleted.id] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        deletedAt: true,
        lastSubmittedByUserId: true,
        lastSubmittedAt: true,
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.deletedAt !== null)).toBe(true);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: live.id,
          lastSubmittedByUserId: submitterUserId,
          lastSubmittedAt: submittedAt,
        }),
        expect.objectContaining({
          id: deleted.id,
          lastSubmittedByUserId: submitterUserId,
          lastSubmittedAt: submittedAt,
        }),
      ]),
    );
  });

  it('keeps legacy-facing columns additive and installs all RESTRICT foreign keys', async () => {
    const columns = await prisma.$queryRaw<
      Array<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >`
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (
          (table_name = 'Activity' AND column_name IN (
            'initiatorMemberId',
            'workflowRevision',
            'attendanceDeclaredCompleteAt',
            'attendanceDeclaredCompleteByUserId'
          ))
          OR
          (table_name = 'AttendanceSheet' AND column_name IN (
            'lastSubmittedByUserId',
            'lastSubmittedAt',
            'returnedByUserId',
            'returnedAt',
            'returnNote',
            'returnedFromStageCode'
          ))
        )
      ORDER BY table_name, column_name
    `;
    expect(columns).toHaveLength(10);
    expect(
      columns
        .filter((column) => column.column_name !== 'workflowRevision')
        .every((column) => column.is_nullable === 'YES'),
    ).toBe(true);
    expect(columns.find((column) => column.column_name === 'workflowRevision')).toMatchObject({
      is_nullable: 'NO',
      column_default: '0',
    });

    const constraintNames = [
      'Activity_initiatorMemberId_fkey',
      'Activity_attendanceDeclaredCompleteByUserId_fkey',
      'AttendanceSheet_lastSubmittedByUserId_fkey',
      'AttendanceSheet_returnedByUserId_fkey',
      'activity_publish_reviews_activityId_fkey',
      'activity_publish_reviews_submittedByUserId_fkey',
      'activity_publish_reviews_reviewedByUserId_fkey',
      'activity_responsibility_assignments_activityId_fkey',
      'activity_responsibility_assignments_memberId_fkey',
      'activity_responsibility_assignments_assignedByUserId_fkey',
      'activity_responsibility_assignments_endedByUserId_fkey',
    ];
    const foreignKeys = await prisma.$queryRaw<
      Array<{ constraint_name: string; delete_action: string }>
    >`
      SELECT tc.constraint_name, rc.delete_rule AS delete_action
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = current_schema()
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name IN (${Prisma.join(constraintNames)})
      ORDER BY tc.constraint_name
    `;
    expect(foreignKeys).toHaveLength(constraintNames.length);
    expect(foreignKeys.map((row) => row.delete_action)).toEqual(
      Array(constraintNames.length).fill('RESTRICT'),
    );
  });

  it('enforces pending review and active responsibility uniqueness plus row invariants', async () => {
    const activityId = await createActivity('constraints');
    const submitterUserId = await createUser('submitter');
    const ownerMemberId = await createMember('owner');
    const secondMemberId = await createMember('second-owner');

    await prisma.activityPublishReview.create({
      data: {
        activityId,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'pending',
        snapshot: { schemaVersion: 1 },
        submittedByUserId: submitterUserId,
      },
    });
    await expect(
      prisma.activityPublishReview.create({
        data: {
          activityId,
          requestType: 'initial',
          requestVersion: 2,
          baseRevision: 0,
          status: 'pending',
          snapshot: { schemaVersion: 1 },
          submittedByUserId: submitterUserId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId,
        memberId: ownerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: submitterUserId,
        source: 'publish',
      },
    });
    await expect(
      prisma.activityResponsibilityAssignment.create({
        data: {
          activityId,
          memberId: secondMemberId,
          responsibilityType: 'owner',
          canManageRegistrations: true,
          canManageAttendance: true,
          assignedByUserId: submitterUserId,
          source: 'admin',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.activityResponsibilityAssignment.create({
        data: {
          activityId,
          memberId: secondMemberId,
          responsibilityType: 'collaborator',
          canManageRegistrations: false,
          canManageAttendance: false,
          assignedByUserId: submitterUserId,
          source: 'delegation',
        },
      }),
    ).rejects.toBeDefined();
  });

  it('rolls back every expand step when a late statement fails', async () => {
    sequence += 1;
    const schemaName = `activity_workflow_expand_rollback_${process.pid}_${Date.now()}_${sequence}`;
    if (!/^activity_workflow_expand_rollback_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`unsafe rollback fixture schema name: ${schemaName}`);
    }

    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect(migration).toMatch(/(?:^|\n)BEGIN;\n/);
    expect(migration).toMatch(/\nCOMMIT;\s*$/);
    const failingMigration = migration.replace(
      /\nCOMMIT;\s*$/,
      `
DO $activity_workflow_expand_failure$
BEGIN
  RAISE EXCEPTION 'activity workflow expand rollback late failure';
END;
$activity_workflow_expand_failure$;
COMMIT;
`,
    );
    if (failingMigration === migration) {
      throw new Error('activity workflow migration COMMIT disappeared before rollback injection');
    }

    const fixtureSql = `
CREATE SCHEMA "${schemaName}";
SET search_path TO "${schemaName}";

CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
CREATE TABLE "Member" ("id" TEXT PRIMARY KEY);
CREATE TABLE "Activity" ("id" TEXT PRIMARY KEY);
CREATE TABLE "AttendanceSheet" (
  "id" TEXT PRIMARY KEY,
  "submitterUserId" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL
);

${failingMigration}`;

    try {
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
      expect(failureText).toContain('activity workflow expand rollback late failure');

      const addedColumns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND column_name IN (
             'initiatorMemberId',
             'workflowRevision',
             'lastSubmittedByUserId',
             'returnedByUserId'
           )
         ORDER BY column_name`,
        schemaName,
      );
      expect(addedColumns).toEqual([]);

      const createdTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name IN (
             'activity_publish_reviews',
             'activity_responsibility_assignments'
           )
         ORDER BY table_name`,
        schemaName,
      );
      expect(createdTables).toEqual([]);
    } finally {
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });
});

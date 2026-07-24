import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  MemberStatus,
  PositionCategory,
  PrincipalType,
  Role,
} from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const PREFLIGHT_SQL_PATH = path.resolve('docs/ops/activity-responsibility-workflow-preflight.sql');
const POSTGRES_CONTAINER = 'u-nest-api-postgres';

interface PreflightSummary {
  legacyDraftWithoutInitiator: number;
  legacyPublishedWithoutOwner: number;
  activeOwnerProjectionGaps: number;
  activityPublishReviewerBindings: number;
  attendanceFirstReviewerBindings: number;
  attendanceFinalReviewerBindings: number;
  dataReadyForContract: boolean;
}

interface PreflightOutput {
  summary: PreflightSummary;
  legacyGaps: Array<{
    activityId: string;
    organizationId: string;
    statusCode: 'draft' | 'published';
    requiredAction: 'assign-initiator' | 'claim';
  }>;
}

function runPreflight(): PreflightOutput {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const sql = readFileSync(PREFLIGHT_SQL_PATH, 'utf8');
  const output = execFileSync(
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
      deriveTestDbName(),
    ],
    {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summaryLine = lines.find((line) => line.startsWith('summary|'));
  if (!summaryLine) throw new Error(`rollout preflight returned no summary: ${output}`);
  return {
    summary: JSON.parse(summaryLine.slice('summary|'.length)) as PreflightSummary,
    legacyGaps: lines
      .filter((line) => line.startsWith('legacy-gap|'))
      .map(
        (line) =>
          JSON.parse(line.slice('legacy-gap|'.length)) as PreflightOutput['legacyGaps'][number],
      ),
  };
}

describe('activity responsibility workflow PR10 rollout drill', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let organizationId: string;
  let draftActivityId: string;
  let publishedActivityId: string;
  let terminalActivityIds: string[];
  let ownerMemberId: string;
  let reviewerRoleIds: Record<string, string>;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await seedActivityResponsibilitySystemRoles(app);

    const admin = await createTestUser(app, {
      username: 'activity-rollout-super-admin',
      role: Role.SUPER_ADMIN,
    });
    adminAuth = (await loginAs(app, admin.username)).authHeader;

    const organization = await prisma.organization.create({
      data: {
        name: '活动责任切换演练组织',
        nodeTypeCode: 'activity-rollout-root',
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.create({
      data: { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
    });

    const owner = await createFormalMember('owner');
    ownerMemberId = owner.memberId;

    const [draft, published, completed, cancelled] = await Promise.all([
      createLegacyActivity('draft'),
      createLegacyActivity('published'),
      createLegacyActivity('completed'),
      createLegacyActivity('cancelled'),
    ]);
    draftActivityId = draft.id;
    publishedActivityId = published.id;
    terminalActivityIds = [completed.id, cancelled.id];

    reviewerRoleIds = {};
    for (const code of [
      'activity-publish-reviewer',
      'attendance-first-reviewer',
      'attendance-final-reviewer',
    ]) {
      const role = await prisma.rbacRole.upsert({
        where: { code },
        create: { code, displayName: code },
        update: { deletedAt: null },
        select: { id: true },
      });
      reviewerRoleIds[code] = role.id;
    }
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createFormalMember(label: string): Promise<{
    memberId: string;
    userId: string;
  }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `activity-rollout-${label}-${sequence}`,
        displayName: `活动切换演练 ${label} ${sequence}`,
        gradeCode: `level-${(sequence % 7) + 1}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `activity-rollout-${label}-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id },
    });
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: member.id,
        organizationId,
      },
    });
    return { memberId: member.id, userId: user.id };
  }

  async function createLegacyActivity(
    statusCode: 'draft' | 'published' | 'completed' | 'cancelled',
  ): Promise<{ id: string }> {
    sequence += 1;
    return prisma.activity.create({
      data: {
        title: `活动责任切换演练 ${statusCode} ${sequence}`,
        activityTypeCode: 'activity-responsibility-rollout',
        organizationId,
        startAt: new Date('2099-12-01T01:00:00.000Z'),
        endAt: new Date('2099-12-01T05:00:00.000Z'),
        location: '深圳',
        statusCode,
      },
      select: { id: true },
    });
  }

  async function configureDistinctReviewers(): Promise<void> {
    const position = await prisma.organizationPosition.create({
      data: {
        code: 'activity-rollout-reviewer',
        name: '活动切换演练审核员',
        categoryCode: PositionCategory.STAFF,
        allowMultiple: true,
      },
      select: { id: true },
    });
    const roleCodes = [
      'activity-publish-reviewer',
      'attendance-first-reviewer',
      'attendance-final-reviewer',
    ] as const;
    for (const roleCode of roleCodes) {
      const reviewer = await createFormalMember(roleCode);
      const assignment = await prisma.organizationPositionAssignment.create({
        data: {
          organizationId,
          positionId: position.id,
          memberId: reviewer.memberId,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          appointmentSource: 'activity-responsibility-rollout-drill',
        },
        select: { id: true },
      });
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.POSITION_ASSIGNMENT,
          principalId: assignment.id,
          roleId: reviewerRoleIds[roleCode],
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: organizationId,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          note: 'activity-responsibility-rollout-drill',
        },
      });
    }
  }

  it('read-only SQL reports only non-terminal legacy gaps and never mutates data', async () => {
    const before = {
      activities: await prisma.activity.count(),
      responsibilities: await prisma.activityResponsibilityAssignment.count(),
      roleBindings: await prisma.roleBinding.count(),
      audits: await prisma.auditLog.count(),
    };

    const result = runPreflight();

    expect(result.summary).toEqual({
      legacyDraftWithoutInitiator: 1,
      legacyPublishedWithoutOwner: 1,
      activeOwnerProjectionGaps: 0,
      activityPublishReviewerBindings: 0,
      attendanceFirstReviewerBindings: 0,
      attendanceFinalReviewerBindings: 0,
      dataReadyForContract: false,
    });
    expect(result.legacyGaps).toEqual([
      {
        activityId: draftActivityId,
        organizationId,
        statusCode: 'draft',
        requiredAction: 'assign-initiator',
      },
      {
        activityId: publishedActivityId,
        organizationId,
        statusCode: 'published',
        requiredAction: 'claim',
      },
    ]);
    expect(result.legacyGaps.map((gap) => gap.activityId)).not.toEqual(
      expect.arrayContaining(terminalActivityIds),
    );
    await expect(
      Promise.all([
        prisma.activity.count(),
        prisma.activityResponsibilityAssignment.count(),
        prisma.roleBinding.count(),
        prisma.auditLog.count(),
      ]),
    ).resolves.toEqual([
      before.activities,
      before.responsibilities,
      before.roleBindings,
      before.audits,
    ]);
  });

  it('drills explicit assign/claim and reaches dataReadyForContract with reviewer bindings', async () => {
    const assign = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${draftActivityId}/responsibilities/assign-initiator`)
      .set('Authorization', adminAuth)
      .send({ memberId: ownerMemberId, reason: 'PR-10 测试库历史 draft 发起人演练' });
    expect(assign.status).toBe(200);
    expect(assign.body.data.initiator.id).toBe(ownerMemberId);

    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${publishedActivityId}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId, reason: 'PR-10 测试库历史 published owner 演练' });
    expect(claim.status).toBe(200);
    expect(claim.body.data.memberId).toBe(ownerMemberId);

    await configureDistinctReviewers();
    const result = runPreflight();

    expect(result.summary).toEqual({
      legacyDraftWithoutInitiator: 0,
      legacyPublishedWithoutOwner: 0,
      activeOwnerProjectionGaps: 0,
      activityPublishReviewerBindings: 1,
      attendanceFirstReviewerBindings: 1,
      attendanceFinalReviewerBindings: 1,
      dataReadyForContract: true,
    });
    expect(result.legacyGaps).toEqual([]);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalType: PrincipalType.MEMBER,
          principalId: ownerMemberId,
          scopeType: BindingScopeType.ACTIVITY,
          scopeActivityId: publishedActivityId,
          status: 'ACTIVE',
          deletedAt: null,
          role: { code: 'activity-owner' },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.auditLog.count({
        where: {
          resourceType: 'activity',
          resourceId: { in: [draftActivityId, publishedActivityId] },
          event: 'activity.publish',
        },
      }),
    ).resolves.toBe(2);
  });
});

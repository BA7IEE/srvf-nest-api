import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role, type Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import {
  fingerprintTimePolicyVersion,
  type TimePolicyDefinition,
} from '../../src/modules/activities/activity-time-policy-definition';
import type { ActivityTimePolicyPointer } from '../../src/modules/activities/activity-time-policy-selection';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from './member-identity.fixture';
import { httpServer } from './http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

export const D13_APP = '/api/app/v1/my/managed-activities';
export const D13_ADMIN = '/api/admin/v1';

export interface D13Fixture {
  readonly app: INestApplication;
  readonly db: PrismaService;
  readonly creator: { readonly id: string; readonly memberId: string; readonly auth: string };
  readonly reviewer: { readonly id: string; readonly memberId: string; readonly auth: string };
  readonly organizationId: string;
  readonly key: (label: string) => string;
}

export interface D13Draft {
  readonly activityId: string;
  readonly sessionId: string;
  readonly positionId: string | null;
}

export interface D13PolicyEffectiveWindow {
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

const TIME_POLICY_SELECTION_PERMISSIONS = [
  'activity.time-policy.read',
  'activity.time-policy.select',
] as const;

const REVIEWER_PERMISSIONS = [
  'activity-review.read.request',
  'activity-review.return.request',
  'activity.publish.record',
] as const;

const DEFAULT_POLICY_DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: false,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 1 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: false },
};

async function grantOrganizationPermissions(
  fixture: Pick<D13Fixture, 'db' | 'organizationId' | 'key'>,
  userId: string,
  codes: readonly string[],
): Promise<void> {
  for (const code of codes) {
    await fixture.db.permission.upsert({
      where: { code },
      create: {
        code,
        module: code.startsWith('activity-review') ? 'activity-review' : 'activity-time-policy',
        action: code.split('.').at(-1) ?? 'read',
        resourceType: code.startsWith('activity-review') ? 'request' : 'activity',
      },
      update: {},
    });
  }
  const role = await fixture.db.rbacRole.create({
    data: { code: fixture.key('role'), displayName: 'D1-3 精确授权测试角色' },
  });
  const permissions = await fixture.db.permission.findMany({
    where: { code: { in: [...codes] } },
    select: { id: true },
  });
  if (permissions.length !== codes.length) throw new Error('D1-3 permission fixture is incomplete');
  await fixture.db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  await fixture.db.roleBinding.create({
    data: {
      principalType: PrincipalType.USER,
      principalId: userId,
      roleId: role.id,
      scopeType: BindingScopeType.ORGANIZATION,
      scopeOrgId: fixture.organizationId,
    },
  });
}

export async function createD13Fixture(): Promise<D13Fixture> {
  const app = await createTestApp();
  await resetDb(app);
  const db = app.get(PrismaService);
  const prefix = `d13_${randomBytes(5).toString('hex')}`;
  let sequence = 0;
  const key = (label: string): string => `${prefix}_${label}_${++sequence}`;

  const creatorUser = await createTestUser(app, {
    username: key('creator'),
    role: Role.SUPER_ADMIN,
  });
  const reviewerUser = await createTestUser(app, { username: key('reviewer'), role: Role.USER });
  const creatorMember = await db.member.create({
    data: {
      memberNo: key('creator_member'),
      ...memberIdentityData('D1-3 发起人'),
      gradeCode: 'level-3',
    },
  });
  const reviewerMember = await db.member.create({
    data: {
      memberNo: key('reviewer_member'),
      ...memberIdentityData('D1-3 审核人'),
      gradeCode: 'level-3',
    },
  });
  await db.user.update({ where: { id: creatorUser.id }, data: { memberId: creatorMember.id } });
  await db.user.update({ where: { id: reviewerUser.id }, data: { memberId: reviewerMember.id } });

  const root = await db.organization.create({
    data: { name: key('root'), nodeTypeCode: key('root_type') },
  });
  const organization = await db.organization.create({
    data: { name: key('organization'), nodeTypeCode: key('team_type'), parentId: root.id },
  });
  await db.organizationClosure.createMany({
    data: [
      { ancestorId: root.id, descendantId: root.id, depth: 0 },
      { ancestorId: root.id, descendantId: organization.id, depth: 1 },
      { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
    ],
  });
  await db.memberOrganizationMembership.create({
    data: { memberId: creatorMember.id, organizationId: organization.id },
  });
  await db.memberOrganizationMembership.create({
    data: { memberId: reviewerMember.id, organizationId: organization.id },
  });

  const type = await db.dictType.create({
    data: { code: 'activity_type', label: 'D1-3 活动类型' },
  });
  await db.dictItem.create({
    data: { typeId: type.id, code: 'event_support', label: '活动保障' },
  });
  const attendanceRole = await db.dictType.create({
    data: { code: 'attendance_role', label: 'D1-3 考勤角色' },
  });
  await db.dictItem.create({
    data: { typeId: attendanceRole.id, code: 'service', label: 'D1-3 服务岗位' },
  });

  const fixture = {
    app,
    db,
    organizationId: organization.id,
    key,
  } satisfies Pick<D13Fixture, 'app' | 'db' | 'organizationId' | 'key'>;
  const bizAdmin = await seedBizAdminPermissionsAndRole(app);
  await seedActivityResponsibilitySystemRoles(app);
  await grantBizAdminToUser(app, creatorUser.id, bizAdmin.bizAdminRoleId);
  await grantOrganizationPermissions(fixture, creatorUser.id, TIME_POLICY_SELECTION_PERMISSIONS);
  await grantOrganizationPermissions(fixture, reviewerUser.id, REVIEWER_PERMISSIONS);

  return {
    ...fixture,
    creator: {
      id: creatorUser.id,
      memberId: creatorMember.id,
      auth: (await loginAs(app, creatorUser.username)).authHeader,
    },
    reviewer: {
      id: reviewerUser.id,
      memberId: reviewerMember.id,
      auth: (await loginAs(app, reviewerUser.username)).authHeader,
    },
  };
}

export async function closeD13Fixture(fixture: D13Fixture | undefined): Promise<void> {
  await fixture?.app.close();
}

export async function createD13ActivePolicy(
  fixture: D13Fixture,
  definition: TimePolicyDefinition = DEFAULT_POLICY_DEFINITION,
  window: D13PolicyEffectiveWindow = {
    effectiveFrom: '2098-01-01T00:00:00.000Z',
    effectiveUntil: '2101-01-01T00:00:00.000Z',
  },
): Promise<ActivityTimePolicyPointer> {
  const document = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    definition,
    evaluatorVersion: 1,
    effectiveFrom: window.effectiveFrom,
    effectiveUntil: window.effectiveUntil,
  });
  const policy = await fixture.db.timePolicy.create({
    data: { code: fixture.key('policy'), name: 'D1-3 时长政策' },
  });
  const draftVersion = await fixture.db.timePolicyVersion.create({
    data: {
      policyId: policy.id,
      version: 1,
      schemaVersion: document.schemaVersion,
      definitionJson: document.definition as unknown as Prisma.InputJsonValue,
      definitionHash: document.definitionHash,
      evaluatorVersion: document.evaluatorVersion,
      effectiveFrom: new Date(document.effectiveFrom),
      effectiveUntil: document.effectiveUntil === null ? null : new Date(document.effectiveUntil),
      statusCode: 'draft',
      activatedAt: null,
    },
  });
  const version = await fixture.db.timePolicyVersion.update({
    where: { id: draftVersion.id },
    data: { statusCode: 'active', activatedAt: new Date() },
  });
  return { policyId: policy.id, versionId: version.id, definitionHash: version.definitionHash };
}

export async function createD13Draft(
  fixture: D13Fixture,
  options: { withPosition?: boolean } = {},
): Promise<D13Draft> {
  const activity = await request(httpServer(fixture.app))
    .post(`${D13_ADMIN}/activities`)
    .set('Authorization', fixture.creator.auth)
    .send({
      title: fixture.key('activity'),
      activityTypeCode: 'event_support',
      allocationModeCode: 'first_come',
      organizationId: fixture.organizationId,
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T10:00:00.000Z',
      registrationDeadline: '2099-08-31T12:00:00.000Z',
      location: 'D1-3 集合点',
      visibilityCode: 'internal',
      isPublicRegistration: true,
    })
    .expect(201);
  const activityId = activity.body.data.id as string;
  // The legacy Admin creator intentionally has no App initiator identity.  D1-3's managed surface
  // is explicitly limited to the active initiating member, so this fixture models that persisted
  // ownership fact before exercising its standalone selection command.
  await fixture.db.activity.update({
    where: { id: activityId },
    data: { initiatorMemberId: fixture.creator.memberId },
  });
  const session = await request(httpServer(fixture.app))
    .post(`${D13_APP}/${activityId}/sessions`)
    .set('Authorization', fixture.creator.auth)
    .send({
      code: fixture.key('session'),
      name: 'D1-3 场次',
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T10:00:00.000Z',
      locationText: 'D1-3 集合点',
      checkInOpenAt: '2099-09-01T07:30:00.000Z',
      checkInCloseAt: '2099-09-01T08:30:00.000Z',
      checkOutOpenAt: '2099-09-01T09:00:00.000Z',
      checkOutCloseAt: '2099-09-01T10:00:00.000Z',
      locationRequired: false,
    })
    .expect(201);
  const sessionId = session.body.data.sessionId as string;
  if (!options.withPosition) return { activityId, sessionId, positionId: null };
  const position = await request(httpServer(fixture.app))
    .post(`${D13_APP}/${activityId}/sessions/${sessionId}/positions`)
    .set('Authorization', fixture.creator.auth)
    .send({
      code: fixture.key('position'),
      name: 'D1-3 岗位',
      attendanceRoleCode: 'service',
      capacity: 10,
      startAt: '2099-09-01T08:30:00.000Z',
      endAt: '2099-09-01T09:30:00.000Z',
    })
    .expect(201);
  return { activityId, sessionId, positionId: position.body.data.positionId as string };
}

/** V8 keeps the existing V7 metric contract.  This helper uses the real App command rather than
 * mutating Activity fields, so a time-policy proposal is exercised with a publishable metric
 * selection exactly as a client would prepare it. */
export async function selectD13MetricNotRequired(
  fixture: D13Fixture,
  activityId: string,
): Promise<void> {
  await request(httpServer(fixture.app))
    .put(`${D13_APP}/${activityId}/metric-selection`)
    .set('Authorization', fixture.creator.auth)
    .send({
      operationKey: fixture.key('metric_not_required'),
      expectedRevision: 0,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
    })
    .expect(200);
}

export function explicitTimePolicyChange(
  pointer: ActivityTimePolicyPointer,
  scope: {
    layerCode: 'activity' | 'session' | 'position';
    sessionId: string | null;
    positionId: string | null;
  },
) {
  return { scope, selection: { mode: 'explicit' as const, pointer } };
}

export function inheritTimePolicyChange(scope: {
  layerCode: 'activity' | 'session' | 'position';
  sessionId: string | null;
  positionId: string | null;
}) {
  return { scope, selection: { mode: 'inherit' as const, pointer: null } };
}

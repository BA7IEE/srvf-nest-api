import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityAuditRecorder } from '../../src/modules/activities/activity-audit-recorder';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import type { CreateActivityFromTemplateCommand } from '../../src/modules/activities/activity-from-template.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const META: AuditMeta = {
  requestId: 'activity-os-r1-a6-e2e',
  ip: '127.0.0.1',
  ua: 'jest',
};
const MIGRATION_PATH =
  'prisma/migrations/20260902143000_activity_os_r1_a6_from_template_transaction/migration.sql';

type TemplateFixture = {
  id: string;
  definitionHash: string;
};

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity: {
      allocationModeCode: 'first_come',
      description: '来自模板的默认说明',
      capacity: 30,
      genderRequirementCode: 'all',
      registrationNotes: '请按时到达集合点',
      isPublicRegistration: false,
      requiresInsurance: true,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: null,
      archiveWaitingDays: 7,
    },
    sessions: [
      {
        code: 'morning',
        name: '上午场',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: 'A6 集合点',
        capacity: 20,
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 30,
        checkOutOpenOffsetMinutes: -30,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 10,
        earlyLeaveThresholdMinutes: 10,
        sortOrder: 2,
        positions: [
          {
            code: 'support',
            name: '现场保障',
            attendanceRoleCode: 'support',
            capacity: 5,
            startOffsetMinutes: 0,
            endOffsetMinutes: 120,
            genderRequirementCode: 'all',
            locationRequired: null,
            description: '负责现场秩序',
            equipmentNotes: '携带手套',
            sortOrder: 3,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function hashFor(definitionJson: Record<string, unknown>): string {
  return computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition: definitionJson });
}

async function waitForTemplateLockWaiters(
  observer: PrismaService,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "ActivityTemplate"%FOR UPDATE%'
        AND pid <> pg_backend_pid()
    `);
    if (rows.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected ${expected} ActivityTemplate row-lock waiters in the current test database`,
  );
}

describe('Activity OS R1 A6 从模板创建活动事务', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let activities: ActivitiesService;
  let activitiesB: ActivitiesService;
  let currentUser: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const unique = (label: string) => `activity-os-r1-a6-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    activities = app.get(ActivitiesService);
    activitiesB = appB.get(ActivitiesService);
  });

  afterAll(async () => {
    await Promise.all([app.close(), appB.close()]);
  });

  beforeEach(async () => {
    await resetDb(app);
    // resetDb 不主动清可独立存在的 Template / Family；本 spec 每例都建自己的闭合 fixture。
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
      select: { id: true, code: true },
    });
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const genderRequirement = await prisma.dictType.create({
      data: { code: 'gender_requirement', label: '性别要求' },
      select: { id: true },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: nodeType.id, code: unique('root-node'), label: '根节点' },
        { typeId: nodeType.id, code: unique('child-node'), label: '子节点' },
        { typeId: activityType.id, code: 'template-training', label: '模板训练' },
        { typeId: genderRequirement.id, code: 'all', label: '不限' },
        { typeId: attendanceRole.id, code: 'support', label: '保障' },
      ],
    });
    const nodeItems = await prisma.dictItem.findMany({
      where: { typeId: nodeType.id },
      select: { code: true },
      orderBy: { createdAt: 'asc' },
    });
    const [rootNode, childNode] = nodeItems;
    if (!rootNode || !childNode) throw new Error('A6 organization node fixture is incomplete');
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: rootNode.code },
      select: { id: true },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: unique('child'), nodeTypeCode: childNode.code, parentId: root.id },
        select: { id: true },
      })
    ).id;
  });

  function command(
    templateVersionId: string,
    overrides: Partial<CreateActivityFromTemplateCommand> = {},
  ) {
    return {
      templateVersionId,
      title: 'A6 模板创建活动',
      organizationId,
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T12:00:00.000Z',
      location: 'A6 活动集合点',
      registrationDeadline: '2099-09-01T07:30:00.000Z',
      operationKey: unique('operation'),
      ...overrides,
    } satisfies CreateActivityFromTemplateCommand;
  }

  async function createTemplate(
    options: {
      readonly status?: 'draft' | 'active' | 'retired';
      readonly definitionJson?: Record<string, unknown>;
      readonly definitionHash?: string;
      readonly family?: boolean;
    } = {},
  ): Promise<TemplateFixture> {
    const definitionJson = options.definitionJson ?? definition();
    const family =
      options.family === false
        ? null
        : await prisma.activityTemplateFamily.create({
            data: {
              code: unique('family-code'),
              name: unique('family-name'),
              categoryCode: 'training',
              scopeTypeCode: 'organization',
              statusCode: 'inventory',
            },
            select: { id: true },
          });
    const created = await prisma.activityTemplate.create({
      data: {
        code: unique('template-code'),
        name: unique('template-name'),
        activityTypeCode: 'template-training',
        statusCode: family === null ? 'legacy' : 'draft',
        version: 1,
        familyId: family?.id,
        schemaVersion: family === null ? null : 1,
        definitionJson:
          family === null ? Prisma.DbNull : (definitionJson as unknown as Prisma.InputJsonValue),
        definitionHash:
          family === null ? null : (options.definitionHash ?? hashFor(definitionJson)),
        effectiveFrom: family === null ? null : new Date('2099-01-01T00:00:00.000Z'),
      },
      select: { id: true, definitionHash: true },
    });
    if (options.status === 'active' || options.status === 'retired') {
      await prisma.activityTemplate.update({
        where: { id: created.id },
        data: { statusCode: 'active' },
      });
    }
    if (options.status === 'retired') {
      await prisma.activityTemplate.update({
        where: { id: created.id },
        data: { statusCode: 'retired' },
      });
    }
    return { id: created.id, definitionHash: created.definitionHash ?? '' };
  }

  async function writeCounts() {
    const [activitiesCount, sessionsCount, positionsCount, auditsCount] = await Promise.all([
      prisma.activity.count(),
      prisma.activitySession.count(),
      prisma.activitySessionPosition.count(),
      prisma.auditLog.count(),
    ]);
    return { activitiesCount, sessionsCount, positionsCount, auditsCount };
  }

  it('active future Version 在单事务内复制草稿、场次、岗位并写入安全审计', async () => {
    const template = await createTemplate({ status: 'active' });

    const created = await activities.createFromTemplate(command(template.id), currentUser, META);

    expect(created).toMatchObject({ title: 'A6 模板创建活动', statusCode: 'draft' });
    expect(created).not.toHaveProperty('selectedTemplateVersionId');
    expect(created).not.toHaveProperty('createFromTemplateOperationKey');
    expect(created).not.toHaveProperty('createFromTemplateRequestHash');

    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: created.id },
      select: {
        selectedTemplateVersionId: true,
        createFromTemplateOperationKey: true,
        createFromTemplateRequestHash: true,
        activityTypeCode: true,
        allocationModeCode: true,
        statusCode: true,
        description: true,
        capacity: true,
        registrationSchema: true,
        content: true,
      },
    });
    expect(activity).toMatchObject({
      selectedTemplateVersionId: template.id,
      activityTypeCode: 'template-training',
      allocationModeCode: 'first_come',
      statusCode: 'draft',
      description: '来自模板的默认说明',
      capacity: 30,
      registrationSchema: null,
      content: null,
    });
    expect(activity.createFromTemplateOperationKey).toBeDefined();
    expect(activity.createFromTemplateRequestHash).toMatch(/^[a-f0-9]{64}$/);

    const [session] = await prisma.activitySession.findMany({
      where: { activityId: created.id },
      select: {
        id: true,
        code: true,
        locationPolicySourceCode: true,
        locationRequired: true,
        longitude: true,
        latitude: true,
        sortOrder: true,
      },
    });
    expect(session).toMatchObject({
      code: 'morning',
      locationPolicySourceCode: 'template',
      locationRequired: false,
      longitude: null,
      latitude: null,
      sortOrder: 2,
    });
    if (!session) throw new Error('A6 materialized session is missing');
    const [position] = await prisma.activitySessionPosition.findMany({
      where: { activityId: created.id, sessionId: session.id },
      select: { code: true, attendanceRoleCode: true, leaderMemberId: true, sortOrder: true },
    });
    expect(position).toEqual({
      code: 'support',
      attendanceRoleCode: 'support',
      leaderMemberId: null,
      sortOrder: 3,
    });

    const [audit] = await prisma.auditLog.findMany({
      where: { resourceType: 'activity', resourceId: created.id, event: 'activity.publish' },
      select: { context: true },
    });
    if (!audit) throw new Error('A6 create audit is missing');
    expect(audit.context).toMatchObject({
      extra: {
        operation: 'create_from_template',
        templateVersionId: template.id,
        definitionHash: template.definitionHash,
        nextStatusCode: 'draft',
      },
    });
    expect(JSON.stringify(audit.context)).not.toMatch(/operationkey|definitionjson|requesthash/i);
  });

  it('相同 operationKey 在模板退休后仍只回放首次 Activity，不再产生写入或审计', async () => {
    const template = await createTemplate({ status: 'active' });
    const input = command(template.id);
    const first = await activities.createFromTemplate(input, currentUser, META);
    await prisma.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'retired' },
    });

    const replay = await activities.createFromTemplate(input, currentUser, META);

    expect(replay.id).toBe(first.id);
    expect(await writeCounts()).toEqual({
      activitiesCount: 1,
      sessionsCount: 1,
      positionsCount: 1,
      auditsCount: 1,
    });
  });

  it('draft、retired、legacy、hash 不一致及越出 V1 的 Version 均拒绝且零写入', async () => {
    const draft = await createTemplate({ status: 'draft' });
    const retired = await createTemplate({ status: 'retired' });
    const legacy = await createTemplate({ family: false });
    const mismatchedHash = await createTemplate({
      status: 'active',
      definitionHash: 'b'.repeat(64),
    });
    const invalidLocationDefinition = definition({
      sessions: [
        {
          ...(definition().sessions as Array<Record<string, unknown>>)[0],
          locationRequired: true,
        },
      ],
    });
    const invalidLocation = await createTemplate({
      status: 'active',
      definitionJson: invalidLocationDefinition,
    });

    for (const template of [draft, retired, legacy, mismatchedHash, invalidLocation]) {
      await expect(
        activities.createFromTemplate(command(template.id), currentUser, META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE });
    }
    expect(await writeCounts()).toEqual({
      activitiesCount: 0,
      sessionsCount: 0,
      positionsCount: 0,
      auditsCount: 0,
    });
  });

  it('审计失败时回滚 Activity、Session、Position 与 audit，不留下半成品', async () => {
    const template = await createTemplate({ status: 'active' });
    const recorder = app.get(ActivityAuditRecorder);
    const failure = jest
      .spyOn(recorder, 'logCreateFromTemplate')
      .mockRejectedValueOnce(new Error('forced A6 audit failure'));

    try {
      await expect(
        activities.createFromTemplate(command(template.id), currentUser, META),
      ).rejects.toThrow('forced A6 audit failure');
    } finally {
      failure.mockRestore();
    }

    expect(await writeCounts()).toEqual({
      activitiesCount: 0,
      sessionsCount: 0,
      positionsCount: 0,
      auditsCount: 0,
    });
  });

  it('两套 Nest / Prisma pool 在 Template Version 行锁后真并发，同 key 收敛为一条 Activity 与一条审计', async () => {
    expect(prisma).not.toBe(prismaB);
    const [[backendA], [backendB]] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(backendA?.pid).not.toBe(backendB?.pid);

    const template = await createTemplate({ status: 'active' });
    const input = command(template.id);
    let signalBlockerReady!: (pid: number) => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<number>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      if (!backend) throw new Error('template lock blocker has no PostgreSQL backend pid');
      await tx.$queryRaw`
        SELECT "id" FROM "ActivityTemplate" WHERE "id" = ${template.id} FOR UPDATE
      `;
      signalBlockerReady(backend.pid);
      await blockerRelease;
    });

    await blockerReady;
    const left = activities.createFromTemplate(input, currentUser, META);
    const right = activitiesB.createFromTemplate(input, currentUser, META);
    let barrierError: unknown;
    try {
      await waitForTemplateLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const results = await Promise.allSettled([left, right]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing A6 template-lock interleaving');
    }
    if (results.some((result) => result.status === 'rejected')) {
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      throw rejected?.reason;
    }
    const [leftResult, rightResult] = results;
    if (leftResult?.status !== 'fulfilled' || rightResult?.status !== 'fulfilled') {
      throw new Error('A6 concurrent results did not settle as fulfilled');
    }
    expect(leftResult.value.id).toBe(rightResult.value.id);
    expect(await writeCounts()).toEqual({
      activitiesCount: 1,
      sessionsCount: 1,
      positionsCount: 1,
      auditsCount: 1,
    });
  });

  it('第104条 migration 是原子、纯 expand 的两列与唯一索引，并已落实到测试库', async () => {
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|DROP)\b/im);
    expect(migration).toContain('ADD COLUMN "createFromTemplateOperationKey" TEXT');
    expect(migration).toContain('ADD COLUMN "createFromTemplateRequestHash" TEXT');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "activity_create_from_template_operation_key_key"',
    );

    const columns = await prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Activity'
        AND column_name IN ('createFromTemplateOperationKey', 'createFromTemplateRequestHash')
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      {
        column_name: 'createFromTemplateOperationKey',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'createFromTemplateRequestHash',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'Activity'
        AND indexname = 'activity_create_from_template_operation_key_key'
    `;
    expect(indexes).toEqual([{ indexname: 'activity_create_from_template_operation_key_key' }]);
  });
});

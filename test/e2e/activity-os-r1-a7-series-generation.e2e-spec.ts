import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivitySeriesService } from '../../src/modules/activities/activity-series.service';
import {
  type CreateActivitySeriesCommand,
  type GenerateActivitySeriesInstancesCommand,
} from '../../src/modules/activities/activity-series.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const META: AuditMeta = {
  requestId: 'activity-os-r1-a7-e2e',
  ip: '127.0.0.1',
  ua: 'jest',
};
const MIGRATION_PATH =
  'prisma/migrations/20260902190221_activity_os_r1_a7_series_generation/migration.sql';
const RESET_DB_PATH = 'test/setup/reset-db.ts';

type TemplateFixture = {
  readonly id: string;
  readonly definitionHash: string;
};

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity: {
      allocationModeCode: 'first_come',
      description: 'A7 模板默认说明',
      capacity: 30,
      genderRequirementCode: 'all',
      registrationNotes: 'A7 报名说明',
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
        locationText: 'A7 集合点',
        capacity: 20,
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 30,
        checkOutOpenOffsetMinutes: -30,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 10,
        earlyLeaveThresholdMinutes: 10,
        sortOrder: 1,
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
            description: 'A7 现场保障',
            equipmentNotes: '手套',
            sortOrder: 1,
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

async function waitForSeriesLockWaiters(observer: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%"ActivitySeries"%'
        AND pid <> pg_backend_pid()
    `);
    if (rows.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected ${expected} ActivitySeries row-lock waiters in the current test database`,
  );
}

describe('Activity OS R1 A7 周期 Series 与按需生成', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousActivityV11Workflow = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousIntegrationApi = process.env.INTEGRATION_API_ENABLED;
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let series: ActivitySeriesService;
  let seriesB: ActivitySeriesService;
  let currentUser: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const unique = (label: string) => `activity-os-r1-a7-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    // A7 的生成实例必须绕开 A6 的“调用者就是发起人”规则；这里故意在 workflow 打开时验证。
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    // A8：Series 是内部路径，必须明确证明其不依赖尚未切换的 v1.1 或 Integration 业务面。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'false';
    process.env.INTEGRATION_API_ENABLED = 'false';
    app = await createTestApp();
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    series = app.get(ActivitySeriesService);
    seriesB = appB.get(ActivitySeriesService);
  });

  afterAll(async () => {
    await Promise.all([app.close(), appB.close()]);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
    if (previousActivityV11Workflow === undefined) {
      delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousActivityV11Workflow;
    }
    if (previousIntegrationApi === undefined) {
      delete process.env.INTEGRATION_API_ENABLED;
    } else {
      process.env.INTEGRATION_API_ENABLED = previousIntegrationApi;
    }
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivitySeriesCommandReceipt", "ActivitySeriesOccurrence", "ActivitySeriesRevision", "ActivitySeries" RESTART IDENTITY CASCADE',
    );
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
    // 有意不创建 Member；A7 不得把 Series 创建者写入 generated Activity.initiatorMemberId。
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
    if (!rootNode || !childNode) throw new Error('A7 organization node fixture is incomplete');
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

  async function createTemplate(
    options: {
      readonly status?: 'draft' | 'active' | 'retired';
      readonly definitionJson?: Record<string, unknown>;
      readonly definitionHash?: string;
    } = {},
  ): Promise<TemplateFixture> {
    const definitionJson = options.definitionJson ?? definition();
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
    const template = await prisma.activityTemplate.create({
      data: {
        code: unique('template-code'),
        name: unique('template-name'),
        activityTypeCode: 'template-training',
        statusCode: 'draft',
        version: 1,
        familyId: family.id,
        schemaVersion: 1,
        definitionJson: definitionJson as unknown as Prisma.InputJsonValue,
        definitionHash: options.definitionHash ?? hashFor(definitionJson),
        effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      },
      select: { id: true, definitionHash: true },
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
    return { id: template.id, definitionHash: template.definitionHash ?? '' };
  }

  function createCommand(
    templateVersionId: string,
    overrides: Partial<CreateActivitySeriesCommand> = {},
  ): CreateActivitySeriesCommand {
    return {
      code: unique('series-code'),
      templateVersionId,
      frequencyCode: 'daily',
      interval: 1,
      timeZone: 'Asia/Shanghai',
      localStartDate: '2099-01-01',
      localStartMinute: 9 * 60,
      durationMinutes: 120,
      title: 'A7 周期训练',
      organizationId,
      location: 'A7 集合点',
      registrationDeadlineOffsetMinutes: 60,
      effectiveFromLocalDate: '2099-01-01',
      effectiveToLocalDate: '2099-03-31',
      generationWindowDays: 31,
      operationKey: unique('create-operation'),
      ...overrides,
    };
  }

  function generateCommand(
    seriesId: string,
    overrides: Partial<GenerateActivitySeriesInstancesCommand> = {},
  ): GenerateActivitySeriesInstancesCommand {
    return {
      seriesId,
      revision: 1,
      fromLocalDate: '2099-01-01',
      count: 2,
      operationKey: unique('generate-operation'),
      ...overrides,
    };
  }

  async function counts() {
    const [activities, occurrences, receipts, audits] = await Promise.all([
      prisma.activity.count(),
      prisma.activitySeriesOccurrence.count(),
      prisma.activitySeriesCommandReceipt.count(),
      prisma.auditLog.count(),
    ]);
    return { activities, occurrences, receipts, audits };
  }

  it('创建 Series 后在同一根事务生成独立草稿，责任 workflow 打开时 initiator 仍为空', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    const generated = await series.generate(generateCommand(created.seriesId), currentUser, META);

    expect(created).toEqual({
      seriesId: created.seriesId,
      revision: 1,
      statusCode: 'active',
      activityIds: [],
    });
    expect(generated.activityIds).toHaveLength(2);
    const activities = await prisma.activity.findMany({
      where: { id: { in: [...generated.activityIds] } },
      select: {
        id: true,
        title: true,
        initiatorMemberId: true,
        selectedTemplateVersionId: true,
        statusCode: true,
      },
      orderBy: { startAt: 'asc' },
    });
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'A7 周期训练',
          initiatorMemberId: null,
          selectedTemplateVersionId: template.id,
          statusCode: 'draft',
        }),
      ]),
    );
    expect(await prisma.activitySeriesOccurrence.count()).toBe(2);
    const occurrence = await prisma.activitySeriesOccurrence.findFirstOrThrow({
      where: { activityId: generated.activityIds[0] },
      select: { seriesId: true, revision: { select: { revision: true } }, occurrenceKey: true },
    });
    expect(occurrence).toMatchObject({ seriesId: created.seriesId, revision: { revision: 1 } });
    expect(occurrence.occurrenceKey).toMatch(/^2099-01-0[12]$/);

    const audits = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audits.filter((audit) => audit.event === 'activity-series.change')).toHaveLength(2);
    const generatedAudit = audits.find(
      (audit) =>
        audit.resourceId === generated.activityIds[0] &&
        (audit.context as { extra?: { operation?: string } }).extra?.operation ===
          'generate_series_instance',
    );
    expect(generatedAudit).toBeDefined();
    expect(JSON.stringify(generatedAudit?.context)).not.toMatch(
      /operationkey|requesthash|definitionjson/i,
    );
  });

  it('同 key 重放先于模板当前状态；不同 key 在模板退休后零写入失败', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    const command = generateCommand(created.seriesId);
    const first = await series.generate(command, currentUser, META);
    const beforeReplay = await counts();
    await expect(
      series.generate({ ...command, count: 1 }, currentUser, META),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    expect(await counts()).toEqual(beforeReplay);
    await prisma.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'retired' },
    });

    await expect(series.generate(command, currentUser, META)).resolves.toEqual(first);
    expect(await counts()).toEqual(beforeReplay);
    await expect(
      series.generate(generateCommand(created.seriesId), currentUser, META),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE });
    expect(await counts()).toEqual(beforeReplay);
  });

  it('Revision 只影响尚未生成期，已生成且已发布实例不会被自动改写', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    const first = await series.generate(
      generateCommand(created.seriesId, { count: 1 }),
      currentUser,
      META,
    );
    const firstActivityId = first.activityIds[0];
    if (!firstActivityId) throw new Error('A7 first generated activity is missing');
    await prisma.activity.update({
      where: { id: firstActivityId },
      data: { statusCode: 'published' },
    });

    const revisionInput = createCommand(template.id, {
      localStartDate: '2099-04-01',
      effectiveFromLocalDate: '2099-04-01',
      effectiveToLocalDate: '2099-06-30',
      title: 'A7 修订后的周期训练',
    });
    const revised = await series.revise(
      {
        seriesId: created.seriesId,
        templateVersionId: revisionInput.templateVersionId,
        frequencyCode: revisionInput.frequencyCode,
        interval: revisionInput.interval,
        timeZone: revisionInput.timeZone,
        localStartDate: revisionInput.localStartDate,
        localStartMinute: revisionInput.localStartMinute,
        durationMinutes: revisionInput.durationMinutes,
        title: revisionInput.title,
        organizationId: revisionInput.organizationId,
        location: revisionInput.location,
        registrationDeadlineOffsetMinutes: revisionInput.registrationDeadlineOffsetMinutes,
        effectiveFromLocalDate: revisionInput.effectiveFromLocalDate,
        effectiveToLocalDate: revisionInput.effectiveToLocalDate,
        generationWindowDays: revisionInput.generationWindowDays,
        operationKey: unique('revise-operation'),
      },
      currentUser,
      META,
    );
    const second = await series.generate(
      generateCommand(created.seriesId, {
        revision: revised.revision ?? 0,
        fromLocalDate: '2099-04-01',
        count: 1,
      }),
      currentUser,
      META,
    );
    const secondActivityId = second.activityIds[0];
    if (!secondActivityId) throw new Error('A7 second generated activity is missing');
    const [firstActivity, secondActivity] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: firstActivityId },
        select: { title: true, statusCode: true },
      }),
      prisma.activity.findUniqueOrThrow({
        where: { id: secondActivityId },
        select: { title: true, statusCode: true },
      }),
    ]);
    expect(firstActivity).toEqual({ title: 'A7 周期训练', statusCode: 'published' });
    expect(secondActivity).toEqual({ title: 'A7 修订后的周期训练', statusCode: 'draft' });
  });

  it('paused、terminated、retired 与 Revision hash 不一致全部零写入失败', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    await series.setStatus(
      { seriesId: created.seriesId, statusCode: 'paused', operationKey: unique('pause-operation') },
      currentUser,
      META,
    );
    const beforePaused = await counts();
    await expect(
      series.generate(generateCommand(created.seriesId), currentUser, META),
    ).rejects.toMatchObject({
      biz: BizCode.BAD_REQUEST,
    });
    expect(await counts()).toEqual(beforePaused);

    await series.setStatus(
      {
        seriesId: created.seriesId,
        statusCode: 'terminated',
        operationKey: unique('terminate-operation'),
      },
      currentUser,
      META,
    );
    const beforeTerminated = await counts();
    await expect(
      series.generate(generateCommand(created.seriesId), currentUser, META),
    ).rejects.toMatchObject({
      biz: BizCode.BAD_REQUEST,
    });
    expect(await counts()).toEqual(beforeTerminated);

    const active = await series.create(createCommand(template.id), currentUser, META);
    await prisma.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'retired' },
    });
    const beforeRetired = await counts();
    await expect(
      series.generate(generateCommand(active.seriesId), currentUser, META),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE,
    });
    expect(await counts()).toEqual(beforeRetired);

    const freshTemplate = await createTemplate({ status: 'active' });
    const mismatched = await series.create(createCommand(freshTemplate.id), currentUser, META);
    await prisma.activitySeriesRevision.create({
      data: {
        seriesId: mismatched.seriesId,
        revision: 2,
        templateVersionId: freshTemplate.id,
        templateDefinitionHash: 'b'.repeat(64),
        frequencyCode: 'daily',
        interval: 1,
        weeklyWeekdayMask: 0,
        timeZone: 'Asia/Shanghai',
        localStartDate: new Date('2099-04-01T00:00:00.000Z'),
        localStartMinute: 540,
        durationMinutes: 120,
        title: '无效 hash Revision',
        organizationId,
        location: 'A7 集合点',
        effectiveFromLocalDate: new Date('2099-04-01T00:00:00.000Z'),
        effectiveToLocalDate: new Date('2099-06-30T00:00:00.000Z'),
        generationWindowDays: 31,
        createdByUserId: currentUser.id,
      },
    });
    const beforeMismatch = await counts();
    await expect(
      series.generate(
        generateCommand(mismatched.seriesId, {
          revision: 2,
          fromLocalDate: '2099-04-01',
          count: 1,
        }),
        currentUser,
        META,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE });
    expect(await counts()).toEqual(beforeMismatch);
  });

  it('两个 Nest/Prisma pool 对同一 Series 的重叠窗口真并发，只生成一个 Occurrence', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    let releaseSeriesLock: (() => void) | undefined;
    let signalSeriesLock: (() => void) | undefined;
    const seriesLockHeld = new Promise<void>((resolve) => {
      signalSeriesLock = resolve;
    });
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ActivitySeries" WHERE "id" = ${created.seriesId} FOR UPDATE
      `;
      signalSeriesLock?.();
      await new Promise<void>((resolve) => {
        releaseSeriesLock = resolve;
      });
    });
    await seriesLockHeld;
    const left = series.generate(
      generateCommand(created.seriesId, { count: 1, fromLocalDate: '2099-01-01' }),
      currentUser,
      META,
    );
    const right = seriesB.generate(
      generateCommand(created.seriesId, { count: 1, fromLocalDate: '2099-01-01' }),
      currentUser,
      META,
    );
    await waitForSeriesLockWaiters(prismaB, 2);
    releaseSeriesLock?.();
    await held;
    const [leftResult, rightResult] = await Promise.all([left, right]);
    expect(leftResult.activityIds).toEqual(rightResult.activityIds);
    expect(await prisma.activitySeriesOccurrence.count()).toBe(1);
    expect(await prisma.activity.count()).toBe(1);
    expect(await prisma.activitySeriesCommandReceipt.count()).toBe(3);
  });

  it('生成期 Activity audit 失败时，Activity / Occurrence / receipt 整批回滚', async () => {
    const template = await createTemplate({ status: 'active' });
    const created = await series.create(createCommand(template.id), currentUser, META);
    const auditLogs = app.get(AuditLogsService);
    const log = jest
      .spyOn(auditLogs, 'log')
      .mockRejectedValueOnce(new Error('A7 audit injected failure'));
    await expect(
      series.generate(generateCommand(created.seriesId), currentUser, META),
    ).rejects.toThrow('A7 audit injected failure');
    log.mockRestore();
    expect(await counts()).toEqual({ activities: 0, occurrences: 0, receipts: 1, audits: 1 });
  });

  it('跨 Series 伪造 Revision 指向会被复合外键拒绝', async () => {
    const template = await createTemplate({ status: 'active' });
    const left = await series.create(createCommand(template.id), currentUser, META);
    const right = await series.create(createCommand(template.id), currentUser, META);
    const rightRevision = await prisma.activitySeriesRevision.findUniqueOrThrow({
      where: { seriesId_revision: { seriesId: right.seriesId, revision: 1 } },
      select: { id: true },
    });

    await expect(
      prisma.activitySeriesCommandReceipt.create({
        data: {
          commandCode: 'create_series',
          operationKey: unique('cross-series-receipt'),
          requestHash: 'a'.repeat(64),
          seriesId: left.seriesId,
          revisionId: rightRevision.id,
          resultRevision: 1,
          resultStatusCode: 'active',
          activityIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.activitySeriesCommandReceipt.count()).toBe(2);
  });

  it('第105条 migration 只扩四张 Series 表，锁住形状、引用和历史不可变性', async () => {
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/im);
    expect(
      migration.match(/^CREATE TABLE "ActivitySeries(?:Revision|CommandReceipt|Occurrence)?" \(/gm),
    ).toHaveLength(4);
    expect(migration).toContain('CREATE TABLE "ActivitySeriesCommandReceipt"');
    expect(migration).not.toContain('ActivitySeriesGeneration');
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)).toHaveLength(9);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "activity_series_revision_id_series_key"\n  ON "ActivitySeriesRevision"("id", "seriesId")',
    );
    expect(
      migration.match(
        /FOREIGN KEY \("revisionId", "seriesId"\) REFERENCES "ActivitySeriesRevision"\("id", "seriesId"\)/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain('CREATE TRIGGER trg_activity_series_10_lifecycle');
    expect(migration).toContain('CREATE TRIGGER trg_activity_series_revision_10_immutable');
    expect(migration).toContain('CREATE TRIGGER trg_activity_series_command_receipt_10_immutable');
    expect(migration).toContain('CREATE TRIGGER trg_activity_series_occurrence_10_immutable');
  });

  it('公共 resetDb 在全部 A7 子表与其来源表之前显式清理，防止跨 spec FK 残留', async () => {
    const resetSource = await readFile(path.resolve(process.cwd(), RESET_DB_PATH), 'utf8');
    const truncateMatch = resetSource.match(/'TRUNCATE TABLE ([^']+) RESTART IDENTITY CASCADE'/);
    if (!truncateMatch?.[1]) throw new Error('resetDb explicit TRUNCATE table list disappeared');

    const tableList = truncateMatch[1];
    const orderedTables = [
      '"ActivitySeriesCommandReceipt"',
      '"ActivitySeriesOccurrence"',
      '"ActivitySeriesRevision"',
      '"ActivitySeries"',
      '"Activity"',
      '"User"',
      '"Organization"',
    ];
    let previousPosition = -1;
    for (const table of orderedTables) {
      const position = tableList.indexOf(table);
      expect(position).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
  });
});

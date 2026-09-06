import type { INestApplication } from '@nestjs/common';
import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityFromTemplateService } from '../../src/modules/activities/activity-from-template.service';
import { ActivitySeriesService } from '../../src/modules/activities/activity-series.service';
import { ActivityTemplateVersionService } from '../../src/modules/activities/activity-template-version.service';
import { ActivityMetricSelectionAccess } from '../../src/modules/activities/activity-metric-selection-access';
import { isActivityOrganizationResolvable } from '../../src/modules/organizations/organization-publish-readiness.primitive';
import { createTestUser } from '../fixtures/users.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

const meta = { requestId: 'd2b-v3-current-identity', ip: null, ua: null };
describe('C1 D2b V3 creation and replay current identity', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let administrator: CurrentUserPayload;
  let series: ActivitySeriesService;
  let templates: ActivityTemplateVersionService;
  let n = 0;
  const key = () => `v3_identity_${++n}`;
  const definition = {
    activity: { allocationModeCode: 'first_come' },
    sessions: [],
    registrationForm: null,
    metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityTemplate", "ActivityTemplateFamily", "ActivitySeriesCommandReceipt", "ActivitySeriesOccurrence", "ActivitySeriesRevision", "ActivitySeries" CASCADE`;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    for (const code of ['activity_type', 'activity_category']) {
      const type = await prisma.dictType.upsert({
        where: { code },
        update: {},
        create: { code, label: code },
      });
      await prisma.dictItem.create({
        data: { typeId: type.id, code: 'v3_training', label: '测试' },
      });
    }
    administrator = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    series = app.get(ActivitySeriesService);
    templates = app.get(ActivityTemplateVersionService);
    peer = await createTestApp();
  });
  afterAll(async () => {
    await peer?.close();
    await app?.close();
  });

  async function template() {
    const result = await templates.create(
      {
        operationKey: key(),
        code: key(),
        name: '身份测试',
        categoryCode: 'v3_training',
        activityTypeCode: 'v3_training',
        version: 1,
        effectiveFrom: '2000-01-01T00:00:00.000Z',
        definition,
      },
      administrator,
      meta,
    );
    await templates.change(
      'activate',
      result.id,
      { operationKey: key(), expectedDefinitionHash: result.definitionHash },
      administrator,
      meta,
    );
    return result;
  }
  function input(templateVersionId: string) {
    return {
      code: key().replaceAll('_', '-'),
      ...revisionInput(templateVersionId),
    };
  }
  function revisionInput(templateVersionId: string) {
    return {
      templateVersionId,
      frequencyCode: 'daily',
      interval: 1,
      timeZone: 'Asia/Shanghai',
      localStartDate: '2099-01-01',
      localStartMinute: 540,
      durationMinutes: 120,
      title: '身份测试',
      organizationId,
      location: '测试',
      effectiveFromLocalDate: '2099-01-01',
      effectiveToLocalDate: '2099-03-31',
      generationWindowDays: 31,
      operationKey: key(),
    } as const;
  }
  async function freeze(id: string) {
    return {
      receipts: await prisma.activitySeriesCommandReceipt.findMany({
        where: { seriesId: id },
        orderBy: { id: 'asc' },
      }),
      occurrences: await prisma.activitySeriesOccurrence.findMany({
        where: { seriesId: id },
        orderBy: { id: 'asc' },
      }),
      activities: await prisma.activity.findMany({
        where: { seriesOccurrence: { seriesId: id } },
        orderBy: { id: 'asc' },
      }),
      auditCount: await prisma.auditLog.count(),
    };
  }
  async function hold(lock: Prisma.Sql) {
    let notify!: (pid: number) => void;
    let unlock!: () => void;
    const ready = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(lock);
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        notify(backend.pid);
        await released;
      },
      { timeout: 10000 },
    );
    const pid = await Promise.race([
      ready,
      held.then(() => {
        throw new Error('holder ended before readiness');
      }),
    ]);
    return {
      pid,
      release: async () => {
        unlock();
        await held;
      },
    };
  }
  async function waiting(pid: number) {
    await waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity a WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(a.pid))
        ) AS waiting`;
        return row.waiting;
      },
      { timeoutMs: 2500, message: 'expected creation/replay did not wait on its root lock' },
    );
  }
  async function grantCreation(userId: string) {
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.create.record' },
      update: {},
      create: {
        code: 'activity.create.record',
        module: 'activity',
        action: 'create',
        resourceType: 'record',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: 'V3 创建角色' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: userId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }
  it.each(['inactive', 'deleted'] as const)(
    'A7 and the existing readiness predicate see an uncommitted %s organization in the caller transaction',
    async (mode) => {
      const access = app.get(ActivityMetricSelectionAccess);
      const rollback = new Error('rollback organization eligibility fixture');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.organization.update({
            where: { id: organizationId },
            data:
              mode === 'inactive'
                ? { status: OrganizationStatus.INACTIVE }
                : { deletedAt: new Date() },
          });
          // The default connection still sees ACTIVE; using it would invalidate this rejection.
          await expect(isActivityOrganizationResolvable(prisma, organizationId)).resolves.toBe(
            true,
          );
          await expect(isActivityOrganizationResolvable(tx, organizationId)).resolves.toBe(false);
          await expect(
            access.authorizeCreation(tx, administrator, 'admin', organizationId, undefined, false),
          ).rejects.toMatchObject({
            biz:
              mode === 'inactive' ? BizCode.ORGANIZATION_INACTIVE : BizCode.ORGANIZATION_NOT_FOUND,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await expect(isActivityOrganizationResolvable(prisma, organizationId)).resolves.toBe(true);
    },
  );
  it.each(['create', 'revise', 'generate'] as const)(
    'V3 Series %s replay denies a now-disabled Human even with its old payload',
    async (mode) => {
      const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
      const selected = await template();
      const creation = input(selected.id);
      const created = await series.create(creation, actor, meta);
      let replay: () => Promise<unknown>;
      if (mode === 'create') replay = () => series.create(creation, actor, meta);
      else if (mode === 'generate') {
        const generate = {
          seriesId: created.seriesId,
          revision: 1,
          fromLocalDate: '2099-01-01',
          count: 2,
          operationKey: key(),
        };
        await series.generate(generate, actor, meta);
        replay = () => series.generate(generate, actor, meta);
      } else {
        const rest = revisionInput(selected.id);
        const revision = {
          ...rest,
          seriesId: created.seriesId,
          operationKey: key(),
          localStartDate: '2099-04-01',
          effectiveFromLocalDate: '2099-04-01',
          effectiveToLocalDate: '2099-06-30',
        };
        await series.revise(revision, actor, meta);
        replay = () => series.revise(revision, actor, meta);
      }
      const before = await freeze(created.seriesId);
      await prisma.user.update({ where: { id: actor.id }, data: { status: UserStatus.DISABLED } });
      await expect(replay()).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
      expect(await freeze(created.seriesId)).toEqual(before);
    },
  );
  it('V3 A6 replay already enforces current identity while retaining the original result', async () => {
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    const selected = await template();
    const service = app.get(ActivityFromTemplateService);
    const command = {
      templateVersionId: selected.id,
      title: 'A6',
      organizationId,
      startAt: '2099-01-01T08:00:00.000Z',
      endAt: '2099-01-01T10:00:00.000Z',
      location: '测试',
      operationKey: key(),
    };
    const row = await service.createFromTemplate(command, actor, meta);
    const before = await prisma.activity.findUniqueOrThrow({ where: { id: row.id } });
    await prisma.user.update({ where: { id: actor.id }, data: { status: UserStatus.DISABLED } });
    await expect(service.createFromTemplate(command, actor, meta)).rejects.toMatchObject({
      biz: BizCode.UNAUTHORIZED,
    });
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });
  it('V3 Series replay remains valid after template retirement without materializing again', async () => {
    const selected = await template();
    const creation = input(selected.id);
    const created = await series.create(creation, administrator, meta);
    const generate = {
      seriesId: created.seriesId,
      revision: 1,
      fromLocalDate: '2099-01-01',
      count: 2,
      operationKey: key(),
    };
    const result = await series.generate(generate, administrator, meta);
    await templates.change(
      'retire',
      selected.id,
      { operationKey: key(), expectedDefinitionHash: selected.definitionHash },
      administrator,
      meta,
    );
    const before = await freeze(created.seriesId);
    expect(await series.create(creation, administrator, meta)).toEqual(created);
    expect(await series.generate(generate, administrator, meta)).toEqual(result);
    expect(await freeze(created.seriesId)).toEqual(before);
  });
  it.each(['create', 'revise', 'generate'] as const)(
    'V3 Series %s replay rechecks a user disabled during the Series lock wait',
    async (mode) => {
      const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
      const selected = await template();
      const creation = input(selected.id);
      const created = await series.create(creation, actor, meta);
      const other = peer.get(ActivitySeriesService);
      let replay: () => Promise<unknown>;
      if (mode === 'create') replay = () => other.create(creation, actor, meta);
      else if (mode === 'generate') {
        const command = {
          seriesId: created.seriesId,
          revision: 1,
          fromLocalDate: '2099-01-01',
          count: 2,
          operationKey: key(),
        };
        await series.generate(command, actor, meta);
        replay = () => other.generate(command, actor, meta);
      } else {
        const rest = revisionInput(selected.id);
        const command = {
          ...rest,
          seriesId: created.seriesId,
          operationKey: key(),
          localStartDate: '2099-04-01',
          effectiveFromLocalDate: '2099-04-01',
          effectiveToLocalDate: '2099-06-30',
        };
        await series.revise(command, actor, meta);
        replay = () => other.revise(command, actor, meta);
      }
      const before = await freeze(created.seriesId);
      const lock = await hold(
        Prisma.sql`SELECT id FROM "ActivitySeries" WHERE id = ${created.seriesId} FOR UPDATE`,
      );
      const pending = Promise.allSettled([replay()]);
      try {
        await waiting(lock.pid);
        await prisma.user.update({
          where: { id: actor.id },
          data: { status: UserStatus.DISABLED },
        });
      } finally {
        await lock.release();
      }
      expect(await pending).toMatchObject([
        { status: 'rejected', reason: { biz: BizCode.UNAUTHORIZED } },
      ]);
      expect(await freeze(created.seriesId)).toEqual(before);
    },
  );
  it.each(['create', 'revise', 'generate'] as const)(
    'V3 Series %s rolls back when its actor loses privilege during the template lock wait',
    async (mode) => {
      const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
      const selected = await template();
      const creation = input(selected.id);
      const other = peer.get(ActivitySeriesService);
      let execute: () => Promise<unknown>;
      if (mode === 'create') execute = () => other.create(creation, actor, meta);
      else {
        const created = await series.create(creation, actor, meta);
        if (mode === 'generate')
          execute = () =>
            other.generate(
              {
                seriesId: created.seriesId,
                revision: 1,
                fromLocalDate: '2099-01-01',
                count: 2,
                operationKey: key(),
              },
              actor,
              meta,
            );
        else {
          const rest = revisionInput(selected.id);
          execute = () =>
            other.revise(
              {
                ...rest,
                seriesId: created.seriesId,
                operationKey: key(),
                localStartDate: '2099-04-01',
                effectiveFromLocalDate: '2099-04-01',
                effectiveToLocalDate: '2099-06-30',
              },
              actor,
              meta,
            );
        }
      }
      const state = async () => ({
        series: await prisma.activitySeries.count(),
        revisions: await prisma.activitySeriesRevision.count(),
        receipts: await prisma.activitySeriesCommandReceipt.count(),
        occurrences: await prisma.activitySeriesOccurrence.count(),
        activities: await prisma.activity.count(),
        audit: await prisma.auditLog.count(),
      });
      const before = await state();
      const lock = await hold(
        Prisma.sql`SELECT id FROM "ActivityTemplate" WHERE id = ${selected.id} FOR UPDATE`,
      );
      const pending = Promise.allSettled([execute()]);
      try {
        await waiting(lock.pid);
        await prisma.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
      } finally {
        await lock.release();
      }
      expect(await pending).toMatchObject([
        { status: 'rejected', reason: { biz: BizCode.RBAC_FORBIDDEN } },
      ]);
      expect(await state()).toEqual(before);
    },
  );
  it.each(['a6', 'series'] as const)(
    'V3 %s audit uses the identity that passed transactional authorization',
    async (mode) => {
      const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
      const selected = await template();
      await grantCreation(actor.id);
      await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
      const fromTemplate = app.get(ActivityFromTemplateService);
      if (mode === 'series') await series.create(input(selected.id), actor, meta);
      else
        await fromTemplate.createFromTemplate(
          {
            templateVersionId: selected.id,
            title: key(),
            organizationId,
            startAt: '2099-01-01T08:00:00.000Z',
            endAt: '2099-01-01T10:00:00.000Z',
            location: '测试',
            operationKey: key(),
          },
          actor,
          meta,
        );
      const logs = await prisma.auditLog.findMany({
        where: { actorUserId: actor.id },
        select: { actorRoleSnap: true },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({ actorRoleSnap: Role.ADMIN });
    },
  );
});

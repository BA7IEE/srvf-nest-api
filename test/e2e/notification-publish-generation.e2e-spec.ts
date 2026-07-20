import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  OrganizationStatus,
  Prisma,
  PrincipalType,
  Role,
} from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxService,
} from '../../src/modules/notifications/notification-outbox.service';
import { NotificationWechatDispatchService } from '../../src/modules/notifications/notification-wechat-dispatch.service';
import { lockOrganizationTopology } from '../../src/modules/organizations/organization-topology-transaction';
import { DevStubWechatProvider } from '../../src/modules/wechat/providers/dev-stub.provider';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const BASE = '/api/admin/v1/notifications';
const ALLOW_EFFECT = { beforeEffect: () => Promise.resolve() };
const GENERATION_TEMPLATE_ID = 'generation-template-general';
interface BackendIdentity {
  pid: number;
  databaseName: string;
}

interface BlockedBackend extends BackendIdentity {
  blockingPids: number[];
  waitEventType: string | null;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBackendIdentity(
  client: Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient,
): Promise<BackendIdentity> {
  const rows = await client.$queryRaw<BackendIdentity[]>(Prisma.sql`
    SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
  `);
  const identity = rows[0];
  if (!identity) throw new Error('PostgreSQL backend identity missing');
  return identity;
}

async function waitForBlockedBackend(
  observer: PrismaService,
  blocker: BackendIdentity,
  mutation: Promise<unknown>,
  queryPattern: string,
): Promise<BlockedBackend> {
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled) throw new Error('mutation settled before the expected PostgreSQL lock wait');
    const rows = await observer.$queryRaw<BlockedBackend[]>(Prisma.sql`
      SELECT
        pid,
        datname AS "databaseName",
        pg_blocking_pids(pid) AS "blockingPids",
        wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> CAST(${blocker.pid} AS integer)
        AND wait_event_type = 'Lock'
        AND CAST(${blocker.pid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE ${queryPattern}
      LIMIT 1
    `);
    const waiter = rows[0];
    if (waiter) {
      expect(waiter.pid).not.toBe(blocker.pid);
      expect(waiter.databaseName).toBe(blocker.databaseName);
      expect(waiter.blockingPids).toContain(blocker.pid);
      expect(waiter.waitEventType).toBe('Lock');
      return waiter;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PostgreSQL lock waiter observed for ${queryPattern}`);
}

async function waitForBlockedBackendByAny(
  observer: PrismaService,
  blockers: BackendIdentity[],
  mutation: Promise<unknown>,
  queryPattern: string,
): Promise<BlockedBackend> {
  if (blockers.length === 0) throw new Error('known PostgreSQL blockers required');
  const databaseName = blockers[0].databaseName;
  expect(blockers.every((blocker) => blocker.databaseName === databaseName)).toBe(true);
  const knownPids = blockers.map(({ pid }) => pid);
  const knownPidSql = Prisma.join(knownPids.map((pid) => Prisma.sql`CAST(${pid} AS integer)`));
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled) throw new Error('mutation settled before the expected PostgreSQL lock wait');
    const rows = await observer.$queryRaw<BlockedBackend[]>(Prisma.sql`
      SELECT
        pid,
        datname AS "databaseName",
        pg_blocking_pids(pid) AS "blockingPids",
        wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND NOT (pid = ANY(ARRAY[${knownPidSql}]::integer[]))
        AND wait_event_type = 'Lock'
        AND pg_blocking_pids(pid) && ARRAY[${knownPidSql}]::integer[]
        AND query LIKE ${queryPattern}
      LIMIT 1
    `);
    const waiter = rows[0];
    if (waiter) {
      expect(knownPids).not.toContain(waiter.pid);
      expect(waiter.databaseName).toBe(databaseName);
      expect(waiter.blockingPids.some((pid) => knownPids.includes(pid))).toBe(true);
      expect(waiter.waitEventType).toBe('Lock');
      return waiter;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PostgreSQL lock waiter observed for ${queryPattern}`);
}

describe('notification publishGeneration · two-app PostgreSQL fence', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let outbox: NotificationOutboxService;
  let outboxB: NotificationOutboxService;
  let handlersB: NotificationOutboxHandlers;
  let auth: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    prisma = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    outbox = appA.get(NotificationOutboxService);
    outboxB = appB.get(NotificationOutboxService);
    handlersB = appB.get(NotificationOutboxHandlers);
    await resetDb(appA);
    const dict = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dict.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
        { typeId: dict.id, code: 'emergency', label: '紧急召集', status: 'ACTIVE' },
      ],
    });
    await createTestUser(appA, {
      username: 'notification_generation_sa',
      role: Role.SUPER_ADMIN,
    });
    auth = (await loginAs(appA, 'notification_generation_sa')).authHeader;
  });

  afterAll(async () => {
    await appB.close();
    await appA.close();
  });

  async function createDraft(channels: string[] = ['in-app', 'wechat']): Promise<string> {
    const response = await request(httpServer(appA)).post(BASE).set('Authorization', auth).send({
      title: 'generation title',
      body: 'generation body',
      notificationTypeCode: 'general',
      visibilityCode: 'member',
      channels,
    });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  async function createClaimedWechatChild(): Promise<{
    intent: ClaimedNotificationOutboxIntent;
    notificationId: string;
    memberId: string;
    templateId: string;
  }> {
    const member = await prisma.member.create({
      data: {
        memberNo: `GEN-${Date.now()}-${Math.random()}`,
        displayName: 'generation member',
        status: 'ACTIVE',
      },
    });
    const user = await createTestUser(appA, {
      username: `generation_member_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id, openid: `dev-openid-${member.id}` },
    });
    const notification = await prisma.notification.create({
      data: {
        title: 'generation delivery',
        body: 'locked snapshot body',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'member',
        audienceType: 'broadcast',
        sourceType: 'admin',
        channels: ['in-app', 'wechat'],
        publishedAt: new Date(),
        publishGeneration: 1,
      },
    });
    // WechatSubscribeTemplate 是 notificationTypeCode=general 的全局当前映射；所有本 spec
    // 同类型 notification 必须共享稳定 templateId，不能让后建夹具使先建 member quota 失配。
    const templateId = GENERATION_TEMPLATE_ID;
    const settings = await prisma.wechatSettings.findFirst({ select: { id: true } });
    if (settings) {
      await prisma.wechatSettings.update({
        where: { id: settings.id },
        data: { providerType: 'DEV_STUB', enabled: true },
      });
    } else {
      await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    }
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'general' },
      create: { notificationTypeCode: 'general', templateId, enabled: true },
      update: { templateId, enabled: true },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId: member.id, templateId, availableCount: 2 },
    });
    const root = await prisma.notificationOutboxIntent.create({
      data: {
        eventKey: `wechat-broadcast:${notification.id}:1`,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
        payload: { notificationId: notification.id, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: notification.id,
        destinationType: 'broadcast',
        destinationRef: notification.id,
        status: 'succeeded',
        attempts: 1,
        completedAt: new Date(),
      },
    });
    const created = await outbox.enqueue({
      eventKey: `wechat-delivery:${notification.id}:${root.id}:${member.id}`,
      eventType: 'notification.wechat-delivery',
      payloadVersion: 2,
      payload: {
        notificationId: notification.id,
        memberId: member.id,
        publishGeneration: 1,
      },
      aggregateType: 'notification',
      aggregateId: notification.id,
      destinationType: 'member',
      destinationRef: member.id,
    });
    const [intent] = await outboxB.claim(`generation-worker-${created.id}`, {
      eventKey: created.eventKey,
      leaseMs: 30_000,
    });
    if (!intent) throw new Error('wechat child was not claimed');
    return { intent, notificationId: notification.id, memberId: member.id, templateId };
  }

  async function createAdditionalClaimedWechatChild(input: {
    notificationId: string;
    templateId: string;
  }): Promise<{ intent: ClaimedNotificationOutboxIntent; memberId: string }> {
    const member = await prisma.member.create({
      data: {
        memberNo: `GEN-SHARED-${Date.now()}-${Math.random()}`,
        displayName: 'shared parent generation member',
        status: 'ACTIVE',
      },
    });
    const user = await createTestUser(appA, {
      username: `generation_shared_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id, openid: `dev-openid-${member.id}` },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId: member.id, templateId: input.templateId, availableCount: 2 },
    });
    const root = await prisma.notificationOutboxIntent.findFirstOrThrow({
      where: {
        aggregateId: input.notificationId,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
      },
      select: { id: true },
    });
    const created = await outbox.enqueue({
      eventKey: `wechat-delivery:${input.notificationId}:${root.id}:${member.id}`,
      eventType: 'notification.wechat-delivery',
      payloadVersion: 2,
      payload: {
        notificationId: input.notificationId,
        memberId: member.id,
        publishGeneration: 1,
      },
      aggregateType: 'notification',
      aggregateId: input.notificationId,
      destinationType: 'member',
      destinationRef: member.id,
    });
    const [intent] = await outboxB.claim(`generation-worker-${created.id}`, {
      eventKey: created.eventKey,
      leaseMs: 30_000,
    });
    if (!intent) throw new Error('additional wechat child was not claimed');
    return { intent, memberId: member.id };
  }

  async function configureManagementRecipient(
    notificationId: string,
    memberId: string,
    shared?: { roleId: string; permissionId: string },
  ): Promise<{ userId: string; bindingId: string; roleId: string; permissionId: string }> {
    const user = await prisma.user.findFirstOrThrow({
      where: { memberId, deletedAt: null },
      select: { id: true },
    });
    const permission = shared
      ? { id: shared.permissionId }
      : await prisma.permission.upsert({
          where: { code: 'notification.read.record' },
          create: {
            code: 'notification.read.record',
            module: 'notification',
            action: 'read',
            resourceType: 'record',
          },
          update: {},
          select: { id: true },
        });
    const role = shared
      ? { id: shared.roleId }
      : await prisma.rbacRole.create({
          data: {
            code: `generation-management-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
            displayName: 'generation management',
          },
          select: { id: true },
        });
    if (!shared) {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: user.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.notification.update({
      where: { id: notificationId },
      data: { visibilityCode: 'management' },
    });
    return {
      userId: user.id,
      bindingId: binding.id,
      roleId: role.id,
      permissionId: permission.id,
    };
  }

  it('同一 draft 并发 publish 只成功一次，generation 0→1 且仅一条 v2 root', async () => {
    const id = await createDraft();
    const [left, right] = await Promise.all([
      request(httpServer(appA)).post(`${BASE}/${id}/publish`).set('Authorization', auth).send({}),
      request(httpServer(appB)).post(`${BASE}/${id}/publish`).set('Authorization', auth).send({}),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    expect([left.body.code, right.body.code].sort((a, b) => a - b)).toEqual([0, 31030]);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      statusCode: 'published',
      publishGeneration: 1,
    });
    const roots = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateId: id, eventType: 'notification.wechat-broadcast' },
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      eventKey: `wechat-broadcast:${id}:1`,
      payloadVersion: 2,
      payload: { notificationId: id, publishGeneration: 1 },
    });
  });

  it('published Effect PATCH 自动回 draft；republish +1；pinned/集合等价保持 published', async () => {
    const id = await createDraft(['wechat', 'in-app', 'wechat']);
    await request(httpServer(appA))
      .post(`${BASE}/${id}/publish`)
      .set('Authorization', auth)
      .send({});
    const changed = await request(httpServer(appA))
      .patch(`${BASE}/${id}`)
      .set('Authorization', auth)
      .send({ title: 'generation title v2' });
    expect(changed.body.data).toMatchObject({ statusCode: 'draft' });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      publishGeneration: 1,
    });

    await request(httpServer(appA))
      .post(`${BASE}/${id}/publish`)
      .set('Authorization', auth)
      .send({});
    const semanticNoop = await request(httpServer(appA))
      .patch(`${BASE}/${id}`)
      .set('Authorization', auth)
      .send({ pinned: true, channels: ['wechat', 'in-app', 'wechat'] });
    expect(semanticNoop.body.data).toMatchObject({ statusCode: 'published', pinned: true });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      publishGeneration: 2,
    });
  });

  it('mutation 先提交：双 pool + pg_blocking_pids 证明 final permission 等 parent 锁，拒绝后仅退款本 attempt reservation', async () => {
    const { intent, notificationId, memberId, templateId } = await createClaimedWechatChild();
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const mutation = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "notifications" WHERE "id" = ${notificationId} FOR UPDATE
      `);
      await tx.notification.update({
        where: { id: notificationId },
        data: { statusCode: 'draft', publishedAt: null },
      });
      reached.resolve(await readBackendIdentity(tx));
      await release.promise;
    });
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    let execution: Promise<{ effectPerformed: boolean }> | undefined;
    try {
      const blocker = await withTimeout(reached.promise, 'mutation-first transaction barrier');
      execution = handlersB.execute(intent, ALLOW_EFFECT);
      await waitForBlockedBackend(prisma, blocker, execution, '%FROM "notifications"%FOR SHARE%');
      release.resolve(undefined);
      await mutation;
      await expect(execution).resolves.toEqual({ effectPerformed: false });

      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 2 });
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({
        status: 'processing',
        preparedAt: null,
        preparedTemplateId: null,
      });
      expect(await prisma.notificationDelivery.count({ where: { id: intent.id } })).toBe(0);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([mutation, ...(execution ? [execution] : [])]);
      provider.mockRestore();
    }
  });

  it('permission 先提交：final permission 持 parent+intent 锁时 mutation 真实阻塞；放行后本 attempt 可用锁内快照完成', async () => {
    const { intent, notificationId, memberId, templateId } = await createClaimedWechatChild();
    const permissionReached = deferred<BackendIdentity>();
    const releasePermission = deferred();
    const originalTransaction = prismaB.$transaction.bind(prismaB);
    let pausePermission = true;
    const transactionSpy = jest
      .spyOn(prismaB, '$transaction')
      .mockImplementation(
        async (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: Parameters<PrismaService['$transaction']>[1],
        ) =>
          originalTransaction(async (tx) => {
            const result = await operation(tx);
            if (
              pausePermission &&
              result !== null &&
              typeof result === 'object' &&
              'id' in result &&
              result.id === notificationId
            ) {
              pausePermission = false;
              permissionReached.resolve(await readBackendIdentity(tx));
              await releasePermission.promise;
            }
            return result;
          }, options),
      );
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    const execution = handlersB.execute(intent, ALLOW_EFFECT);
    let mutation: Promise<request.Response> | undefined;
    try {
      const blocker = await withTimeout(
        permissionReached.promise,
        'permission-first transaction barrier',
      );
      mutation = Promise.resolve(
        request(httpServer(appA))
          .patch(`${BASE}/${notificationId}`)
          .set('Authorization', auth)
          .send({ title: 'mutation waits for permission' }),
      );
      // waiter 是真实 PATCH writer，自身仍以 FOR UPDATE 请求 parent；blocker 才是 permission FOR SHARE。
      await waitForBlockedBackend(prismaB, blocker, mutation, '%FROM "notifications"%FOR UPDATE%');
      releasePermission.resolve(undefined);
      await expect(execution).resolves.toMatchObject({ effectPerformed: true });
      const mutationResponse = await mutation;
      expect(mutationResponse?.status).toBe(200);
      expect(mutationResponse?.body.data).toMatchObject({ statusCode: 'draft' });
      expect(provider).toHaveBeenCalledTimes(1);
      const [, providerInput] = provider.mock.calls[0] ?? [];
      expect(providerInput?.data.thing1).toEqual({ value: 'generation delivery' });
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 1 });
      expect(await prisma.notificationDelivery.count({ where: { id: intent.id } })).toBe(1);
    } finally {
      releasePermission.resolve(undefined);
      await Promise.allSettled([execution, ...(mutation ? [mutation] : [])]);
      transactionSpy.mockRestore();
      provider.mockRestore();
    }
  });

  it('recipient 撤销先提交：持 Member lock 时 final permission 真实等待，提交后 provider=0 且精确退款清 marker', async () => {
    const { intent, memberId, templateId } = await createClaimedWechatChild();
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const withdrawal = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE
      `);
      await tx.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });
      reached.resolve(await readBackendIdentity(tx));
      await release.promise;
    });
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    let execution: Promise<{ effectPerformed: boolean }> | undefined;
    try {
      const blocker = await withTimeout(
        reached.promise,
        'recipient-withdrawal transaction barrier',
      );
      execution = handlersB.execute(intent, ALLOW_EFFECT);
      await waitForBlockedBackend(prisma, blocker, execution, '%FROM "Member"%FOR UPDATE%');
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ preparedAt: expect.any(Date), preparedTemplateId: templateId });
      release.resolve(undefined);
      await withdrawal;
      await expect(execution).resolves.toEqual({ effectPerformed: false });

      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 2 });
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({
        status: 'processing',
        preparedAt: null,
        preparedTemplateId: null,
      });
      expect(await prisma.notificationDelivery.count({ where: { id: intent.id } })).toBe(0);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([withdrawal, ...(execution ? [execution] : [])]);
      provider.mockRestore();
    }
  });

  it('recipient permission 先赢：同事务持 Member lock 时撤销真实等待；撤销提交后仍按锁内快照允许一次', async () => {
    const { intent, memberId, templateId } = await createClaimedWechatChild();
    const permissionReached = deferred<BackendIdentity>();
    const releasePermission = deferred();
    const allowProvider = deferred();
    const eligibility = appB.get(NotificationWechatDispatchService);
    const authorize = eligibility.authorizeDurableBroadcastRecipient.bind(eligibility);
    let pausePermission = true;
    const eligibilitySpy = jest
      .spyOn(eligibility, 'authorizeDurableBroadcastRecipient')
      .mockImplementation(async (...args) => {
        const result = await authorize(...args);
        if (pausePermission && result) {
          pausePermission = false;
          permissionReached.resolve(await readBackendIdentity(args[0]));
          await releasePermission.promise;
        }
        return result;
      });
    const providerInstance = appB.get(DevStubWechatProvider);
    const send = providerInstance.sendSubscribeMessage.bind(providerInstance);
    const provider = jest
      .spyOn(providerInstance, 'sendSubscribeMessage')
      .mockImplementation(async (...args) => {
        await allowProvider.promise;
        return send(...args);
      });
    const execution = handlersB.execute(intent, ALLOW_EFFECT);
    let withdrawal: Promise<void> | undefined;
    try {
      const blocker = await withTimeout(
        permissionReached.promise,
        'recipient-permission transaction barrier',
      );
      withdrawal = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE
        `);
        await tx.member.update({
          where: { id: memberId },
          data: { status: MemberStatus.INACTIVE },
        });
      });
      await waitForBlockedBackend(prismaB, blocker, withdrawal, '%FROM "Member"%FOR UPDATE%');
      releasePermission.resolve(undefined);
      await withdrawal;
      expect(await prisma.member.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
        status: MemberStatus.INACTIVE,
      });
      allowProvider.resolve(undefined);
      await expect(execution).resolves.toMatchObject({ effectPerformed: true });

      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 1 });
      expect(await prisma.notificationDelivery.count({ where: { id: intent.id } })).toBe(1);
    } finally {
      releasePermission.resolve(undefined);
      allowProvider.resolve(undefined);
      await Promise.allSettled([execution, ...(withdrawal ? [withdrawal] : [])]);
      eligibilitySpy.mockRestore();
      provider.mockRestore();
    }
  });

  it.each([
    ['rebind', 'writer-first-current-openid'],
    ['clear', null],
  ] as const)(
    'openid %s writer-first：User shared lock 等提交并只消费锁内 destination',
    async (_name, nextOpenid) => {
      const { intent, memberId, templateId } = await createClaimedWechatChild();
      const user = await prisma.user.findFirstOrThrow({
        where: { memberId, deletedAt: null },
        select: { id: true },
      });
      const reached = deferred<BackendIdentity>();
      const release = deferred();
      const mutation = prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { openid: nextOpenid } });
        reached.resolve(await readBackendIdentity(tx));
        await release.promise;
      });
      const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
      let execution: Promise<{ effectPerformed: boolean }> | undefined;
      try {
        const blocker = await withTimeout(reached.promise, `openid ${_name} writer barrier`);
        execution = handlersB.execute(intent, ALLOW_EFFECT);
        await waitForBlockedBackend(prisma, blocker, execution, '%FROM "User"%FOR SHARE%');
        release.resolve(undefined);
        await mutation;
        await expect(execution).resolves.toEqual({ effectPerformed: nextOpenid !== null });

        if (nextOpenid === null) {
          expect(provider).not.toHaveBeenCalled();
          expect(
            await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: intent.id } }),
          ).toMatchObject({ status: 'skipped', reasonCode: 'no-openid', recipientRef: '-' });
          expect(
            await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
              where: { memberId_templateId: { memberId, templateId } },
            }),
          ).toMatchObject({ availableCount: 2 });
        } else {
          expect(provider).toHaveBeenCalledTimes(1);
          const [, providerInput] = provider.mock.calls[0] ?? [];
          expect(providerInput?.openid).toBe(nextOpenid);
        }
      } finally {
        release.resolve(undefined);
        await Promise.allSettled([mutation, ...(execution ? [execution] : [])]);
        provider.mockRestore();
      }
    },
  );

  it('v2 quota=0 在 final permission 前只记 no-quota，零 destination 伪证据', async () => {
    const { intent, memberId, templateId } = await createClaimedWechatChild();
    await prisma.wechatSubscriptionQuota.update({
      where: { memberId_templateId: { memberId, templateId } },
      data: { availableCount: 0 },
    });
    const eligibility = appB.get(NotificationWechatDispatchService);
    const permission = jest.spyOn(eligibility, 'authorizeDurableBroadcastRecipient');
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    try {
      await expect(handlersB.execute(intent, ALLOW_EFFECT)).resolves.toEqual({
        effectPerformed: false,
      });
      expect(permission).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ status: 'skipped', reasonCode: 'no-quota', recipientRef: '-' });
    } finally {
      permission.mockRestore();
      provider.mockRestore();
    }
  });

  it.each([
    ['RoleBinding revoke', 'role-binding'] as const,
    ['RolePermission revoke', 'role-permission'] as const,
  ])('%s writer-first：management permission 等真实撤权提交后拒绝', async (_name, target) => {
    const { intent, notificationId, memberId, templateId } = await createClaimedWechatChild();
    const grant = await configureManagementRecipient(notificationId, memberId);
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const mutation = prisma.$transaction(async (tx) => {
      if (target === 'role-binding') {
        const now = new Date();
        await tx.roleBinding.update({
          where: { id: grant.bindingId },
          data: { status: BindingStatus.ENDED, endedAt: now, deletedAt: now },
        });
      } else {
        await tx.rolePermission.delete({
          where: {
            roleId_permissionId: {
              roleId: grant.roleId,
              permissionId: grant.permissionId,
            },
          },
        });
      }
      reached.resolve(await readBackendIdentity(tx));
      await release.promise;
    });
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    let execution: Promise<{ effectPerformed: boolean }> | undefined;
    try {
      const blocker = await withTimeout(reached.promise, `${_name} writer barrier`);
      execution = handlersB.execute(intent, ALLOW_EFFECT);
      await waitForBlockedBackend(
        prisma,
        blocker,
        execution,
        target === 'role-binding'
          ? '%FROM "role_bindings"%FOR SHARE%'
          : '%FROM "role_permissions"%FOR SHARE%',
      );
      release.resolve(undefined);
      await mutation;
      await expect(execution).resolves.toEqual({ effectPerformed: false });
      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 2 });
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([mutation, ...(execution ? [execution] : [])]);
      provider.mockRestore();
    }
  });

  it('User role downgrade writer-first：management permission 等 User shared lock 后按 USER 拒绝', async () => {
    const { intent, notificationId, memberId, templateId } = await createClaimedWechatChild();
    const user = await prisma.user.findFirstOrThrow({
      where: { memberId, deletedAt: null },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { role: Role.ADMIN } });
    await prisma.notification.update({
      where: { id: notificationId },
      data: { visibilityCode: 'management' },
    });
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const mutation = prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { role: Role.USER } });
      reached.resolve(await readBackendIdentity(tx));
      await release.promise;
    });
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    let execution: Promise<{ effectPerformed: boolean }> | undefined;
    try {
      const blocker = await withTimeout(reached.promise, 'user role downgrade writer barrier');
      execution = handlersB.execute(intent, ALLOW_EFFECT);
      await waitForBlockedBackend(prisma, blocker, execution, '%FROM "User"%FOR SHARE%');
      release.resolve(undefined);
      await mutation;
      await expect(execution).resolves.toEqual({ effectPerformed: false });
      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 2 });
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([mutation, ...(execution ? [execution] : [])]);
      provider.mockRestore();
    }
  });

  it('同一 Notification 的不同 child 可共享 parent permission；真实 PATCH writer 等两者提交', async () => {
    const first = await createClaimedWechatChild();
    const second = await createAdditionalClaimedWechatChild({
      notificationId: first.notificationId,
      templateId: first.templateId,
    });
    const firstGrant = await configureManagementRecipient(first.notificationId, first.memberId);
    await configureManagementRecipient(first.notificationId, second.memberId, firstGrant);
    expect(first.intent.aggregateId).toBe(second.intent.aggregateId);
    expect(first.intent.id).not.toBe(second.intent.id);
    expect(first.memberId).not.toBe(second.memberId);
    expect(first.intent.eventKey.split(':')[2]).toBe(second.intent.eventKey.split(':')[2]);

    const handlersA = appA.get(NotificationOutboxHandlers);
    const eligibilityA = appA.get(NotificationWechatDispatchService);
    const eligibilityB = appB.get(NotificationWechatDispatchService);
    const authorizeA = eligibilityA.authorizeDurableBroadcastRecipient.bind(eligibilityA);
    const authorizeB = eligibilityB.authorizeDurableBroadcastRecipient.bind(eligibilityB);
    const bothReached = deferred();
    const release = deferred();
    const blockers: BackendIdentity[] = [];
    const pauseAtRecipientBarrier = async (
      authorize: typeof authorizeA,
      args: Parameters<typeof authorizeA>,
    ) => {
      const result = await authorize(...args);
      if (result) {
        blockers.push(await readBackendIdentity(args[0]));
        if (blockers.length === 2) bothReached.resolve(undefined);
        await release.promise;
      }
      return result;
    };
    const eligibilitySpyA = jest
      .spyOn(eligibilityA, 'authorizeDurableBroadcastRecipient')
      .mockImplementation((...args) => pauseAtRecipientBarrier(authorizeA, args));
    const eligibilitySpyB = jest
      .spyOn(eligibilityB, 'authorizeDurableBroadcastRecipient')
      .mockImplementation((...args) => pauseAtRecipientBarrier(authorizeB, args));
    const firstExecution = handlersA.execute(first.intent, ALLOW_EFFECT);
    const secondExecution = handlersB.execute(second.intent, ALLOW_EFFECT);
    let mutation: Promise<request.Response> | undefined;
    try {
      await withTimeout(bothReached.promise, 'shared Notification parent permission barrier');
      expect(blockers).toHaveLength(2);
      expect(blockers[0]?.pid).not.toBe(blockers[1]?.pid);
      mutation = Promise.resolve(
        request(httpServer(appA))
          .patch(`${BASE}/${first.notificationId}`)
          .set('Authorization', auth)
          .send({ title: 'writer waits for both shared permissions' }),
      );
      await waitForBlockedBackendByAny(
        prismaB,
        blockers,
        mutation,
        '%FROM "notifications"%FOR UPDATE%',
      );

      release.resolve(undefined);
      await expect(Promise.all([firstExecution, secondExecution])).resolves.toEqual([
        { effectPerformed: true },
        { effectPerformed: true },
      ]);
      const mutationResponse = await mutation;
      expect(mutationResponse.status).toBe(200);
      expect(mutationResponse.body.data).toMatchObject({ statusCode: 'draft' });
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([firstExecution, secondExecution, ...(mutation ? [mutation] : [])]);
      eligibilitySpyA.mockRestore();
      eligibilitySpyB.mockRestore();
    }
  });

  it('两名 management recipient 共享 Role/Permission 时可同时进入 permission barrier', async () => {
    const first = await createClaimedWechatChild();
    const firstGrant = await configureManagementRecipient(first.notificationId, first.memberId);
    const second = await createClaimedWechatChild();
    await configureManagementRecipient(second.notificationId, second.memberId, firstGrant);
    expect(first.notificationId).not.toBe(second.notificationId);
    expect(first.intent.aggregateId).not.toBe(second.intent.aggregateId);
    expect(first.intent.id).not.toBe(second.intent.id);

    const handlersA = appA.get(NotificationOutboxHandlers);
    const eligibilityA = appA.get(NotificationWechatDispatchService);
    const eligibilityB = appB.get(NotificationWechatDispatchService);
    const authorizeA = eligibilityA.authorizeDurableBroadcastRecipient.bind(eligibilityA);
    const authorizeB = eligibilityB.authorizeDurableBroadcastRecipient.bind(eligibilityB);
    const bothReached = deferred();
    const release = deferred();
    let reachedCount = 0;
    const pauseAfterSharedLocks = async (
      authorize: typeof authorizeA,
      args: Parameters<typeof authorizeA>,
    ) => {
      const result = await authorize(...args);
      if (result) {
        reachedCount += 1;
        if (reachedCount === 2) bothReached.resolve(undefined);
        await release.promise;
      }
      return result;
    };
    const eligibilitySpyA = jest
      .spyOn(eligibilityA, 'authorizeDurableBroadcastRecipient')
      .mockImplementation((...args) => pauseAfterSharedLocks(authorizeA, args));
    const eligibilitySpyB = jest
      .spyOn(eligibilityB, 'authorizeDurableBroadcastRecipient')
      .mockImplementation((...args) => pauseAfterSharedLocks(authorizeB, args));
    const firstExecution = handlersA.execute(first.intent, ALLOW_EFFECT);
    const secondExecution = handlersB.execute(second.intent, ALLOW_EFFECT);
    try {
      await withTimeout(bothReached.promise, 'shared RBAC permission barrier');
      expect(reachedCount).toBe(2);
      release.resolve(undefined);
      await expect(Promise.all([firstExecution, secondExecution])).resolves.toEqual([
        { effectPerformed: true },
        { effectPerformed: true },
      ]);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([firstExecution, secondExecution]);
      eligibilitySpyA.mockRestore();
      eligibilitySpyB.mockRestore();
    }
  });

  it('organization topology 写锁先赢：recipient shared topology permission 真实等待，提交 inactive 后拒绝并退款', async () => {
    const { intent, notificationId, memberId, templateId } = await createClaimedWechatChild();
    const organization = await prisma.organization.create({
      data: { name: `generation-org-${Date.now()}`, nodeTypeCode: 'demo-node', status: 'ACTIVE' },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId, organizationId: organization.id, membershipType: 'PRIMARY' },
    });
    await prisma.notification.update({
      where: { id: notificationId },
      data: { visibilityCode: 'department', visibleOrganizationIds: [organization.id] },
    });
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const topologyMutation = prisma.$transaction(async (tx) => {
      await lockOrganizationTopology(tx);
      await tx.organization.update({
        where: { id: organization.id },
        data: { status: OrganizationStatus.INACTIVE },
      });
      reached.resolve(await readBackendIdentity(tx));
      await release.promise;
    });
    const provider = jest.spyOn(appB.get(DevStubWechatProvider), 'sendSubscribeMessage');
    let execution: Promise<{ effectPerformed: boolean }> | undefined;
    try {
      const blocker = await withTimeout(reached.promise, 'topology-withdrawal transaction barrier');
      execution = handlersB.execute(intent, ALLOW_EFFECT);
      await waitForBlockedBackend(prisma, blocker, execution, '%pg_advisory_xact_lock_shared%');
      release.resolve(undefined);
      await topologyMutation;
      await expect(execution).resolves.toEqual({ effectPerformed: false });
      expect(provider).not.toHaveBeenCalled();
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId } },
        }),
      ).toMatchObject({ availableCount: 2 });
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ preparedAt: null, preparedTemplateId: null });
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([topologyMutation, ...(execution ? [execution] : [])]);
      provider.mockRestore();
    }
  });

  it('system-directed 仍可 list/detail，但 mutation=31030、sendSms=31013 且零 outbox', async () => {
    const created = await prisma.notification.create({
      data: {
        title: 'system directed',
        body: 'immutable from admin surface',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'member',
        audienceType: 'directed',
        sourceType: 'system',
        channels: ['in-app', 'sms'],
        publishedAt: new Date(),
      },
    });
    expect(
      (await request(httpServer(appA)).get(`${BASE}/${created.id}`).set('Authorization', auth))
        .status,
    ).toBe(200);
    expectBizError(
      await request(httpServer(appA))
        .patch(`${BASE}/${created.id}`)
        .set('Authorization', auth)
        .send({ pinned: true }),
      BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
    );
    expectBizError(
      await request(httpServer(appA)).delete(`${BASE}/${created.id}`).set('Authorization', auth),
      BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
    );
    expectBizError(
      await request(httpServer(appA))
        .post(`${BASE}/${created.id}/send-sms`)
        .set('Authorization', auth)
        .send({ confirmed: false }),
      BizCode.NOTIFICATION_SMS_NOT_SENDABLE,
    );
    expect(
      await prisma.notificationOutboxIntent.count({ where: { aggregateId: created.id } }),
    ).toBe(0);
  });
});

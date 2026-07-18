import type { INestApplication } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import {
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxService,
} from '../../src/modules/notifications/notification-outbox.service';
import type { NotificationOutboxEnqueueInput } from '../../src/modules/notifications/notification-outbox.types';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { SmsChannelUnavailableError } from '../../src/modules/sms/sms.types';
import { WechatSettingsService } from '../../src/modules/wechat/wechat-settings.service';
import { WechatService } from '../../src/modules/wechat/wechat.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

interface Refs {
  notificationId: string;
  memberIds: string[];
}

interface ChildResult {
  booted?: boolean;
  ids?: string[];
  effectPerformed?: boolean;
}

// D-Outbox 真 PostgreSQL杀伤矩阵：本 spec 只使用当前 worktree 派生的 app_test_* 库；
// 双 OS 进程通过独立 Nest application context / Prisma pool claim，非 Promise mock 并发。
describe('notification durable outbox PostgreSQL concurrency and crash recovery', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let outbox: NotificationOutboxService;
  let outboxB: NotificationOutboxService;

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    outbox = app.get(NotificationOutboxService);
    outboxB = appB.get(NotificationOutboxService);
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
    await appB.close();
  });

  async function createRefs(memberCount = 1): Promise<Refs> {
    const memberIds: string[] = [];
    for (let index = 0; index < memberCount; index += 1) {
      const member = await prisma.member.create({
        data: {
          memberNo: `OUTBOX-${Date.now()}-${index}`,
          displayName: `outbox-member-${index}`,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      memberIds.push(member.id);
    }
    const notification = await prisma.notification.create({
      data: {
        title: 'outbox test',
        body: 'durable delivery',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'member',
        audienceType: 'broadcast',
        sourceType: 'admin',
        channels: ['in-app', 'sms'],
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    return { notificationId: notification.id, memberIds };
  }

  function input(
    refs: Refs,
    memberId = refs.memberIds[0],
    generation = '00000000-0000-4000-8000-000000000001',
  ): NotificationOutboxEnqueueInput {
    return {
      eventKey: `admin-sms:${refs.notificationId}:${generation}:${memberId}`,
      eventType: OUTBOX_EVENT_ADMIN_SMS,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    };
  }

  it('同 eventKey 真并发 enqueue 恰一行，内容相同双方均返回同一 intent', async () => {
    const refs = await createRefs();
    const [left, right] = await Promise.all([
      outbox.enqueue(input(refs)),
      outbox.enqueue(input(refs)),
    ]);
    expect(left.id).toBe(right.id);
    expect(await prisma.notificationOutboxIntent.count()).toBe(1);
  });

  it('两个独立 OS worker 以 SKIP LOCKED 各 claim 一条且不重叠', async () => {
    const refs = await createRefs(2);
    await Promise.all(refs.memberIds.map((memberId) => outbox.enqueue(input(refs, memberId))));

    const [left, right] = await Promise.all([
      runChild(['claim', 'os-worker-a']),
      runChild(['claim', 'os-worker-b']),
    ]);
    const ids = [...(left.ids ?? []), ...(right.ids ?? [])];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'processing' } })).toBe(
      2,
    );
  });

  it('第一 OS 进程持短 lease 后退出，第二独立进程到期重领同一 intent，旧 fence 失效', async () => {
    const refs = await createRefs();
    const enqueueInput = input(refs);
    const created = await outbox.enqueue(enqueueInput);
    const firstNow = new Date(Date.now());
    const first = await runChild([
      'claim',
      'os-crash-owner',
      firstNow.toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(first.ids).toEqual([created.id]);
    const oldFence = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(oldFence).toMatchObject({ status: 'processing', leaseOwner: 'os-crash-owner' });

    const reclaimed = await runChild([
      'claim',
      'os-reclaim-owner',
      new Date(firstNow.getTime() + 1001).toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(reclaimed.ids).toEqual([created.id]);
    await expect(outbox.ack(oldFence as ClaimedNotificationOutboxIntent, true)).rejects.toThrow(
      'NOTIFICATION_OUTBOX_LEASE_LOST',
    );
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ attempts: 2, leaseOwner: 'os-reclaim-owner' });
  });

  it('expired lease 可回收且旧 fence 不能 ack 新 owner', async () => {
    const refs = await createRefs();
    await outbox.enqueue(input(refs));
    const firstNow = new Date();
    const [first] = await outbox.claim('worker-a', { now: firstNow, leaseMs: 1000 });
    const [second] = await outbox.claim('worker-b', {
      now: new Date(firstNow.getTime() + 1001),
      leaseMs: 1000,
    });
    expect(first.id).toBe(second.id);
    await expect(outbox.ack(first, true)).rejects.toThrow('NOTIFICATION_OUTBOX_LEASE_LOST');
    await expect(outbox.ack(second, true)).resolves.toBeUndefined();
  });

  it('expired attempts=8 原子 dead，handler/provider 零调用', async () => {
    const refs = await createRefs();
    await prisma.notificationOutboxIntent.create({
      data: {
        ...input(refs),
        status: 'processing',
        attempts: 8,
        leaseOwner: 'crashed-worker',
        lockedAt: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() - 30_000),
      },
    });
    const handlers = { execute: jest.fn() };
    const worker = new NotificationOutboxWorker(outbox, handlers as never);
    await expect(worker.drainOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(handlers.execute).not.toHaveBeenCalled();
    expect(await prisma.notificationOutboxIntent.findFirst()).toMatchObject({
      status: 'dead',
      attempts: 8,
      lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
    });
  });

  it('provider 成功后 ack 前崩溃会在 lease reclaim 后重复 Effect，随后新 fence 才可 ack', async () => {
    const refs = await createRefs();
    await outbox.enqueue(input(refs));
    const firstNow = new Date();
    const [first] = await outbox.claim('worker-before-crash', {
      now: firstNow,
      leaseMs: 1000,
    });
    const handlers = {
      execute: jest.fn().mockResolvedValue({ effectPerformed: true }),
    };
    // 模拟 provider 已成功但进程在 ack 前退出：Effect 发生一次，intent 仍 processing。
    await handlers.execute(first);
    const [reclaimed] = await outbox.claim('worker-after-crash', {
      now: new Date(firstNow.getTime() + 1001),
      leaseMs: 1000,
    });
    const worker = new NotificationOutboxWorker(outbox, handlers as never);
    await worker.executeReserved(reclaimed);
    expect(handlers.execute).toHaveBeenCalledTimes(2);
    expect(
      await prisma.notificationOutboxIntent.findUnique({ where: { id: first.id } }),
    ).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
  });

  it('真实 OS worker 完成微信 provider/DB effect 后退出未 ack，第二 OS worker 重领且零重复 effect', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_os_crash_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, openid: 'dev-openid-outbox-os-crash' },
    });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    app.get(WechatSettingsService).invalidate();
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'general' },
      create: { notificationTypeCode: 'general', templateId: 'outbox-os-template', enabled: true },
      update: { templateId: 'outbox-os-template', enabled: true },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId, templateId: 'outbox-os-template', availableCount: 2 },
    });
    const enqueueInput: NotificationOutboxEnqueueInput = {
      eventKey: `wechat-delivery:${refs.notificationId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    };
    const created = await outbox.enqueue(enqueueInput);
    const firstNow = new Date(Date.now());
    const first = await runChild([
      'execute-no-ack',
      'os-provider-before-crash',
      firstNow.toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(first).toMatchObject({ ids: [created.id], effectPerformed: true });
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'processing', attempts: 1 });
    expect(await prisma.notificationDelivery.findMany({ where: { id: created.id } })).toHaveLength(
      1,
    );
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-os-template' } },
      }),
    ).toMatchObject({ availableCount: 1 });

    const second = await runChild([
      'execute-and-ack',
      'os-provider-after-crash',
      new Date(firstNow.getTime() + 1001).toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(second.ids).toEqual([created.id]);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await prisma.notificationDelivery.findMany({ where: { id: created.id } })).toHaveLength(
      1,
    );
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-os-template' } },
      }),
    ).toMatchObject({ availableCount: 1 });
  });

  it('admin SMS provider成功后 ack-crash，通道随后 disabled 仍以 SENT evidence 零重复发送并 ack', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_sms_crash_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, phone: '13977770001' },
    });
    await prisma.smsSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        templateIdNotification: 'outbox-sms-template',
      },
    });
    app.get(SmsSettingsService).invalidate();
    const enqueueInput = input(refs, memberId, '00000000-0000-4000-8000-000000000077');
    const firstNow = new Date();
    const reservation = await prisma.$transaction((tx) =>
      outbox.reserveAdminSmsAttempt(enqueueInput, 'crashed-http-request', tx, {
        now: new Date(firstNow.getTime() - 1001),
        leaseMs: 1000,
      }),
    );
    expect(reservation.state).toBe('reserved');
    const first = await runChild([
      'execute-no-ack',
      'os-sms-before-ack-crash',
      firstNow.toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(first).toMatchObject({ ids: [reservation.intent!.id], effectPerformed: true });
    expect(await prisma.smsSendLog.count({ where: { phone: '13977770001', status: 'SENT' } })).toBe(
      1,
    );
    expect(
      await prisma.notificationDelivery.count({
        where: { notificationId: refs.notificationId, memberId, status: 'sent' },
      }),
    ).toBe(1);

    await prisma.smsSettings.updateMany({ data: { enabled: false } });
    app.get(SmsSettingsService).invalidate();
    const second = await runChild([
      'execute-and-ack',
      'os-sms-after-ack-crash',
      new Date(firstNow.getTime() + 1001).toISOString(),
      '1000',
      enqueueInput.eventKey,
    ]);
    expect(second.ids).toEqual([reservation.intent!.id]);
    expect(await prisma.smsSendLog.count({ where: { phone: '13977770001', status: 'SENT' } })).toBe(
      1,
    );
    expect(
      await prisma.notificationDelivery.findMany({
        where: { notificationId: refs.notificationId, memberId },
        orderBy: { createdAt: 'asc' },
        select: { status: true, reasonCode: true },
      }),
    ).toEqual([
      { status: 'sent', reasonCode: null },
      { status: 'skipped', reasonCode: 'already-sent' },
    ]);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({
        where: { id: reservation.intent!.id },
      }),
    ).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('preparedAt 与 quota decrement 同短事务，崩溃重领也只扣一次', async () => {
    const refs = await createRefs();
    const templateId = 'outbox-template';
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId: refs.memberIds[0], templateId, availableCount: 2 },
    });
    await outbox.enqueue(input(refs));
    const firstNow = new Date();
    const [first] = await outbox.claim('prepare-a', { now: firstNow, leaseMs: 1000 });
    await expect(
      outbox.markPrepared(first, async (tx) => {
        await tx.wechatSubscriptionQuota.update({
          where: { memberId_templateId: { memberId: refs.memberIds[0], templateId } },
          data: { availableCount: { decrement: 1 } },
        });
      }),
    ).resolves.toBe(true);
    const [second] = await outbox.claim('prepare-b', {
      now: new Date(firstNow.getTime() + 1001),
      leaseMs: 1000,
    });
    const prepareAgain = jest.fn();
    await expect(outbox.markPrepared(second, prepareAgain)).resolves.toBe(false);
    expect(prepareAgain).not.toHaveBeenCalled();
    expect(
      await prisma.wechatSubscriptionQuota.findUnique({
        where: { memberId_templateId: { memberId: refs.memberIds[0], templateId } },
      }),
    ).toMatchObject({ availableCount: 1 });
  });

  it('43101 terminal delivery/refund 以 intent.id 幂等，ack crash 重领不重复 provider/refund', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_43101_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, openid: 'dev-openid-wxerr-43101' },
    });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    app.get(WechatSettingsService).invalidate();
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'general' },
      create: {
        notificationTypeCode: 'general',
        templateId: 'outbox-43101-template',
        enabled: true,
      },
      update: { templateId: 'outbox-43101-template', enabled: true },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId, templateId: 'outbox-43101-template', availableCount: 2 },
    });
    const enqueueInput: NotificationOutboxEnqueueInput = {
      eventKey: `wechat-delivery:${refs.notificationId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    };
    await outbox.enqueue(enqueueInput);
    const handlers = app.get(NotificationOutboxHandlers);
    const provider = app.get(WechatService);
    const providerSpy = jest.spyOn(provider, 'sendSubscribeMessage');
    const firstNow = new Date(Date.now());
    const [first] = await outbox.claim('refund-before-crash', {
      now: firstNow,
      leaseMs: 1000,
      eventKey: enqueueInput.eventKey,
    });
    await expect(handlers.execute(first)).resolves.toMatchObject({ effectPerformed: true });
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.notificationDelivery.findUnique({ where: { id: first.id } })).toMatchObject(
      { status: 'failed', reasonCode: 'need-resubscribe', errCode: '43101' },
    );
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-43101-template' } },
      }),
    ).toMatchObject({ availableCount: 2 });

    const [second] = await outbox.claim('refund-after-crash', {
      now: new Date(firstNow.getTime() + 1001),
      leaseMs: 1000,
      eventKey: enqueueInput.eventKey,
    });
    await expect(handlers.execute(second)).resolves.toMatchObject({ effectPerformed: false });
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-43101-template' } },
      }),
    ).toMatchObject({ availableCount: 2 });
    await outbox.ack(second, false);
    providerSpy.mockRestore();
  });

  it('targeted intent 与其 Notification.id/微信 child 引用均为同一 CUID', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const created = await outbox.enqueue({
      eventKey: `targeted-cuid:${memberId}`,
      eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: {
        recipientMemberId: memberId,
        notificationTypeCode: 'expiry-reminder',
        title: 'CUID 锁定',
        body: 'targeted notification 与 outbox 共用 CUID',
        channels: ['in-app', 'wechat'],
      },
      aggregateType: 'certificate',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    expect(created.id).toMatch(/^c[a-z0-9]{20,31}$/);
    const [claimed] = await outbox.claim('targeted-cuid-worker', {
      eventKey: `targeted-cuid:${memberId}`,
    });
    await new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers)).executeReserved(
      claimed,
    );
    expect(await prisma.notification.findUnique({ where: { id: created.id } })).toMatchObject({
      id: created.id,
      recipientMemberId: memberId,
    });
    const child = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { eventKey: `wechat-delivery:${created.id}:${memberId}` },
    });
    expect(child.id).toMatch(/^c[a-z0-9]{20,31}$/);
    expect(child.payload).toEqual({ notificationId: created.id, memberId });
  });

  it('producer transaction 回滚时 intent 同步回滚，worker 无可见 Effect', async () => {
    const refs = await createRefs();
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(input(refs), tx);
        throw new Error('rollback business marker');
      }),
    ).rejects.toThrow('rollback business marker');
    expect(await prisma.notificationOutboxIntent.count()).toBe(0);
  });

  it('双 app 真并发 admin SMS generation 收敛单 active slot，foreign generation 明确 busy', async () => {
    const refs = await createRefs();
    const [left, right] = await Promise.all([
      prisma.$transaction((tx) =>
        outbox.reserveAdminSmsAttempt(
          input(refs, refs.memberIds[0], '00000000-0000-4000-8000-000000000021'),
          'admin-generation-left',
          tx,
        ),
      ),
      prismaB.$transaction((tx) =>
        outboxB.reserveAdminSmsAttempt(
          input(refs, refs.memberIds[0], '00000000-0000-4000-8000-000000000022'),
          'admin-generation-right',
          tx,
        ),
      ),
    ]);
    expect([left.state, right.state].sort()).toEqual(['busy', 'reserved']);
    expect(
      await prisma.notificationOutboxIntent.count({
        where: {
          eventType: OUTBOX_EVENT_ADMIN_SMS,
          aggregateId: refs.notificationId,
          destinationRef: refs.memberIds[0],
          status: { in: ['pending', 'processing'] },
        },
      }),
    ).toBe(1);
  });

  it.each([
    ['unknown type', 'notification.unknown', OUTBOX_PAYLOAD_VERSION],
    ['unknown version', OUTBOX_EVENT_ADMIN_SMS, 99],
  ])('直插 %s 后真实 worker 立即 dead 且零业务 Effect', async (_name, eventType, version) => {
    const refs = await createRefs();
    const created = await prisma.notificationOutboxIntent.create({
      data: {
        eventKey: `raw-unsupported:${eventType}:${version}:${refs.notificationId}`,
        eventType,
        payloadVersion: version,
        payload: { notificationId: refs.notificationId, memberId: refs.memberIds[0] },
        aggregateType: 'notification',
        aggregateId: refs.notificationId,
        destinationType: 'member',
        destinationRef: refs.memberIds[0],
      },
    });
    const before = {
      notifications: await prisma.notification.count(),
      deliveries: await prisma.notificationDelivery.count(),
      sendLogs: await prisma.smsSendLog.count(),
    };
    await expect(app.get(NotificationOutboxWorker).drainOnce()).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 1,
    });
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'dead' });
    expect({
      notifications: await prisma.notification.count(),
      deliveries: await prisma.notificationDelivery.count(),
      sendLogs: await prisma.smsSendLog.count(),
    }).toEqual(before);
  });

  it('直插 exact-shape targeted 敏感 raw row 后真实 worker dead，Notification 零写入', async () => {
    const refs = await createRefs();
    const created = await prisma.notificationOutboxIntent.create({
      data: {
        eventKey: `raw-sensitive-targeted:${refs.notificationId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: refs.memberIds[0],
          notificationTypeCode: 'activity-reminder',
          title: '敏感活动',
          body: '请联系 13900000001 或使用 Bearer abcdefghijklmnop',
          channels: ['in-app'],
        },
        aggregateType: 'activity',
        aggregateId: refs.notificationId,
        destinationType: 'member',
        destinationRef: refs.memberIds[0],
      },
    });
    const before = await prisma.notification.count();
    await expect(app.get(NotificationOutboxWorker).drainOnce()).resolves.toMatchObject({ dead: 1 });
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'dead' });
    expect(await prisma.notification.count()).toBe(before);
  });

  it('admin per-recipient reservation 防后台抢领，partial/channel/DB失败只重试失败 child', async () => {
    const refs = await createRefs(3);
    const requestOwner = 'admin-request-owner';
    const reserved = await prisma.$transaction(async (tx) => {
      const rows: ClaimedNotificationOutboxIntent[] = [];
      for (const memberId of refs.memberIds) {
        const result = await outbox.reserveAdminSmsAttempt(input(refs, memberId), requestOwner, tx);
        if (result.intent) rows.push(result.intent);
      }
      // 另一个 pool 在 request transaction commit 前看不到未提交 rows。
      expect(await outbox.claim('background-before-commit')).toEqual([]);
      return rows;
    });
    expect(reserved).toHaveLength(3);
    // commit 后 rows 已是 request-owned processing，后台同样抢不到。
    expect(await outbox.claim('background-after-commit')).toEqual([]);

    const firstAttempts = new Map<string, number>();
    const handlers = {
      execute: jest.fn(async (intent: ClaimedNotificationOutboxIntent) => {
        const memberId = (intent.payload as { memberId: string }).memberId;
        const count = (firstAttempts.get(memberId) ?? 0) + 1;
        firstAttempts.set(memberId, count);
        if (memberId === refs.memberIds[1] && count === 1) {
          throw new SmsChannelUnavailableError('channel closed after first recipient');
        }
        if (memberId === refs.memberIds[2] && count === 1) {
          throw new Error('single-recipient delivery DB failure');
        }
        return { effectPerformed: true, value: { outcome: 'sent' } };
      }),
    };
    const worker = new NotificationOutboxWorker(outbox, handlers as never);
    const firstResults = await Promise.allSettled(
      reserved.map((intent) => worker.executeReserved(intent)),
    );
    expect(firstResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(firstResults.filter(({ status }) => status === 'rejected')).toHaveLength(2);
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'succeeded' } })).toBe(1);
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'pending' } })).toBe(2);

    const pending = await prisma.notificationOutboxIntent.findMany({
      where: { status: 'pending' },
      orderBy: { availableAt: 'asc' },
    });
    const retryAt = new Date(
      Math.max(...pending.map(({ availableAt }) => availableAt.getTime())) + 1,
    );
    const retry = await outbox.claim('background-retry', { now: retryAt });
    expect(retry).toHaveLength(2);
    await Promise.all(retry.map((intent) => worker.executeReserved(intent)));
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'succeeded' } })).toBe(3);
    expect(firstAttempts.get(refs.memberIds[0])).toBe(1);
    expect(firstAttempts.get(refs.memberIds[1])).toBe(2);
    expect(firstAttempts.get(refs.memberIds[2])).toBe(2);
  });

  it('短 lease 被后台 reclaim 后 stale HTTP re-fence 失败且 provider 零调用', async () => {
    const refs = await createRefs();
    const firstNow = new Date(Date.now() - 2000);
    const reservation = await prisma.$transaction((tx) =>
      outbox.reserveAdminSmsAttempt(input(refs), 'stale-http-request', tx, {
        now: firstNow,
        leaseMs: 1000,
      }),
    );
    expect(reservation.intent).not.toBeNull();
    await expect(
      prismaB.$transaction((tx) =>
        outboxB.reserveAdminSmsAttempt(
          input(refs, refs.memberIds[0], '00000000-0000-4000-8000-000000000099'),
          'new-http-generation',
          tx,
        ),
      ),
    ).resolves.toMatchObject({ state: 'busy', intent: null });
    const provider = { execute: jest.fn() };
    const staleHttp = new NotificationOutboxWorker(outbox, provider as never);
    const [reclaimResult, staleResult] = await Promise.allSettled([
      outboxB.claim('background-reclaimer', { now: new Date(), leaseMs: 30_000 }),
      staleHttp.executeReserved(reservation.intent!),
    ]);
    expect(reclaimResult.status).toBe('fulfilled');
    if (reclaimResult.status === 'fulfilled') expect(reclaimResult.value).toHaveLength(1);
    expect(staleResult.status).toBe('rejected');
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('微信 child 仍 processing（ack-crash 窗口）时新 publish generation 复用 active slot', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const attempt = (rootId: string): NotificationOutboxEnqueueInput => ({
      eventKey: `wechat-delivery:${refs.notificationId}:${rootId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const first = await outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000007'));
    const [processing] = await outbox.claim('wechat-ack-crash', {
      eventKey: first.eventKey,
      leaseMs: 30_000,
    });
    expect(processing.id).toBe(first.id);

    const reused = await outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000008'));
    expect(reused.id).toBe(first.id);
    expect(
      await prisma.notificationOutboxIntent.count({
        where: {
          eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
          aggregateId: refs.notificationId,
          destinationRef: memberId,
          status: { in: ['pending', 'processing'] },
        },
      }),
    ).toBe(1);
  });

  it('同一 notification/member 两 generation 真并发 enqueue 收敛单 active，terminal 后新 generation 获得新 id', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const attempt = (rootId: string): NotificationOutboxEnqueueInput => ({
      eventKey: `wechat-delivery:${refs.notificationId}:${rootId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const [left, right] = await Promise.all([
      outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000011')),
      outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000012')),
    ]);
    expect(left.id).toBe(right.id);
    expect(
      await prisma.notificationOutboxIntent.count({
        where: {
          eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
          aggregateId: refs.notificationId,
          destinationRef: memberId,
          status: { in: ['pending', 'processing'] },
        },
      }),
    ).toBe(1);

    const [claimed] = await outbox.claim('wechat-generation-terminal', {
      eventKey: left.eventKey,
    });
    await outbox.ack(claimed, false);
    const nextGeneration = await outbox.enqueueWechatDeliveryAttempt(
      attempt('cm00000000000000000000013'),
    );
    expect(nextGeneration.id).not.toBe(left.id);
    expect(nextGeneration.status).toBe('pending');
  });

  it('独立 worker module 可由 child application context 启动且不依赖 AppModule/ScheduleModule', async () => {
    await expect(runChild(['boot'])).resolves.toMatchObject({ booted: true });
  });
});

function runChild(args: string[]): Promise<ChildResult> {
  const fixture = join(process.cwd(), 'test', 'fixtures', 'notification-outbox-worker-child.ts');
  const tsNodeRegister = join(
    process.cwd(),
    'node_modules',
    'ts-node',
    'register',
    'transpile-only.js',
  );
  const tsconfigPathsRegister = join(
    process.cwd(),
    'node_modules',
    'tsconfig-paths',
    'register.js',
  );
  return new Promise((resolve, reject) => {
    // tsx/esbuild 不生成 Nest 依赖注入所需的 decorator metadata；真 OS child 必须复用
    // TypeScript compiler + 本仓 tsconfig 的 emitDecoratorMetadata，才能等价启动生产 module。
    const child = spawn(
      process.execPath,
      ['-r', tsNodeRegister, '-r', tsconfigPathsRegister, fixture, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'test', 'tsconfig.test.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `outbox child exit=${code ?? 'signal'} stdout=${stdout.trim()} stderr=${stderr.trim()}`,
          ),
        );
        return;
      }
      const line = stdout.trim().split('\n').at(-1);
      if (!line) {
        reject(new Error('outbox child produced no JSON result'));
        return;
      }
      resolve(JSON.parse(line) as ChildResult);
    });
  });
}

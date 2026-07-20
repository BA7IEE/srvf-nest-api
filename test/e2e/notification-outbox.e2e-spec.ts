import { Logger, type INestApplication } from '@nestjs/common';
import type { NotificationOutboxIntent } from '@prisma/client';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import {
  OUTBOX_ADMIN_PAYLOAD_VERSION,
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_EVENT_BIRTHDAY_SMS,
  OUTBOX_EVENT_SYSTEM_BROADCAST,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxGenerationConflictError,
  NotificationOutboxService,
} from '../../src/modules/notifications/notification-outbox.service';
import {
  type NotificationOutboxEnqueueInput,
  NotificationOutboxLeaseLostError,
} from '../../src/modules/notifications/notification-outbox.types';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { SmsChannelUnavailableError } from '../../src/modules/sms/sms.types';
import { DevStubSmsProvider } from '../../src/modules/sms/providers/dev-stub.provider';
import { DevStubWechatProvider } from '../../src/modules/wechat/providers/dev-stub.provider';
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
  phase?:
    | 'claimed'
    | 'not-claimed'
    | 'permission-granted'
    | 'permission-denied'
    | 'evidence-persisted'
    | 'effect-persisted-before-return';
  ids?: string[];
  effectPerformed?: boolean;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningChild {
  result: Promise<ChildResult>;
  exited: Promise<ChildExit>;
  sendSignal: (signal: NodeJS.Signals) => void;
  kill: () => Promise<NodeJS.Signals | null>;
}

const ALLOW_EFFECT = { beforeEffect: () => Promise.resolve() };

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

  async function configureDevSms(): Promise<void> {
    await prisma.smsSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        templateIdBirthday: 'outbox-birthday-template',
        templateIdNotification: 'outbox-notification-template',
      },
    });
  }

  function input(
    refs: Refs,
    memberId = refs.memberIds[0],
    generation = '00000000-0000-4000-8000-000000000001',
  ): NotificationOutboxEnqueueInput {
    return {
      eventKey: `admin-sms:${refs.notificationId}:${generation}:${memberId}`,
      eventType: OUTBOX_EVENT_ADMIN_SMS,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
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

  it('真实 OS child claimed-before-effect 后 SIGKILL，expiry 后第二 child 仅执行一次 Effect', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const created = await outbox.enqueue({
      eventKey: `targeted-sigkill-before-effect:${memberId}`,
      eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: {
        recipientMemberId: memberId,
        notificationTypeCode: 'expiry-reminder',
        title: 'SIGKILL claimed window',
        body: 'Effect must start only after reclaim',
        channels: ['in-app'],
      },
      aggregateType: 'member',
      aggregateId: memberId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const crashed = startChild([
      'claim-and-wait',
      'os-sigkill-before-effect',
      '',
      '1000',
      created.eventKey,
    ]);
    try {
      await expect(crashed.result).resolves.toMatchObject({
        phase: 'claimed',
        ids: [created.id],
      });
    } finally {
      await expect(crashed.kill()).resolves.toBe('SIGKILL');
    }

    const abandoned = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(abandoned).toMatchObject({ status: 'processing', attempts: 1 });
    expect(await prisma.notification.findUnique({ where: { id: created.id } })).toBeNull();
    await waitUntilExpired(abandoned.leaseExpiresAt!);

    const recovered = await runChild([
      'execute-and-ack',
      'os-after-sigkill-before-effect',
      '',
      '30000',
      created.eventKey,
    ]);
    expect(recovered.ids).toEqual([created.id]);
    expect(await prisma.notification.findUnique({ where: { id: created.id } })).toMatchObject({
      id: created.id,
      recipientMemberId: memberId,
    });
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('真实 OS child 收到 SIGTERM 后 stop-and-drain 当前 attempt/heartbeat，且不 claim 下一条', async () => {
    const refs = await createRefs();
    const created: NotificationOutboxIntent[] = [];
    for (let index = 0; index < 2; index += 1) {
      created.push(
        await outbox.enqueue({
          eventKey: `targeted-sigterm-drain:${refs.memberIds[0]}:${index}`,
          eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
          payloadVersion: OUTBOX_PAYLOAD_VERSION,
          payload: {
            recipientMemberId: refs.memberIds[0],
            notificationTypeCode: 'expiry-reminder',
            title: `SIGTERM drain ${index}`,
            body: 'finish current attempt before process exit',
            channels: ['in-app'],
          },
          aggregateType: 'member',
          aggregateId: refs.memberIds[0],
          destinationType: 'member',
          destinationRef: refs.memberIds[0],
        }),
      );
    }
    const child = startChild(['run-slow-sigterm', 'os-sigterm-drain', '', '750']);
    let observedExit = false;
    let activeId = '';
    try {
      const barrier = await child.result;
      expect(barrier).toMatchObject({ phase: 'effect-persisted-before-return' });
      activeId = barrier.ids?.[0] ?? '';
      expect(created.map(({ id }) => id)).toContain(activeId);
      expect(await prisma.notification.findUnique({ where: { id: activeId } })).not.toBeNull();

      child.sendSignal('SIGTERM');
      await expect(
        Promise.race([child.exited.then(() => 'exited'), pause(100).then(() => 'still-draining')]),
      ).resolves.toBe('still-draining');
      const exit = await child.exited;
      observedExit = true;
      expect(exit.signal === 'SIGTERM' || exit.code === 0).toBe(true);
    } finally {
      if (!observedExit) await child.kill();
    }

    const active = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { id: activeId },
    });
    const untouchedId = created.find(({ id }) => id !== activeId)!.id;
    const untouched = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { id: untouchedId },
    });
    expect(active).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(untouched).toMatchObject({
      status: 'pending',
      attempts: 0,
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
    });
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

  it('首条慢 Effect 时 20 条批尾零预消耗，且本轮最多 JIT 处理 20 条', async () => {
    const refs = await createRefs();
    for (let index = 0; index < 21; index += 1) {
      await outbox.enqueue({
        eventKey: `batch-tail:${refs.notificationId}:${index}`,
        eventType: OUTBOX_EVENT_SYSTEM_BROADCAST,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          notificationTypeCode: 'expiry-reminder',
          title: `batch ${index}`,
          body: 'JIT claim envelope',
          visibilityCode: 'member',
        },
        aggregateType: 'batch-test',
        aggregateId: refs.notificationId,
        destinationType: 'audience',
        destinationRef: `batch-${index}`,
      });
    }
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let handlerCalls = 0;
    const handlers = {
      execute: jest.fn(async () => {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          markFirstStarted();
          await firstReleased;
        }
        return { effectPerformed: false };
      }),
    };
    const worker = new NotificationOutboxWorker(outbox, handlers as never);
    const execution = worker.drainOnce();
    let processing: NotificationOutboxIntent[] = [];
    let pending: NotificationOutboxIntent[] = [];

    try {
      await firstStarted;
      [processing, pending] = await Promise.all([
        prisma.notificationOutboxIntent.findMany({ where: { status: 'processing' } }),
        prisma.notificationOutboxIntent.findMany({ where: { status: 'pending' } }),
      ]);
    } finally {
      releaseFirst();
      await execution;
    }

    expect(processing).toHaveLength(1);
    expect(processing[0]).toMatchObject({ attempts: 1, leaseOwner: expect.any(String) });
    expect(pending).toHaveLength(20);
    expect(
      pending.every(
        (row) =>
          row.attempts === 0 &&
          row.leaseOwner === null &&
          row.lockedAt === null &&
          row.leaseExpiresAt === null,
      ),
    ).toBe(true);

    await expect(execution).resolves.toMatchObject({
      claimed: 20,
      succeeded: 20,
      failed: 0,
    });
    expect(handlers.execute).toHaveBeenCalledTimes(20);
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'succeeded' } })).toBe(
      20,
    );
    expect(
      await prisma.notificationOutboxIntent.findFirstOrThrow({ where: { status: 'pending' } }),
    ).toMatchObject({
      attempts: 0,
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
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
    await handlers.execute(first, ALLOW_EFFECT);
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

  it('真实 OS child evidence-before-ack 后 SIGKILL，reclaim 依 evidence 零重复 quota/provider', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_os_crash_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, openid: 'dev-openid-outbox-os-crash' },
    });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
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
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    };
    const created = await outbox.enqueue(enqueueInput);
    const crashed = startChild([
      'execute-effect-and-wait',
      'os-provider-before-crash',
      '',
      '1000',
      enqueueInput.eventKey,
    ]);
    try {
      await expect(crashed.result).resolves.toMatchObject({
        phase: 'evidence-persisted',
        ids: [created.id],
        effectPerformed: true,
      });
    } finally {
      await expect(crashed.kill()).resolves.toBe('SIGKILL');
    }
    const abandoned = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(abandoned).toMatchObject({ status: 'processing', attempts: 1 });
    expect(await prisma.notificationDelivery.findMany({ where: { id: created.id } })).toHaveLength(
      1,
    );
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-os-template' } },
      }),
    ).toMatchObject({ availableCount: 1 });
    // SIGKILL 发生在 evidence commit 与 ack 之间；等待真实短租约到期，不手改 fence/expiry。
    await waitUntilExpired(abandoned.leaseExpiresAt!);

    const second = await runChild([
      'execute-and-ack',
      'os-provider-after-crash',
      '',
      '30000',
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
    const enqueueInput = input(refs, memberId, '00000000-0000-4000-8000-000000000077');
    const reservation = await prisma.$transaction((tx) =>
      outbox.reserveAdminSmsAttempt(enqueueInput, tx),
    );
    expect(reservation.state).toBe('reserved');
    expect(reservation.intent).toMatchObject({
      status: 'pending',
      attempts: 0,
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
    });
    const first = await runChild([
      'execute-no-ack',
      'os-sms-before-ack-crash',
      '',
      '30000',
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
    // SENT evidence 已落库后只推进 lease 到期；杀死 reclaim 先查 channel readiness
    // 或再次调用 provider 的 mutation（通道已关闭时仍必须凭 SENT evidence ack）。
    await prisma.notificationOutboxIntent.update({
      where: { id: reservation.intent!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });

    await prisma.smsSettings.updateMany({ data: { enabled: false } });
    const second = await runChild([
      'execute-and-ack',
      'os-sms-after-ack-crash',
      '',
      '30000',
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
    ).toMatchObject({ status: 'succeeded', attempts: 2 });
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

  it('双 app/双 pool 短租约慢 Effect 由 heartbeat 护航，lockedAt 稳定且 quota 只扣一次', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_heartbeat_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, openid: 'dev-openid-outbox-heartbeat' },
    });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'general' },
      create: { notificationTypeCode: 'general', templateId: 'outbox-heartbeat', enabled: true },
      update: { templateId: 'outbox-heartbeat', enabled: true },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId, templateId: 'outbox-heartbeat', availableCount: 2 },
    });
    const enqueueInput: NotificationOutboxEnqueueInput = {
      eventKey: `wechat-heartbeat:${refs.notificationId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    };
    await outbox.enqueue(enqueueInput);
    const provider = app.get(DevStubWechatProvider);
    const send = provider.sendSubscribeMessage.bind(provider);
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerSpy = jest
      .spyOn(provider, 'sendSubscribeMessage')
      .mockImplementation(async (accessToken, request, beforeEffect) => {
        markProviderStarted();
        await providerReleased;
        return send(accessToken, request, beforeEffect);
      });
    const worker = new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers));
    const [claimed] = await outbox.claim('heartbeat-worker-a', {
      eventKey: enqueueInput.eventKey,
      leaseMs: 300,
    });
    const initialLockedAt = claimed.lockedAt;
    const initialExpiry = claimed.leaseExpiresAt;
    const execution = worker.executeReserved(claimed);
    let providerCallCount = 0;

    try {
      await providerStarted;
      await waitForCondition(async () => {
        const row = await prisma.notificationOutboxIntent.findUniqueOrThrow({
          where: { id: claimed.id },
        });
        return row.leaseExpiresAt!.getTime() > initialExpiry.getTime();
      });
      await waitUntilExpired(initialExpiry);
      expect(
        await outboxB.claim('heartbeat-worker-b', {
          eventKey: enqueueInput.eventKey,
          leaseMs: 300,
        }),
      ).toEqual([]);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
      ).toMatchObject({
        status: 'processing',
        lockedAt: initialLockedAt,
        preparedAt: expect.any(Date),
      });
      expect(
        await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
          where: { memberId_templateId: { memberId, templateId: 'outbox-heartbeat' } },
        }),
      ).toMatchObject({ availableCount: 1 });
    } finally {
      releaseProvider();
      try {
        await execution;
        providerCallCount = providerSpy.mock.calls.length;
      } finally {
        providerSpy.mockRestore();
      }
    }

    expect(providerCallCount).toBe(1);
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId: 'outbox-heartbeat' } },
      }),
    ).toMatchObject({ availableCount: 1 });
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
    ).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('WeChat deep provider guard renew 失败：stub Effect=0、delivery evidence=0、零 terminal', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const user = await createTestUser(app, { username: `outbox_deep_guard_${Date.now()}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId, openid: 'dev-openid-outbox-deep-guard' },
    });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    const templateId = 'outbox-deep-guard-template';
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'general' },
      create: { notificationTypeCode: 'general', templateId, enabled: true },
      update: { templateId, enabled: true },
    });
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId, templateId, availableCount: 2 },
    });
    const created = await outbox.enqueue({
      eventKey: `wechat-deep-guard:${refs.notificationId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const [claimed] = await outbox.claim('deep-guard-worker', {
      eventKey: created.eventKey,
      leaseMs: 30_000,
    });
    const leaseLost = new NotificationOutboxLeaseLostError(claimed.id);
    const renew = outbox.renewLease.bind(outbox);
    let renewCalls = 0;
    const renewSpy = jest.spyOn(outbox, 'renewLease').mockImplementation((...args) => {
      renewCalls += 1;
      return renewCalls === 1 ? renew(...args) : Promise.reject(leaseLost);
    });
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    let debugText = '';
    try {
      await expect(
        new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers)).executeReserved(
          claimed,
        ),
      ).rejects.toBe(leaseLost);
      debugText = (debugSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');
    } finally {
      renewSpy.mockRestore();
      debugSpy.mockRestore();
    }

    expect(renewCalls).toBe(2);
    expect(debugText).not.toContain('[DEV_STUB] getAccessToken called');
    expect(debugText).not.toContain('[DEV_STUB] sendSubscribeMessage called');
    expect(
      await prisma.notificationDelivery.count({ where: { notificationId: refs.notificationId } }),
    ).toBe(0);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
    ).toMatchObject({
      status: 'processing',
      attempts: 1,
      preparedAt: expect.any(Date),
      completedAt: null,
      deadAt: null,
    });
    expect(
      await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId, templateId } },
      }),
    ).toMatchObject({ availableCount: 1 });
  });

  it.each([
    ['birthday', OUTBOX_EVENT_BIRTHDAY_SMS, 'sendBirthdayGreeting'],
    ['admin', OUTBOX_EVENT_ADMIN_SMS, 'sendNotification'],
  ] as const)(
    '%s SMS deep guard renew 失败：DevStub 最终 Effect=0、SENT/FAILED evidence=0、零 terminal',
    async (kind, eventType, providerMethod) => {
      const refs = await createRefs();
      const memberId = refs.memberIds[0];
      const phone = kind === 'birthday' ? '13988000001' : '13988000002';
      const user = await createTestUser(app, {
        username: `outbox_sms_guard_${kind}_${Date.now()}`,
      });
      await prisma.user.update({ where: { id: user.id }, data: { memberId, phone } });
      await configureDevSms();

      const created = await outbox.enqueue(
        kind === 'birthday'
          ? {
              eventKey: `birthday-sms:2026-07-19:${memberId}`,
              eventType,
              payloadVersion: OUTBOX_PAYLOAD_VERSION,
              payload: { memberId, dateKey: '2026-07-19' },
              aggregateType: 'member',
              aggregateId: memberId,
              destinationType: 'member',
              destinationRef: memberId,
            }
          : input(refs),
      );
      const [claimed] = await outbox.claim(`sms-deep-guard-${kind}`, {
        eventKey: created.eventKey,
        leaseMs: 30_000,
      });
      const leaseLost = new NotificationOutboxLeaseLostError(claimed.id);
      const renew = outbox.renewLease.bind(outbox);
      let renewCalls = 0;
      const renewSpy = jest.spyOn(outbox, 'renewLease').mockImplementation((...args) => {
        renewCalls += 1;
        return renewCalls === 1 ? renew(...args) : Promise.reject(leaseLost);
      });
      const devStub = app.get(DevStubSmsProvider);
      const providerSpy =
        providerMethod === 'sendBirthdayGreeting'
          ? jest.spyOn(devStub, 'sendBirthdayGreeting')
          : jest.spyOn(devStub, 'sendNotification');
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      let debugText = '';
      try {
        await expect(
          new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers)).executeReserved(
            claimed,
          ),
        ).rejects.toBe(leaseLost);
        expect(providerSpy).not.toHaveBeenCalled();
        debugText = (debugSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');
      } finally {
        renewSpy.mockRestore();
        providerSpy.mockRestore();
        debugSpy.mockRestore();
      }

      expect(renewCalls).toBe(2);
      expect(debugText).not.toContain(`[DEV_STUB] ${providerMethod}`);
      expect(await prisma.smsSendLog.count({ where: { phone } })).toBe(0);
      expect(
        await prisma.notificationDelivery.count({
          where: { notificationId: refs.notificationId, channel: 'sms' },
        }),
      ).toBe(0);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
      ).toMatchObject({
        status: 'processing',
        attempts: 1,
        completedAt: null,
        deadAt: null,
      });
    },
  );

  it('birthday provider accepted 后 SENT evidence DB 写失败只 nack，绝不伪造 FAILED', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const phone = '13988000004';
    const user = await createTestUser(app, {
      username: `outbox_birthday_evidence_${Date.now()}`,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId, phone } });
    await configureDevSms();

    const created = await outbox.enqueue({
      eventKey: `birthday-sms:2026-07-20:${memberId}`,
      eventType: OUTBOX_EVENT_BIRTHDAY_SMS,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: { memberId, dateKey: '2026-07-20' },
      aggregateType: 'member',
      aggregateId: memberId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const [claimed] = await outbox.claim('birthday-evidence-db-failure', {
      eventKey: created.eventKey,
      leaseMs: 30_000,
    });
    const dbError = new Error('birthday SENT evidence unavailable');
    const devStub = app.get(DevStubSmsProvider);
    const providerSpy = jest.spyOn(devStub, 'sendBirthdayGreeting');
    const createSpy = jest.spyOn(prisma.smsSendLog, 'create').mockRejectedValueOnce(dbError);

    try {
      await expect(
        new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers)).executeReserved(
          claimed,
        ),
      ).rejects.toBe(dbError);
      expect(providerSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0].data).toMatchObject({ phone, status: 'SENT' });
    } finally {
      providerSpy.mockRestore();
      createSpy.mockRestore();
    }

    expect(await prisma.smsSendLog.count({ where: { phone } })).toBe(0);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
    ).toMatchObject({
      status: 'pending',
      attempts: 1,
      completedAt: null,
      deadAt: null,
    });
  });

  it('双 app/双 pool：admin SMS 短租约慢 DevStub Effect 由 heartbeat 护航并 terminal', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const phone = '13988000003';
    const user = await createTestUser(app, { username: `outbox_sms_slow_${Date.now()}` });
    await prisma.user.update({ where: { id: user.id }, data: { memberId, phone } });
    await configureDevSms();
    const created = await outbox.enqueue(input(refs));
    const devStub = app.get(DevStubSmsProvider);
    const send = devStub.sendNotification.bind(devStub);
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    let releaseEffect!: () => void;
    const effectReleased = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const providerSpy = jest
      .spyOn(devStub, 'sendNotification')
      .mockImplementation(async (request) => {
        markEffectStarted();
        await effectReleased;
        return send(request);
      });
    const worker = new NotificationOutboxWorker(outbox, app.get(NotificationOutboxHandlers));
    const [claimed] = await outbox.claim('sms-heartbeat-worker-a', {
      eventKey: created.eventKey,
      leaseMs: 300,
    });
    const initialLockedAt = claimed.lockedAt;
    const initialExpiry = claimed.leaseExpiresAt;
    const execution = worker.executeReserved(claimed);
    let providerCallCount = 0;

    try {
      await effectStarted;
      await waitForCondition(async () => {
        const row = await prisma.notificationOutboxIntent.findUniqueOrThrow({
          where: { id: claimed.id },
        });
        return row.leaseExpiresAt!.getTime() > initialExpiry.getTime();
      });
      await waitUntilExpired(initialExpiry);
      await expect(
        outboxB.claim('sms-heartbeat-worker-b', {
          eventKey: created.eventKey,
          leaseMs: 300,
        }),
      ).resolves.toEqual([]);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
      ).toMatchObject({ status: 'processing', lockedAt: initialLockedAt });
    } finally {
      releaseEffect();
      try {
        await execution;
        providerCallCount = providerSpy.mock.calls.length;
      } finally {
        providerSpy.mockRestore();
      }
    }

    expect(providerCallCount).toBe(1);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: claimed.id } }),
    ).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await prisma.smsSendLog.count({ where: { phone, status: 'SENT' } })).toBe(1);
    expect(
      await prisma.notificationDelivery.count({
        where: { notificationId: refs.notificationId, memberId, channel: 'sms', status: 'sent' },
      }),
    ).toBe(1);
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
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
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
    await expect(handlers.execute(first, ALLOW_EFFECT)).resolves.toMatchObject({
      effectPerformed: true,
    });
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
    await expect(handlers.execute(second, ALLOW_EFFECT)).resolves.toMatchObject({
      effectPerformed: false,
    });
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
          tx,
        ),
      ),
      prismaB.$transaction((tx) =>
        outboxB.reserveAdminSmsAttempt(
          input(refs, refs.memberIds[0], '00000000-0000-4000-8000-000000000022'),
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

  it('显式替换旧 HTTP 防抢锁：admin commit 后 pending，后台可抢且 HTTP 返回 not-claimed', async () => {
    const refs = await createRefs();
    const reservation = await prisma.$transaction(async (tx) => {
      const result = await outbox.reserveAdminSmsAttempt(input(refs), tx);
      // 未提交 command 对另一个 app/pool 不可见。
      expect(await outboxB.claim('background-before-commit', { limit: 1 })).toEqual([]);
      return result;
    });
    expect(reservation.intent).toMatchObject({
      status: 'pending',
      attempts: 0,
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
    });

    const [stolen] = await outboxB.claim('background-after-commit', {
      limit: 1,
      eventKey: reservation.intent!.eventKey,
    });
    expect(stolen).toMatchObject({ status: 'processing', attempts: 1 });
    const httpHandlers = { execute: jest.fn() };
    const httpWorker = new NotificationOutboxWorker(outbox, httpHandlers as never);
    await expect(httpWorker.drainEventKeyOrThrow(stolen.eventKey)).resolves.toEqual({
      state: 'not-claimed',
    });
    expect(httpHandlers.execute).not.toHaveBeenCalled();

    const backgroundHandlers = {
      execute: jest.fn().mockResolvedValue({
        effectPerformed: true,
        value: { outcome: 'sent' },
      }),
    };
    await new NotificationOutboxWorker(outboxB, backgroundHandlers as never).executeReserved(
      stolen,
    );
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: stolen.id } }),
    ).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it.each([
    ['reservation 后撤回', { statusCode: 'draft' }],
    ['reservation 后移除 sms', { channels: ['in-app'] }],
  ])(
    '双 app/双 pool %s：另一 worker 重验父状态后 terminal skip 且 provider=0',
    async (_name, data) => {
      const refs = await createRefs();
      const reservation = await prisma.$transaction((tx) =>
        outbox.reserveAdminSmsAttempt(input(refs), tx),
      );
      expect(reservation.intent).toMatchObject({ status: 'pending', attempts: 0 });
      await prisma.notification.update({
        where: { id: refs.notificationId },
        data,
      });

      const providerSpy = jest.spyOn(appB.get(DevStubSmsProvider), 'sendNotification');
      try {
        const [claimed] = await outboxB.claim('parent-state-worker-b', {
          eventKey: reservation.intent!.eventKey,
          limit: 1,
        });
        await expect(
          new NotificationOutboxWorker(
            outboxB,
            appB.get(NotificationOutboxHandlers),
          ).executeReserved(claimed),
        ).resolves.toEqual({ outcome: 'skipped' });
        expect(providerSpy).not.toHaveBeenCalled();
      } finally {
        providerSpy.mockRestore();
      }

      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({
          where: { id: reservation.intent!.id },
        }),
      ).toMatchObject({ status: 'succeeded', attempts: 1, sentAt: null });
    },
  );

  it('admin per-recipient JIT 首轮 partial/channel/DB 失败只重试失败 child', async () => {
    const refs = await createRefs(3);
    const reserved = await prisma.$transaction(async (tx) => {
      const rows: NotificationOutboxIntent[] = [];
      for (const memberId of refs.memberIds) {
        const result = await outbox.reserveAdminSmsAttempt(input(refs, memberId), tx);
        if (result.intent) rows.push(result.intent);
      }
      return rows;
    });
    expect(reserved).toHaveLength(3);
    expect(reserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'pending', attempts: 0, leaseOwner: null }),
      ]),
    );

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
    const firstResults: PromiseSettledResult<unknown>[] = [];
    for (const intent of reserved) {
      try {
        firstResults.push({
          status: 'fulfilled',
          value: await worker.drainEventKeyOrThrow(intent.eventKey),
        });
      } catch (reason) {
        firstResults.push({ status: 'rejected', reason });
      }
    }
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
    for (const row of pending) {
      const [retry] = await outbox.claim('background-retry', {
        now: retryAt,
        limit: 1,
        eventKey: row.eventKey,
      });
      await worker.executeReserved(retry);
    }
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'succeeded' } })).toBe(3);
    expect(firstAttempts.get(refs.memberIds[0])).toBe(1);
    expect(firstAttempts.get(refs.memberIds[1])).toBe(2);
    expect(firstAttempts.get(refs.memberIds[2])).toBe(2);
  });

  it('短 lease 被后台 reclaim 后 stale HTTP re-fence 失败且 provider 零调用', async () => {
    const refs = await createRefs();
    const reservation = await prisma.$transaction((tx) =>
      outbox.reserveAdminSmsAttempt(input(refs), tx),
    );
    expect(reservation.intent).not.toBeNull();
    const firstNow = new Date();
    const [staleIntent] = await outbox.claim('stale-http-request', {
      now: firstNow,
      leaseMs: 1000,
      limit: 1,
      eventKey: reservation.intent!.eventKey,
    });
    await expect(
      prismaB.$transaction((tx) =>
        outboxB.reserveAdminSmsAttempt(
          input(refs, refs.memberIds[0], '00000000-0000-4000-8000-000000000099'),
          tx,
        ),
      ),
    ).resolves.toMatchObject({ state: 'busy', intent: null });
    const provider = { execute: jest.fn() };
    const staleHttp = new NotificationOutboxWorker(outbox, provider as never);
    const reclaimed = await outboxB.claim('background-reclaimer', {
      now: new Date(firstNow.getTime() + 1001),
      leaseMs: 30_000,
      limit: 1,
      eventKey: reservation.intent!.eventKey,
    });
    expect(reclaimed).toHaveLength(1);
    await expect(staleHttp.executeReserved(staleIntent)).rejects.toThrow(
      'NOTIFICATION_OUTBOX_LEASE_LOST',
    );
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('微信 child 仍 processing（ack-crash 窗口）时新 publish generation 显式冲突供 root defer', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    const attempt = (
      rootId: string,
      publishGeneration: number,
    ): NotificationOutboxEnqueueInput => ({
      eventKey: `wechat-delivery:${refs.notificationId}:${rootId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const first = await outbox.enqueueWechatDeliveryAttempt(
      attempt('cm00000000000000000000007', 1),
    );
    const [processing] = await outbox.claim('wechat-ack-crash', {
      eventKey: first.eventKey,
      leaseMs: 30_000,
    });
    expect(processing.id).toBe(first.id);

    await expect(
      outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000008', 2)),
    ).rejects.toBeInstanceOf(NotificationOutboxGenerationConflictError);
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
    const attempt = (
      rootId: string,
      publishGeneration: number,
    ): NotificationOutboxEnqueueInput => ({
      eventKey: `wechat-delivery:${refs.notificationId}:${rootId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const settled = await Promise.allSettled([
      outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000011', 1)),
      outbox.enqueueWechatDeliveryAttempt(attempt('cm00000000000000000000012', 2)),
    ]);
    const fulfilled = settled.find(
      (result): result is PromiseFulfilledResult<NotificationOutboxIntent> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toBeInstanceOf(NotificationOutboxGenerationConflictError);
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

    const left = fulfilled!.value;
    const [claimed] = await outbox.claim('wechat-generation-terminal', {
      eventKey: left.eventKey,
    });
    await outbox.ack(claimed, false);
    const nextGeneration = await outbox.enqueueWechatDeliveryAttempt(
      attempt('cm00000000000000000000013', 3),
    );
    expect(nextGeneration.id).not.toBe(left.id);
    expect(nextGeneration.status).toBe('pending');
  });

  it('OS child permission 后崩溃，撤回先于 reclaim permission 时第二次零 Effect', async () => {
    const refs = await createRefs();
    const memberId = refs.memberIds[0];
    await prisma.notification.update({
      where: { id: refs.notificationId },
      data: { channels: ['in-app', 'wechat'] },
    });
    const created = await outbox.enqueue({
      eventKey: `wechat-permission-crash:${refs.notificationId}:${memberId}`,
      eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
      payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
      payload: { notificationId: refs.notificationId, memberId, publishGeneration: 0 },
      aggregateType: 'notification',
      aggregateId: refs.notificationId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    const firstNow = new Date();
    const first = startChild([
      'authorize-admin-and-wait',
      'permission-crash-owner',
      firstNow.toISOString(),
      '1000',
      created.eventKey,
    ]);
    try {
      await expect(first.result).resolves.toMatchObject({ phase: 'permission-granted' });
      expect(await first.kill()).toBe('SIGKILL');
    } finally {
      await first.kill().catch(() => undefined);
    }
    await prisma.notification.update({
      where: { id: refs.notificationId },
      data: { statusCode: 'draft' },
    });
    await expect(
      runChild([
        'execute-and-ack',
        'permission-reclaim-owner',
        new Date(firstNow.getTime() + 1001).toISOString(),
        '30000',
        created.eventKey,
      ]),
    ).resolves.toMatchObject({ ids: [created.id] });
    expect(
      await prisma.notificationDelivery.count({ where: { notificationId: refs.notificationId } }),
    ).toBe(0);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({
      status: 'succeeded',
      sentAt: null,
    });
  });

  it('独立 worker module 可由 child application context 启动且不依赖 AppModule/ScheduleModule', async () => {
    await expect(runChild(['boot'])).resolves.toMatchObject({ booted: true });
  });
});

function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawnWorkerChild(args);
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

function startChild(args: string[]): RunningChild {
  const child = spawnWorkerChild(args);
  let stdout = '';
  let stderr = '';
  let resultSettled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const completeLines = stdout.split('\n').slice(0, -1);
      const line = completeLines.find((candidate) => candidate.trim().startsWith('{'));
      if (!line || resultSettled) return;
      resultSettled = true;
      resolve(JSON.parse(line) as ChildResult);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (resultSettled) return;
      resultSettled = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (resultSettled) return;
      resultSettled = true;
      reject(
        new Error(
          `outbox child exited before barrier code=${code ?? 'null'} signal=${signal ?? 'null'} ` +
            `stdout=${stdout.trim()} stderr=${stderr.trim()}`,
        ),
      );
    });
  });
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    result,
    exited,
    sendSignal: (signal) => {
      child.kill(signal);
    },
    kill: async () => {
      child.kill('SIGKILL');
      return (await exited).signal;
    },
  };
}

function spawnWorkerChild(args: string[]) {
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
  // tsx/esbuild 不生成 Nest 依赖注入所需的 decorator metadata；真 OS child 必须复用
  // TypeScript compiler + 本仓 tsconfig 的 emitDecoratorMetadata，才能等价启动生产 module。
  return spawn(
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
}

async function waitUntilExpired(expiresAt: Date): Promise<void> {
  const remainingMs = expiresAt.getTime() - Date.now() + 25;
  if (remainingMs > 0) await pause(remainingMs);
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for outbox condition');
    await pause(20);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

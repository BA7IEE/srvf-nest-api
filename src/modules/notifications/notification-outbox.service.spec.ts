import { Prisma, type NotificationOutboxIntent } from '@prisma/client';

import {
  normalizeNotificationOutboxInput,
  NotificationOutboxInvariantError,
  redactNotificationOutboxText,
  type NotificationOutboxEnqueueInput,
  type SystemBroadcastOutboxPayload,
  type TargetedNotificationOutboxPayload,
} from './notification-outbox.types';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxGenerationConflictError,
  NotificationOutboxService,
} from './notification-outbox.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');
const MEMBER_1 = 'cm00000000000000000000001';
const MEMBER_2 = 'cm00000000000000000000002';
const NOTIFICATION_1 = 'cm00000000000000000000003';
const GENERATION_1 = '00000000-0000-4000-8000-000000000001';

interface UpdateManyCall {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function input(
  payload: Record<string, string | number> = {
    notificationId: NOTIFICATION_1,
    memberId: MEMBER_1,
    publishGeneration: 1,
  },
): NotificationOutboxEnqueueInput {
  return {
    eventKey: `admin-sms:${NOTIFICATION_1}:${GENERATION_1}:${MEMBER_1}`,
    eventType: 'notification.admin-sms',
    payloadVersion: 2,
    payload,
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
  };
}

function wechatInput(
  rootId: string,
  publishGeneration: number = 1,
): NotificationOutboxEnqueueInput {
  return {
    eventKey: `wechat-delivery:${NOTIFICATION_1}:${rootId}:${MEMBER_1}`,
    eventType: 'notification.wechat-delivery',
    payloadVersion: 2,
    payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration },
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
  };
}

function row(overrides: Partial<NotificationOutboxIntent> = {}): NotificationOutboxIntent {
  return {
    id: 'intent-1',
    eventKey: `admin-sms:${NOTIFICATION_1}:${GENERATION_1}:${MEMBER_1}`,
    eventType: 'notification.admin-sms',
    payloadVersion: 2,
    payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
    status: 'pending',
    attempts: 0,
    availableAt: NOW,
    leaseOwner: null,
    lockedAt: null,
    leaseExpiresAt: null,
    preparedAt: null,
    preparedTemplateId: null,
    sentAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    deadAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('NotificationOutboxService', () => {
  function build() {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue(row());
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue({ preparedAt: null });
    const findMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest
      .fn<Promise<Array<Record<string, unknown>>>, [Prisma.Sql]>()
      .mockResolvedValue([]);
    const tx = {
      notificationOutboxIntent: { createMany, findUnique, updateMany, findFirst, findMany },
      $queryRaw: queryRaw,
    };
    const prisma = {
      notificationOutboxIntent: { createMany, findUnique, updateMany, findFirst },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    return {
      service: new NotificationOutboxService(prisma as never),
      prisma,
      tx,
      createMany,
      findUnique,
      updateMany,
      findFirst,
      findMany,
      queryRaw,
    };
  }

  it('同 eventKey 同内容幂等；不同内容 fail-closed', async () => {
    const f = build();
    f.createMany.mockResolvedValue({ count: 0 });
    await expect(f.service.enqueue(input())).resolves.toMatchObject({ id: 'intent-1' });

    await expect(
      f.service.enqueue(input({ notificationId: NOTIFICATION_1, memberId: MEMBER_2 })),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
  });

  it('微信广播不同 generation 撞 active partial unique 时显式要求 root defer', async () => {
    const f = build();
    const firstGeneration = wechatInput('cm00000000000000000000007');
    const active = row({
      id: 'cm00000000000000000000009',
      eventKey: firstGeneration.eventKey,
      eventType: firstGeneration.eventType,
      payloadVersion: firstGeneration.payloadVersion,
      payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
      aggregateType: firstGeneration.aggregateType,
      aggregateId: firstGeneration.aggregateId,
      destinationType: firstGeneration.destinationType,
      destinationRef: firstGeneration.destinationRef,
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    });
    f.createMany.mockResolvedValue({ count: 0 });
    f.findUnique.mockResolvedValue(null);
    f.findFirst.mockResolvedValue(active);

    await expect(
      f.service.enqueueWechatDeliveryAttempt(wechatInput('cm00000000000000000000008', 2)),
    ).rejects.toEqual(new NotificationOutboxGenerationConflictError(active));
    expect(f.createMany).toHaveBeenCalledTimes(1);
    const [findFirstInput] = f.findFirst.mock.calls.at(-1) as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(findFirstInput.where).toMatchObject({
      aggregateId: NOTIFICATION_1,
      destinationRef: MEMBER_1,
      status: { in: ['pending', 'processing'] },
    });
  });

  it('cross-generation root 只以稳定 fence 回 pending、恢复 attempt 且排到 active lease 之后', async () => {
    const f = build();
    const root = row({
      id: 'cm00000000000000000000010',
      eventType: 'notification.wechat-broadcast',
      status: 'processing',
      attempts: 1,
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
      preparedAt: null,
    }) as ClaimedNotificationOutboxIntent;
    const active = row({
      id: 'cm00000000000000000000011',
      eventType: 'notification.wechat-delivery',
      status: 'processing',
      attempts: 2,
      leaseOwner: 'child-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 5_000),
    });

    await expect(
      f.service.deferWechatBroadcast(
        root,
        new NotificationOutboxGenerationConflictError(active),
        NOW,
      ),
    ).resolves.toBeUndefined();
    const [call] = f.updateMany.mock.calls.at(-1) as unknown as [UpdateManyCall];
    expect(call.where).toMatchObject({
      id: root.id,
      status: 'processing',
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      preparedAt: null,
      attempts: { gt: 0 },
    });
    expect(call.data).toMatchObject({
      status: 'pending',
      attempts: { decrement: 1 },
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
    });
    expect((call.data.availableAt as Date).getTime()).toBe(NOW.getTime() + 6_000);
  });

  it('provider permission 固定先锁 parent 再锁 intent，并返回同一 generation 快照', async () => {
    const f = build();
    const claimed = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const notification = {
      id: NOTIFICATION_1,
      deletedAt: null,
      statusCode: 'published',
      sourceType: 'admin',
      audienceType: 'broadcast',
      publishGeneration: 3,
      channels: ['in-app', 'wechat'],
    };
    f.queryRaw.mockResolvedValueOnce([notification]).mockResolvedValueOnce([{ id: claimed.id }]);
    f.findFirst.mockResolvedValueOnce({ id: claimed.id });

    await expect(
      f.service.authorizeAdminNotificationEffect(claimed, NOTIFICATION_1, 3, 'wechat', NOW),
    ).resolves.toBe(notification);
    const sql = f.queryRaw.mock.calls.map(([query]) => query.strings.join(' '));
    expect(sql[0]).toContain('FROM "notifications"');
    expect(sql[1]).toContain('FROM "notification_outbox_intents"');
  });

  it.each([
    ['phone', '说明 13900000001 请勿外传'],
    ['JWT', '说明 eyJabc123.def456.ghi789 请勿外传'],
    ['Bearer', '请用 Bearer abcdefghijklmnop'],
    ['sk', '请用 sk-abcdefghijklmnop'],
    ['AKID', '请用 AKIDabcdefghijklmnop'],
    ['openid', '内嵌 oOpaqueOpenidValue123456789'],
    ['COS V5 URL', '下载 https://cos.example/x?q-signature=abc&q-ak=AKID123'],
    ['AWS URL', '下载 https://s3.example/x?X-Amz-Signature=abc&x=1'],
  ])('targeted/system exact-shape 会 canonical redact %s 且二跑幂等', (_name, sensitive) => {
    const targeted = normalizeNotificationOutboxInput({
      eventKey: `targeted:${MEMBER_1}`,
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: MEMBER_1,
        notificationTypeCode: 'activity-reminder',
        title: `活动 ${sensitive}`,
        body: `正文 ${sensitive}`,
        channels: ['wechat', 'in-app', 'wechat'],
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'member',
      destinationRef: MEMBER_1,
    });
    const system = normalizeNotificationOutboxInput({
      eventKey: `system:${NOTIFICATION_1}`,
      eventType: 'notification.system-broadcast',
      payloadVersion: 1,
      payload: {
        notificationTypeCode: 'expiry-reminder',
        title: `活动 ${sensitive}`,
        body: `正文 ${sensitive}`,
        visibilityCode: 'management',
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'audience',
      destinationRef: NOTIFICATION_1,
    });
    const targetedPayload = targeted.payload as unknown as TargetedNotificationOutboxPayload;
    expect(targetedPayload.title).toContain('[REDACTED]');
    expect(targetedPayload.body).toContain('[REDACTED]');
    expect(targetedPayload.channels).toEqual(['in-app', 'wechat']);
    const systemPayload = system.payload as unknown as SystemBroadcastOutboxPayload;
    expect(systemPayload.title).toContain('[REDACTED]');
    expect(systemPayload.body).toContain('[REDACTED]');
    expect(normalizeNotificationOutboxInput(targeted)).toEqual(targeted);
    expect(normalizeNotificationOutboxInput(system)).toEqual(system);
  });

  it('safe URL/design、普通 token/secret/openid 词、日期/CUID/活动名逐字不变；空渠道补 in-app', () => {
    const safe =
      '山野训练 2026-07-18 ' +
      `${MEMBER_1} token secret openid https://example.test/page?design=blue&tokenize=yes`;
    expect(redactNotificationOutboxText(safe)).toBe(safe);
    const normalized = normalizeNotificationOutboxInput({
      eventKey: `targeted-safe:${MEMBER_1}`,
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: MEMBER_1,
        notificationTypeCode: 'activity-reminder',
        title: safe,
        body: safe,
        channels: [],
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'member',
      destinationRef: MEMBER_1,
    });
    expect(normalized.payload).toMatchObject({ title: safe, body: safe, channels: ['in-app'] });
  });

  it('strict metadata/extra payload/unknown type 仍 fail-closed', async () => {
    const f = build();
    const forbidden = [
      input({ phone: '13900000001' }),
      { ...input(), eventKey: 'phone:13900000001' },
      { ...input(), aggregateType: 'credential' },
      { ...input(), aggregateId: '13900000001' },
      { ...input(), destinationType: 'openid' },
      { ...input(), destinationRef: '13900000001' },
      { ...input(), eventType: 'notification.unknown' },
    ];
    for (const candidate of forbidden) {
      await expect(f.service.enqueue(candidate)).rejects.toBeInstanceOf(
        NotificationOutboxInvariantError,
      );
    }
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it('expired 第 8 次 processing 先原子 dead，claim 查询不得返回第 9 次 Effect', async () => {
    const f = build();
    await expect(f.service.claim('worker-2', { now: NOW })).resolves.toEqual([]);
    const [reaper] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>)[0];
    expect(reaper.where).toMatchObject({
      status: 'processing',
      attempts: { gte: 8 },
      leaseExpiresAt: { not: null, lte: NOW },
    });
    expect(reaper.data).toMatchObject({ status: 'dead', deadAt: NOW, completedAt: NOW });
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('prepared callback 与 preparedAt fencing 更新在同一短事务且只执行一次', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    const prepare = jest.fn().mockResolvedValue(undefined);
    await expect(f.service.markPrepared(intent, prepare, NOW)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith(f.tx);
    expect(f.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { preparedAt: NOW } }),
    );

    f.findFirst.mockResolvedValue({ preparedAt: NOW });
    prepare.mockClear();
    await expect(f.service.markPrepared(intent, prepare, NOW)).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('admin SMS transaction 只创建 pending/attempts=0 且 lease 全空的 durable command', async () => {
    const f = build();
    await expect(f.service.reserveAdminSmsAttempt(input(), f.tx as never)).resolves.toMatchObject({
      state: 'reserved',
      intent: {
        status: 'pending',
        attempts: 0,
        leaseOwner: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    expect(f.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: 'pending',
            attempts: 0,
            leaseOwner: null,
            lockedAt: null,
            leaseExpiresAt: null,
          }),
        ],
      }),
    );
  });

  it('renewLease 保留终身 lockedAt fence，只在完整 CAS 下延长 leaseExpiresAt', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const renewAt = new Date(NOW.getTime() + 10_000);
    const nextExpiry = new Date(renewAt.getTime() + 30_000);

    await expect(f.service.renewLease(intent, renewAt, 30_000)).resolves.toMatchObject({
      lockedAt: NOW,
      leaseExpiresAt: nextExpiry,
    });
    const [renew] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(renew.where).toMatchObject({
      id: intent.id,
      status: 'processing',
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: { not: null, gt: renewAt },
    });
    expect(renew.data).toEqual({ leaseExpiresAt: nextExpiry });
    expect(renew.data).not.toHaveProperty('lockedAt');
  });

  it('第 8 次失败直接 dead；此前失败清 lease 并指数退避回 pending', async () => {
    const f = build();
    const first = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    await expect(f.service.nack(first, new Error('transient'), NOW)).resolves.toBe('pending');
    const [pending] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(pending.data).toMatchObject({
      status: 'pending',
      availableAt: new Date(NOW.getTime() + 1000),
      leaseOwner: null,
    });

    const eighth = { ...first, attempts: 8 };
    await expect(f.service.nack(eighth, new Error('terminal'), NOW)).resolves.toBe('dead');
    const [dead] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(dead.data).toMatchObject({ status: 'dead', deadAt: NOW, completedAt: NOW });
  });
});

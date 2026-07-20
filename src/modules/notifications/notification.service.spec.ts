import type { Notification } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { SmsChannelUnavailableError } from '../sms/sms.types';
import { NOTIFICATION_CHANNEL_SMS, NOTIFICATION_STATUS_PUBLISHED } from './notification.constants';
import { NotificationService } from './notification.service';

const NOTIFICATION_ID = 'cm00000000000000000000001';
const MEMBER_ID = 'cm00000000000000000000003';
const NOW = new Date('2026-07-20T00:00:00.000Z');
const USER = { id: 'cm00000000000000000000002', role: 'ADMIN' } as never;
const META = {} as never;
type AuditEntry = { extra?: Record<string, unknown> };
const NOTIFICATION = {
  id: NOTIFICATION_ID,
  statusCode: NOTIFICATION_STATUS_PUBLISHED,
  channels: ['in-app', NOTIFICATION_CHANNEL_SMS],
  sourceType: 'admin',
  audienceType: 'broadcast',
  publishGeneration: 1,
  deletedAt: null,
} as Notification;

function build(readinessError: Error) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID }]),
    notification: { findFirst: jest.fn().mockResolvedValue(NOTIFICATION) },
  };
  const prisma = {
    notification: { findFirst: jest.fn().mockResolvedValue(NOTIFICATION) },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const rbac = { can: jest.fn().mockResolvedValue(true) };
  const auditLogs = { log: jest.fn() };
  const smsDispatch = {
    assertChannelReady: jest.fn().mockRejectedValue(readinessError),
    countRecipients: jest.fn(),
    resolveRecipientMemberIds: jest.fn(),
  };
  const outbox = { reserveAdminSmsAttempt: jest.fn() };
  const outboxWorker = { executeReserved: jest.fn() };
  const service = new NotificationService(
    prisma as never,
    rbac as never,
    auditLogs as never,
    smsDispatch as never,
    outbox as never,
    outboxWorker as never,
  );
  return { service, prisma, auditLogs, smsDispatch, outbox };
}

describe('NotificationService.sendSms readiness mapping', () => {
  it('readiness 通道不可用精确映射 24030，reservation 与 audit 均为零', async () => {
    const f = build(new SmsChannelUnavailableError('notification template missing'));

    await expect(
      f.service.sendSms(NOTIFICATION_ID, { confirmed: true }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED));

    expect(f.smsDispatch.assertChannelReady).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.outbox.reserveAdminSmsAttempt).not.toHaveBeenCalled();
    expect(f.auditLogs.log).not.toHaveBeenCalled();
  });

  it('readiness 非通道异常原样透传，且不得进入 reservation / audit', async () => {
    const unexpected = new Error('settings database unavailable');
    const f = build(unexpected);

    await expect(f.service.sendSms(NOTIFICATION_ID, { confirmed: true }, USER, META)).rejects.toBe(
      unexpected,
    );

    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.outbox.reserveAdminSmsAttempt).not.toHaveBeenCalled();
    expect(f.auditLogs.log).not.toHaveBeenCalled();
  });

  it('其它 worker 抢走 pending intent 时首轮显式计 failed，不得误算 skipped', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID }]),
      notification: { findFirst: jest.fn().mockResolvedValue(NOTIFICATION) },
    };
    const prisma = {
      notification: { findFirst: jest.fn().mockResolvedValue(NOTIFICATION) },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const smsDispatch = {
      assertChannelReady: jest.fn().mockResolvedValue(undefined),
      countRecipients: jest.fn(),
      resolveRecipientMemberIds: jest.fn().mockResolvedValue([MEMBER_ID]),
    };
    const eventKey = `admin-sms:${NOTIFICATION_ID}:generation:${MEMBER_ID}`;
    const outbox = {
      reserveAdminSmsAttempt: jest.fn().mockResolvedValue({
        state: 'reserved',
        intent: { eventKey },
      }),
    };
    const outboxWorker = {
      drainEventKeyOrThrow: jest.fn().mockResolvedValue({ state: 'not-claimed' }),
    };
    const service = new NotificationService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      smsDispatch as never,
      outbox as never,
      outboxWorker as never,
    );

    await expect(
      service.sendSms(NOTIFICATION_ID, { confirmed: true }, USER, META),
    ).resolves.toEqual({
      confirmed: true,
      recipientCount: 1,
      sent: 0,
      failed: 1,
      skipped: 0,
    });
    expect(outboxWorker.drainEventKeyOrThrow).toHaveBeenCalledWith(eventKey);
    const [reserved] = outbox.reserveAdminSmsAttempt.mock.calls[0] as [
      { payloadVersion: number; payload: Record<string, unknown> },
    ];
    expect(reserved).toMatchObject({
      payloadVersion: 2,
      payload: { notificationId: NOTIFICATION_ID, memberId: MEMBER_ID, publishGeneration: 1 },
    });
    const auditCalls = auditLogs.log.mock.calls as Array<[AuditEntry]>;
    const firstAttempt = auditCalls.find(
      ([entry]) => entry.extra?.deliveryState === 'first-attempt',
    )?.[0];
    expect(firstAttempt?.extra).toMatchObject({
      deliveryState: 'first-attempt',
      sent: 0,
      failed: 1,
      skipped: 0,
    });
  });
});

describe('NotificationService publish generation 与 admin ownership gate', () => {
  function buildMutation(existing: Notification, updated: Notification = existing) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: existing.id }]),
      notification: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue(updated),
      },
      dictItem: { findFirst: jest.fn().mockResolvedValue({ id: 'dict-item' }) },
      organization: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      {} as never,
      outbox as never,
      {} as never,
    );
    return { service, tx, outbox };
  }

  it('draft publish 在父行锁内 generation +1，并写 generation-fenced v2 root', async () => {
    const existing = {
      ...NOTIFICATION,
      statusCode: 'draft',
      channels: ['in-app', 'wechat'],
      publishGeneration: 4,
    };
    const updated = {
      ...existing,
      statusCode: 'published',
      publishedAt: NOW,
      publishGeneration: 5,
    };
    const f = buildMutation(existing, updated);

    await expect(f.service.publish(existing.id, USER, META)).resolves.toBeDefined();
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [publishUpdate] = f.tx.notification.update.mock.calls[0] as unknown as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(publishUpdate).toMatchObject({
      where: { id: existing.id },
      data: {
        statusCode: 'published',
        publishGeneration: { increment: 1 },
      },
    });
    expect(f.outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `wechat-broadcast:${existing.id}:5`,
        payloadVersion: 2,
        payload: { notificationId: existing.id, publishGeneration: 5 },
      }),
      f.tx,
    );
  });

  it.each([
    ['title', { title: 'new title' }],
    ['body', { body: 'new body' }],
    ['notificationTypeCode', { notificationTypeCode: 'emergency' }],
    ['visibilityCode', { visibilityCode: 'management', visibleOrganizationIds: [] }],
    ['visibleOrganizationIds', { visibleOrganizationIds: ['org-2'] }],
    ['channels', { channels: ['wechat', 'in-app'] }],
  ])(
    'published 的真实 Effect 字段变化 %s 自动回 draft 且不 bump generation',
    async (_name, dto) => {
      const existing = {
        ...NOTIFICATION,
        title: 'old title',
        body: 'old body',
        notificationTypeCode: 'general',
        visibilityCode: 'department',
        visibleOrganizationIds: ['org-1'],
        publishGeneration: 8,
      };
      const updated = { ...existing, ...dto, statusCode: 'draft' };
      const f = buildMutation(existing, updated);
      f.tx.organization.findMany.mockResolvedValue(
        'visibleOrganizationIds' in dto ? [{ id: 'org-2' }] : [{ id: 'org-1' }],
      );

      await f.service.update(existing.id, dto, USER, META);
      const [{ data }] = f.tx.notification.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.statusCode).toBe('draft');
      expect(data.publishGeneration).toBeUndefined();
    },
  );

  it('pinned-only 与 channels/org 集合等价更新保持 published/generation 不动', async () => {
    const existing = {
      ...NOTIFICATION,
      title: 'same',
      body: 'same',
      notificationTypeCode: 'general',
      visibilityCode: 'department',
      visibleOrganizationIds: ['org-1', 'org-2'],
      channels: ['in-app', 'wechat', 'sms'],
      publishGeneration: 3,
      pinned: false,
    };
    const f = buildMutation(existing, { ...existing, pinned: true });
    f.tx.organization.findMany.mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }]);

    await f.service.update(
      existing.id,
      {
        pinned: true,
        channels: ['sms', 'wechat', 'in-app', 'sms'],
        visibleOrganizationIds: ['org-2', 'org-1', 'org-2'],
      },
      USER,
      META,
    );
    const [{ data }] = f.tx.notification.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(data.statusCode).toBeUndefined();
    expect(data.publishGeneration).toBeUndefined();
  });

  it('system-directed 通知 list/detail 仍可读，但任一 mutation 统一 31030', async () => {
    const system = {
      ...NOTIFICATION,
      sourceType: 'system',
      audienceType: 'directed',
    };
    const f = buildMutation(system);

    await expect(f.service.softDelete(system.id, USER, META)).rejects.toEqual(
      new BizException(BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION),
    );
    expect(f.tx.notification.update).not.toHaveBeenCalled();
  });
});

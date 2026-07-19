import type { Notification } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { SmsChannelUnavailableError } from '../sms/sms.types';
import { NOTIFICATION_CHANNEL_SMS, NOTIFICATION_STATUS_PUBLISHED } from './notification.constants';
import { NotificationService } from './notification.service';

const NOTIFICATION_ID = 'cm00000000000000000000001';
const MEMBER_ID = 'cm00000000000000000000003';
const USER = { id: 'cm00000000000000000000002', role: 'ADMIN' } as never;
const META = {} as never;
type AuditEntry = { extra?: Record<string, unknown> };
const NOTIFICATION = {
  id: NOTIFICATION_ID,
  statusCode: NOTIFICATION_STATUS_PUBLISHED,
  channels: ['in-app', NOTIFICATION_CHANNEL_SMS],
  deletedAt: null,
} as Notification;

function build(readinessError: Error) {
  const prisma = {
    notification: { findFirst: jest.fn().mockResolvedValue(NOTIFICATION) },
    $transaction: jest.fn(),
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
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.outbox.reserveAdminSmsAttempt).not.toHaveBeenCalled();
    expect(f.auditLogs.log).not.toHaveBeenCalled();
  });

  it('readiness 非通道异常原样透传，且不得进入 reservation / audit', async () => {
    const unexpected = new Error('settings database unavailable');
    const f = build(unexpected);

    await expect(f.service.sendSms(NOTIFICATION_ID, { confirmed: true }, USER, META)).rejects.toBe(
      unexpected,
    );

    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.outbox.reserveAdminSmsAttempt).not.toHaveBeenCalled();
    expect(f.auditLogs.log).not.toHaveBeenCalled();
  });

  it('其它 worker 抢走 pending intent 时首轮显式计 failed，不得误算 skipped', async () => {
    const tx = {};
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

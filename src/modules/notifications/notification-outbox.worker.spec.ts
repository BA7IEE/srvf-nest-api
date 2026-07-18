import type { ClaimedNotificationOutboxIntent } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { UnsupportedNotificationOutboxEventError } from './notification-outbox.handlers';

function claimed(): ClaimedNotificationOutboxIntent {
  const now = new Date('2026-07-18T00:00:00.000Z');
  return {
    id: 'intent-1',
    eventKey: 'event-1',
    eventType: 'notification.targeted',
    payloadVersion: 1,
    payload: {},
    aggregateType: 'notification',
    aggregateId: 'aggregate-1',
    destinationType: 'member',
    destinationRef: 'member-1',
    status: 'processing',
    attempts: 1,
    availableAt: now,
    leaseOwner: 'worker',
    lockedAt: now,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    preparedAt: null,
    sentAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    deadAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('NotificationOutboxWorker', () => {
  function build() {
    const intent = claimed();
    const outbox = {
      claim: jest.fn().mockResolvedValue([intent]),
      renewLease: jest.fn().mockResolvedValue(intent),
      ack: jest.fn().mockResolvedValue(undefined),
      nack: jest.fn().mockResolvedValue('pending'),
      deadLetter: jest.fn().mockResolvedValue(undefined),
    };
    const handlers = {
      execute: jest.fn().mockResolvedValue({ effectPerformed: true, value: { sent: 1 } }),
    };
    return {
      worker: new NotificationOutboxWorker(outbox as never, handlers as never),
      outbox,
      handlers,
      intent,
    };
  }

  it('effect 完成后才 ack，并把同 handler 的首轮结果返给 admin SMS', async () => {
    const f = build();
    await expect(f.worker.drainEventKeyOrThrow('event-1')).resolves.toEqual({ sent: 1 });
    expect(f.handlers.execute).toHaveBeenCalledWith(f.intent);
    expect(f.outbox.ack).toHaveBeenCalledWith(f.intent, true);
  });

  it('transient 失败先 nack 留待重试，且原错误继续抛给 HTTP 映射', async () => {
    const f = build();
    const error = new Error('provider unavailable');
    f.handlers.execute.mockRejectedValue(error);
    await expect(f.worker.drainEventKeyOrThrow('event-1')).rejects.toBe(error);
    expect(f.outbox.nack).toHaveBeenCalledWith(f.intent, error);
    expect(f.outbox.ack).not.toHaveBeenCalled();
  });

  it('未知 type/version 立即 dead 且不 ack/nack', async () => {
    const f = build();
    const error = new UnsupportedNotificationOutboxEventError('unknown', 99);
    f.handlers.execute.mockRejectedValue(error);
    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 1,
    });
    expect(f.outbox.deadLetter).toHaveBeenCalledWith(f.intent, error);
    expect(f.outbox.nack).not.toHaveBeenCalled();
  });

  it('claim DB 故障时 handler/provider 零调用', async () => {
    const f = build();
    f.outbox.claim.mockRejectedValue(new Error('db unavailable'));
    await expect(f.worker.drainOnce()).rejects.toThrow('db unavailable');
    expect(f.handlers.execute).not.toHaveBeenCalled();
  });

  it('just-in-time re-fence 失败时 handler/provider 零调用且不再 nack 旧 fence', async () => {
    const f = build();
    f.outbox.renewLease.mockRejectedValue(new Error('lease reclaimed'));
    await expect(f.worker.executeReserved(f.intent)).rejects.toThrow('lease reclaimed');
    expect(f.handlers.execute).not.toHaveBeenCalled();
    expect(f.outbox.ack).not.toHaveBeenCalled();
    expect(f.outbox.nack).not.toHaveBeenCalled();
  });
});

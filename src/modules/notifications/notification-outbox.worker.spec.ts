import type { ClaimedNotificationOutboxIntent } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import {
  type NotificationOutboxEffectGuard,
  UnsupportedNotificationOutboxEventError,
} from './notification-outbox.handlers';
import { NotificationOutboxLeaseLostError } from './notification-outbox.types';

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
    preparedTemplateId: null,
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
      claim: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValue([]),
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
    await expect(f.worker.drainEventKeyOrThrow('event-1')).resolves.toEqual({
      state: 'executed',
      value: { sent: 1 },
    });
    const [[executedIntent, guard]] = f.handlers.execute.mock.calls as Array<
      [ClaimedNotificationOutboxIntent, NotificationOutboxEffectGuard]
    >;
    expect(executedIntent).toBe(f.intent);
    expect(typeof guard.beforeEffect).toBe('function');
    expect(f.outbox.ack).toHaveBeenCalledWith(f.intent, true);
  });

  it('指定 eventKey 已被另一 worker 抢领时显式返回 not-claimed', async () => {
    const f = build();
    f.outbox.claim.mockReset().mockResolvedValue([]);

    await expect(f.worker.drainEventKeyOrThrow('event-1')).resolves.toEqual({
      state: 'not-claimed',
    });
    expect(f.handlers.execute).not.toHaveBeenCalled();
    expect(f.outbox.ack).not.toHaveBeenCalled();
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
    f.outbox.claim.mockReset().mockRejectedValue(new Error('db unavailable'));
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
    expect(f.outbox.deadLetter).not.toHaveBeenCalled();
  });

  it('drainOnce 每次只 claim 一条，前一条 ack 后才领取下一条', async () => {
    const f = build();
    const second = { ...f.intent, id: 'intent-2', eventKey: 'event-2' };
    let claimCount = 0;
    f.outbox.claim.mockReset().mockImplementation(() => {
      claimCount += 1;
      if (claimCount === 1) return Promise.resolve([f.intent]);
      if (claimCount === 2) {
        expect(f.outbox.ack).toHaveBeenCalledWith(f.intent, true);
        return Promise.resolve([second]);
      }
      return Promise.resolve([]);
    });

    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      claimed: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(f.outbox.claim).toHaveBeenCalledTimes(3);
    for (const [, options] of f.outbox.claim.mock.calls as Array<[string, { limit: number }]>) {
      expect(options.limit).toBe(1);
    }
  });

  it('slow Effect 期间 heartbeat 单路非重叠，handler 完成后才 ack', async () => {
    const f = build();
    const now = new Date();
    f.intent.lockedAt = now;
    f.intent.leaseExpiresAt = new Date(now.getTime() + 60);
    let activeRenewals = 0;
    let maxActiveRenewals = 0;
    f.outbox.renewLease.mockImplementation(async (intent: ClaimedNotificationOutboxIntent) => {
      activeRenewals += 1;
      maxActiveRenewals = Math.max(maxActiveRenewals, activeRenewals);
      await wait(5);
      activeRenewals -= 1;
      return intent;
    });
    f.handlers.execute.mockImplementation(
      async (_intent: ClaimedNotificationOutboxIntent, guard: NotificationOutboxEffectGuard) => {
        await wait(50);
        await guard.beforeEffect();
        await wait(70);
        return { effectPerformed: true, value: { sent: 1 } };
      },
    );

    await expect(f.worker.executeReserved(f.intent)).resolves.toEqual({ sent: 1 });
    expect(f.outbox.renewLease.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(maxActiveRenewals).toBe(1);
    expect(f.outbox.ack).toHaveBeenCalledTimes(1);
  });

  it('heartbeat sticky failure 在 provider guard 可见，provider=0 且绝不 ack/nack/dead', async () => {
    const f = build();
    const now = new Date();
    f.intent.lockedAt = now;
    f.intent.leaseExpiresAt = new Date(now.getTime() + 30);
    const leaseLost = new NotificationOutboxLeaseLostError(f.intent.id);
    let observeHeartbeatFailure!: () => void;
    const heartbeatFailed = new Promise<void>((resolve) => {
      observeHeartbeatFailure = resolve;
    });
    f.outbox.renewLease.mockImplementation((intent: ClaimedNotificationOutboxIntent) => {
      if (f.outbox.renewLease.mock.calls.length === 1) return Promise.resolve(intent);
      observeHeartbeatFailure();
      return Promise.reject(leaseLost);
    });
    const provider = jest.fn();
    f.handlers.execute.mockImplementation(
      async (_intent: ClaimedNotificationOutboxIntent, guard: NotificationOutboxEffectGuard) => {
        await heartbeatFailed;
        await guard.beforeEffect();
        provider();
        return { effectPerformed: true, value: { sent: 1 } };
      },
    );

    await expect(f.worker.executeReserved(f.intent)).rejects.toBe(leaseLost);
    expect(provider).not.toHaveBeenCalled();
    expect(f.outbox.ack).not.toHaveBeenCalled();
    expect(f.outbox.nack).not.toHaveBeenCalled();
    expect(f.outbox.deadLetter).not.toHaveBeenCalled();
  });

  it('provider 紧邻 guard 的即时 renew 失败时 provider=0 且绝不写 terminal', async () => {
    const f = build();
    const leaseLost = new NotificationOutboxLeaseLostError(f.intent.id);
    f.outbox.renewLease.mockResolvedValueOnce(f.intent).mockRejectedValueOnce(leaseLost);
    const provider = jest.fn();
    f.handlers.execute.mockImplementation(
      async (_intent: ClaimedNotificationOutboxIntent, guard: NotificationOutboxEffectGuard) => {
        await guard.beforeEffect();
        provider();
        return { effectPerformed: true };
      },
    );

    await expect(f.worker.executeReserved(f.intent)).rejects.toBe(leaseLost);
    expect(provider).not.toHaveBeenCalled();
    expect(f.outbox.renewLease).toHaveBeenCalledTimes(2);
    expect(f.outbox.ack).not.toHaveBeenCalled();
    expect(f.outbox.nack).not.toHaveBeenCalled();
    expect(f.outbox.deadLetter).not.toHaveBeenCalled();
  });

  it('shutdown 后 drainOnce 不再 claim 新 intent', async () => {
    const f = build();
    await f.worker.onApplicationShutdown();
    await expect(f.worker.drainOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(f.outbox.claim).not.toHaveBeenCalled();
  });

  it('当前 intent terminal 后收到 shutdown 时不再领取下一条', async () => {
    const f = build();
    f.outbox.ack.mockImplementation(() => {
      void f.worker.onApplicationShutdown();
      return Promise.resolve(undefined);
    });

    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    expect(f.outbox.claim).toHaveBeenCalledTimes(1);
  });

  it('OnModuleDestroy 先 stop 新 claim，再等待在途 attempt/heartbeat terminal', async () => {
    const f = build();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.handlers.execute.mockImplementation(async () => {
      markStarted();
      await released;
      return { effectPerformed: true, value: { sent: 1 } };
    });

    const draining = f.worker.drainOnce();
    await started;
    let shutdownSettled = false;
    const shutdown = f.worker.onModuleDestroy().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(f.outbox.ack).not.toHaveBeenCalled();

    release();
    await draining;
    await shutdown;
    expect(f.outbox.ack).toHaveBeenCalledTimes(1);
    expect(f.outbox.claim).toHaveBeenCalledTimes(1);
  });

  it('shutdown 可唤醒空闲 poll delay，run 无需等待 500ms 才退出', async () => {
    const f = build();
    f.outbox.claim.mockReset().mockResolvedValue([]);
    const running = f.worker.run();
    while (f.outbox.claim.mock.calls.length === 0) await Promise.resolve();

    await f.worker.onModuleDestroy();
    await expect(running).resolves.toBeUndefined();
  });

  it('run 捕获 claim DB error 后受控退避并恢复处理后续 pending', async () => {
    jest.useFakeTimers();
    try {
      const f = build();
      const dbError = new Error('db secret must not terminate worker');
      f.outbox.claim.mockReset().mockRejectedValueOnce(dbError).mockResolvedValueOnce([f.intent]);
      f.outbox.ack.mockImplementation(() => {
        void f.worker.onModuleDestroy();
        return Promise.resolve(undefined);
      });

      const running = f.worker.run();
      await jest.advanceTimersByTimeAsync(0);
      expect(f.outbox.claim).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(499);
      expect(f.outbox.claim).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await running;

      expect(f.outbox.claim).toHaveBeenCalledTimes(2);
      expect(f.handlers.execute).toHaveBeenCalledTimes(1);
      expect(f.outbox.ack).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('run 捕获首轮 LeaseLost 后受控退避并恢复处理下一 intent', async () => {
    jest.useFakeTimers();
    try {
      const f = build();
      const next = { ...f.intent, id: 'intent-2', eventKey: 'event-2' };
      const leaseLost = new NotificationOutboxLeaseLostError(f.intent.id);
      f.outbox.claim.mockReset().mockResolvedValueOnce([f.intent]).mockResolvedValueOnce([next]);
      f.outbox.renewLease.mockRejectedValueOnce(leaseLost).mockResolvedValue(next);
      f.outbox.ack.mockImplementation(() => {
        void f.worker.onModuleDestroy();
        return Promise.resolve(undefined);
      });

      const running = f.worker.run();
      await jest.advanceTimersByTimeAsync(0);
      expect(f.outbox.claim).toHaveBeenCalledTimes(1);
      expect(f.outbox.ack).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(499);
      expect(f.outbox.claim).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await running;

      expect(f.outbox.claim).toHaveBeenCalledTimes(2);
      expect(f.handlers.execute).toHaveBeenCalledTimes(1);
      expect(f.outbox.ack).toHaveBeenCalledWith(next, true);
      expect(f.outbox.nack).not.toHaveBeenCalled();
      expect(f.outbox.deadLetter).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

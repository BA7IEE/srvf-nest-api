import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { OUTBOX_CLAIM_BATCH, OUTBOX_LEASE_MS } from './notification.constants';
import {
  NotificationOutboxHandlers,
  UnsupportedNotificationOutboxEventError,
} from './notification-outbox.handlers';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxService,
} from './notification-outbox.service';

export interface NotificationOutboxDrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  value?: unknown;
}

export type NotificationOutboxEventDrainResult =
  | { state: 'executed'; value: unknown }
  | { state: 'not-claimed' };

type NotificationOutboxAttemptResult =
  | { state: 'succeeded'; value: unknown }
  | { state: 'failed'; dead: boolean; error: unknown };

@Injectable()
export class NotificationOutboxWorker implements OnApplicationShutdown, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private readonly workerId = `notification-outbox:${process.pid}:${randomUUID()}`;
  private readonly activeDrains = new Set<Promise<unknown>>();
  private readonly activeAttempts = new Set<Promise<unknown>>();
  private stopping = false;
  private wakeIdle: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly outbox: NotificationOutboxService,
    private readonly handlers: NotificationOutboxHandlers,
  ) {}

  onApplicationShutdown(): Promise<void> {
    return this.stopAndDrain();
  }

  onModuleDestroy(): Promise<void> {
    return this.stopAndDrain();
  }

  async run(): Promise<void> {
    this.logger.log(`notification outbox worker started worker=${this.workerId}`);
    while (!this.stopping) {
      try {
        const result = await this.drainOnce();
        if (result.claimed === 0) await this.waitForNextPoll(500);
      } catch (error) {
        this.logger.warn(
          `notification outbox drain failed worker=${this.workerId} errorClass=${errorClass(error)}`,
        );
        await this.waitForNextPoll(500);
      }
    }
  }

  async drainEventKey(eventKey: string): Promise<NotificationOutboxDrainResult> {
    return this.drainOnce(eventKey);
  }

  // claim 后先在 Effect 前续租，再启动单路、非重叠 heartbeat。handler 结束后先停止并等待
  // 在途 heartbeat；任一续租失败都不 ack/nack/dead，旧 owner 只能等待 expiry 后被 reclaim。
  async executeReserved(intent: ClaimedNotificationOutboxIntent): Promise<unknown> {
    const result = await this.executeAttempt(intent);
    if (result.state === 'failed') throw result.error;
    return result.value;
  }

  private executeAttempt(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<NotificationOutboxAttemptResult> {
    return this.track(this.activeAttempts, this.executeAttemptInternal(intent));
  }

  private async executeAttemptInternal(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<NotificationOutboxAttemptResult> {
    const leaseMs = leaseDurationMs(intent);
    const refreshed = await this.outbox.renewLease(intent, new Date(), leaseMs);
    const heartbeat = startLeaseHeartbeat(Math.max(1, Math.floor(leaseMs / 3)), () =>
      this.outbox.renewLease(refreshed, new Date(), leaseMs).then(() => undefined),
    );
    let handlerResult: { effectPerformed: boolean; value?: unknown } | undefined;
    let handlerError: unknown;
    let handlerFailed = false;
    try {
      handlerResult = await this.handlers.execute(refreshed, {
        beforeEffect: heartbeat.beforeEffect,
      });
    } catch (error) {
      handlerFailed = true;
      handlerError = error;
    } finally {
      await heartbeat.stop();
    }

    const heartbeatFailure = heartbeat.failure();
    if (heartbeatFailure) throw heartbeatFailure.error;

    if (handlerFailed) {
      if (handlerError instanceof UnsupportedNotificationOutboxEventError) {
        await this.outbox.deadLetter(refreshed, handlerError);
        return { state: 'failed', dead: true, error: handlerError };
      }
      const state = await this.outbox.nack(refreshed, handlerError);
      return { state: 'failed', dead: state === 'dead', error: handlerError };
    }

    await this.outbox.ack(refreshed, handlerResult!.effectPerformed);
    return { state: 'succeeded', value: handlerResult!.value };
  }

  // admin SMS commit 后逐 eventKey JIT claim。若另一 worker 已抢领，显式返回 not-claimed；
  // 该结果只描述 HTTP 首轮归属，不覆盖 intent 的 durable final state。
  drainEventKeyOrThrow(eventKey: string): Promise<NotificationOutboxEventDrainResult> {
    return this.track(this.activeDrains, this.drainEventKeyOrThrowInternal(eventKey));
  }

  private async drainEventKeyOrThrowInternal(
    eventKey: string,
  ): Promise<NotificationOutboxEventDrainResult> {
    if (this.stopping) return { state: 'not-claimed' };
    const [intent] = await this.outbox.claim(this.workerId, { limit: 1, eventKey });
    if (!intent) return { state: 'not-claimed' };
    const result = await this.executeAttempt(intent);
    if (result.state === 'failed') throw result.error;
    const value = result.value;
    return { state: 'executed', value };
  }

  drainOnce(eventKey?: string): Promise<NotificationOutboxDrainResult> {
    return this.track(this.activeDrains, this.drainOnceInternal(eventKey));
  }

  private async drainOnceInternal(eventKey?: string): Promise<NotificationOutboxDrainResult> {
    const summary: NotificationOutboxDrainResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };
    const limit = eventKey ? 1 : OUTBOX_CLAIM_BATCH;

    while (!this.stopping && summary.claimed < limit) {
      const [intent] = await this.outbox.claim(this.workerId, { limit: 1, eventKey });
      if (!intent) break;
      summary.claimed += 1;

      const result = await this.executeAttempt(intent);
      if (result.state === 'succeeded') {
        summary.succeeded += 1;
        if (eventKey) summary.value = result.value;
        continue;
      }

      summary.failed += 1;
      if (result.dead) summary.dead += 1;
      this.logger.warn(
        `notification outbox intent failed id=${intent.id} eventType=${intent.eventType} ` +
          `attempt=${intent.attempts} errorClass=${errorClass(result.error)}`,
      );
    }
    return summary;
  }

  private stopAndDrain(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.wakeIdle?.();
    this.shutdownPromise = (async () => {
      while (this.activeDrains.size > 0 || this.activeAttempts.size > 0) {
        await Promise.allSettled([...this.activeDrains, ...this.activeAttempts]);
      }
    })();
    return this.shutdownPromise;
  }

  private async waitForNextPoll(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeIdle === finish) this.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeIdle = finish;
      if (this.stopping) finish();
    });
  }

  private track<T>(active: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
    active.add(promise);
    void promise.then(
      () => {
        active.delete(promise);
      },
      () => {
        active.delete(promise);
      },
    );
    return promise;
  }
}

function leaseDurationMs(intent: ClaimedNotificationOutboxIntent): number {
  const duration = intent.leaseExpiresAt.getTime() - intent.lockedAt.getTime();
  return Number.isFinite(duration) && duration > 0 ? duration : OUTBOX_LEASE_MS;
}

function startLeaseHeartbeat(
  intervalMs: number,
  renew: () => Promise<void>,
): {
  beforeEffect: () => Promise<void>;
  stop: () => Promise<void>;
  failure: () => { error: unknown } | null;
} {
  let stopped = false;
  let cancelWait: (() => void) | null = null;
  let failed: { error: unknown } | null = null;
  let renewing: Promise<void> | null = null;
  const renewSerial = async (): Promise<void> => {
    if (failed) throw failed.error;
    if (!renewing) {
      const current = (async () => {
        try {
          await renew();
        } catch (error) {
          failed ??= { error };
          throw error;
        }
      })();
      renewing = current;
      void current.then(
        () => {
          if (renewing === current) renewing = null;
        },
        () => {
          if (renewing === current) renewing = null;
        },
      );
    }
    await renewing;
  };
  const done = (async () => {
    while (!stopped) {
      const tick = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          cancelWait = null;
          resolve(true);
        }, intervalMs);
        cancelWait = () => {
          clearTimeout(timer);
          cancelWait = null;
          resolve(false);
        };
      });
      if (!tick || stopped) break;
      try {
        await renewSerial();
      } catch {
        break;
      }
    }
  })();

  return {
    beforeEffect: renewSerial,
    stop: async () => {
      stopped = true;
      cancelWait?.();
      await done;
      const current = renewing;
      if (current) await current.catch(() => undefined);
    },
    failure: () => failed,
  };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

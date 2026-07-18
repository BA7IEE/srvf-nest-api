import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { OUTBOX_CLAIM_BATCH, OUTBOX_MAX_ATTEMPTS } from './notification.constants';
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

@Injectable()
export class NotificationOutboxWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private readonly workerId = `notification-outbox:${process.pid}:${randomUUID()}`;
  private stopping = false;

  constructor(
    private readonly outbox: NotificationOutboxService,
    private readonly handlers: NotificationOutboxHandlers,
  ) {}

  onApplicationShutdown(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    this.logger.log(`notification outbox worker started worker=${this.workerId}`);
    while (!this.stopping) {
      const result = await this.drainOnce();
      if (result.claimed === 0) await delay(500);
    }
  }

  async drainEventKey(eventKey: string): Promise<NotificationOutboxDrainResult> {
    return this.drainOnce(eventKey);
  }

  // HTTP 只能执行 request transaction 已预留并持有 fence 的 child intent；不再二次 claim，
  // 因而后台 worker 无法在 commit 与首轮 provider 调用之间抢走同一收件人。
  async executeReserved(intent: ClaimedNotificationOutboxIntent): Promise<unknown> {
    const refreshed = await this.outbox.renewLease(intent);
    try {
      const result = await this.handlers.execute(refreshed);
      await this.outbox.ack(refreshed, result.effectPerformed);
      return result.value;
    } catch (error) {
      if (error instanceof UnsupportedNotificationOutboxEventError) {
        await this.outbox.deadLetter(refreshed, error);
      } else {
        await this.outbox.nack(refreshed, error);
      }
      throw error;
    }
  }

  // admin SMS HTTP 首轮使用与后台完全相同的 claim/handler/ack 路径；失败先 nack 留待
  // worker 重试，再把原错误交回 service 映射既有 HTTP 语义。
  async drainEventKeyOrThrow(eventKey: string): Promise<unknown> {
    const [intent] = await this.outbox.claim(this.workerId, { limit: 1, eventKey });
    if (!intent) return undefined;
    return this.executeReserved(intent);
  }

  async drainOnce(eventKey?: string): Promise<NotificationOutboxDrainResult> {
    const claimed = await this.outbox.claim(this.workerId, {
      limit: eventKey ? 1 : OUTBOX_CLAIM_BATCH,
      eventKey,
    });
    const summary: NotificationOutboxDrainResult = {
      claimed: claimed.length,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };

    for (const intent of claimed) {
      try {
        const value = await this.executeReserved(intent);
        summary.succeeded += 1;
        if (eventKey) summary.value = value;
      } catch (error) {
        summary.failed += 1;
        if (error instanceof UnsupportedNotificationOutboxEventError) {
          summary.dead += 1;
          continue;
        }
        if (intent.attempts >= OUTBOX_MAX_ATTEMPTS) summary.dead += 1;
        this.logger.warn(
          `notification outbox intent failed id=${intent.id} eventType=${intent.eventType} ` +
            `attempt=${intent.attempts} errorClass=${errorClass(error)}`,
        );
      }
    }
    return summary;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

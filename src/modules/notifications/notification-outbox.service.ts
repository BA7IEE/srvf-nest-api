import { Injectable } from '@nestjs/common';
import { Prisma, type NotificationOutboxIntent } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_CLAIM_BATCH,
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_STATUS_DEAD,
  OUTBOX_STATUS_PENDING,
  OUTBOX_STATUS_PROCESSING,
  OUTBOX_STATUS_SUCCEEDED,
} from './notification.constants';
import {
  normalizeNotificationOutboxInput,
  NotificationOutboxInvariantError,
  NotificationOutboxLeaseLostError,
  type NotificationOutboxEnqueueInput,
} from './notification-outbox.types';

type OutboxClient = PrismaService | Prisma.TransactionClient;

export interface ClaimedNotificationOutboxIntent extends NotificationOutboxIntent {
  leaseOwner: string;
  lockedAt: Date;
}

export interface NotificationOutboxReservation {
  intent: ClaimedNotificationOutboxIntent | null;
  state: 'reserved' | 'busy' | 'completed' | 'dead';
}

@Injectable()
export class NotificationOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    input: NotificationOutboxEnqueueInput,
    client: OutboxClient = this.prisma,
  ): Promise<NotificationOutboxIntent> {
    const normalized = normalizeNotificationOutboxInput(input);
    const created = await client.notificationOutboxIntent.createMany({
      data: [
        {
          eventKey: normalized.eventKey,
          eventType: normalized.eventType,
          payloadVersion: normalized.payloadVersion,
          payload: normalized.payload,
          aggregateType: normalized.aggregateType,
          aggregateId: normalized.aggregateId,
          destinationType: normalized.destinationType,
          destinationRef: normalized.destinationRef,
          status: OUTBOX_STATUS_PENDING,
        },
      ],
      skipDuplicates: true,
    });

    const row = await client.notificationOutboxIntent.findUnique({
      where: { eventKey: normalized.eventKey },
    });
    if (!row) {
      throw new NotificationOutboxInvariantError(
        `eventKey=${normalized.eventKey} insert disappeared`,
      );
    }
    if (created.count === 0 && !sameIntent(row, normalized)) {
      throw new NotificationOutboxInvariantError(
        `eventKey=${normalized.eventKey} was reused with different content`,
      );
    }
    return row;
  }

  // 广播微信 child 每个 publish generation 保留独立 eventKey/history，但同 notification/member
  // 任一时刻只允许一条 active attempt（migration partial unique）。并发 root 撞 active slot 时
  // 复用既有 pending/processing intent；terminal 后槽位释放，下一次真实 re-publish 可新建。
  async enqueueWechatDeliveryAttempt(
    input: NotificationOutboxEnqueueInput,
    client: OutboxClient = this.prisma,
  ): Promise<NotificationOutboxIntent> {
    const normalized = normalizeNotificationOutboxInput(input);
    if (normalized.eventType !== OUTBOX_EVENT_WECHAT_DELIVERY) {
      throw new NotificationOutboxInvariantError(
        `eventType=${normalized.eventType} cannot use wechat delivery active slot`,
      );
    }

    // active row 可能恰在 unique conflict 后转 terminal；有限重试允许本 generation 接手刚释放的槽位。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.notificationOutboxIntent.createMany({
        data: [
          {
            eventKey: normalized.eventKey,
            eventType: normalized.eventType,
            payloadVersion: normalized.payloadVersion,
            payload: normalized.payload,
            aggregateType: normalized.aggregateType,
            aggregateId: normalized.aggregateId,
            destinationType: normalized.destinationType,
            destinationRef: normalized.destinationRef,
            status: OUTBOX_STATUS_PENDING,
          },
        ],
        skipDuplicates: true,
      });
      const sameKey = await client.notificationOutboxIntent.findUnique({
        where: { eventKey: normalized.eventKey },
      });
      if (sameKey) {
        if (!sameIntent(sameKey, normalized)) {
          throw new NotificationOutboxInvariantError(
            `eventKey=${normalized.eventKey} was reused with different content`,
          );
        }
        return sameKey;
      }
      const active = await client.notificationOutboxIntent.findFirst({
        where: {
          eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
          aggregateId: normalized.aggregateId,
          destinationRef: normalized.destinationRef,
          status: { in: [OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING] },
        },
      });
      if (active) return active;
    }
    throw new NotificationOutboxInvariantError(
      `wechat delivery active slot churned for aggregate=${normalized.aggregateId}`,
    );
  }

  // admin SMS 每次 confirmation 使用新 generation eventKey；partial unique 保证同一
  // notification/member 任一时刻只有一条 pending/processing。createMany skipDuplicates
  // 在 transaction 内吸收 unique race，再区分 own key 与 foreign active slot，禁止 catch P2002 续跑。
  async reserveAdminSmsAttempt(
    input: NotificationOutboxEnqueueInput,
    leaseOwner: string,
    client: Prisma.TransactionClient,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<NotificationOutboxReservation> {
    const normalized = normalizeNotificationOutboxInput(input);
    if (normalized.eventType !== OUTBOX_EVENT_ADMIN_SMS) {
      throw new NotificationOutboxInvariantError(
        `eventType=${normalized.eventType} cannot use admin SMS active slot`,
      );
    }
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? OUTBOX_LEASE_MS));
    const lockedAt = now;
    const created = await client.notificationOutboxIntent.createMany({
      data: [
        {
          eventKey: normalized.eventKey,
          eventType: normalized.eventType,
          payloadVersion: normalized.payloadVersion,
          payload: normalized.payload,
          aggregateType: normalized.aggregateType,
          aggregateId: normalized.aggregateId,
          destinationType: normalized.destinationType,
          destinationRef: normalized.destinationRef,
          status: OUTBOX_STATUS_PROCESSING,
          attempts: 1,
          leaseOwner,
          lockedAt,
          leaseExpiresAt,
        },
      ],
      skipDuplicates: true,
    });
    const sameKey = await client.notificationOutboxIntent.findUnique({
      where: { eventKey: normalized.eventKey },
    });
    if (sameKey && !sameIntent(sameKey, normalized)) {
      throw new NotificationOutboxInvariantError(
        `eventKey=${normalized.eventKey} was reused with different content`,
      );
    }
    if (created.count === 1) {
      if (!sameKey || !hasFence(sameKey)) {
        throw new NotificationOutboxInvariantError(`eventKey=${normalized.eventKey} lost fence`);
      }
      return { intent: sameKey, state: 'reserved' };
    }
    if (sameKey) {
      if (
        sameKey.status === OUTBOX_STATUS_PROCESSING &&
        sameKey.leaseOwner === leaseOwner &&
        hasFence(sameKey)
      ) {
        return { intent: sameKey, state: 'reserved' };
      }
      if (sameKey.status === OUTBOX_STATUS_SUCCEEDED) {
        return { intent: null, state: 'completed' };
      }
      if (sameKey.status === OUTBOX_STATUS_DEAD || sameKey.attempts >= OUTBOX_MAX_ATTEMPTS) {
        return { intent: null, state: 'dead' };
      }
      return { intent: null, state: 'busy' };
    }
    const active = await client.notificationOutboxIntent.findFirst({
      where: {
        eventType: OUTBOX_EVENT_ADMIN_SMS,
        aggregateId: normalized.aggregateId,
        destinationRef: normalized.destinationRef,
        status: { in: [OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING] },
      },
    });
    if (active) return { intent: null, state: 'busy' };
    throw new NotificationOutboxInvariantError(
      `admin SMS active slot disappeared for aggregate=${normalized.aggregateId}`,
    );
  }

  async claim(
    leaseOwner: string,
    options: { now?: Date; limit?: number; leaseMs?: number; eventKey?: string } = {},
  ): Promise<ClaimedNotificationOutboxIntent[]> {
    const now = options.now ?? new Date();
    const limit = Math.min(Math.max(options.limit ?? OUTBOX_CLAIM_BATCH, 1), 100);
    const lockedAt = now;
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? OUTBOX_LEASE_MS));

    return this.prisma.$transaction(async (tx) => {
      // 上次 provider 已执行到第 8 次后进程崩溃、尚未来得及 nack 时，租约到期必须
      // 原子 dead，绝不能让第 9 个 worker 再执行一次 Effect。
      await tx.notificationOutboxIntent.updateMany({
        where: {
          status: OUTBOX_STATUS_PROCESSING,
          attempts: { gte: OUTBOX_MAX_ATTEMPTS },
          leaseExpiresAt: { not: null, lte: now },
        },
        data: {
          status: OUTBOX_STATUS_DEAD,
          deadAt: now,
          completedAt: now,
          leaseOwner: null,
          lockedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
          lastErrorClass: 'NotificationOutboxMaxAttempts',
        },
      });
      const eventFilter = options.eventKey
        ? Prisma.sql`AND "eventKey" = ${options.eventKey}`
        : Prisma.empty;
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "notification_outbox_intents"
        WHERE ((
            "status" = ${OUTBOX_STATUS_PENDING}
            AND "availableAt" <= ${now}
          ) OR (
            "status" = ${OUTBOX_STATUS_PROCESSING}
            AND "leaseExpiresAt" IS NOT NULL
            AND "leaseExpiresAt" <= ${now}
          )
        )
        AND "attempts" < ${OUTBOX_MAX_ATTEMPTS}
        ${eventFilter}
        ORDER BY "availableAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (candidates.length === 0) return [];

      const ids = candidates.map((row) => row.id);
      await tx.notificationOutboxIntent.updateMany({
        where: { id: { in: ids } },
        data: {
          status: OUTBOX_STATUS_PROCESSING,
          attempts: { increment: 1 },
          leaseOwner,
          lockedAt,
          leaseExpiresAt,
          lastErrorCode: null,
          lastErrorClass: null,
        },
      });
      const rows = await tx.notificationOutboxIntent.findMany({
        where: { id: { in: ids }, leaseOwner, lockedAt },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.filter(hasFence);
    });
  }

  async ack(
    intent: ClaimedNotificationOutboxIntent,
    effectPerformed: boolean,
    now: Date = new Date(),
  ): Promise<void> {
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: fenceWhere(intent),
      data: {
        status: OUTBOX_STATUS_SUCCEEDED,
        sentAt: effectPerformed ? now : intent.sentAt,
        completedAt: now,
        leaseOwner: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorClass: null,
      },
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
  }

  // 每个 child 在任何 handler/provider 前 just-in-time 续租。CAS 同时校验旧 fence 与租约尚未
  // 过期，并旋转 lockedAt；失败表示已过期或被其它 worker reclaim，调用方必须零 Effect。
  async renewLease(
    intent: ClaimedNotificationOutboxIntent,
    now: Date = new Date(),
    leaseMs: number = OUTBOX_LEASE_MS,
  ): Promise<ClaimedNotificationOutboxIntent> {
    const lockedAt = now;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: {
        ...fenceWhere(intent),
        leaseExpiresAt: { not: null, gt: now },
      },
      data: { lockedAt, leaseExpiresAt },
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
    const row = await this.prisma.notificationOutboxIntent.findFirst({
      where: { id: intent.id, leaseOwner: intent.leaseOwner, lockedAt },
    });
    if (!row || !hasFence(row)) throw new NotificationOutboxLeaseLostError(intent.id);
    return row;
  }

  async nack(
    intent: ClaimedNotificationOutboxIntent,
    error: unknown,
    now: Date = new Date(),
  ): Promise<'pending' | 'dead'> {
    const normalized = normalizeOutboxError(error);
    const dead = intent.attempts >= OUTBOX_MAX_ATTEMPTS;
    const data: Prisma.NotificationOutboxIntentUpdateManyMutationInput = dead
      ? {
          status: OUTBOX_STATUS_DEAD,
          deadAt: now,
          completedAt: now,
          leaseOwner: null,
          lockedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
        }
      : {
          status: OUTBOX_STATUS_PENDING,
          availableAt: new Date(now.getTime() + retryDelayMs(intent.attempts)),
          leaseOwner: null,
          lockedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
        };
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: fenceWhere(intent),
      data,
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
    return dead ? 'dead' : 'pending';
  }

  async deadLetter(
    intent: ClaimedNotificationOutboxIntent,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeOutboxError(error);
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: fenceWhere(intent),
      data: {
        status: OUTBOX_STATUS_DEAD,
        deadAt: now,
        completedAt: now,
        leaseOwner: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: normalized.code,
        lastErrorClass: normalized.errorClass,
      },
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
  }

  async markPrepared(
    intent: ClaimedNotificationOutboxIntent,
    prepare: (tx: Prisma.TransactionClient) => Promise<void>,
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.notificationOutboxIntent.findFirst({
        where: fenceWhere(intent),
        select: { preparedAt: true },
      });
      if (!current) throw new NotificationOutboxLeaseLostError(intent.id);
      if (current.preparedAt) return false;

      await prepare(tx);
      const updated = await tx.notificationOutboxIntent.updateMany({
        where: { ...fenceWhere(intent), preparedAt: null },
        data: { preparedAt: now },
      });
      if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
      return true;
    });
  }

  async findByEventKey(eventKey: string): Promise<NotificationOutboxIntent | null> {
    return this.prisma.notificationOutboxIntent.findUnique({ where: { eventKey } });
  }
}

function hasFence(row: NotificationOutboxIntent): row is ClaimedNotificationOutboxIntent {
  return row.leaseOwner !== null && row.lockedAt !== null;
}

function fenceWhere(
  intent: ClaimedNotificationOutboxIntent,
): Prisma.NotificationOutboxIntentWhereInput {
  return {
    id: intent.id,
    status: OUTBOX_STATUS_PROCESSING,
    leaseOwner: intent.leaseOwner,
    lockedAt: intent.lockedAt,
  };
}

function sameIntent(row: NotificationOutboxIntent, input: NotificationOutboxEnqueueInput): boolean {
  return (
    row.eventType === input.eventType &&
    row.payloadVersion === input.payloadVersion &&
    canonicalJson(row.payload) === canonicalJson(input.payload) &&
    row.aggregateType === input.aggregateType &&
    row.aggregateId === input.aggregateId &&
    row.destinationType === input.destinationType &&
    row.destinationRef === input.destinationRef
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeOutboxError(error: unknown): { code: string; errorClass: string } {
  if (error instanceof Error) {
    const candidate = 'errCode' in error ? String(error.errCode) : error.name;
    return { code: candidate.slice(0, 120), errorClass: error.name.slice(0, 120) };
  }
  return { code: 'UNKNOWN', errorClass: typeof error };
}

function retryDelayMs(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), OUTBOX_BACKOFF_MAX_MS);
}

import { Injectable } from '@nestjs/common';
import { Prisma, type Notification, type NotificationOutboxIntent } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_STATUS_SENT,
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_CHANNEL_WECOM,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_SOURCE_SYSTEM,
  NOTIFICATION_STATUS_PUBLISHED,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_CLAIM_BATCH,
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_PAYLOAD_VERSION,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_EVENT_WECHAT_BROADCAST,
  OUTBOX_EVENT_WECOM_BROADCAST,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_STATUS_DEAD,
  OUTBOX_STATUS_PENDING,
  OUTBOX_STATUS_PROCESSING,
  OUTBOX_STATUS_SUCCEEDED,
} from './notification.constants';
import {
  buildWecomDirectedDeliveryEventKey,
  normalizeNotificationOutboxInput,
  NotificationOutboxInvariantError,
  NotificationOutboxLeaseLostError,
  readWecomDirectedReplayNonce,
  type NotificationOutboxEnqueueInput,
} from './notification-outbox.types';

/** 系统定向通知 replay 的四种结局。用判别联合:调用方必须显式处理每一种。 */
export type WecomDirectedReplayResult =
  | { state: 'enqueued'; intentId: string; eventKey: string }
  /** 这个人这条通知已经收到过 —— 跨 attempt 的永久去重事实,不重复打扰。 */
  | { state: 'already-sent' }
  /** 还有一条 pending/processing 的 attempt 在跑,active-slot 归它。 */
  | { state: 'active-attempt-exists'; activeIntentId: string }
  | {
      state: 'not-replayable';
      reason:
        | 'notification-not-found'
        | 'notification-deleted'
        | 'notification-not-published'
        | 'not-system-directed'
        | 'channel-not-declared'
        /** 这条通知对这个人从来没有过 wecom child —— 没有"上一次"可以重发。 */
        | 'never-attempted'
        /**
         * 上一次不是"等人工 replay"的那种终态(SHOULD-FIX 3)。
         * 即:intent 没 dead 过,或最后那条 delivery 的 reason 不在
         * {@link WECOM_REPLAYABLE_DELIVERY_REASONS} 内 —— 例如 `channel-disabled`
         * (通道自己关着)、`recipient-unlicensed`(许可没买)。这两类重发解决不了。
         * 运维确认过确实要绕过时传 `overrideReason: true`。
         */
        | 'last-attempt-not-replayable';
    };

/**
 * 允许自动放行 replay 的**上一次失败原因**闭集(runbook §6;第二轮外部评审 SHOULD-FIX 3)。
 *
 * 只有这两类是"重发真有可能成功"的:官方拦截窗口过去之后 45009 会恢复,
 * 请求契约错修好之后 invalidparty/invalidtag 会消失。
 * 其余原因(通道关着 / 许可没买 / 收件人不可达)重发一百次也是同一个结果。
 */
const WECOM_REPLAYABLE_DELIVERY_REASONS: ReadonlySet<string> = new Set<string>([
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
]);

type OutboxClient = PrismaService | Prisma.TransactionClient;
export type NotificationOutboxRecipientPermission = (
  tx: Prisma.TransactionClient,
  notification: Notification,
) => Promise<boolean>;

export interface ClaimedNotificationOutboxIntent extends NotificationOutboxIntent {
  leaseOwner: string;
  lockedAt: Date;
  leaseExpiresAt: Date;
}

export interface NotificationOutboxReservation {
  intent: NotificationOutboxIntent | null;
  state: 'reserved' | 'busy' | 'completed' | 'dead';
}

export interface NotificationOutboxPreparation {
  templateId: string;
  preparedNow: boolean;
  refundCapability: object | null;
}

export class NotificationOutboxGenerationConflictError extends Error {
  constructor(readonly activeIntent: NotificationOutboxIntent) {
    super(`NOTIFICATION_OUTBOX_GENERATION_CONFLICT: ${activeIntent.id}`);
    this.name = 'NotificationOutboxGenerationConflictError';
  }
}

@Injectable()
export class NotificationOutboxService {
  private readonly refundCapabilities = new WeakMap<
    object,
    { intentId: string; leaseOwner: string; lockedAtMs: number; templateId: string }
  >();

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

  /**
   * 批量 enqueue(M3):**恒 2 次 SQL**,与条数无关。
   *
   * 存在的理由:考勤终审对每条 record 各发一条 intent,逐条 `enqueue()` 是
   * 「createMany(1) + findUnique」= 2 次往返 × N 条。200 人的考勤单光这里就 400 次,
   * 是把 Prisma 默认 5s 交互事务预算跑穿的主因之一。
   *
   * 语义与单条版逐字一致:
   * - `skipDuplicates` 让重放幂等(同 eventKey 已存在就不插);
   * - 回读后**逐条**对账 `sameIntent` —— 新插的行按构造必然相等,已存在的行若内容不同
   *   仍抛 `NotificationOutboxInvariantError`(eventKey 被复用成别的内容 = 语义事故)。
   *   单条版靠 `created.count === 0` 区分「这条是重复」;批量版拿不到逐条结果,
   *   于是对全部行做对账 —— 判据更强,不更弱。
   * - **批内先按 eventKey 去重**:`skipDuplicates` 只看表里已有的行,同一批里两条相同
   *   eventKey 会直接撞唯一约束抛 P2002。批内重复必须是同内容,否则同样是事故。
   */
  async enqueueMany(
    inputs: readonly NotificationOutboxEnqueueInput[],
    client: OutboxClient = this.prisma,
  ): Promise<NotificationOutboxIntent[]> {
    if (inputs.length === 0) return [];
    const byKey = new Map<string, NotificationOutboxEnqueueInput>();
    for (const input of inputs) {
      const normalized = normalizeNotificationOutboxInput(input);
      const seen = byKey.get(normalized.eventKey);
      if (seen === undefined) {
        byKey.set(normalized.eventKey, normalized);
        continue;
      }
      if (!sameIntentInput(seen, normalized)) {
        throw new NotificationOutboxInvariantError(
          `eventKey=${normalized.eventKey} appears twice in one batch with different content`,
        );
      }
    }
    const normalizedList = [...byKey.values()];

    await client.notificationOutboxIntent.createMany({
      data: normalizedList.map((normalized) => ({
        eventKey: normalized.eventKey,
        eventType: normalized.eventType,
        payloadVersion: normalized.payloadVersion,
        payload: normalized.payload,
        aggregateType: normalized.aggregateType,
        aggregateId: normalized.aggregateId,
        destinationType: normalized.destinationType,
        destinationRef: normalized.destinationRef,
        status: OUTBOX_STATUS_PENDING,
      })),
      skipDuplicates: true,
    });

    const rows = await client.notificationOutboxIntent.findMany({
      where: { eventKey: { in: [...byKey.keys()] } },
    });
    const rowByKey = new Map(rows.map((row) => [row.eventKey, row]));
    return normalizedList.map((normalized) => {
      const row = rowByKey.get(normalized.eventKey);
      if (!row) {
        throw new NotificationOutboxInvariantError(
          `eventKey=${normalized.eventKey} insert disappeared`,
        );
      }
      if (!sameIntent(row, normalized)) {
        throw new NotificationOutboxInvariantError(
          `eventKey=${normalized.eventKey} was reused with different content`,
        );
      }
      return row;
    });
  }

  // 广播微信 child 每个 publish generation 保留独立 eventKey/history，但同 notification/member
  // 任一时刻只允许一条 active attempt（migration partial unique）。并发 root 撞 active slot 时
  // 复用既有 pending/processing intent；terminal 后槽位释放，下一次真实 re-publish 可新建。
  async enqueueWechatDeliveryAttempt(
    input: NotificationOutboxEnqueueInput,
    client: OutboxClient = this.prisma,
  ): Promise<NotificationOutboxIntent> {
    return this.enqueueActiveSlotDeliveryAttempt(input, OUTBOX_EVENT_WECHAT_DELIVERY, client);
  }

  /**
   * 企业微信 child 的 active-slot enqueue(T5B)。
   *
   * 与微信版**共用同一段实现、各自独立的槽位**:active-slot partial unique 的谓词按
   * `eventType` 分域(第 69 个 migration),故同一通知同一人可以同时有一条 wechat child
   * 和一条 wecom child —— 冻结稿 §10.3 明确点名:共用不含 eventType 的索引会让两个渠道互斥,
   * 同一通知同一人无法同时收到两条。
   *
   * 做成两个具名入口而不是让调用方传 eventType:"拿错渠道的 eventType 去抢别人的槽位"
   * 因此是一件写不出来的事。
   */
  async enqueueWecomDeliveryAttempt(
    input: NotificationOutboxEnqueueInput,
    client: OutboxClient = this.prisma,
  ): Promise<NotificationOutboxIntent> {
    return this.enqueueActiveSlotDeliveryAttempt(input, OUTBOX_EVENT_WECOM_DELIVERY, client);
  }

  /**
   * **系统定向通知**的企业微信投递显式 replay(外部评审 F2 / SF2)。
   *
   * 为什么需要它:admin 广播撞 45009 / 请求契约错而 dead 之后,运维走
   * unpublish + publish 造新 `publishGeneration`,新 root 会为尚未 SENT 的人重建 child
   * (runbook §6)。**系统定向通知没有 publish 状态机** —— producer 在业务事务内 enqueue、
   * worker 直接建成 published 行,payload 里根本没有 generation。它的 v1 child eventKey
   * `wecom-delivery:{notificationId}:{memberId}` 是**确定性**的,一旦 dead,再 enqueue
   * 只会命中那条 dead 行 ⇒ **这条通知对这个人永远不会再发**,而现场看起来一切正常。
   *
   * 处置:建**新 child id + 新 eventKey**(追加 `:r{n}` replay nonce),旧的 dead 行
   * 原样保留(它是历史事实,不是垃圾)。
   *
   * 四条护栏,一条都不能少:
   * - **已 SENT 者不被重复打扰**:跨 attempt 去重仍是 `notificationId + memberId + channel + SENT`
   *   这条永久事实,与 re-publish 用的是同一条(不是第二套口径)。
   * - **在途 attempt 优先**:仍走 `enqueueWecomDeliveryAttempt`,active-slot partial unique
   *   照旧是"同一通知同一人任一时刻只一条 active"的唯一真相 —— replay 不给它开后门。
   * - **只认系统定向**:admin 广播有自己的 replay 路径,不该有第二条;非 published / 已软删 /
   *   没勾 wecom 渠道的通知一律拒。
   * - **只认"重发有可能成功"的上一次终态**(第二轮外部评审 SHOULD-FIX 3):默认只放行
   *   {@link WECOM_REPLAYABLE_DELIVERY_REASONS};`channel-disabled` / `recipient-unlicensed` /
   *   从未尝试过一律拒。在此之前 runbook §6 的这条限制**只写在文档里**,代码不认。
   *
   * ⚠️ 这是**给人用的入口**,不是自动重试:45009 的窗口有没有过去只有人知道
   * (见 `docs/ops/wecom-message-channel-rollout.md` §6.1)。本方法不判断窗口。
   *
   * @param options.overrideReason 显式绕过上一条允许集判据(默认 `false`)。
   *        运维确认"我知道这类重发通常没用,但这次情况特殊"时才传 ——
   *        做成必须写出来的实参,而不是默认行为。**其余护栏一概不绕**
   *        (已 SENT / 在途 attempt / 非系统定向 依旧照拒)。
   */
  async replayDirectedWecomDelivery(
    notificationId: string,
    options: { overrideReason?: boolean } = {},
  ): Promise<WecomDirectedReplayResult> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        deletedAt: true,
        statusCode: true,
        sourceType: true,
        audienceType: true,
        recipientMemberId: true,
        channels: true,
      },
    });
    if (!notification) return { state: 'not-replayable', reason: 'notification-not-found' };
    if (notification.deletedAt !== null) {
      return { state: 'not-replayable', reason: 'notification-deleted' };
    }
    if (notification.statusCode !== NOTIFICATION_STATUS_PUBLISHED) {
      return { state: 'not-replayable', reason: 'notification-not-published' };
    }
    if (
      notification.sourceType !== NOTIFICATION_SOURCE_SYSTEM ||
      notification.audienceType !== NOTIFICATION_AUDIENCE_DIRECTED ||
      notification.recipientMemberId === null
    ) {
      // admin 广播走 unpublish + publish;这里不给它第二条路径。
      return { state: 'not-replayable', reason: 'not-system-directed' };
    }
    if (!notification.channels.includes(NOTIFICATION_CHANNEL_WECOM)) {
      return { state: 'not-replayable', reason: 'channel-not-declared' };
    }

    const memberId = notification.recipientMemberId;
    const alreadySent = await this.prisma.notificationDelivery.findFirst({
      where: {
        notificationId,
        memberId,
        channel: NOTIFICATION_CHANNEL_WECOM,
        status: DELIVERY_STATUS_SENT,
      },
      select: { id: true },
    });
    if (alreadySent) return { state: 'already-sent' };

    // ── 历史终态闸(第二轮外部评审 SHOULD-FIX 3)────────────────────────────
    //
    // 上面五条只看通知**本身**的形态,一条都没看"上一次尝试是怎么结束的"。
    // 于是 runbook §6 写的「仅限 rate-limited / provider-contract-error」在代码里
    // 没有执行位:`channel-disabled`、`recipient-unlicensed`、乃至**从未尝试过**的
    // 通知都能建出新 child —— 而这三类重发一次也解决不了,只会把上游调用量和
    // 噪音各放大一轮。文档写了限制、代码不认,等于没限制。
    const existing = await this.prisma.notificationOutboxIntent.findMany({
      where: {
        eventType: OUTBOX_EVENT_WECOM_DELIVERY,
        aggregateId: notificationId,
        destinationRef: memberId,
      },
      select: { eventKey: true, status: true },
    });

    // 从来没有过 child ⇒ 没有"上一次"可以 replay。replay 是**重发**入口,
    // 不是"补发"入口:该建 child 而没建(通道关着 / 没有 active identity)是
    // 另一类问题,凭空建一条只会掩盖它。
    if (existing.length === 0) {
      return { state: 'not-replayable', reason: 'never-attempted' };
    }

    // 还有在途 attempt 时**不判** reason —— 那一条还没结束,"上一次终态"根本不存在。
    // 这里只做跳过;`active-attempt-exists` 仍由下面 enqueue 撞 active-slot partial
    // unique 来裁决(它才是并发下的唯一真相,这里再判一次只会是第二套口径)。
    const hasActiveAttempt = existing.some(
      (row) => row.status === OUTBOX_STATUS_PENDING || row.status === OUTBOX_STATUS_PROCESSING,
    );
    if (!hasActiveAttempt && options.overrideReason !== true) {
      // 两条判据都要过:intent 得是 dead(**等人工 replay** 的那个终态 —— ack 掉的
      // 说明链路已按设计走完),且最后那条 delivery 的 reason 在允许集内。
      const lastTerminal = await this.prisma.notificationDelivery.findFirst({
        where: { notificationId, memberId, channel: NOTIFICATION_CHANNEL_WECOM },
        orderBy: { createdAt: 'desc' },
        select: { reasonCode: true },
      });
      const deadOnce = existing.some((row) => row.status === OUTBOX_STATUS_DEAD);
      const replayableReason =
        lastTerminal !== null &&
        lastTerminal.reasonCode !== null &&
        WECOM_REPLAYABLE_DELIVERY_REASONS.has(lastTerminal.reasonCode);
      if (!deadOnce || !replayableReason) {
        return { state: 'not-replayable', reason: 'last-attempt-not-replayable' };
      }
    }

    // 下一个 replay 序号 = 既有 child 里最大的那个 + 1(基础键算 0)。
    const nextNonce =
      existing.reduce((max, row) => {
        const nonce = readWecomDirectedReplayNonce(row.eventKey, notificationId, memberId);
        return nonce === null ? max : Math.max(max, nonce);
      }, 0) + 1;

    try {
      const intent = await this.enqueueWecomDeliveryAttempt({
        eventKey: buildWecomDirectedDeliveryEventKey(notificationId, memberId, nextNonce),
        eventType: OUTBOX_EVENT_WECOM_DELIVERY,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: { notificationId, memberId },
        aggregateType: 'notification',
        aggregateId: notificationId,
        destinationType: 'member',
        destinationRef: memberId,
      });
      return { state: 'enqueued', intentId: intent.id, eventKey: intent.eventKey };
    } catch (error) {
      // active-slot 已被占:还有一条 pending/processing 的 attempt 在跑,replay 无事可做。
      if (error instanceof NotificationOutboxGenerationConflictError) {
        return { state: 'active-attempt-exists', activeIntentId: error.activeIntent.id };
      }
      throw error;
    }
  }

  private async enqueueActiveSlotDeliveryAttempt(
    input: NotificationOutboxEnqueueInput,
    expectedEventType: string,
    client: OutboxClient,
  ): Promise<NotificationOutboxIntent> {
    const normalized = normalizeNotificationOutboxInput(input);
    if (normalized.eventType !== expectedEventType) {
      throw new NotificationOutboxInvariantError(
        `eventType=${normalized.eventType} cannot use ${expectedEventType} active slot`,
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
          // ⚠️ 必须用 `expectedEventType` 而不是写死某一个渠道:两个渠道的 partial unique
          // 各自分域,查错了 eventType 会把**另一个渠道**的 active child 当成本渠道的冲突,
          // 于是 root 无限 defer 而消息永远发不出去。
          eventType: expectedEventType,
          aggregateId: normalized.aggregateId,
          destinationRef: normalized.destinationRef,
          status: { in: [OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING] },
        },
      });
      if (active) throw new NotificationOutboxGenerationConflictError(active);
    }
    throw new NotificationOutboxInvariantError(
      `${expectedEventType} active slot churned for aggregate=${normalized.aggregateId}`,
    );
  }

  // admin SMS 每次 confirmation 使用新 generation eventKey；request transaction 只落
  // pending/attempts=0 的 durable command，不提前持有 lease。commit 后 HTTP 与后台 worker
  // 通过同一 JIT claim 路径竞争；partial unique 仍保证同 notification/member 单 active slot。
  async reserveAdminSmsAttempt(
    input: NotificationOutboxEnqueueInput,
    client: Prisma.TransactionClient,
  ): Promise<NotificationOutboxReservation> {
    const normalized = normalizeNotificationOutboxInput(input);
    if (normalized.eventType !== OUTBOX_EVENT_ADMIN_SMS) {
      throw new NotificationOutboxInvariantError(
        `eventType=${normalized.eventType} cannot use admin SMS active slot`,
      );
    }
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
          attempts: 0,
          leaseOwner: null,
          lockedAt: null,
          leaseExpiresAt: null,
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
      if (
        !sameKey ||
        sameKey.status !== OUTBOX_STATUS_PENDING ||
        sameKey.attempts !== 0 ||
        sameKey.leaseOwner !== null ||
        sameKey.lockedAt !== null ||
        sameKey.leaseExpiresAt !== null
      ) {
        throw new NotificationOutboxInvariantError(
          `eventKey=${normalized.eventKey} lost pending reservation`,
        );
      }
      return { intent: sameKey, state: 'reserved' };
    }
    if (sameKey) {
      if (sameKey.status === OUTBOX_STATUS_PENDING) {
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

  // 每个 child 在任何 handler/provider 前 just-in-time 续租。lockedAt 是 intent 终身稳定
  // fence；续租 CAS 校验完整旧 fence + leaseExpiresAt>now，只延长 expiry，绝不旋转 fence。
  async renewLease(
    intent: ClaimedNotificationOutboxIntent,
    now: Date = new Date(),
    leaseMs: number = OUTBOX_LEASE_MS,
  ): Promise<ClaimedNotificationOutboxIntent> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: {
        ...fenceWhere(intent),
        leaseExpiresAt: { not: null, gt: now },
      },
      data: { leaseExpiresAt },
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
    return { ...intent, leaseExpiresAt };
  }

  // Provider permission point：固定锁序 Notification parent(FOR SHARE) → outbox intent
  // (FOR UPDATE)。同代不同 child 可共享 parent 快照；admin publish-generation 与撤回/删除的
  // 写锁仍被所有 permission shared locks 阻塞。事务提交即线性化点，外部 Effect 只消费锁内快照。
  async authorizeAdminNotificationEffect(
    intent: ClaimedNotificationOutboxIntent,
    notificationId: string,
    publishGeneration: number,
    requiredChannel: string,
    now?: Date,
    authorizeRecipient?: NotificationOutboxRecipientPermission,
  ): Promise<Notification | null> {
    return this.prisma.$transaction(async (tx) => {
      const notification = await this.lockNotificationWithFence(tx, intent, notificationId, now);
      if (
        !notification ||
        notification.deletedAt !== null ||
        notification.statusCode !== NOTIFICATION_STATUS_PUBLISHED ||
        notification.sourceType !== NOTIFICATION_SOURCE_ADMIN ||
        notification.audienceType !== NOTIFICATION_AUDIENCE_BROADCAST ||
        notification.publishGeneration !== publishGeneration ||
        !notification.channels.includes(requiredChannel)
      ) {
        return null;
      }
      if (authorizeRecipient && !(await authorizeRecipient(tx, notification))) return null;
      return notification;
    });
  }

  /**
   * 系统定向通知的 Provider 前授权闸(T5B)。
   *
   * 与 admin 版**同一段锁序、不同的通知谓词**。为什么需要单独一个:系统定向通知
   * (`sourceType=system` / `audienceType=directed` / `authorUserId=null`)不走 admin 状态机,
   * 没有 publishGeneration 概念 —— 拿 admin 版去判它会因 `sourceType !== admin` 恒返 null。
   *
   * 收件人由 producer 显式指定,故这里**不判可见档**(定向行的 `visibilityCode='member'`
   * 只是语义占位,真正的闸是 `recipientMemberId === memberId`);但 Member/User/身份的
   * 最终复验仍由调用方通过 `authorizeRecipient` 注入 —— 撤权 / 离队 / 解绑同样必须拦住。
   *
   * ⚠️ 微信小程序的 v1 系统定向路径**不**走本方法(它保持原样:无事务闸、直读 openid)。
   * 本刀不改微信任何行为;企业微信作为新渠道,从第一天起就走完整闸。
   */
  async authorizeSystemDirectedNotificationEffect(
    intent: ClaimedNotificationOutboxIntent,
    notificationId: string,
    recipientMemberId: string,
    requiredChannel: string,
    now?: Date,
    authorizeRecipient?: NotificationOutboxRecipientPermission,
  ): Promise<Notification | null> {
    return this.prisma.$transaction(async (tx) => {
      const notification = await this.lockNotificationWithFence(tx, intent, notificationId, now);
      if (
        !notification ||
        notification.deletedAt !== null ||
        notification.statusCode !== NOTIFICATION_STATUS_PUBLISHED ||
        notification.sourceType !== NOTIFICATION_SOURCE_SYSTEM ||
        notification.audienceType !== NOTIFICATION_AUDIENCE_DIRECTED ||
        notification.recipientMemberId !== recipientMemberId ||
        !notification.channels.includes(requiredChannel)
      ) {
        return null;
      }
      if (authorizeRecipient && !(await authorizeRecipient(tx, notification))) return null;
      return notification;
    });
  }

  /**
   * 两个 authorize 入口共用的锁序前缀:Notification parent(FOR SHARE)→ outbox intent
   * (FOR UPDATE)→ lease fence 复核。
   *
   * 抽出来是为了**只有一处**决定"先锁哪个、fence 怎么判" —— 复制第二份的那天,
   * 两份就会开始各自演化,而锁序不一致的两条路径互相等待就是死锁。
   * admin 版的行为逐字未变(既有 outbox/handlers/e2e spec 是它的 characterization)。
   */
  private async lockNotificationWithFence(
    tx: Prisma.TransactionClient,
    intent: ClaimedNotificationOutboxIntent,
    notificationId: string,
    now?: Date,
  ): Promise<Notification | undefined> {
    const [notification] = await tx.$queryRaw<Notification[]>(Prisma.sql`
        SELECT n.*
        FROM "notifications" n
        WHERE n."id" = ${notificationId}
        FOR SHARE
      `);
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "notification_outbox_intents"
        WHERE "id" = ${intent.id}
        FOR UPDATE
      `);
    const fenceNow = now ?? new Date();
    const currentIntent = await tx.notificationOutboxIntent.findFirst({
      where: {
        ...fenceWhere(intent),
        leaseExpiresAt: { not: null, gt: fenceNow },
      },
      select: { id: true },
    });
    if (!currentIntent) throw new NotificationOutboxLeaseLostError(intent.id);
    return notification;
  }

  // 新 publish generation 的 root 若撞到旧 generation active child，只允许 root 自身
  // 无损 defer：停止 heartbeat 后以原 fence CAS 回 pending，并恢复本轮 claim 消耗的 attempt。
  async deferWechatBroadcast(
    intent: ClaimedNotificationOutboxIntent,
    conflict: NotificationOutboxGenerationConflictError,
    now: Date = new Date(),
  ): Promise<void> {
    return this.deferBroadcastGeneration(intent, conflict, OUTBOX_EVENT_WECHAT_BROADCAST, now);
  }

  /**
   * 企业微信 root 的 generation defer(T5B)。语义与微信版逐字相同,只是认另一个 eventType。
   *
   * **方法名保持成对而不是合并成一个**:worker 按 `intent.eventType` 分派到对应入口,
   * 于是"微信 root 撞到企业微信 child 的槽位"这种跨渠道误判在调用层就不成立。
   * (合并成一个通用 defer 也能工作,但那样既有 wechat worker/outbox spec 全部要改名 ——
   * 本刀的硬约束之一是既有微信链 spec 零修改。)
   */
  async deferWecomBroadcast(
    intent: ClaimedNotificationOutboxIntent,
    conflict: NotificationOutboxGenerationConflictError,
    now: Date = new Date(),
  ): Promise<void> {
    return this.deferBroadcastGeneration(intent, conflict, OUTBOX_EVENT_WECOM_BROADCAST, now);
  }

  private async deferBroadcastGeneration(
    intent: ClaimedNotificationOutboxIntent,
    conflict: NotificationOutboxGenerationConflictError,
    expectedEventType: string,
    now: Date,
  ): Promise<void> {
    if (
      intent.eventType !== expectedEventType ||
      intent.preparedAt !== null ||
      intent.preparedTemplateId !== null
    ) {
      throw new NotificationOutboxInvariantError(`intent=${intent.id} cannot generation-defer`);
    }
    const active = conflict.activeIntent;
    let lowerBound: Date;
    if (active.status === OUTBOX_STATUS_PROCESSING) {
      if (!active.leaseExpiresAt) {
        throw new NotificationOutboxInvariantError(
          `active=${active.id} processing without lease expiry`,
        );
      }
      lowerBound = new Date(
        Math.max(active.leaseExpiresAt.getTime(), now.getTime()) + OUTBOX_BACKOFF_BASE_MS,
      );
    } else if (active.status === OUTBOX_STATUS_PENDING) {
      lowerBound = new Date(
        Math.max(active.availableAt.getTime(), now.getTime()) + OUTBOX_BACKOFF_BASE_MS,
      );
    } else {
      throw new NotificationOutboxInvariantError(`active=${active.id} is not active`);
    }
    const availableAt = new Date(Math.max(lowerBound.getTime(), now.getTime() + 1));
    if (availableAt.getTime() > now.getTime() + OUTBOX_BACKOFF_MAX_MS) {
      throw new NotificationOutboxInvariantError(`active=${active.id} defer horizon is invalid`);
    }
    const updated = await this.prisma.notificationOutboxIntent.updateMany({
      where: {
        ...fenceWhere(intent),
        preparedAt: null,
        preparedTemplateId: null,
        attempts: { gt: 0 },
      },
      data: {
        status: OUTBOX_STATUS_PENDING,
        attempts: { decrement: 1 },
        availableAt,
        leaseOwner: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
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
    requestedTemplateId: string,
    prepare: (tx: Prisma.TransactionClient, templateId: string) => Promise<void>,
    now: Date = new Date(),
  ): Promise<NotificationOutboxPreparation> {
    if (requestedTemplateId.trim() === '') {
      throw new NotificationOutboxInvariantError(`intent=${intent.id} prepared template is empty`);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.notificationOutboxIntent.findFirst({
        where: fenceWhere(intent),
        select: { preparedAt: true, preparedTemplateId: true },
      });
      if (!current) throw new NotificationOutboxLeaseLostError(intent.id);
      if ((current.preparedAt === null) !== (current.preparedTemplateId === null)) {
        throw new NotificationOutboxInvariantError(`intent=${intent.id} has partial prepare state`);
      }
      if (current.preparedAt) {
        return { templateId: current.preparedTemplateId!, preparedNow: false };
      }

      await prepare(tx, requestedTemplateId);
      const updated = await tx.notificationOutboxIntent.updateMany({
        where: { ...fenceWhere(intent), preparedAt: null, preparedTemplateId: null },
        data: { preparedAt: now, preparedTemplateId: requestedTemplateId },
      });
      if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
      return { templateId: requestedTemplateId, preparedNow: true };
    });
    if (!result.preparedNow) return { ...result, refundCapability: null };
    const refundCapability = {};
    this.refundCapabilities.set(refundCapability, {
      intentId: intent.id,
      leaseOwner: intent.leaseOwner,
      lockedAtMs: intent.lockedAt.getTime(),
      templateId: result.templateId,
    });
    return { ...result, refundCapability };
  }

  async refundPrepared(
    intent: ClaimedNotificationOutboxIntent,
    preparation: NotificationOutboxPreparation,
    refund: (tx: Prisma.TransactionClient, templateId: string) => Promise<boolean>,
  ): Promise<void> {
    const capability = preparation.refundCapability
      ? this.refundCapabilities.get(preparation.refundCapability)
      : undefined;
    if (
      !preparation.preparedNow ||
      !preparation.refundCapability ||
      !capability ||
      capability.intentId !== intent.id ||
      capability.leaseOwner !== intent.leaseOwner ||
      capability.lockedAtMs !== intent.lockedAt.getTime() ||
      capability.templateId !== preparation.templateId
    ) {
      throw new NotificationOutboxInvariantError(
        `intent=${intent.id} has no current-attempt refund capability`,
      );
    }
    const templateId = preparation.templateId;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.notificationOutboxIntent.findFirst({
        where: fenceWhere(intent),
        select: { preparedAt: true, preparedTemplateId: true },
      });
      if (!current) throw new NotificationOutboxLeaseLostError(intent.id);
      if (!current.preparedAt || !current.preparedTemplateId) {
        throw new NotificationOutboxInvariantError(
          `intent=${intent.id} has no complete prepare state`,
        );
      }
      if (current.preparedTemplateId !== templateId) {
        throw new NotificationOutboxInvariantError(`intent=${intent.id} prepared template changed`);
      }

      if (!(await refund(tx, templateId))) {
        throw new NotificationOutboxInvariantError(
          `intent=${intent.id} quota refund was not exact`,
        );
      }
      const updated = await tx.notificationOutboxIntent.updateMany({
        where: {
          ...fenceWhere(intent),
          preparedAt: current.preparedAt,
          preparedTemplateId: templateId,
        },
        data: { preparedAt: null, preparedTemplateId: null },
      });
      if (updated.count !== 1) throw new NotificationOutboxLeaseLostError(intent.id);
    });
    this.refundCapabilities.delete(preparation.refundCapability);
  }

  async findByEventKey(eventKey: string): Promise<NotificationOutboxIntent | null> {
    return this.prisma.notificationOutboxIntent.findUnique({ where: { eventKey } });
  }
}

function hasFence(row: NotificationOutboxIntent): row is ClaimedNotificationOutboxIntent {
  return row.leaseOwner !== null && row.lockedAt !== null && row.leaseExpiresAt !== null;
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

/** 两份**入参**是否等价(批内去重用;与 sameIntent 判同一组字段,只是左侧不是 DB 行)。 */
function sameIntentInput(
  a: NotificationOutboxEnqueueInput,
  b: NotificationOutboxEnqueueInput,
): boolean {
  return (
    a.eventType === b.eventType &&
    a.payloadVersion === b.payloadVersion &&
    canonicalJson(a.payload) === canonicalJson(b.payload) &&
    a.aggregateType === b.aggregateType &&
    a.aggregateId === b.aggregateId &&
    a.destinationType === b.destinationType &&
    a.destinationRef === b.destinationRef
  );
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

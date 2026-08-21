import { randomUUID } from 'node:crypto';

import { Role } from '@prisma/client';
import request from 'supertest';

import {
  OUTBOX_EVENT_WECHAT_BROADCAST,
  OUTBOX_EVENT_WECHAT_DELIVERY,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { journeyPrisma, type JourneyRuntime } from './journey-runtime';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const ADMIN_NOTIFICATIONS = '/api/admin/v1/notifications';
const TEMPLATE_ID = 'journey-outbox-general-template';

function requireStatus(
  response: { status: number; body: unknown },
  expected: number,
  action: string,
): void {
  if (response.status !== expected) {
    throw new Error(`${action} expected HTTP ${expected}, got ${response.status}`);
  }
}

async function createRecipient(
  runtime: JourneyRuntime,
  suffix: string,
  openid: string,
): Promise<{ memberId: string }> {
  const prisma = journeyPrisma(runtime);
  const user = await createTestUser(runtime.app, {
    username: `journey-outbox-${suffix}-${randomUUID()}`,
    role: Role.USER,
  });
  // journey-direct-write: ambient — 队员建档属招新链
  const member = await prisma.member.create({
    data: {
      memberNo: `journey-outbox-${suffix}-${randomUUID()}`,
      ...memberIdentityData(`出箱旅程${suffix}收件人`),
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  // journey-direct-write: ambient — 账号关联同属招新链
  await prisma.user.update({
    where: { id: user.id },
    data: { memberId: member.id, openid },
  });
  return { memberId: member.id };
}

async function seedWechatBroadcastReferences(runtime: JourneyRuntime): Promise<void> {
  const prisma = journeyPrisma(runtime);
  // journey-direct-write: ambient — 字典底座
  const type = await prisma.dictType.create({
    data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
    select: { id: true },
  });
  // journey-direct-write: ambient — 同上
  await prisma.dictItem.create({
    data: { typeId: type.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
  });
  // journey-direct-write: ambient — 微信订阅模板属渠道配置,不是被验的投递链
  await prisma.wechatSubscribeTemplate.create({
    data: { notificationTypeCode: 'general', templateId: TEMPLATE_ID, enabled: true },
  });
}

export interface OutboxDeliveryJourneyResult {
  readonly rootSucceeded: boolean;
  readonly successfulDeliveryStatus: string | null;
  readonly retryAttempts: number;
  readonly retryStatus: string | null;
  readonly transientFailureCount: number;
}

/** 金五条⑤：发布业务通知 → durable intent → worker 真实投递与重试终态。 */
export async function runOutboxDeliveryJourney(
  runtime: JourneyRuntime,
): Promise<OutboxDeliveryJourneyResult> {
  const prisma = journeyPrisma(runtime);
  await seedWechatBroadcastReferences(runtime);
  const delivered = await createRecipient(runtime, '正常', 'dev-openid-journey-outbox-ok');
  // DevStub 的 40001 是 token 无效类暂态错误；因此真实 handler 会 nack，而不是直接记终态。
  const retried = await createRecipient(runtime, '重试', 'dev-openid-wxerr-40001');
  // journey-direct-write: ambient — 微信配额是外部系统产物
  await prisma.wechatSubscriptionQuota.createMany({
    data: [
      { memberId: delivered.memberId, templateId: TEMPLATE_ID, availableCount: 1 },
      { memberId: retried.memberId, templateId: TEMPLATE_ID, availableCount: 1 },
    ],
  });

  const created = await request(httpServer(runtime.app))
    .post(ADMIN_NOTIFICATIONS)
    .set('Authorization', runtime.adminAuth)
    .send({
      title: '出箱旅程通知',
      body: '由业务发布动作产生 durable outbox intent。',
      notificationTypeCode: 'general',
      visibilityCode: 'member',
      channels: ['wechat'],
    });
  requireStatus(created, 201, '创建出箱旅程通知');
  const notificationId = String(created.body.data?.id ?? '');
  if (!notificationId) throw new Error('创建出箱旅程通知未返回 id');
  const published = await request(httpServer(runtime.app))
    .post(`${ADMIN_NOTIFICATIONS}/${notificationId}/publish`)
    .set('Authorization', runtime.adminAuth);
  requireStatus(published, 200, '发布出箱旅程通知');

  const root = await prisma.notificationOutboxIntent.findFirst({
    where: { eventType: OUTBOX_EVENT_WECHAT_BROADCAST, aggregateId: notificationId },
    select: { eventKey: true },
  });
  if (!root) throw new Error('发布业务通知后未生成微信广播 outbox intent');
  const worker = runtime.app.get(NotificationOutboxWorker);
  const rootResult = await worker.drainEventKey(root.eventKey);
  if (rootResult.claimed !== 1 || rootResult.succeeded !== 1) {
    throw new Error(`微信广播 root 未由 worker 成功展开: ${JSON.stringify(rootResult)}`);
  }

  const children = await prisma.notificationOutboxIntent.findMany({
    where: { eventType: OUTBOX_EVENT_WECHAT_DELIVERY, aggregateId: notificationId },
    select: { eventKey: true, destinationRef: true },
  });
  const deliveredChild = children.find((child) => child.destinationRef === delivered.memberId);
  const retriedChild = children.find((child) => child.destinationRef === retried.memberId);
  if (!deliveredChild || !retriedChild) {
    throw new Error(`广播 root 未生成完整投递 child: ${JSON.stringify(children)}`);
  }

  const deliveredResult = await worker.drainEventKey(deliveredChild.eventKey);
  if (deliveredResult.claimed !== 1 || deliveredResult.succeeded !== 1) {
    throw new Error(`正常收件人未完成真实 worker 投递: ${JSON.stringify(deliveredResult)}`);
  }

  // 不等待指数退避墙钟；每轮仍由真实 worker 领取并执行，只把测试时钟推进到下一次可领时刻。
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await worker.drainEventKey(retriedChild.eventKey);
    const expectedDead = attempt === 8 ? 1 : 0;
    if (result.claimed !== 1 || result.failed !== 1 || result.dead !== expectedDead) {
      throw new Error(`第 ${attempt} 次暂态投递结果不符合重试协议: ${JSON.stringify(result)}`);
    }
    if (attempt < 8) {
      // journey-direct-write: time-compression — 只把 availableAt 提前到 epoch 以压掉重试退避等待;不跳过任何链上步骤,重试仍逐次真跑 drainEventKey
      await prisma.notificationOutboxIntent.update({
        where: { eventKey: retriedChild.eventKey },
        data: { availableAt: new Date(0) },
      });
    }
  }

  const [successDelivery, retryIntent, transientFailureCount] = await Promise.all([
    prisma.notificationDelivery.findFirst({
      where: { notificationId, memberId: delivered.memberId, channel: 'wechat' },
      select: { status: true },
    }),
    prisma.notificationOutboxIntent.findUnique({
      where: { eventKey: retriedChild.eventKey },
      select: { attempts: true, status: true },
    }),
    prisma.notificationDelivery.count({
      where: {
        notificationId,
        memberId: retried.memberId,
        channel: 'wechat',
        status: 'failed',
      },
    }),
  ]);
  return {
    rootSucceeded: true,
    successfulDeliveryStatus: successDelivery?.status ?? null,
    retryAttempts: retryIntent?.attempts ?? 0,
    retryStatus: retryIntent?.status ?? null,
    transientFailureCount,
  };
}

import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import {
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECOM,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
  OUTBOX_STATUS_DEAD,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ============================================================================
// 外部评审 F2 / SF2 —— 系统定向通知的 replay 路径
// ============================================================================
//
// **缺口**:admin 广播撞 45009 dead 之后,运维可以 unpublish + publish 造一个新
// generation,新 root 会为尚未 SENT 的人重建 child(runbook §6)。
// 但**系统定向通知没有 publish 状态机**——它由 producer 在业务事务内 enqueue、
// 由 worker 直接建成 published 行,payload 里根本没有 generation。于是它的 v1 child
// 一旦 dead,eventKey `wecom-delivery:{notificationId}:{memberId}` 是**确定性**的,
// 再 enqueue 一次只会命中那条 dead 行 —— **这条通知对这个人永远不会再发**。
//
// 修法(DoD 6 给的第二个选项):显式 replay 入口,建**新 child id + 新 eventKey**
// (v1 定向 child 的 eventKey 允许追加 `:r{n}` replay nonce)。
// 跨 attempt 去重继续用 `notificationId + memberId + channel + SENT`,
// 所以已 SENT 的人不会被重复打扰。

const TYPE_CODE = 'f2-wecom-directed-replay';
const CORP_ID = 'ww-f2-replay-0001';
const WEB_BASE_URL = 'https://srvf-f2-replay.example.org';
// DEV_STUB 按 toUser 前缀注入故障:这个 id 会让 message/send 返 45009 ⇒ 终态 dead。
const RATE_LIMITED_USER_ID = 'wecomerr-ratelimit-directed-0001';
const HEALTHY_USER_ID = 'wecom-user-directed-healthy';

describe('F2 / SF2 —— 系统定向通知的 replay 路径', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: NotificationOutboxService;
  let handlers: NotificationOutboxHandlers;

  let memberId: string;
  let userId: string;

  const worker = (): NotificationOutboxWorker => new NotificationOutboxWorker(outbox, handlers);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    outbox = app.get(NotificationOutboxService);
    handlers = app.get(NotificationOutboxHandlers);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.dictType.create({
      data: {
        code: 'notification_type',
        label: '通知类型',
        items: { create: [{ code: TYPE_CODE, label: 'F2 定向 replay', status: 'ACTIVE' }] },
      },
    });
    await prisma.wecomSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        loginEnabled: false,
        messageEnabled: true,
        corpId: CORP_ID,
        webBaseUrl: WEB_BASE_URL,
        credentialConfigured: false,
      },
    });

    const member = await prisma.member.create({
      data: {
        memberNo: 'F2RPL001',
        displayName: 'F2 定向队员',
        status: 'ACTIVE',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    memberId = member.id;
    const user = await createTestUser(app, { username: 'f2_replay_member' });
    userId = user.id;
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.wecomIdentity.create({
      data: {
        userId: user.id,
        corpId: CORP_ID,
        wecomUserId: RATE_LIMITED_USER_ID,
        status: 'active',
        bindingSource: 'me',
      },
    });
  });

  /** producer 在业务事务内 enqueue 的那条 `notification.targeted@1`。 */
  async function enqueueDirected(): Promise<string> {
    const intent = await outbox.enqueue({
      eventKey: `f2-directed:${memberId}`,
      eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: {
        recipientMemberId: memberId,
        notificationTypeCode: TYPE_CODE,
        title: 'F2 定向通知',
        body: '请于周六 09:00 到岗。',
        channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
      },
      aggregateType: 'member',
      aggregateId: memberId,
      destinationType: 'member',
      destinationRef: memberId,
    });
    return intent.id;
  }

  async function drainAll(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      const result = await worker().drainOnce();
      if (result.claimed === 0) break;
    }
  }

  const wecomChildren = () =>
    prisma.notificationOutboxIntent.findMany({
      where: { eventType: OUTBOX_EVENT_WECOM_DELIVERY },
      orderBy: { eventKey: 'asc' },
    });

  const wecomDeliveries = () =>
    prisma.notificationDelivery.findMany({
      where: { channel: NOTIFICATION_CHANNEL_WECOM },
      orderBy: { createdAt: 'asc' },
    });

  /** 官方拦截窗口结束 = 那个人换回一个不注入故障的 userid。 */
  async function clearRateLimitInjection(): Promise<void> {
    await prisma.wecomIdentity.updateMany({
      where: { userId },
      data: { wecomUserId: HEALTHY_USER_ID },
    });
  }

  it('45009 dead 之后,显式 replay 能真正重发一次', async () => {
    const notificationId = await enqueueDirected();
    await drainAll();

    // 前置事实:child 已 dead,delivery 记的是 failed/rate-limited。
    const [deadChild] = await wecomChildren();
    expect(deadChild.status).toBe(OUTBOX_STATUS_DEAD);
    expect(deadChild.eventKey).toBe(`wecom-delivery:${notificationId}:${memberId}`);
    const failed = await wecomDeliveries();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      status: DELIVERY_STATUS_FAILED,
      reasonCode: DELIVERY_REASON_RATE_LIMITED,
    });

    // 缺口取证:不走 replay 入口的话,再 drain 多少轮都不会再发一次。
    await drainAll();
    expect(await wecomChildren()).toHaveLength(1);

    // 窗口过去了 → 显式 replay。
    await clearRateLimitInjection();
    const replay = await outbox.replayDirectedWecomDelivery(notificationId);
    expect(replay.state).toBe('enqueued');

    const children = await wecomChildren();
    expect(children).toHaveLength(2);
    // 新 child:新 id + 新 eventKey(带 replay nonce),旧的那条 dead 行原样保留。
    const replayed = children.find((row) => row.id !== deadChild.id);
    expect(replayed?.eventKey).toBe(`wecom-delivery:${notificationId}:${memberId}:r1`);

    await drainAll();
    const sent = (await wecomDeliveries()).filter((row) => row.status === DELIVERY_STATUS_SENT);
    expect(sent).toHaveLength(1);
  });

  it('已 SENT 者不被重复打扰:replay 直接返回 already-sent,不建新 child', async () => {
    await prisma.wecomIdentity.updateMany({
      where: { userId },
      data: { wecomUserId: HEALTHY_USER_ID },
    });
    const notificationId = await enqueueDirected();
    await drainAll();

    const sent = (await wecomDeliveries()).filter((row) => row.status === DELIVERY_STATUS_SENT);
    expect(sent).toHaveLength(1);
    const childCountBefore = (await wecomChildren()).length;

    const replay = await outbox.replayDirectedWecomDelivery(notificationId);
    expect(replay.state).toBe('already-sent');
    expect(await wecomChildren()).toHaveLength(childCountBefore);

    await drainAll();
    const sentAfter = (await wecomDeliveries()).filter(
      (row) => row.status === DELIVERY_STATUS_SENT,
    );
    expect(sentAfter).toHaveLength(1);
  });

  it('连续 replay:nonce 递增,不会撞既有 eventKey', async () => {
    const notificationId = await enqueueDirected();
    await drainAll();
    expect((await wecomChildren())[0].status).toBe(OUTBOX_STATUS_DEAD);

    expect((await outbox.replayDirectedWecomDelivery(notificationId)).state).toBe('enqueued');
    await drainAll();
    expect((await outbox.replayDirectedWecomDelivery(notificationId)).state).toBe('enqueued');

    const keys = (await wecomChildren()).map((row) => row.eventKey);
    expect(keys).toEqual([
      `wecom-delivery:${notificationId}:${memberId}`,
      `wecom-delivery:${notificationId}:${memberId}:r1`,
      `wecom-delivery:${notificationId}:${memberId}:r2`,
    ]);
  });

  it('还有在途 attempt 时拒绝 replay(active-slot 仍是单一真相)', async () => {
    const notificationId = await enqueueDirected();
    // 只跑 targeted intent 那一轮:wecom child 建出来了但还没投递 ⇒ 仍是 active。
    await worker().drainEventKey(`f2-directed:${memberId}`);
    expect((await wecomChildren())[0].status).not.toBe(OUTBOX_STATUS_DEAD);

    const replay = await outbox.replayDirectedWecomDelivery(notificationId);
    expect(replay.state).toBe('active-attempt-exists');
    expect(await wecomChildren()).toHaveLength(1);
  });

  it('非系统定向通知 / 未勾 wecom 渠道 ⇒ 拒绝 replay', async () => {
    const notificationId = await enqueueDirected();
    await drainAll();
    await prisma.notification.update({
      where: { id: notificationId },
      data: { channels: [NOTIFICATION_CHANNEL_IN_APP] },
    });
    const replay = await outbox.replayDirectedWecomDelivery(notificationId);
    expect(replay.state).toBe('not-replayable');
  });
});

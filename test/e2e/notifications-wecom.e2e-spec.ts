import type { INestApplication } from '@nestjs/common';
import { type Notification, Role, UserStatus } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import {
  DELIVERY_REASON_API_FAILED,
  DELIVERY_REASON_CHANNEL_DISABLED,
  DELIVERY_REASON_NO_WECOM_IDENTITY,
  DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
  DELIVERY_REASON_RECIPIENT_UNLICENSED,
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  DELIVERY_STATUS_SKIPPED,
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_CHANNEL_WECOM,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_VISIBILITY_MEMBER,
  OUTBOX_ADMIN_PAYLOAD_VERSION,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_EVENT_WECOM_BROADCAST,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_STATUS_DEAD,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { NotificationReadService } from '../../src/modules/notifications/notification-read.service';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ============================================================================
// T5B —— 企业微信应用消息渠道全链 e2e
// ============================================================================
//
// 需求真相源:docs/archive/reviews/wecom-integration-t0-terminal-review.md §10
// (D-WC-17/18/20/23/24/27 + §10.4 两阶段裁决 + §14.3 通知 e2e 清单)。
//
// **stub provider,不实连企业微信**:全部用例走 DEV_STUB,靠 `wecomUserId` 里的
// `wecomerr-*` 前缀注入投递语义故障(真机联调归 T6)。
//
// 本 spec 的四条主线:
//   ① 默认关(D-WC-24):没配 / 只开总闸 / 只开二级闸 —— 一律零 wecom intent
//   ② 两层闸各自的 red-first:关掉任一层,对应用例即红
//   ③ 敏感值三件套:查库对拍 + stringify-not-contain + audit 缺席
//   ④ 回执分类(§10.7):invaliduser / unlicenseduser / 81013 / 45009 / invalidparty / 网络
//
// ⚠️ 通知类型码取本 spec 专属值:`wechat_subscribe_templates` 没有指向 TRUNCATE 列表里
// 任何表的外键,不会被 resetDb 的 CASCADE 清掉,用共享码会与别的 spec 在同一 worker 库撞唯一键。
const TYPE_CODE = 't5b-wecom-channel';
// AuditMeta 三字段(requestId / ip / ua)由 controller 从 @Req() 构造;service 层直调时自备一份。
const AUDIT_META = { requestId: 't5b-e2e', ip: '127.0.0.1', ua: 'jest' };
const CORP_ID = 'ww-t5b-corp-0001';
const WEB_BASE_URL = 'https://srvf-t5b.example.org';

interface Person {
  key: string;
  memberId: string;
  userId: string;
  payload: CurrentUserPayload;
  wecomUserId: string | null;
}

describe('T5B —— 企业微信通知渠道(Outbox 全链)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: NotificationOutboxService;
  let handlers: NotificationOutboxHandlers;
  let notifications: NotificationService;
  let readService: NotificationReadService;

  const people = new Map<string, Person>();
  let adminPayload: CurrentUserPayload;
  let seq = 0;

  const worker = (): NotificationOutboxWorker => new NotificationOutboxWorker(outbox, handlers);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    outbox = app.get(NotificationOutboxService);
    handlers = app.get(NotificationOutboxHandlers);
    notifications = app.get(NotificationService);
    readService = app.get(NotificationReadService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    people.clear();
    seq = 0;
    await prisma.dictType.create({
      data: {
        code: 'notification_type',
        label: '通知类型',
        items: { create: [{ code: TYPE_CODE, label: 'T5B 测试类型', status: 'ACTIVE' }] },
      },
    });
    const admin = await createTestUser(app, { username: 't5b_admin', role: Role.SUPER_ADMIN });
    adminPayload = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  });

  // ---- fixtures ----

  async function createPerson(key: string, wecomUserId: string | null): Promise<Person> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `T5B${String(seq).padStart(4, '0')}`,
        displayName: key,
        status: 'ACTIVE',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const user = await createTestUser(app, { username: `t5b_${key.toLowerCase()}` });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    if (wecomUserId !== null) {
      await prisma.wecomIdentity.create({
        data: {
          userId: user.id,
          corpId: CORP_ID,
          wecomUserId,
          status: 'active',
          bindingSource: 'me',
        },
      });
    }
    const person: Person = {
      key,
      memberId: member.id,
      userId: user.id,
      payload: {
        id: user.id,
        username: user.username,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
      wecomUserId,
    };
    people.set(key, person);
    return person;
  }

  async function setChannel(
    overrides: Partial<{
      enabled: boolean;
      messageEnabled: boolean;
      corpId: string | null;
      webBaseUrl: string | null;
    }> = {},
  ): Promise<void> {
    const data = {
      providerType: 'DEV_STUB',
      enabled: true,
      loginEnabled: false,
      messageEnabled: true,
      corpId: CORP_ID,
      webBaseUrl: WEB_BASE_URL,
      credentialConfigured: false,
      ...overrides,
    };
    const existing = await prisma.wecomSettings.findFirst({ select: { id: true } });
    if (existing) {
      await prisma.wecomSettings.update({ where: { id: existing.id }, data });
    } else {
      await prisma.wecomSettings.create({ data });
    }
  }

  async function publishBroadcast(
    channels: string[] = [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
    overrides: Partial<{ title: string; body: string }> = {},
  ): Promise<Notification> {
    const row = await prisma.notification.create({
      data: {
        title: overrides.title ?? 'T5B 演练通知',
        body: overrides.body ?? '周六 09:00 集合。',
        notificationTypeCode: TYPE_CODE,
        statusCode: NOTIFICATION_STATUS_DRAFT,
        visibilityCode: NOTIFICATION_VISIBILITY_MEMBER,
        audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
        sourceType: NOTIFICATION_SOURCE_ADMIN,
        channels,
        authorUserId: adminPayload.id,
      },
    });
    await notifications.publish(row.id, adminPayload, AUDIT_META);
    return prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
  }

  const wecomIntents = (eventType: string) =>
    prisma.notificationOutboxIntent.findMany({
      where: { eventType },
      orderBy: { eventKey: 'asc' },
    });

  const wecomDeliveries = () =>
    prisma.notificationDelivery.findMany({
      where: { channel: NOTIFICATION_CHANNEL_WECOM },
      orderBy: { createdAt: 'asc' },
    });

  /**
   * **只**展开 root,不碰它刚生出来的 child。
   *
   * ⚠️ 不能用 `drainOnce()` 干这件事:它一轮最多领 20 条,root 展开出 child 之后
   * 同一轮的下一次 claim 就会把 child 一起领走并直接投递 —— 于是"root 之后、child 之前
   * 改变状态"这个窗口在测试里根本不存在,后续断言全部落空(本 spec 初版实测:
   * 5 条用例集体误绿/误红)。`drainEventKey` 按 eventKey 精确领一条,窗口才留得住。
   */
  async function expandRootOnly(notification: Notification): Promise<void> {
    await worker().drainEventKey(
      `wecom-broadcast:${notification.id}:${notification.publishGeneration}`,
    );
  }

  /** 反复 drain 直到没有可领的 intent(root 展开 child 后 child 还要再跑一轮)。 */
  async function drainAll(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      const result = await worker().drainOnce();
      if (result.claimed === 0) break;
    }
  }

  // ==========================================================================
  // ① 默认关(D-WC-24)—— 第一层闸
  // ==========================================================================

  describe('默认关:messageEnabled=false 全链拒', () => {
    it('settings 完全未配置 → publish 勾了 wecom 也不产生任何 wecom intent', async () => {
      await createPerson('bound', 'zhangsan');
      await publishBroadcast();

      expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
      expect(await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY)).toHaveLength(0);
    });

    it('总闸开、二级闸 messageEnabled=false → 仍然零 wecom intent', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel({ enabled: true, messageEnabled: false });
      await publishBroadcast();

      expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
    });

    it('二级闸开、总闸 enabled=false → 仍然零 wecom intent', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel({ enabled: false, messageEnabled: true });
      await publishBroadcast();

      expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
    });

    it('corpId 缺失 → 零 wecom intent(身份键的一半缺了就不该发)', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel({ corpId: null });
      await publishBroadcast();

      expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
    });

    // red-first 的正向对照:**只有**两个开关都开,root 才出现。
    // 把上面任一条的开关翻回 true,这条与那条必有一条红 —— 两层判据各自可证伪。
    it('两个开关都开 → root intent 出现,且是 v2 带 generation', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();

      const roots = await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({
        payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
        eventKey: `wecom-broadcast:${notification.id}:${notification.publishGeneration}`,
        aggregateId: notification.id,
        destinationType: 'broadcast',
      });
    });

    it('channels 不含 wecom → 即使通道全开也不产生 wecom intent', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel();
      await publishBroadcast([NOTIFICATION_CHANNEL_IN_APP]);

      expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
    });
  });

  // ==========================================================================
  // ② 第二层闸:Provider 前 settings 锁后复判
  // ==========================================================================

  describe('第二层闸:root 之后关掉开关', () => {
    it('root 已入队后关掉 messageEnabled → child 终态 skipped/channel-disabled,不迟到补发', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();

      // root 展开出 child(此时通道还开着),但**不投递** —— 窗口就在这两步之间。
      await expandRootOnly(notification);
      const children = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(children).toHaveLength(1);

      // 运维在 child 投递前关掉二级闸。
      await setChannel({ messageEnabled: false });
      await drainAll();

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        memberId: bound.memberId,
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_CHANNEL_DISABLED,
        providerMsgId: null,
      });
      // 终态:intent 不再 pending,**不会等开关恢复后补发**。
      const [child] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(child.status).not.toBe('pending');
    });

    // §14.3 #15:identity 在 child 创建后被清除 → 最终闸记 skipped/no-wecom-identity。
    it('child 创建后撤销身份 → skipped/no-wecom-identity', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();
      await expandRootOnly(notification);
      expect(await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY)).toHaveLength(1);

      await prisma.wecomIdentity.updateMany({
        where: { userId: bound.userId },
        data: { status: 'revoked', revokedAt: new Date() },
      });
      await drainAll();

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_WECOM_IDENTITY,
      });
    });

    // 资格失效 ≠ 无身份:前者**不落 delivery**(§10.4 步骤 9 第 1 条)。
    it('child 创建后队员离队 → 不发、不落 delivery(effectPerformed=false)', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();
      await expandRootOnly(notification);

      await prisma.member.update({ where: { id: bound.memberId }, data: { status: 'INACTIVE' } });
      await drainAll();

      expect(await wecomDeliveries()).toHaveLength(0);
    });

    it('child 创建后通知被撤回 → 不发、不落 delivery', async () => {
      await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();
      await expandRootOnly(notification);

      await notifications.unpublish(notification.id, adminPayload, AUDIT_META);
      await drainAll();

      expect(await wecomDeliveries()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // ③ 受众:两阶段裁决的第一阶段(§10.4)
  // ==========================================================================

  describe('广播受众', () => {
    it('只为 active WecomIdentity 建 child;未绑定者不进 fan-out', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await createPerson('unbound', null);
      await setChannel();
      const notification = await publishBroadcast();
      await expandRootOnly(notification);

      const children = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(children).toHaveLength(1);
      expect(children[0].destinationRef).toBe(bound.memberId);
    });

    it('未绑定者仍能在 App feed 读到同一条通知(站内可见性不受影响)', async () => {
      await createPerson('bound', 'zhangsan');
      const unbound = await createPerson('unbound', null);
      await setChannel();
      const notification = await publishBroadcast();
      await drainAll();

      const feed = await readService.appList(unbound.payload, { page: 1, pageSize: 20 });
      expect(feed.items.map((item) => item.id)).toContain(notification.id);
    });

    it('root 返回运营指标:可见受众数与 active identity 候选数分开记录', async () => {
      await createPerson('bound1', 'zhangsan');
      await createPerson('bound2', 'lisi');
      await createPerson('unbound', null);
      await setChannel();
      await publishBroadcast();

      const [root] = await outbox.claim('t5b-metrics', { limit: 1 });
      const result = await handlers.execute(root, { beforeEffect: async () => undefined });

      expect(result.effectPerformed).toBe(false);
      expect(result.value).toMatchObject({
        visibleAudience: 3,
        identityCandidates: 2,
        alreadySent: 0,
        expanded: 2,
      });
    });

    // §10.3 :1127 —— 本刀 migration 的存在理由。
    it('微信小程序与企业微信同一通知同一人可以并行,各自独立 active slot', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast([
        NOTIFICATION_CHANNEL_IN_APP,
        NOTIFICATION_CHANNEL_WECOM,
      ]);
      // 只展开 root:child 必须停在 pending,否则它一投递就转 terminal,
      // "两个渠道同时各有一条 active" 这件事就没机会被观测到。
      await expandRootOnly(notification);

      const [wecomChild] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(wecomChild).toBeDefined();

      // 同 (notification, member) 再插一条微信 child —— 必须放行。
      await expect(
        prisma.notificationOutboxIntent.create({
          data: {
            eventKey: `wechat-delivery:${notification.id}:${bound.memberId}`,
            eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
            payloadVersion: 1,
            payload: { notificationId: notification.id, memberId: bound.memberId },
            aggregateType: 'notification',
            aggregateId: notification.id,
            destinationType: 'member',
            destinationRef: bound.memberId,
            status: 'pending',
          },
        }),
      ).resolves.toBeDefined();
    });

    // §14.3 #6 / :1620 —— red-first:去掉 partial unique 本条即绿(变成 2 条 active)。
    it('并发双 child:同一 (notification, member) 任一时刻只一条 active', async () => {
      const bound = await createPerson('bound', 'zhangsan');
      await setChannel();
      const notification = await publishBroadcast();
      await expandRootOnly(notification);

      const activeBefore = await prisma.notificationOutboxIntent.count({
        where: {
          eventType: OUTBOX_EVENT_WECOM_DELIVERY,
          aggregateId: notification.id,
          destinationRef: bound.memberId,
          status: { in: ['pending', 'processing'] },
        },
      });
      expect(activeBefore).toBe(1);

      // 第二个 generation 的 root 想为同一人再建一条 active child → 被 active-slot 挡下。
      await expect(
        outbox.enqueueWecomDeliveryAttempt({
          eventKey: `wecom-delivery:${notification.id}:cm0000000000000000000000x:${bound.memberId}`,
          eventType: OUTBOX_EVENT_WECOM_DELIVERY,
          payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
          payload: {
            notificationId: notification.id,
            memberId: bound.memberId,
            publishGeneration: notification.publishGeneration + 1,
          },
          aggregateType: 'notification',
          aggregateId: notification.id,
          destinationType: 'member',
          destinationRef: bound.memberId,
        }),
      ).rejects.toThrow();

      const activeAfter = await prisma.notificationOutboxIntent.count({
        where: {
          eventType: OUTBOX_EVENT_WECOM_DELIVERY,
          aggregateId: notification.id,
          destinationRef: bound.memberId,
          status: { in: ['pending', 'processing'] },
        },
      });
      expect(activeAfter).toBe(1);
    });
  });

  // ==========================================================================
  // ④ 回执分类(§10.7)—— 全部走 DEV_STUB 注入,不实连企业微信
  // ==========================================================================

  describe('回执分类', () => {
    async function runSingleRecipient(wecomUserId: string): Promise<void> {
      await createPerson('target', wecomUserId);
      await setChannel();
      await publishBroadcast();
      await drainAll();
    }

    it('正常回执 → SENT,recipientRef 是掩码 wecomUserId,带 msgid', async () => {
      await runSingleRecipient('zhangsan-wecom-userid');

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_SENT,
        reasonCode: null,
      });
      expect(deliveries[0].providerMsgId).not.toBeNull();
      expect(deliveries[0].attemptedAt).not.toBeNull();
      // 掩码:既不是明文,也不能泄露中段。
      expect(deliveries[0].recipientRef).not.toBe('zhangsan-wecom-userid');
      expect(deliveries[0].recipientRef).toContain('****');
    });

    // §10.4 业务结果第 4 条:errcode=0 仍须查 invaliduser —— 绝不误记 SENT。
    it('errcode=0 但落在 invaliduser → skipped/recipient-unavailable,**不是** SENT', async () => {
      await runSingleRecipient('wecomerr-invaliduser-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
      });
      expect(deliveries[0].status).not.toBe(DELIVERY_STATUS_SENT);
    });

    it('errcode=0 但落在 unlicenseduser → skipped/recipient-unlicensed', async () => {
      await runSingleRecipient('wecomerr-unlicensed-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_RECIPIENT_UNLICENSED,
      });
    });

    it('81013 全无效 → skipped/recipient-unavailable,不得记 SENT', async () => {
      await runSingleRecipient('wecomerr-81013-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
      });
    });

    it('45009 限流 → failed/rate-limited 且 intent 终态 dead(等人工 replay,不盲重试)', async () => {
      await runSingleRecipient('wecomerr-ratelimit-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_FAILED,
        reasonCode: DELIVERY_REASON_RATE_LIMITED,
        errCode: '45009',
      });
      const [child] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(child.status).toBe(OUTBOX_STATUS_DEAD);
      // 只尝试过一次 —— 没有盲重试把官方拦截窗口拉长。
      expect(child.attempts).toBe(1);
    });

    it('单 touser 却收到 invalidparty → failed/provider-contract-error + dead(不得忽略)', async () => {
      await runSingleRecipient('wecomerr-party-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_FAILED,
        reasonCode: DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
      });
      const [child] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(child.status).toBe(OUTBOX_STATUS_DEAD);
    });

    // 暂态失败**不占 intent.id**,否则重试会被自己的幂等判据短路。
    it('网络类失败 → 记暂态流水并退避重试,intent 回 pending 而不是 succeeded', async () => {
      await runSingleRecipient('wecomerr-net-001');

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: DELIVERY_STATUS_FAILED,
        reasonCode: DELIVERY_REASON_API_FAILED,
      });
      const [child] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);
      expect(child.status).toBe('pending');
      expect(child.attempts).toBe(1);
      // 关键:暂态流水没有占用 intent.id,重领时不会被"本 intent 已记账"短路。
      expect(deliveries[0].id).not.toBe(child.id);
    });

    it('SENT 之后重放同一 root:不重复发送(SENT 是跨 generation 的永久去重事实)', async () => {
      await runSingleRecipient('zhangsan-wecom-userid');
      expect(await wecomDeliveries()).toHaveLength(1);

      // 再发布一次(新 generation)。
      const [notification] = await prisma.notification.findMany({ take: 1 });
      await notifications.unpublish(notification.id, adminPayload, AUDIT_META);
      await notifications.publish(notification.id, adminPayload, AUDIT_META);
      await drainAll();

      const sent = (await wecomDeliveries()).filter((d) => d.status === DELIVERY_STATUS_SENT);
      expect(sent).toHaveLength(1);
    });
  });

  // ==========================================================================
  // ⑤ 敏感值三件套(D-WC-18 / §5.5)
  // ==========================================================================

  describe('敏感值:payload / 日志 / Audit 三件套', () => {
    const SECRET_USER_ID = 'zhangsan-secret-wecom-userid';

    async function runFullChain(): Promise<Person> {
      const bound = await createPerson('bound', SECRET_USER_ID);
      await setChannel();
      await publishBroadcast();
      await drainAll();
      return bound;
    }

    // ① 查库对拍:payload 的键集合**恰好**是内部引用三件套。
    it('outbox payload 只含 notificationId / memberId / publishGeneration', async () => {
      const bound = await runFullChain();
      const [child] = await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY);

      expect(Object.keys(child.payload as Record<string, unknown>).sort()).toEqual([
        'memberId',
        'notificationId',
        'publishGeneration',
      ]);
      expect((child.payload as Record<string, unknown>).memberId).toBe(bound.memberId);
    });

    // ② stringify-not-contain:把整条链上会持久化的东西全序列化,逐个断言不含明文。
    it('intents / deliveries / notifications 全表序列化后都不含明文 wecomUserId 与 corpId', async () => {
      await runFullChain();

      const dump = JSON.stringify({
        intents: await prisma.notificationOutboxIntent.findMany(),
        deliveries: await prisma.notificationDelivery.findMany(),
        notifications: await prisma.notification.findMany(),
      });

      expect(dump).not.toContain(SECRET_USER_ID);
      expect(dump).not.toContain(CORP_ID);
      // 深链、access_token、DevStub token 一律不入库。
      expect(dump).not.toContain(WEB_BASE_URL);
      expect(dump).not.toContain('dev-stub-wecom-access-token');
    });

    // ③ audit 缺席:企业微信投递不写 audit(运营触达,不是治理事件)。
    it('audit_logs 里没有企业微信投递事件,也不含明文 wecomUserId', async () => {
      await runFullChain();

      const auditDump = JSON.stringify(await prisma.auditLog.findMany());
      expect(auditDump).not.toContain(SECRET_USER_ID);
      expect(auditDump).not.toContain(CORP_ID);
      expect(auditDump).not.toContain('wecom-delivery');
      expect(auditDump).not.toContain('wecom-broadcast');

      // 只有 publish 伞事件,且它是 T5B 之前就有的行为(不因新渠道多写一条)。
      const events = (await prisma.auditLog.findMany({ select: { event: true } })).map(
        (row) => row.event,
      );
      expect(new Set(events)).toEqual(new Set(['notification.publish']));
    });

    // recipientRef 只存掩码(§10.7 第 1 条)。
    it('NotificationDelivery.recipientRef 只存掩码 wecomUserId', async () => {
      await runFullChain();

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].recipientRef).toBe('zhan****erid');
    });
  });

  // ==========================================================================
  // ⑥ 微信小程序 / 短信零变化(DoD 5)
  // ==========================================================================

  it('不勾 wecom 的通知:整条链与 T5B 之前完全一致(零 wecom intent / 零 wecom delivery)', async () => {
    await createPerson('bound', 'zhangsan');
    await setChannel();
    await publishBroadcast([NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT]);
    await drainAll();

    expect(await wecomIntents(OUTBOX_EVENT_WECOM_BROADCAST)).toHaveLength(0);
    expect(await wecomIntents(OUTBOX_EVENT_WECOM_DELIVERY)).toHaveLength(0);
    expect(await wecomDeliveries()).toHaveLength(0);
  });
});

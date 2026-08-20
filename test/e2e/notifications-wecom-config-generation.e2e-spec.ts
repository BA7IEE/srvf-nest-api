import type { INestApplication } from '@nestjs/common';
import { type Notification, Role, UserStatus } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import {
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECOM,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_VISIBILITY_MEMBER,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_STATUS_DEAD,
  OUTBOX_STATUS_PENDING,
} from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { NotificationWecomDispatchService } from '../../src/modules/notifications/notification-wecom-dispatch.service';
import { WecomMessagePresenter } from '../../src/modules/notifications/notification-wecom.presenter';
import { WecomCryptoService } from '../../src/modules/wecom/wecom-crypto.service';
import { WecomService } from '../../src/modules/wecom/wecom.service';
import { WecomSettingsService } from '../../src/modules/wecom/wecom-settings.service';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ============================================================================
// 外部评审 F2 第二刀(2026-08-03)—— B5 同代配置 / B7 类型化错误 / SF1 严格回执
// ============================================================================
//
// 与既有 `notifications-wecom.e2e-spec.ts` 的分工:那一份走 **DEV_STUB**,靠 `wecomerr-*`
// 前缀注入**投递语义**;这一份走 **真实 Provider + mock 上游 HTTP**,因为本刀要钉的三件事
// 都只在真实传输层可见:
//   - 消息到底发给了**哪个 CorpID**(DEV_STUB 根本不认识 corpId,观测不到)
//   - **gettoken 阶段**的 errcode 与 HTTP 状态码怎么归类(stub 只能注入 send 阶段)
//   - 上游回执**字段类型非法**时的解析行为(stub 直接给归一化结果,绕过了 parser)
//
// 全部用例 red-first:先在未修代码上跑红,再修。

const TYPE_CODE = 'f2-wecom-config-generation';
const AUDIT_META = { requestId: 'f2-e2e', ip: '127.0.0.1', ua: 'jest' };
const WEB_BASE_URL = 'https://srvf-f2.example.org';
const AGENT_ID = 1000009;
const ALPHA_USER_ID = 'wecom-user-alpha-0001';

interface UpstreamStub {
  /** gettoken 的回执(或 HTTP 状态)。 */
  token?: { body: unknown; status?: number };
  /** message/send 的回执(或 HTTP 状态)。 */
  send?: { body: unknown; status?: number };
}

describe('F2 —— 企业微信消息链的同代配置 / 类型化错误 / 严格回执', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: NotificationOutboxService;
  let handlers: NotificationOutboxHandlers;
  let notifications: NotificationService;
  let wecom: WecomService;
  let wecomSettings: WecomSettingsService;
  let presenter: WecomMessagePresenter;
  let crypto: WecomCryptoService;

  let adminPayload: CurrentUserPayload;
  let fetchSpy: jest.SpyInstance;
  let requestedUrls: string[];
  let sentBodies: string[];
  let corpSeq = 0;
  let currentCorpId = '';

  const worker = (): NotificationOutboxWorker => new NotificationOutboxWorker(outbox, handlers);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    outbox = app.get(NotificationOutboxService);
    handlers = app.get(NotificationOutboxHandlers);
    notifications = app.get(NotificationService);
    wecom = app.get(WecomService);
    wecomSettings = app.get(WecomSettingsService);
    presenter = app.get(WecomMessagePresenter);
    crypto = app.get(WecomCryptoService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    requestedUrls = [];
    sentBodies = [];
    // 每条用例一个独立 CorpID:token cache 是**模块级** Map(键含 corpId 与 generation),
    // 复用 CorpID 会让上一条用例缓存的 token 命中本条,gettoken 断言就静默失效了。
    corpSeq += 1;
    currentCorpId = `ww-f2-corp-${String(corpSeq).padStart(4, '0')}`;

    await prisma.dictType.create({
      data: {
        code: 'notification_type',
        label: '通知类型',
        items: { create: [{ code: TYPE_CODE, label: 'F2 测试类型', status: 'ACTIVE' }] },
      },
    });
    const admin = await createTestUser(app, { username: 'f2_admin', role: Role.SUPER_ADMIN });
    adminPayload = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fetchSpy?.mockRestore();
  });

  // ---- fixtures ----

  /** 真实 Provider 需要 providerType=WECOM + 可解密凭证。 */
  async function configureRealChannel(corpId: string = currentCorpId): Promise<void> {
    const data = {
      providerType: 'WECOM',
      enabled: true,
      loginEnabled: false,
      messageEnabled: true,
      corpId,
      agentId: AGENT_ID,
      webBaseUrl: WEB_BASE_URL,
      corpSecretEncrypted: crypto.encrypt(`secret-${corpId}`),
      credentialConfigured: true,
    };
    const existing = await prisma.wecomSettings.findFirst({ select: { id: true } });
    if (existing) {
      await prisma.wecomSettings.update({ where: { id: existing.id }, data });
    } else {
      await prisma.wecomSettings.create({ data });
    }
  }

  async function createBoundPerson(
    wecomUserId: string,
    corpId: string = currentCorpId,
  ): Promise<{ memberId: string; userId: string }> {
    const member = await prisma.member.create({
      data: {
        memberNo: `F2${String(corpSeq).padStart(4, '0')}`,
        ...memberIdentityData('F2 队员'),
        status: 'ACTIVE',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const user = await createTestUser(app, { username: `f2_member_${corpSeq}` });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.wecomIdentity.create({
      data: { userId: user.id, corpId, wecomUserId, status: 'active', bindingSource: 'me' },
    });
    return { memberId: member.id, userId: user.id };
  }

  async function publishBroadcast(): Promise<Notification> {
    const row = await prisma.notification.create({
      data: {
        title: 'F2 演练通知',
        body: '周六 09:00 集合。',
        notificationTypeCode: TYPE_CODE,
        statusCode: NOTIFICATION_STATUS_DRAFT,
        visibilityCode: NOTIFICATION_VISIBILITY_MEMBER,
        audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
        sourceType: NOTIFICATION_SOURCE_ADMIN,
        channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
        authorUserId: adminPayload.id,
      },
    });
    await notifications.publish(row.id, adminPayload, AUDIT_META);
    return prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
  }

  /** 按 URL 分派上游回执;同时记录每一次真实请求的 URL 与 body(判据靠它)。 */
  function mockUpstream(stub: UpstreamStub): void {
    const token = stub.token ?? { body: { errcode: 0, access_token: 'tok', expires_in: 7200 } };
    const send = stub.send ?? { body: { errcode: 0, msgid: 'MSG-1' } };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      // Provider 一律传字符串 URL;`Request` / `URL` 两种形态在这里不会出现,
      // 但仍显式收窄 —— 靠 `String()` 兜底会把 `Request` 变成 `[object Object]`,
      // 于是"发去了哪个 CorpID"这条判据会静默失效。
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      if (url.includes('/message/send')) {
        const body = (init as { body?: unknown } | undefined)?.body;
        sentBodies.push(typeof body === 'string' ? body : '');
        return Promise.resolve(
          new Response(JSON.stringify(send.body), { status: send.status ?? 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(token.body), { status: token.status ?? 200 }),
      );
    });
  }

  async function expandRootOnly(notification: Notification): Promise<void> {
    await worker().drainEventKey(
      `wecom-broadcast:${notification.id}:${notification.publishGeneration}`,
    );
  }

  /** 展开 root,再单独跑那一条 child(留住"root 之后、child 之前"的窗口)。 */
  async function runChild(notification: Notification): Promise<void> {
    await expandRootOnly(notification);
    const child = await prisma.notificationOutboxIntent.findFirstOrThrow({
      where: { eventType: OUTBOX_EVENT_WECOM_DELIVERY },
    });
    await worker().drainEventKey(child.eventKey);
  }

  const childIntent = () =>
    prisma.notificationOutboxIntent.findFirstOrThrow({
      where: { eventType: OUTBOX_EVENT_WECOM_DELIVERY },
    });

  const wecomDeliveries = () =>
    prisma.notificationDelivery.findMany({
      where: { channel: NOTIFICATION_CHANNEL_WECOM },
      orderBy: { createdAt: 'asc' },
    });

  const tokenRequests = () => requestedUrls.filter((url) => url.includes('/gettoken'));
  const sendRequests = () => requestedUrls.filter((url) => url.includes('/message/send'));

  // ==========================================================================
  // B5 —— 同代配置
  // ==========================================================================

  describe('B5 同代配置', () => {
    /**
     * **修复前的交错**(评审 BLOCKER B5):
     *   最终闸在事务内锁读 settings 拿到 CorpID=A,按 A 查出 `wecomUserId`;
     *   事务提交后 `deliverWecom` 又调 `WecomService.resolveRoute()` **重新读一次 settings** ——
     *   这中间运维改了 CorpID,于是 route 绑到 B,**A 企业的 userid 被发去了 B 企业**。
     *
     * 本用例用 `WecomMessagePresenter.present`(闸后、发送前的唯一同步落点)作为触发点,
     * 从那一刻起让 `getActiveSettings` 返回 B。DB 里仍是 A —— 于是最终闸(直读 DB)
     * 与"事后重解析"(走 service)的分歧被精确暴露出来。
     */
    it('闸后换 CorpID:旧 wecomUserId 不得发往新 Corp', async () => {
      const corpA = currentCorpId;
      const corpB = `${currentCorpId}-rotated`;
      await configureRealChannel(corpA);
      await createBoundPerson(ALPHA_USER_ID, corpA);
      mockUpstream({});

      const realGetActiveSettings = wecomSettings.getActiveSettings.bind(wecomSettings);
      let rotated = false;
      jest.spyOn(wecomSettings, 'getActiveSettings').mockImplementation(async () => {
        const resolved = await realGetActiveSettings();
        if (!rotated || resolved === null) return resolved;
        // 运维在"闸已过、消息还没发出去"的这一刻把 CorpID 换了
        return { ...resolved, corpId: corpB, configurationGeneration: `${corpA}-gen-b` };
      });
      const realPresent = presenter.present.bind(presenter);
      jest.spyOn(presenter, 'present').mockImplementation((...args) => {
        rotated = true;
        return realPresent(...args);
      });

      const notification = await publishBroadcast();
      await runChild(notification);

      // 判据:换 CorpID 之后仍然只用**闸所依据的那个** CorpID 换 token 并发送。
      expect(tokenRequests()).toHaveLength(1);
      expect(tokenRequests()[0]).toContain(`corpid=${corpA}`);
      expect(tokenRequests()[0]).not.toContain(corpB);
      expect(sendRequests()).toHaveLength(1);
      expect(JSON.parse(sentBodies[0]) as { touser: string }).toMatchObject({
        touser: ALPHA_USER_ID,
      });
    });

    // "提交后只能使用此前那个 Provider,禁止再解析最新 route"的执行位判据。
    it('投递链路全程不再调用 resolveRoute(它读的是"最新"配置,不是本次那一代)', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({});
      const resolveRouteSpy = jest.spyOn(wecom, 'resolveRoute');

      const notification = await publishBroadcast();
      await runChild(notification);

      expect(resolveRouteSpy).not.toHaveBeenCalled();
      expect(sendRequests()).toHaveLength(1);
    });

    /**
     * 快照取到之后、最终闸锁读之前配置就变了 —— 锁后复读必须发现代际不一致并中止。
     *
     * 触发点必须精确落在这个窗口里,所以钩在 `authorizeDurableRecipient` 的**入口**:
     * 那一刻事务只持有 Notification / outbox intent 的锁,还没碰 `wecom_settings`,
     * 外部连接改配置不会自锁死。(换成"child 跑之前改"是**另一回事** —— 那时整条投递
     * 都还没开工,用新一代配置走完全程本来就是对的,本用例初版就写错在这里。)
     *
     * 身份在**两个 CorpID 下都存在**是刻意的:否则"新 CorpID 下查不到身份"这条既有分支
     * 会先把用例接管走,代际校验有没有生效就看不出来了。
     */
    it('快照取到之后换 CorpID:代际不一致 ⇒ 一条消息都不发,intent 留待重试', async () => {
      const corpA = currentCorpId;
      const corpB = `${currentCorpId}-rotated`;
      await configureRealChannel(corpA);
      const person = await createBoundPerson(ALPHA_USER_ID, corpA);
      await prisma.wecomIdentity.create({
        data: {
          userId: person.userId,
          corpId: corpB,
          wecomUserId: 'wecom-user-beta-0001',
          status: 'active',
          bindingSource: 'me',
        },
      });
      mockUpstream({});

      const dispatch = app.get(NotificationWecomDispatchService);
      const realAuthorize = dispatch.authorizeDurableRecipient.bind(dispatch);
      let rotated = false;
      jest
        .spyOn(dispatch, 'authorizeDurableRecipient')
        .mockImplementation(async (...args: Parameters<typeof realAuthorize>) => {
          if (!rotated) {
            rotated = true;
            await configureRealChannel(corpB);
          }
          return realAuthorize(...args);
        });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect(rotated).toBe(true);
      expect(sendRequests()).toHaveLength(0);
      expect(await wecomDeliveries()).toHaveLength(0);
      expect((await childIntent()).status).toBe(OUTBOX_STATUS_PENDING);
    });

    it('反向:配置没变 ⇒ 正常 SENT(代际校验不误杀)', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({});

      const notification = await publishBroadcast();
      await runChild(notification);

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe(DELIVERY_STATUS_SENT);
    });
  });

  // ==========================================================================
  // B7 —— 类型化错误不被擦除
  // ==========================================================================

  describe('B7 错误类型不被擦除', () => {
    /**
     * **修复前**:`deliverWecom` 的 catch 把 `send()` 抛出的**任何**错误一律压成
     * `TOKEN_FAILED` 暂态 —— 于是 gettoken 阶段的 45009 被当成"取 token 失败",
     * 退避重试 8 次才 dead。而 45009 的语义恰恰是"再打就延长拦截"。
     */
    it('gettoken 阶段 45009 ⇒ intent 终态 dead(不是暂态退避)', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ token: { body: { errcode: 45009, errmsg: 'api freq out of limit' } } });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect((await childIntent()).status).toBe(OUTBOX_STATUS_DEAD);
      expect(sendRequests()).toHaveLength(0);
    });

    it('gettoken 阶段 HTTP 4xx ⇒ 同样终态,不退避', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ token: { body: { errcode: 0 }, status: 400 } });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect((await childIntent()).status).not.toBe(OUTBOX_STATUS_PENDING);
      expect(sendRequests()).toHaveLength(0);
    });

    it('gettoken 阶段配置终态错(40001 Secret 错)⇒ 不退避', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ token: { body: { errcode: 40001, errmsg: 'invalid credential' } } });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect((await childIntent()).status).not.toBe(OUTBOX_STATUS_PENDING);
    });

    // 反向锁:真正的暂态必须**仍然**退避,否则上面几条就成了"一刀切改成终态"。
    it('反向:gettoken 阶段 HTTP 5xx ⇒ 仍然暂态退避,intent 回 pending', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ token: { body: { errcode: 0 }, status: 503 } });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect((await childIntent()).status).toBe(OUTBOX_STATUS_PENDING);
    });

    it('反向:message/send 阶段 HTTP 5xx ⇒ 仍然暂态退避', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ send: { body: { errcode: 0 }, status: 502 } });

      const notification = await publishBroadcast();
      await runChild(notification);

      expect((await childIntent()).status).toBe(OUTBOX_STATUS_PENDING);
    });
  });

  // ==========================================================================
  // SF1 —— 严格回执解析
  // ==========================================================================

  describe('SF1 严格回执解析', () => {
    // DoD 判据逐字:`{errcode:0, invaliduser:123}` **不得**记 SENT。
    it('{errcode:0, invaliduser:123} ⇒ 不得记 SENT', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ send: { body: { errcode: 0, msgid: 'MSG-1', invaliduser: 123 } } });

      const notification = await publishBroadcast();
      await runChild(notification);

      const deliveries = await wecomDeliveries();
      expect(deliveries.map((row) => row.status)).not.toContain(DELIVERY_STATUS_SENT);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe(DELIVERY_STATUS_FAILED);
    });

    it('{errcode:0, unlicenseduser:null} ⇒ 同样不得记 SENT', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({ send: { body: { errcode: 0, msgid: 'MSG-1', unlicenseduser: null } } });

      const notification = await publishBroadcast();
      await runChild(notification);

      const deliveries = await wecomDeliveries();
      expect(deliveries.map((row) => row.status)).not.toContain(DELIVERY_STATUS_SENT);
    });

    it('反向:名单字段是合法空串 ⇒ 正常 SENT', async () => {
      await configureRealChannel();
      await createBoundPerson(ALPHA_USER_ID);
      mockUpstream({
        send: { body: { errcode: 0, msgid: 'MSG-1', invaliduser: '', unlicenseduser: '' } },
      });

      const notification = await publishBroadcast();
      await runChild(notification);

      const deliveries = await wecomDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe(DELIVERY_STATUS_SENT);
    });
  });
});

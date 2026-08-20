import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  DELIVERY_REASON_CHANNEL_DISABLED,
  DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_REASON_RECIPIENT_UNLICENSED,
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
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ============================================================================
// T6-1 —— 定向通知 replay 的**运维入口**(第二轮外部评审 SHOULD-FIX 3 的收口)
// ============================================================================
//
// F3 第三刀(#901)把「只放行 rate-limited / provider-contract-error」做成了代码判据,
// 但那仍然只是**服务层原语**:没有入口、没有 RBAC、没有 Audit,runbook §6.2 只能写
// 「需维护者在应用上下文中调用」—— 对本项目维护者而言那不是可执行路径。
//
// 本 spec 钉的是端点层的三件事,**以及端点层没有做的那件事**:
//   1. 判权(新码 `notification.replay.wecom`,R 模式 service 层 rbac.can);
//   2. 结局闭集出参(把原语的判别联合摊平成一个 outcome 闭集);
//   3. 审计(复用 `notification.publish` 伞事件 + `extra.operation='replay-wecom'`,
//      `overrideReason` 单独成字段 ⇒ 「谁绕过了允许集」可按 extra 直接查出来);
//   4. **端点层零第二份判据** —— 允许集与三条护栏全部由原语裁决。本 spec 因此
//      逐条复跑 `notifications-wecom-directed-replay.e2e-spec.ts` 的判据形状,
//      但**走 HTTP**:两处读数必须一致,否则就说明端点层长出了第二把尺子。
//
// 判据形状(允许集内/外、never-attempted、已 SENT、在途 attempt)沿用直调 spec 的
// 同一套 DEV_STUB 故障注入,保证两边测的是同一件事。

const ADMIN = '/api/admin/v1/notifications';

const TYPE_CODE = 't61-wecom-replay-admin';
const CORP_ID = 'ww-t61-replay-0001';
const WEB_BASE_URL = 'https://srvf-t61-replay.example.org';
// DEV_STUB 按 toUser 前缀注入故障:这个 id 会让 message/send 返 45009 ⇒ 终态 dead(允许集内)。
const RATE_LIMITED_USER_ID = 'wecomerr-ratelimit-t61-0001';
const HEALTHY_USER_ID = 'wecom-user-t61-healthy';
const PROVIDER_CONTRACT_USER_ID = 'wecomerr-party-t61-0001';
const UNLICENSED_USER_ID = 'wecomerr-unlicensed-t61-0001';

const REPLAY_PERMISSION = {
  code: 'notification.replay.wecom',
  module: 'notification',
  action: 'replay',
  resourceType: 'wecom',
} as const;

interface ReplayItem {
  memberId: string | null;
  outcome: string;
  newIntentId?: string;
  newEventKey?: string;
}
interface ReplayBody {
  replayed: number;
  skipped: number;
  results: ReplayItem[];
}

describe('T6-1 定向通知 replay 运维入口 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: NotificationOutboxService;
  let handlers: NotificationOutboxHandlers;

  let memberId: string;
  let userId: string;
  let adminAuth: string;
  let plainAuth: string;

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

  // 新码归 ops-admin(运维面,沿 wecom-setting.* 同族),**不**绑 biz-admin。
  async function seedReplayPermissionToOpsAdmin(): Promise<string> {
    const permission = await prisma.permission.upsert({
      where: { code: REPLAY_PERMISSION.code },
      update: {},
      create: { ...REPLAY_PERMISSION },
      select: { id: true },
    });
    const role = await prisma.rbacRole.upsert({
      where: { code: 'ops-admin' },
      update: {},
      create: { code: 'ops-admin', displayName: '运营管理员' },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: [{ roleId: role.id, permissionId: permission.id }],
      skipDuplicates: true,
    });
    return role.id;
  }

  beforeEach(async () => {
    await resetDb(app);
    await prisma.dictType.create({
      data: {
        code: 'notification_type',
        label: '通知类型',
        items: { create: [{ code: TYPE_CODE, label: 'T6-1 定向 replay', status: 'ACTIVE' }] },
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
        memberNo: 'T61RPL01',
        ...memberIdentityData('T6-1 定向队员'),
        status: 'ACTIVE',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    memberId = member.id;
    const recipient = await createTestUser(app, { username: 't61_replay_member' });
    userId = recipient.id;
    await prisma.user.update({ where: { id: recipient.id }, data: { memberId: member.id } });
    await prisma.wecomIdentity.create({
      data: {
        userId: recipient.id,
        corpId: CORP_ID,
        wecomUserId: RATE_LIMITED_USER_ID,
        status: 'active',
        bindingSource: 'me',
      },
    });

    const opsAdminRoleId = await seedReplayPermissionToOpsAdmin();
    const adminUser = await createTestUser(app, { username: 't61_replay_admin', role: Role.ADMIN });
    await grantOpsAdminToUser(app, adminUser.id, opsAdminRoleId);
    adminAuth = (await loginAs(app, 't61_replay_admin')).authHeader;

    await createTestUser(app, { username: 't61_plain_user', role: Role.USER });
    plainAuth = (await loginAs(app, 't61_plain_user')).authHeader;
  });

  // ---------------------------------------------------------------- helpers

  function replay(auth: string, id: string, body: Record<string, unknown> = {}): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN}/${id}/replay-wecom`)
      .set('Authorization', auth)
      .send(body);
  }

  async function replayOk(id: string, body: Record<string, unknown> = {}): Promise<ReplayBody> {
    const res = await replay(adminAuth, id, body);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    return res.body.data as ReplayBody;
  }

  /** producer 在业务事务内 enqueue 的那条 `notification.targeted@1`。 */
  async function enqueueDirected(): Promise<string> {
    const intent = await outbox.enqueue({
      eventKey: `t61-directed:${memberId}`,
      eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
      payloadVersion: OUTBOX_PAYLOAD_VERSION,
      payload: {
        recipientMemberId: memberId,
        notificationTypeCode: TYPE_CODE,
        title: 'T6-1 定向通知',
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

  async function setIdentity(wecomUserId: string): Promise<void> {
    await prisma.wecomIdentity.updateMany({ where: { userId }, data: { wecomUserId } });
  }

  /** 让 child 建出来之后再关通道 —— 关在 root 之前的话根本不会有 child。 */
  async function deadEndByChannelDisabled(): Promise<string> {
    const notificationId = await enqueueDirected();
    await worker().drainEventKey(`t61-directed:${memberId}`);
    await prisma.wecomSettings.updateMany({ data: { messageEnabled: false } });
    await drainAll();
    return notificationId;
  }

  async function replayAudits(notificationId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.auditLog.findMany({
      where: { event: 'notification.publish', resourceId: notificationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows
      .map((row) => (row.context as { extra?: Record<string, unknown> })?.extra ?? {})
      .filter((extra) => extra.operation === 'replay-wecom');
  }

  // ================================================================= RBAC

  describe('判权(R 模式:service 层 rbac.can,零 @Roles)', () => {
    it('无 Authorization → 401', async () => {
      const notificationId = await enqueueDirected();
      await drainAll();
      const res = await request(httpServer(app))
        .post(`${ADMIN}/${notificationId}/replay-wecom`)
        .send({});
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('普通 USER(无 notification.replay.wecom)→ 30100,且不建 child、不记 audit', async () => {
      const notificationId = await enqueueDirected();
      await drainAll();
      const before = (await wecomChildren()).length;

      expectBizError(await replay(plainAuth, notificationId), BizCode.RBAC_FORBIDDEN);

      // 判权在**任何** replay 动作与记账之前:被拒的请求既不留 child 也不留 audit。
      expect(await wecomChildren()).toHaveLength(before);
      expect(await replayAudits(notificationId)).toHaveLength(0);
    });
  });

  // ============================================== 允许集内:真的重发一次

  describe('允许集内 ⇒ 真建新 child', () => {
    it('rate-limited dead 之后 replay:新 intentId + 新 eventKey,旧 dead 行保留', async () => {
      const notificationId = await enqueueDirected();
      await drainAll();

      const [deadChild] = await wecomChildren();
      expect(deadChild.status).toBe(OUTBOX_STATUS_DEAD);
      expect(deadChild.eventKey).toBe(`wecom-delivery:${notificationId}:${memberId}`);
      expect((await wecomDeliveries())[0].reasonCode).toBe(DELIVERY_REASON_RATE_LIMITED);

      // 官方拦截窗口过去了 → 运维点重发。
      await setIdentity(HEALTHY_USER_ID);
      const body = await replayOk(notificationId);

      expect(body).toMatchObject({ replayed: 1, skipped: 0 });
      expect(body.results).toHaveLength(1);
      const [item] = body.results;
      expect(item.memberId).toBe(memberId);
      expect(item.outcome).toBe('enqueued');
      expect(item.newEventKey).toBe(`wecom-delivery:${notificationId}:${memberId}:r1`);

      // 出参里的 id/key 必须是**真** child(不是编出来的):库里查得到,且不是旧那条。
      const children = await wecomChildren();
      expect(children).toHaveLength(2);
      const created = children.find((row) => row.id === item.newIntentId);
      expect(created).toBeDefined();
      expect(created?.id).not.toBe(deadChild.id);
      expect(created?.eventKey).toBe(item.newEventKey);
      // 旧 dead 行是历史事实,原样保留。
      expect(children.find((row) => row.id === deadChild.id)?.status).toBe(OUTBOX_STATUS_DEAD);

      // 端点只入队;真正投递仍由 worker 在事务外做。
      await drainAll();
      const sent = (await wecomDeliveries()).filter((row) => row.status === DELIVERY_STATUS_SENT);
      expect(sent).toHaveLength(1);
    });

    it('provider-contract-error 照常放行', async () => {
      await setIdentity(PROVIDER_CONTRACT_USER_ID);
      const notificationId = await enqueueDirected();
      await drainAll();
      expect((await wecomDeliveries())[0].reasonCode).toBe(DELIVERY_REASON_PROVIDER_CONTRACT_ERROR);

      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('enqueued');
      expect(await wecomChildren()).toHaveLength(2);
    });
  });

  // ================================================ 允许集外 / 护栏:拒绝

  describe('拒绝(判据全在原语,端点层零第二份)', () => {
    it('上一次是 channel-disabled ⇒ last-attempt-not-replayable,不建新 child', async () => {
      const notificationId = await deadEndByChannelDisabled();
      expect((await wecomDeliveries())[0].reasonCode).toBe(DELIVERY_REASON_CHANNEL_DISABLED);
      const before = (await wecomChildren()).length;

      const body = await replayOk(notificationId);
      expect(body).toMatchObject({ replayed: 0, skipped: 1 });
      expect(body.results[0].outcome).toBe('last-attempt-not-replayable');
      expect(body.results[0].newIntentId).toBeUndefined();
      expect(await wecomChildren()).toHaveLength(before);
    });

    it('上一次是 recipient-unlicensed ⇒ last-attempt-not-replayable,不建新 child', async () => {
      await setIdentity(UNLICENSED_USER_ID);
      const notificationId = await enqueueDirected();
      await drainAll();
      expect((await wecomDeliveries())[0].reasonCode).toBe(DELIVERY_REASON_RECIPIENT_UNLICENSED);
      const before = (await wecomChildren()).length;

      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('last-attempt-not-replayable');
      expect(await wecomChildren()).toHaveLength(before);
    });

    it('从未 attempt ⇒ never-attempted(replay 不是补发入口,不凭空建 child)', async () => {
      // 形态上完全合格(published / system / directed / 含 wecom / 未 SENT),但没有任何 wecom child。
      const notification = await prisma.notification.create({
        data: {
          title: 'T6-1 从未投递过的定向通知',
          body: '这条通知没有任何 wecom child。',
          notificationTypeCode: TYPE_CODE,
          statusCode: 'published',
          visibilityCode: 'member',
          audienceType: 'directed',
          sourceType: 'system',
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
          recipientMemberId: memberId,
          publishedAt: new Date(),
        },
        select: { id: true },
      });
      expect(await wecomChildren()).toHaveLength(0);

      const body = await replayOk(notification.id);
      expect(body.results[0].outcome).toBe('never-attempted');
      expect(await wecomChildren()).toHaveLength(0);
    });

    it('非系统定向(未勾 wecom 渠道)⇒ not-replayable 形态类拒绝', async () => {
      const notificationId = await enqueueDirected();
      await drainAll();
      const before = (await wecomChildren()).length;
      await prisma.notification.update({
        where: { id: notificationId },
        data: { channels: [NOTIFICATION_CHANNEL_IN_APP] },
      });

      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('channel-not-declared');
      expect(await wecomChildren()).toHaveLength(before);
    });

    it('admin 广播通知(非 system-directed)⇒ not-system-directed;memberId 为 null', async () => {
      const notification = await prisma.notification.create({
        data: {
          title: 'T6-1 admin 广播',
          body: '广播 replay 走 unpublish + publish,不走本端点。',
          notificationTypeCode: TYPE_CODE,
          statusCode: 'published',
          visibilityCode: 'member',
          audienceType: 'broadcast',
          sourceType: 'admin',
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
          publishedAt: new Date(),
        },
        select: { id: true },
      });

      const body = await replayOk(notification.id);
      expect(body.results[0]).toMatchObject({ memberId: null, outcome: 'not-system-directed' });
    });

    it('通知不存在 ⇒ notification-not-found(闭集出参,不是 31001)', async () => {
      const body = await replayOk('no-such-notification-id');
      expect(body).toMatchObject({ replayed: 0, skipped: 1 });
      expect(body.results[0]).toMatchObject({ memberId: null, outcome: 'notification-not-found' });
    });

    it('已 SENT ⇒ already-sent 且不建 child(跨 attempt 永久去重事实)', async () => {
      await setIdentity(HEALTHY_USER_ID);
      const notificationId = await enqueueDirected();
      await drainAll();
      const sent = (await wecomDeliveries()).filter((row) => row.status === DELIVERY_STATUS_SENT);
      expect(sent).toHaveLength(1);
      const before = (await wecomChildren()).length;

      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('already-sent');
      expect(await wecomChildren()).toHaveLength(before);

      // 反向证明这条断言不是空绿:同一入口在**允许集内**的形态下确实会把计数推上去
      // (见「允许集内 ⇒ 真建新 child」),而这里没有 —— 且再 drain 也不会多发一条。
      await drainAll();
      const sentAfter = (await wecomDeliveries()).filter(
        (row) => row.status === DELIVERY_STATUS_SENT,
      );
      expect(sentAfter).toHaveLength(1);
    });

    it('在途 attempt ⇒ active-attempt-exists(active-slot 仍是并发下的唯一真相)', async () => {
      const notificationId = await enqueueDirected();
      // 只跑 targeted intent 那一轮:wecom child 建出来了但还没投递 ⇒ 仍是 active。
      await worker().drainEventKey(`t61-directed:${memberId}`);
      expect((await wecomChildren())[0].status).not.toBe(OUTBOX_STATUS_DEAD);

      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('active-attempt-exists');
      expect(await wecomChildren()).toHaveLength(1);
    });

    it('overrideReason 只绕允许集:已 SENT 依旧拒', async () => {
      await setIdentity(HEALTHY_USER_ID);
      const notificationId = await enqueueDirected();
      await drainAll();
      const before = (await wecomChildren()).length;

      const body = await replayOk(notificationId, { overrideReason: true });
      expect(body.results[0].outcome).toBe('already-sent');
      expect(await wecomChildren()).toHaveLength(before);
    });
  });

  // ============================================== overrideReason 与审计留痕

  describe('overrideReason:放行 + 审计可辨', () => {
    it('默认拒的形态,传 overrideReason=true ⇒ 放行,且 audit 里绕过动作显式可查', async () => {
      const notificationId = await deadEndByChannelDisabled();

      // 先按默认调一次:拒。
      const refused = await replayOk(notificationId);
      expect(refused.results[0].outcome).toBe('last-attempt-not-replayable');

      // 通道重新打开、运维明确知道自己在做什么 ⇒ 显式绕过。
      await prisma.wecomSettings.updateMany({ data: { messageEnabled: true } });
      const allowed = await replayOk(notificationId, { overrideReason: true });
      expect(allowed).toMatchObject({ replayed: 1, skipped: 0 });
      expect(allowed.results[0].outcome).toBe('enqueued');
      expect(await wecomChildren()).toHaveLength(2);

      // 两次都记 audit;越界的那次靠 overrideReason 字段与默认那次分得开
      // (事后要回答的问题是「谁绕过了允许集」,不是「谁调过 replay」)。
      const audits = await replayAudits(notificationId);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        operation: 'replay-wecom',
        overrideReason: false,
        replayed: 0,
        skipped: 1,
        outcomes: { 'last-attempt-not-replayable': 1 },
        newIntentIds: [],
      });
      expect(audits[1]).toMatchObject({
        operation: 'replay-wecom',
        overrideReason: true,
        replayed: 1,
        skipped: 0,
        outcomes: { enqueued: 1 },
        newIntentIds: [allowed.results[0].newIntentId],
      });

      // 越界的那一条能被**单独筛出来**(运维查账的真实动作)。
      expect(audits.filter((extra) => extra.overrideReason === true)).toHaveLength(1);
    });

    it('audit 不带 wecomUserId / 深链 / 凭证(§5.5)', async () => {
      await setIdentity(RATE_LIMITED_USER_ID);
      const notificationId = await enqueueDirected();
      await drainAll();
      await setIdentity(HEALTHY_USER_ID);
      await replayOk(notificationId);

      const rows = await prisma.auditLog.findMany({
        where: { event: 'notification.publish', resourceId: notificationId },
      });
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(RATE_LIMITED_USER_ID);
      expect(serialized).not.toContain(HEALTHY_USER_ID);
      expect(serialized).not.toContain(CORP_ID);
      expect(serialized).not.toContain(WEB_BASE_URL);
    });
  });

  // ================================================================ 入参

  describe('入参', () => {
    it('overrideReason 非布尔 ⇒ 400(不静默当作 false)', async () => {
      const notificationId = await enqueueDirected();
      await drainAll();
      const res = await replay(adminAuth, notificationId, { overrideReason: 'yes' });
      expect(res.status).toBe(400);
      // 400 发生在 service 之前 ⇒ 既不记 audit 也不建 child。
      expect(await replayAudits(notificationId)).toHaveLength(0);
      expect(await wecomChildren()).toHaveLength(1);
    });

    it('空 body ⇒ 等价于 overrideReason=false(默认不绕)', async () => {
      const notificationId = await deadEndByChannelDisabled();
      const body = await replayOk(notificationId);
      expect(body.results[0].outcome).toBe('last-attempt-not-replayable');
      expect((await replayAudits(notificationId))[0]).toMatchObject({ overrideReason: false });
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationDispatcher } from '../../src/modules/notifications/notification-dispatcher';
import { WechatSettingsService } from '../../src/modules/wechat/wechat-settings.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 统一通知 S3:定向派发器(NotificationDispatcher Effect)+ feed 可见性 e2e
// (评审稿 unified-notification-dispatcher-review.md §2.1/§2.2/§3.6 + goal DoD #2/#3)。
//
// 经 app.get(NotificationDispatcher).dispatchTargeted(...) 直驱 Effect(producer 内调,无端点),再以 app feed 端点断言:
// - 建已发布定向行(directed / system / authorUserId=null / published);
// - feed = 广播可见 ∪ 本人定向:收件人 list 含 + detail 200 + unread +1 + markRead;
//   **他人**(另一 member)list 不含 + detail 31001(防枚举);广播仍对所有 member 可见(regression 不回归);
// - 微信(channels 含 wechat):有 quota + 模板 → delivery sent + 原子扣 1;无 quota → skipped no-quota;无模板 → skipped no-template。

const APP_NOTIFS = '/api/app/v1/notifications';
const TMPL_RECRUITMENT = 'tmpl-recruitment-001';

interface Caller {
  userId: string;
  memberId: string;
  auth: string;
}

describe('统一通知 S3 定向派发 + feed 可见性 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NotificationDispatcher;

  let alice: Caller; // 定向收件人(member + openid)
  let bob: Caller; // 另一 member(验他人不可见 / 防枚举)

  async function makeMember(username: string, openid: string | null): Promise<Caller> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `S3-${username}`, displayName: username, status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id, openid } });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, auth: authHeader };
  }

  function feedList(auth: string): request.Test {
    return request(httpServer(app)).get(APP_NOTIFS).set('Authorization', auth);
  }
  function feedDetail(auth: string, id: string): request.Test {
    return request(httpServer(app)).get(`${APP_NOTIFS}/${id}`).set('Authorization', auth);
  }
  function unreadCount(auth: string): request.Test {
    return request(httpServer(app)).get(`${APP_NOTIFS}/unread-count`).set('Authorization', auth);
  }
  async function setQuota(memberId: string, templateId: string, count: number): Promise<void> {
    await prisma.wechatSubscriptionQuota.upsert({
      where: { memberId_templateId: { memberId, templateId } },
      update: { availableCount: count },
      create: { memberId, templateId, availableCount: count },
    });
  }
  async function setTemplate(templateId: string | null, enabled = true): Promise<void> {
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'recruitment' },
      update: { templateId, enabled },
      create: { notificationTypeCode: 'recruitment', templateId, enabled },
    });
  }
  async function deliveriesOf(notificationId: string) {
    return prisma.notificationDelivery.findMany({ where: { notificationId } });
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dispatcher = app.get(NotificationDispatcher);
    await resetDb(app);

    // notification_type 字典(recruitment;dispatcher 不校验类型,但 admin 列表 / 一致性沿用)
    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: dictType.id, code: 'recruitment', label: '招新公告', status: 'ACTIVE' },
    });

    // wechat DEV_STUB(test 非 production-like;派发走确定性假回执)
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    app.get(WechatSettingsService).invalidate();

    alice = await makeMember('s3_alice', 'dev-openid-s3-alice');
    bob = await makeMember('s3_bob', 'dev-openid-s3-bob');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.notificationDelivery.deleteMany({});
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.wechatSubscriptionQuota.deleteMany({});
    await setTemplate(TMPL_RECRUITMENT, true);
  });

  // ============ 定向行形态 + feed 可见性 ============
  describe('定向行 + feed(广播可见 ∪ 本人定向;他人防枚举)', () => {
    it('dispatchTargeted 建已发布定向行(directed / system / authorUserId=null / published / recipientMemberId)', async () => {
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '已发放永久编号',
        body: '您已转为志愿者,永久编号 26001。',
        channels: ['in-app'],
      });
      const persisted = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(persisted).toMatchObject({
        audienceType: 'directed',
        sourceType: 'system',
        authorUserId: null,
        statusCode: 'published',
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
      });
      expect(persisted.publishedAt).not.toBeNull();
    });

    it('收件人 alice:list 含定向 + detail 200 + unread +1 + markRead 幂等', async () => {
      const before = (await unreadCount(alice.auth).expect(200)).body.data.unreadCount as number;
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '入队成功',
        body: '您已加入「山地救援队」。',
        channels: ['in-app'],
      });

      const list = await feedList(alice.auth).expect(200);
      const ids = (list.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).toContain(row.id);

      await feedDetail(alice.auth, row.id).expect(200);

      const afterUnread = (await unreadCount(alice.auth).expect(200)).body.data
        .unreadCount as number;
      expect(afterUnread).toBe(before + 1);

      // markRead 幂等:两次都 200,readCount 仅 +1
      await request(httpServer(app))
        .post(`${APP_NOTIFS}/${row.id}/read`)
        .set('Authorization', alice.auth)
        .expect(200);
      await request(httpServer(app))
        .post(`${APP_NOTIFS}/${row.id}/read`)
        .set('Authorization', alice.auth)
        .expect(200);
      const persisted = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(persisted.readCount).toBe(1);
      const finalUnread = (await unreadCount(alice.auth).expect(200)).body.data
        .unreadCount as number;
      expect(finalUnread).toBe(before); // 已读后回落
    });

    it('他人 bob:list **不含** alice 定向 + detail 31001(防枚举)+ markRead 31001', async () => {
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '只给 alice',
        body: '定向内容',
        channels: ['in-app'],
      });

      const list = await feedList(bob.auth).expect(200);
      const ids = (list.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).not.toContain(row.id); // 他人 feed 不含

      // 详情 / markRead 看不到的定向 → 31001 防枚举(不泄漏存在性)
      expectBizError(await feedDetail(bob.auth, row.id), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(
        await request(httpServer(app))
          .post(`${APP_NOTIFS}/${row.id}/read`)
          .set('Authorization', bob.auth),
        BizCode.NOTIFICATION_NOT_FOUND,
      );

      // bob 未读数不因 alice 定向增加
      const bobUnread = (await unreadCount(bob.auth).expect(200)).body.data.unreadCount as number;
      expect(bobUnread).toBe(0);
    });

    it('regression:广播(published / member 档)仍对所有 member 可见(定向收窄不伤广播)', async () => {
      const broadcast = await prisma.notification.create({
        data: {
          title: '全员广播',
          body: '广播正文',
          notificationTypeCode: 'recruitment',
          statusCode: 'published',
          publishedAt: new Date(),
          visibilityCode: 'member',
          audienceType: 'broadcast',
          sourceType: 'admin',
          channels: ['in-app'],
        },
        select: { id: true },
      });
      for (const c of [alice, bob]) {
        const list = await feedList(c.auth).expect(200);
        const ids = (list.body.data.items as { id: string }[]).map((i) => i.id);
        expect(ids).toContain(broadcast.id);
        await feedDetail(c.auth, broadcast.id).expect(200);
      }
    });
  });

  // ============ 微信渠道(复用 S2 单收件人发送) ============
  describe('定向微信渠道(channels 含 wechat;复用 S2 dispatchDirected)', () => {
    it('有 quota + 模板 → delivery sent + 原子扣 1', async () => {
      await setQuota(alice.memberId, TMPL_RECRUITMENT, 2);
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '发号',
        body: '永久编号 26002。',
        channels: ['in-app', 'wechat'],
      });
      const ds = await deliveriesOf(row.id);
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ channel: 'wechat', memberId: alice.memberId, status: 'sent' });
      expect(ds[0].recipientRef).not.toContain('dev-openid-s3-alice'); // 掩码
      const q = await prisma.wechatSubscriptionQuota.findUniqueOrThrow({
        where: { memberId_templateId: { memberId: alice.memberId, templateId: TMPL_RECRUITMENT } },
      });
      expect(q.availableCount).toBe(1); // 2 → 1
    });

    it('无 quota(新志愿者常态)→ skipped no-quota(站内仍达)', async () => {
      // alice 无 quota 行
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '发号',
        body: '永久编号 26003。',
        channels: ['in-app', 'wechat'],
      });
      const ds = await deliveriesOf(row.id);
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ status: 'skipped', reasonCode: 'no-quota' });
      // 站内行仍建(收件人可见)
      const list = await feedList(alice.auth).expect(200);
      expect((list.body.data.items as { id: string }[]).map((i) => i.id)).toContain(row.id);
    });

    it('类型无启用模板 → skipped no-template(单收件人留痕)', async () => {
      await setTemplate(null, true); // recruitment templateId=null
      await setQuota(alice.memberId, TMPL_RECRUITMENT, 2);
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '发号',
        body: '永久编号 26004。',
        channels: ['in-app', 'wechat'],
      });
      const ds = await deliveriesOf(row.id);
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ status: 'skipped', reasonCode: 'no-template' });
    });

    it('仅站内(channels 不含 wechat)→ 零 delivery', async () => {
      await setQuota(alice.memberId, TMPL_RECRUITMENT, 2);
      const row = await dispatcher.dispatchTargeted({
        recipientMemberId: alice.memberId,
        notificationTypeCode: 'recruitment',
        title: '入队',
        body: '仅站内。',
        channels: ['in-app'],
      });
      expect(await deliveriesOf(row.id)).toHaveLength(0);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { WechatSettingsService } from '../../src/modules/wechat/wechat-settings.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 统一通知 S2 微信订阅 quota 渠道 e2e(冻结评审稿 unified-notification-dispatcher-review.md §3/§7 + goal DoD)。
//
// 覆盖:
// - ack:逐模板 quota +1 累积 + 封顶 5(D-N2);additive 非去重;canUseApp 准入。
// - status:逐模板返剩余配额(无行=0)。
// - 派发(publish 勾 wechat,事务外同步):订阅+可见会员 sent + 原子扣 1;43101→failed need-resubscribe + 回补;
//   no-openid→skipped(不扣);no-quota 会员不 fan-out;不可见会员不在受众;未配置模板整渠道跳过;re-publish 去重。
// - 并发不越扣:同会员 quota=1 两通知并发 publish → 恰 1 sent + 1 no-quota,quota 落 0(不为负)。
// - 模板配置 admin:list + upsert(运营可配)+ RBAC 边界 + 类型校验。
//
// DevStub 失败注入:openid 含 wxerr-<errcode> → DevStub 返该 errcode(43101 等);production 物理不可达。

const ADMIN_NOTIFICATIONS = '/api/admin/v1/notifications';
const ADMIN_TEMPLATES = '/api/admin/v1/notification-wechat-templates';
const APP_SUBSCRIPTIONS = '/api/app/v1/notifications/subscriptions';
const TMPL_GENERAL = 'tmpl-general-001';

const NOTIFICATION_PERMISSION_CODES = [
  { code: 'notification.read.record', action: 'read', resourceType: 'record' },
  { code: 'notification.create.record', action: 'create', resourceType: 'record' },
  { code: 'notification.update.record', action: 'update', resourceType: 'record' },
  { code: 'notification.delete.record', action: 'delete', resourceType: 'record' },
  { code: 'notification.publish.record', action: 'publish', resourceType: 'record' },
  { code: 'notification.update.template', action: 'update', resourceType: 'template' },
] as const;

interface Caller {
  userId: string;
  memberId: string;
  auth: string;
}

describe('统一通知 S2 微信订阅 quota 渠道 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuth: string; // biz-admin(承载 notification.* + update.template)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let alice: Caller; // 活跃会员 + openid + 可见(member 档)
  let unlinkedAuth: string; // 未绑 member(canUseApp=false)

  async function makeMember(username: string, openid: string | null): Promise<Caller> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `S2-${username}`, displayName: username, status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id, openid },
    });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, auth: authHeader };
  }

  async function setQuota(memberId: string, templateId: string, count: number): Promise<void> {
    await prisma.wechatSubscriptionQuota.upsert({
      where: { memberId_templateId: { memberId, templateId } },
      update: { availableCount: count },
      create: { memberId, templateId, availableCount: count },
    });
  }
  async function getQuota(memberId: string, templateId: string): Promise<number> {
    const row = await prisma.wechatSubscriptionQuota.findUnique({
      where: { memberId_templateId: { memberId, templateId } },
      select: { availableCount: true },
    });
    return row?.availableCount ?? 0;
  }
  async function setTemplate(
    typeCode: string,
    templateId: string | null,
    enabled = true,
  ): Promise<void> {
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: typeCode },
      update: { templateId, enabled },
      create: { notificationTypeCode: typeCode, templateId, enabled },
    });
  }
  async function deliveriesOf(notificationId: string) {
    return prisma.notificationDelivery.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  function adminPost(body: Record<string, unknown>, path = ''): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN_NOTIFICATIONS}${path}`)
      .set('Authorization', adminAuth)
      .send(body);
  }
  // 建草稿(默认 general + 勾 wechat + member 可见)→ publish(触发事务外派发),返通知 id。
  async function createAndPublish(over: Record<string, unknown> = {}): Promise<string> {
    const created = await adminPost({
      title: '微信通知',
      body: '正文内容',
      notificationTypeCode: 'general',
      visibilityCode: 'member',
      channels: ['wechat'],
      ...over,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const pub = await request(httpServer(app))
      .post(`${ADMIN_NOTIFICATIONS}/${id}/publish`)
      .set('Authorization', adminAuth);
    expect(pub.status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // RBAC:biz-admin + notification.* 6 码
    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    for (const p of NOTIFICATION_PERMISSION_CODES) {
      await prisma.permission.upsert({
        where: { code: p.code },
        update: {},
        create: {
          code: p.code,
          module: 'notification',
          action: p.action,
          resourceType: p.resourceType,
        },
      });
    }
    const seeded = await prisma.permission.findMany({
      where: { code: { in: NOTIFICATION_PERMISSION_CODES.map((p) => p.code) } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: seeded.map((p) => ({ roleId: bizAdminRoleId, permissionId: p.id })),
      skipDuplicates: true,
    });

    // notification_type 字典
    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dictType.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'emergency', label: '紧急召集', status: 'ACTIVE' },
      ],
    });

    // wechat_settings DEV_STUB(test 非 production-like,允许 stub;派发走确定性假回执)
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    app.get(WechatSettingsService).invalidate();

    const adminUser = await createTestUser(app, { username: 's2_admin', role: Role.ADMIN });
    await grantBizAdminToUser(app, adminUser.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, 's2_admin')).authHeader;

    await createTestUser(app, { username: 's2_user', role: Role.USER });
    userAuth = (await loginAs(app, 's2_user')).authHeader;

    alice = await makeMember('s2_alice', 'dev-openid-alice');

    const unlinked = await createTestUser(app, { username: 's2_unlinked', role: Role.USER });
    expect(unlinked.id).toBeTruthy();
    unlinkedAuth = (await loginAs(app, 's2_unlinked')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 test 清 S2 状态(保留 members / org / settings / dict / RBAC);模板复位 general→enabled / emergency→null。
  beforeEach(async () => {
    await prisma.notificationDelivery.deleteMany({});
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.wechatSubscriptionQuota.deleteMany({});
    await setTemplate('general', TMPL_GENERAL, true);
    await setTemplate('emergency', null, true); // 未配置 templateId 的类型
  });

  // ============ ack / status ============
  describe('ack / status(quota +1 封顶 + 诚实非幂等)', () => {
    it('ack 累积 +1 + 封顶 5(additive 非去重)', async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await request(httpServer(app))
          .post(`${APP_SUBSCRIPTIONS}/ack`)
          .set('Authorization', alice.auth)
          .send({ templateIds: [TMPL_GENERAL] });
        expect(res.status).toBe(200);
        expect(res.body.data.quotas[0]).toEqual({ templateId: TMPL_GENERAL, availableCount: i });
      }
      // 第 6 次 → 封顶 no-op,仍 5
      const capped = await request(httpServer(app))
        .post(`${APP_SUBSCRIPTIONS}/ack`)
        .set('Authorization', alice.auth)
        .send({ templateIds: [TMPL_GENERAL] });
      expect(capped.body.data.quotas[0].availableCount).toBe(5);
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(5);
    });

    it('ack 多模板各 +1', async () => {
      const res = await request(httpServer(app))
        .post(`${APP_SUBSCRIPTIONS}/ack`)
        .set('Authorization', alice.auth)
        .send({ templateIds: [TMPL_GENERAL, 'tmpl-other'] });
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        (res.body.data.quotas as { templateId: string; availableCount: number }[]).map((q) => [
          q.templateId,
          q.availableCount,
        ]),
      );
      expect(byId[TMPL_GENERAL]).toBe(1);
      expect(byId['tmpl-other']).toBe(1);
    });

    it('status 返各模板配额(无行=0)', async () => {
      await setQuota(alice.memberId, TMPL_GENERAL, 3);
      const res = await request(httpServer(app))
        .get(`${APP_SUBSCRIPTIONS}/status?templateIds=${TMPL_GENERAL},tmpl-missing`)
        .set('Authorization', alice.auth);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        (res.body.data.quotas as { templateId: string; availableCount: number }[]).map((q) => [
          q.templateId,
          q.availableCount,
        ]),
      );
      expect(byId[TMPL_GENERAL]).toBe(3);
      expect(byId['tmpl-missing']).toBe(0);
    });

    it('ack 空 templateIds → 400', async () => {
      const res = await request(httpServer(app))
        .post(`${APP_SUBSCRIPTIONS}/ack`)
        .set('Authorization', alice.auth)
        .send({ templateIds: [] });
      // 自定义校验文案("至少一个模板 ID")非 BizCode 默认,放宽 message 严格匹配
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('canUseApp=false(未绑 member)ack → 403', async () => {
      const res = await request(httpServer(app))
        .post(`${APP_SUBSCRIPTIONS}/ack`)
        .set('Authorization', unlinkedAuth)
        .send({ templateIds: [TMPL_GENERAL] });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('无 Authorization → 401', async () => {
      const res = await request(httpServer(app))
        .post(`${APP_SUBSCRIPTIONS}/ack`)
        .send({ templateIds: [TMPL_GENERAL] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ 派发(publish 勾 wechat → 事务外同步) ============
  describe('微信派发(发送三态 + 43101 回补 + 原子扣减)', () => {
    it('订阅 + 可见会员 → delivery sent + 原子扣 1', async () => {
      await setQuota(alice.memberId, TMPL_GENERAL, 3);
      const id = await createAndPublish();
      const deliveries = await deliveriesOf(id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        channel: 'wechat',
        memberId: alice.memberId,
        status: 'sent',
        reasonCode: null,
      });
      expect(deliveries[0].providerMsgId).toContain('dev-msgid-');
      expect(deliveries[0].attemptedAt).not.toBeNull();
      expect(deliveries[0].recipientRef).not.toContain('dev-openid-alice'); // 掩码,非明文
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(2); // 3 → 2
    });

    it('43101(用户拒收)→ failed need-resubscribe + 回补 quota', async () => {
      const bob = await makeMember('s2_bob43101', 'dev-openid-wxerr-43101');
      await setQuota(bob.memberId, TMPL_GENERAL, 2);
      const id = await createAndPublish();
      const deliveries = (await deliveriesOf(id)).filter((d) => d.memberId === bob.memberId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: 'failed',
        reasonCode: 'need-resubscribe',
        errCode: '43101',
      });
      // 扣 1(2→1)后明确失败回补(1→2)
      expect(await getQuota(bob.memberId, TMPL_GENERAL)).toBe(2);
    });

    it('40003(openid 非法)→ failed invalid-openid(不回补)', async () => {
      const carol = await makeMember('s2_carol40003', 'dev-openid-wxerr-40003');
      await setQuota(carol.memberId, TMPL_GENERAL, 2);
      const id = await createAndPublish();
      const d = (await deliveriesOf(id)).filter((x) => x.memberId === carol.memberId);
      expect(d[0]).toMatchObject({
        status: 'failed',
        reasonCode: 'invalid-openid',
        errCode: '40003',
      });
      expect(await getQuota(carol.memberId, TMPL_GENERAL)).toBe(1); // 扣 1 不回补
    });

    it('可见但无 openid → skipped no-openid(不扣 quota)', async () => {
      const dave = await makeMember('s2_dave_noopenid', null);
      await setQuota(dave.memberId, TMPL_GENERAL, 3);
      const id = await createAndPublish();
      const d = (await deliveriesOf(id)).filter((x) => x.memberId === dave.memberId);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ status: 'skipped', reasonCode: 'no-openid' });
      expect(d[0].attemptedAt).toBeNull();
      expect(await getQuota(dave.memberId, TMPL_GENERAL)).toBe(3); // 不扣
    });

    it('无 quota 会员 → 不 fan-out(无 delivery 行)', async () => {
      // alice 无 quota 行
      const id = await createAndPublish();
      expect(await deliveriesOf(id)).toHaveLength(0);
    });

    it('类型未配置 templateId → 整渠道跳过(无 delivery)', async () => {
      await setQuota(alice.memberId, 'tmpl-emergency', 3); // emergency templateId=null
      const id = await createAndPublish({ notificationTypeCode: 'emergency' });
      expect(await deliveriesOf(id)).toHaveLength(0);
    });

    it('未勾 wechat(仅站内)→ 不派发', async () => {
      await setQuota(alice.memberId, TMPL_GENERAL, 3);
      const id = await createAndPublish({ channels: ['in-app'] });
      expect(await deliveriesOf(id)).toHaveLength(0);
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(3);
    });

    it('不可见会员(department 档不匹配)→ 不在受众', async () => {
      const org = await prisma.organization.create({
        data: { name: 'S2部门X', nodeTypeCode: 'demo-node', status: 'ACTIVE' },
        select: { id: true },
      });
      // alice 无 member_department → 对 department[orgX] 不可见
      await setQuota(alice.memberId, TMPL_GENERAL, 3);
      const id = await createAndPublish({
        visibilityCode: 'department',
        visibleOrganizationIds: [org.id],
      });
      expect(await deliveriesOf(id)).toHaveLength(0);
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(3); // 不在受众不扣
    });

    it('re-publish 去重:已 sent 不重复推(unpublish → 再 publish)', async () => {
      await setQuota(alice.memberId, TMPL_GENERAL, 3);
      const created = await adminPost({
        title: 't',
        body: 'b',
        notificationTypeCode: 'general',
        visibilityCode: 'member',
        channels: ['wechat'],
      });
      const id = created.body.data.id as string;
      await request(httpServer(app))
        .post(`${ADMIN_NOTIFICATIONS}/${id}/publish`)
        .set('Authorization', adminAuth);
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(2);
      // 撤回 → 再发布:alice 已有 sent delivery → 不重复推(quota 不再扣)
      await request(httpServer(app))
        .post(`${ADMIN_NOTIFICATIONS}/${id}/unpublish`)
        .set('Authorization', adminAuth);
      await request(httpServer(app))
        .post(`${ADMIN_NOTIFICATIONS}/${id}/publish`)
        .set('Authorization', adminAuth);
      const sent = (await deliveriesOf(id)).filter((d) => d.status === 'sent');
      expect(sent).toHaveLength(1); // 仍 1 条
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(2); // 未二次扣
    });

    it('并发不越扣:quota=1 两通知并发 publish → 恰 1 sent + 1 no-quota,quota 落 0', async () => {
      await setQuota(alice.memberId, TMPL_GENERAL, 1);
      const mk = async () => {
        const c = await adminPost({
          title: 'concurrent',
          body: 'b',
          notificationTypeCode: 'general',
          visibilityCode: 'member',
          channels: ['wechat'],
        });
        return c.body.data.id as string;
      };
      const [id1, id2] = [await mk(), await mk()];
      await Promise.all([
        request(httpServer(app))
          .post(`${ADMIN_NOTIFICATIONS}/${id1}/publish`)
          .set('Authorization', adminAuth),
        request(httpServer(app))
          .post(`${ADMIN_NOTIFICATIONS}/${id2}/publish`)
          .set('Authorization', adminAuth),
      ]);
      const all = [...(await deliveriesOf(id1)), ...(await deliveriesOf(id2))].filter(
        (d) => d.memberId === alice.memberId,
      );
      // 硬不变量(与时序无关):恰 1 条 sent(绝不双发)+ quota 落 0(绝不越扣为负)。
      // 落败的那条 publish 取决于时序:或记 no-quota skipped(候选已载、扣减时撞 0),
      // 或干脆不把 alice 纳入候选(候选载入晚于对方扣减,alice 已 0)——两者都正确,
      // 故只断言「绝无第二条 sent」而非固定 no-quota 行数。
      const sent = all.filter((d) => d.status === 'sent');
      expect(sent).toHaveLength(1); // 恰 1 条 sent:无双发
      expect(await getQuota(alice.memberId, TMPL_GENERAL)).toBe(0); // 不越扣为负
    });
  });

  // ============ 模板配置 admin ============
  describe('微信模板配置 admin', () => {
    it('list 返配置;upsert 改 templateId(运营可配)', async () => {
      const list1 = await request(httpServer(app))
        .get(ADMIN_TEMPLATES)
        .set('Authorization', adminAuth);
      expect(list1.status).toBe(200);
      expect(Array.isArray(list1.body.data)).toBe(true);

      const up = await request(httpServer(app))
        .put(`${ADMIN_TEMPLATES}/general`)
        .set('Authorization', adminAuth)
        .send({ templateId: 'tmpl-new-id', enabled: true });
      expect(up.status).toBe(200);
      expect(up.body.data).toMatchObject({
        notificationTypeCode: 'general',
        templateId: 'tmpl-new-id',
        enabled: true,
      });
    });

    it('upsert 不存在的 notificationTypeCode → 31010', async () => {
      const res = await request(httpServer(app))
        .put(`${ADMIN_TEMPLATES}/not-a-real-type`)
        .set('Authorization', adminAuth)
        .send({ templateId: 'x' });
      expectBizError(res, BizCode.NOTIFICATION_TYPE_INVALID);
    });

    it('普通 USER upsert → 30100', async () => {
      const res = await request(httpServer(app))
        .put(`${ADMIN_TEMPLATES}/general`)
        .set('Authorization', userAuth)
        .send({ templateId: 'x' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { DevStubSmsProvider } from '../../src/modules/sms/providers/dev-stub.provider';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 统一通知模块 S5 短信兜底渠道 e2e(冻结评审稿 unified-notification-dispatcher-review.md §4 / §8.3 / D-N4)。
//
// 覆盖(goal DoD #6):RBAC 边界 + 前置闸(31001 / 31013)+ 计费确认必需(confirmed 缺失 400 / 未 confirmed 不发)
// + 确认发送(逐人 send_log + delivery + maskPhone + audit)+ 同号同日同模板幂等继承 + re-trigger 去重
// + 仅可见有手机者 + 通道未配置 24030。**逐人 FAILED 不阻断在 unit 经 mock router 锁定**(DevStub e2e 恒成功链路,
// 镜像 notifications-birthday.e2e 口径)。
//
// 受众隔离:广播 member 可见档命中全部 active member,故 send 类用例用 department 可见档 + per-test org
// (每用例造独立 org + 成员,审计 recipientCount 精确可断,互不串扰)。

const ADMIN = '/api/admin/v1/notifications';

const NOTIFICATION_PERMISSION_CODES = [
  {
    code: 'notification.read.record',
    module: 'notification',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'notification.create.record',
    module: 'notification',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'notification.update.record',
    module: 'notification',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'notification.publish.record',
    module: 'notification',
    action: 'publish',
    resourceType: 'record',
  },
  { code: 'notification.send.sms', module: 'notification', action: 'send', resourceType: 'sms' },
] as const;

describe('统一通知模块 S5 短信兜底渠道 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let settings: SmsSettingsService;
  let worker: NotificationOutboxWorker;
  let devStub: DevStubSmsProvider;
  let adminAuth: string;
  let userAuth: string;
  let seq = 0;

  async function seedPermsToBizAdmin(roleId: string): Promise<void> {
    for (const p of NOTIFICATION_PERMISSION_CODES) {
      await prisma.permission.upsert({
        where: { code: p.code },
        update: {},
        create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      });
    }
    const seeded = await prisma.permission.findMany({
      where: { code: { in: NOTIFICATION_PERMISSION_CODES.map((p) => p.code) } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: seeded.map((p) => ({ roleId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  async function seedDict(): Promise<void> {
    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dictType.id, code: 'emergency', label: '紧急召集', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
      ],
    });
  }

  async function setSmsSettings(
    over: { templateIdNotification?: string | null } = {},
  ): Promise<void> {
    await prisma.smsSettings.deleteMany({});
    await prisma.smsSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        templateIdNotification:
          over.templateIdNotification === undefined ? 'tpl-notif-1' : over.templateIdNotification,
      },
    });
    settings.invalidate();
  }

  async function createOrg(): Promise<string> {
    seq += 1;
    const org = await prisma.organization.create({
      data: { name: `部门-S5-${seq}`, nodeTypeCode: 'demo-node', status: 'ACTIVE' },
      select: { id: true },
    });
    return org.id;
  }

  // 造 active member + active user(phone)+ 在 orgId 下的活跃 memberDepartment(department 可见命中)。
  async function createMemberInOrg(orgId: string, phone: string | null): Promise<string> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `SMS${String(seq).padStart(5, '0')}`,
        displayName: `短信测试${seq}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const user = await createTestUser(app, { username: `sms_recip_${seq}` });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id, phone } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId: orgId },
    });
    return member.id;
  }

  function adminPost(path: string, body: Record<string, unknown>): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN}${path}`)
      .set('Authorization', adminAuth)
      .send(body);
  }

  // 造 department 可见档通知(默认 channels 含 sms);published=true 时发布(站内即达,短信不随 publish 发)。
  async function createDeptNotification(
    orgId: string,
    opts: { channels?: string[]; published?: boolean } = {},
  ): Promise<string> {
    const create = await adminPost('', {
      title: '紧急召集',
      body: '请立即查看 App',
      notificationTypeCode: 'emergency',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgId],
      channels: opts.channels ?? ['in-app', 'sms'],
    });
    expect(create.status).toBe(201);
    const id = create.body.data.id as string;
    if (opts.published !== false) {
      const pub = await request(httpServer(app))
        .post(`${ADMIN}/${id}/publish`)
        .set('Authorization', adminAuth);
      expect(pub.status).toBe(200);
    }
    return id;
  }

  function sendSms(auth: string, id: string, body: Record<string, unknown>): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN}/${id}/send-sms`)
      .set('Authorization', auth)
      .send(body);
  }

  async function drainAll(): Promise<number> {
    let claimed = 0;
    for (;;) {
      const result = await worker.drainOnce();
      claimed += result.claimed;
      if (result.claimed === 0) return claimed;
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    settings = app.get(SmsSettingsService);
    worker = app.get(NotificationOutboxWorker);
    devStub = app.get(DevStubSmsProvider);
    await resetDb(app);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    await seedPermsToBizAdmin(bizAdminRoleId);
    await seedDict();
    await setSmsSettings();

    const adminUser = await createTestUser(app, { username: 'sms_admin', role: Role.ADMIN });
    await grantBizAdminToUser(app, adminUser.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, 'sms_admin')).authHeader;

    await createTestUser(app, { username: 'sms_plain_user', role: Role.USER });
    userAuth = (await loginAs(app, 'sms_plain_user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ RBAC 边界 ============
  describe('RBAC 边界', () => {
    it('无 Authorization → 401', async () => {
      const org = await createOrg();
      const id = await createDeptNotification(org);
      const res = await request(httpServer(app))
        .post(`${ADMIN}/${id}/send-sms`)
        .send({ confirmed: false });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('普通 USER(无 notification.send.sms)→ 30100', async () => {
      const org = await createOrg();
      const id = await createDeptNotification(org);
      expectBizError(await sendSms(userAuth, id, { confirmed: false }), BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ 前置闸 ============
  describe('前置闸', () => {
    it('通知不存在 → 31001', async () => {
      expectBizError(
        await sendSms(adminAuth, 'no-such-id', { confirmed: false }),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });

    it('未发布(draft)→ 31013', async () => {
      const org = await createOrg();
      const id = await createDeptNotification(org, { published: false });
      expectBizError(
        await sendSms(adminAuth, id, { confirmed: false }),
        BizCode.NOTIFICATION_SMS_NOT_SENDABLE,
      );
    });

    it('已发布但 channels 未声明 sms → 31013', async () => {
      const org = await createOrg();
      const id = await createDeptNotification(org, { channels: ['in-app'] });
      expectBizError(
        await sendSms(adminAuth, id, { confirmed: false }),
        BizCode.NOTIFICATION_SMS_NOT_SENDABLE,
      );
    });
  });

  // ============ 计费确认必需 ============
  describe('计费确认必需', () => {
    it('confirmed 缺失 → 通用 400(DTO 校验)', async () => {
      const org = await createOrg();
      const id = await createDeptNotification(org);
      const res = await sendSms(adminAuth, id, {});
      expect(res.status).toBe(400);
    });

    it('confirmed=false → 预览受众计数,零发送零计费零 delivery(仅可见有手机者计入)', async () => {
      const org = await createOrg();
      await createMemberInOrg(org, '13900010001');
      await createMemberInOrg(org, '13900010002');
      await createMemberInOrg(org, null); // 无手机 → 不计入可计费受众
      const id = await createDeptNotification(org);

      const res = await sendSms(adminAuth, id, { confirmed: false });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        confirmed: false,
        recipientCount: 2,
        sent: 0,
        failed: 0,
        skipped: 0,
      });
      // 零发送:无 delivery、无 send_log
      expect(await prisma.notificationDelivery.count({ where: { notificationId: id } })).toBe(0);
      expect(await prisma.smsSendLog.count({ where: { phone: '13900010001' } })).toBe(0);
    });

    it('他部门成员不计入(可见性隔离)', async () => {
      const orgA = await createOrg();
      const orgB = await createOrg();
      await createMemberInOrg(orgA, '13900011001');
      await createMemberInOrg(orgB, '13900011002'); // 他部门
      const id = await createDeptNotification(orgA);
      const res = await sendSms(adminAuth, id, { confirmed: false });
      expect(res.body.data.recipientCount).toBe(1);
    });
  });

  // ============ 确认发送 ============
  describe('确认发送(confirmed=true)', () => {
    it('逐人发送:sent + send_log(templateKey=notification)+ delivery(maskPhone)+ audit 收件人计数', async () => {
      const org = await createOrg();
      await createMemberInOrg(org, '13912340001');
      await createMemberInOrg(org, '13912340002');
      const id = await createDeptNotification(org);

      const preClaimRows: Array<{
        status: string;
        attempts: number;
        leaseOwner: string | null;
        lockedAt: Date | null;
        leaseExpiresAt: Date | null;
      }> = [];
      const originalDrain = worker.drainEventKeyOrThrow.bind(worker);
      const drainSpy = jest
        .spyOn(worker, 'drainEventKeyOrThrow')
        .mockImplementation(async (eventKey) => {
          const row = await prisma.notificationOutboxIntent.findUniqueOrThrow({
            where: { eventKey },
          });
          preClaimRows.push(row);
          return originalDrain(eventKey);
        });
      const providerSpy = jest.spyOn(devStub, 'sendNotification');
      const res = await (async () => {
        try {
          const response = await sendSms(adminAuth, id, { confirmed: true });
          expect(providerSpy).toHaveBeenCalledTimes(2);
          return response;
        } finally {
          drainSpy.mockRestore();
          providerSpy.mockRestore();
        }
      })();
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        confirmed: true,
        recipientCount: 2,
        sent: 2,
        failed: 0,
        skipped: 0,
      });
      expect(preClaimRows).toHaveLength(2);
      expect(
        preClaimRows.every(
          (row) =>
            row.status === 'pending' &&
            row.attempts === 0 &&
            row.leaseOwner === null &&
            row.lockedAt === null &&
            row.leaseExpiresAt === null,
        ),
      ).toBe(true);

      // send_logs:templateKey=notification / status SENT / providerType DEV_STUB
      const logs = await prisma.smsSendLog.findMany({
        where: { phone: { in: ['13912340001', '13912340002'] } },
      });
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.templateKey === 'notification' && l.status === 'SENT')).toBe(true);

      // delivery:channel sms / sent / recipientRef 掩码(明文手机号不入库)
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: id, channel: 'sms' },
      });
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.status === 'sent')).toBe(true);
      expect(deliveries.map((d) => d.recipientRef).sort()).toEqual(['139****0001', '139****0002']);

      // audit:reserved 与 durable intents 同事务；first-attempt 记录同步首轮真实计数，且不冒充最终态。
      const audits = await prisma.auditLog.findMany({
        where: { event: 'notification.publish', resourceId: id },
      });
      const sendAudits = audits.filter(
        (a) => (a.context as { extra?: { operation?: string } })?.extra?.operation === 'send-sms',
      );
      expect(sendAudits).toHaveLength(2);
      const extraByState = Object.fromEntries(
        sendAudits.map((row) => {
          const extra = (row.context as { extra: Record<string, unknown> }).extra;
          return [extra.deliveryState, extra];
        }),
      );
      expect(extraByState.reserved).toMatchObject({
        operation: 'send-sms',
        deliveryState: 'reserved',
        recipientCount: 2,
        reserved: 2,
        busy: 0,
        completed: 0,
        dead: 0,
        firstAttemptIsFinal: false,
      });
      expect(extraByState['first-attempt']).toMatchObject({
        operation: 'send-sms',
        deliveryState: 'first-attempt',
        recipientCount: 2,
        sent: 2,
        failed: 0,
        skipped: 0,
        firstAttemptIsFinal: false,
      });
      expect(extraByState.reserved.generationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      expect(extraByState['first-attempt'].generationId).toBe(extraByState.reserved.generationId);
      // 审计 context 不含明文手机号
      expect(JSON.stringify(sendAudits)).not.toContain('13912340001');
    });

    it('re-trigger 去重:同通知二次确认发送 → 全 skipped already-sent(不重复计费)', async () => {
      const org = await createOrg();
      await createMemberInOrg(org, '13912350001');
      const id = await createDeptNotification(org);

      const first = await sendSms(adminAuth, id, { confirmed: true });
      expect(first.body.data).toMatchObject({ sent: 1, skipped: 0 });

      const second = await sendSms(adminAuth, id, { confirmed: true });
      expect(second.body.data).toMatchObject({ recipientCount: 1, sent: 0, skipped: 1 });
      // 仍只一条 send_log(未重复发)
      expect(await prisma.smsSendLog.count({ where: { phone: '13912350001' } })).toBe(1);
      const skipDelivery = await prisma.notificationDelivery.findFirst({
        where: { notificationId: id, status: 'skipped' },
      });
      expect(skipDelivery?.reasonCode).toBe('already-sent');
      const generations = await prisma.notificationOutboxIntent.findMany({
        where: { eventType: 'notification.admin-sms', aggregateId: id },
        select: { eventKey: true, status: true },
      });
      expect(generations).toHaveLength(2);
      expect(new Set(generations.map(({ eventKey }) => eventKey))).toHaveProperty('size', 2);
      expect(generations.every(({ status }) => status === 'succeeded')).toBe(true);
    });

    it.each([
      ['idempotent', 'notification', 1, '13912360001'],
      ['daily-limit', 'birthday-greeting', 10, '13912360002'],
      ['interval', 'birthday-greeting', 1, '13912360003'],
    ])(
      '%s 临时 skip terminal 后窗口跨越，新 confirmation generation 可真实发送',
      async (reasonCode: string, templateKey: string, logCount: number, phone: string) => {
        const org = await createOrg();
        await createMemberInOrg(org, phone);
        await prisma.smsSendLog.createMany({
          data: Array.from({ length: logCount }, () => ({
            phone,
            templateKey,
            providerType: 'DEV_STUB',
            status: 'SENT',
          })),
        });

        const id = await createDeptNotification(org);
        const first = await sendSms(adminAuth, id, { confirmed: true });
        expect(first.body.data).toMatchObject({ recipientCount: 1, sent: 0, skipped: 1 });
        const delivery = await prisma.notificationDelivery.findFirst({
          where: { notificationId: id, status: 'skipped' },
        });
        expect(delivery?.reasonCode).toBe(reasonCode);

        await prisma.smsSendLog.updateMany({
          where: { phone },
          data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
        });
        const second = await sendSms(adminAuth, id, { confirmed: true });
        expect(second.body.data).toMatchObject({ recipientCount: 1, sent: 1, skipped: 0 });
        expect(
          await prisma.notificationOutboxIntent.count({
            where: { eventType: 'notification.admin-sms', aggregateId: id },
          }),
        ).toBe(2);
      },
    );
  });

  // ============ 通道未配置 ============
  describe('通道未配置', () => {
    it('templateIdNotification 空 → confirmed 发送前抛 24030(零计费零 delivery),且不影响预览', async () => {
      const org = await createOrg();
      await createMemberInOrg(org, '13900099001');
      const id = await createDeptNotification(org);

      await setSmsSettings({ templateIdNotification: null });
      try {
        // 预览不查通道,仍可返计数
        const preview = await sendSms(adminAuth, id, { confirmed: false });
        expect(preview.body.data.recipientCount).toBe(1);
        // 确认发送 → 24030,零 delivery
        expectBizError(
          await sendSms(adminAuth, id, { confirmed: true }),
          BizCode.SMS_CHANNEL_NOT_CONFIGURED,
        );
        expect(
          await prisma.notificationOutboxIntent.count({
            where: { eventType: 'notification.admin-sms', aggregateId: id },
          }),
        ).toBe(0);
        expect(await prisma.notificationDelivery.count({ where: { notificationId: id } })).toBe(0);
        expect(await prisma.smsSendLog.count({ where: { phone: '13900099001' } })).toBe(0);
      } finally {
        await setSmsSettings(); // 还原
      }
      expect(await drainAll()).toBe(0);
      expect(await prisma.notificationDelivery.count({ where: { notificationId: id } })).toBe(0);
      expect(await prisma.smsSendLog.count({ where: { phone: '13900099001' } })).toBe(0);
    });
  });
});

import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import { ExpiryReminderService } from '../../src/modules/notifications/expiry-reminder.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import {
  seedCertificateStandard,
  type SeededCertificateStandard,
} from '../fixtures/certificate-standard.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const NOW = new Date('2026-07-14T09:00:00+08:00');

describe('到期提醒 job（真实 DB 直调 runOnce）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let certStd: SeededCertificateStandard;
  let job: ExpiryReminderService;
  let worker: NotificationOutboxWorker;

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
    job = app.get(ExpiryReminderService);
    worker = app.get(NotificationOutboxWorker);
    await resetDb(app);
    // PR-4b:必须在 resetDb **之后** seed —— 之前 seed 会被 TRUNCATE 掉,
    // 后续直插证书就会撞 Certificate_standardId_fkey。
    certStd = await seedCertificateStandard(prisma);

    // templateId 保持 null：个人提醒站内成功，微信 best-effort 记 no-template，不阻断主链。
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: 'expiry-reminder' },
      update: { templateId: null, enabled: true },
      create: { notificationTypeCode: 'expiry-reminder', templateId: null, enabled: true },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('首跑补齐五路径；活动仅提醒 pass 且 marker 保证二跑零新增；到期证书同事务翻态+audit', async () => {
    const members = await Promise.all(
      ['证书预提醒', '证书到期', '个人保险'].map((displayName, index) =>
        prisma.member.create({
          data: {
            memberNo: `ER${String(index + 1).padStart(4, '0')}`,
            displayName,
            status: 'ACTIVE',
          },
        }),
      ),
    );

    const certificateReminder = await prisma.certificate.create({
      data: {
        memberId: members[0].id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-08-01T00:00:00.000Z'),
        expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        certStatusCode: 'verified',
      },
    });
    // 冻结稿 §10.5:过期条件是 `expiredAt < today`。原 fixture 用 today(07-14)本身,
    // 那是**最后有效日**、当天仍有效;下移到 07-13 才是真正已过期的那一天。
    const certificateExpired = await prisma.certificate.create({
      data: {
        memberId: members[1].id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: new Date('2026-07-13T00:00:00.000Z'),
        certStatusCode: 'verified',
        verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
      },
    });
    const perpetualCertificate = await prisma.certificate.create({
      data: {
        memberId: members[0].id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: null,
        certStatusCode: 'verified',
      },
    });
    const outsideWindowCertificate = await prisma.certificate.create({
      data: {
        memberId: members[0].id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: new Date('2027-01-01T00:00:00.000Z'),
        certStatusCode: 'verified',
      },
    });
    const memberInsurance = await prisma.memberInsurance.create({
      data: {
        memberId: members[2].id,
        insurerName: '测试保险公司',
        policyNumber: 'PRIVATE-NOT-IN-AUDIT',
        coverageEnd: new Date('2026-07-01T00:00:00.000Z'), // 已过期存量也须首跑补提醒
      },
    });
    const teamPolicy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: '测试保险公司',
        policyNumber: 'TEAM-NOT-IN-NOTIFICATION',
        coverageStart: new Date('2025-08-01T00:00:00.000Z'),
        coverageEnd: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    const organization = await prisma.organization.create({
      data: { name: '提醒测试组织', nodeTypeCode: 'test-root' },
      select: { id: true },
    });
    const upcomingActivity = await prisma.activity.create({
      data: {
        title: '24 小时内活动提醒 13900000001',
        activityTypeCode: 'demo-activity-type',
        organizationId: organization.id,
        startAt: new Date(NOW.getTime() + 12 * 3_600_000),
        endAt: new Date(NOW.getTime() + 14 * 3_600_000),
        location: 'https://cos.example/x?q-signature=abc&q-ak=AKID123',
        statusCode: 'published',
      },
    });
    await prisma.activityRegistration.createMany({
      data: [
        { activityId: upcomingActivity.id, memberId: members[0].id, statusCode: 'pass' },
        { activityId: upcomingActivity.id, memberId: members[1].id, statusCode: 'pending' },
      ],
    });

    const first = await job.runOnce(NOW);
    expect(first).toEqual({
      activityReminderCandidates: 1,
      activityRemindersDispatched: 1,
      certificateReminderCandidates: 1,
      certificateRemindersDispatched: 1,
      certificateExpiryCandidates: 1,
      certificatesExpired: 1,
      certificateExpiryNotificationsDispatched: 1,
      memberInsuranceCandidates: 1,
      memberInsuranceNotificationsDispatched: 1,
      teamPolicyCandidates: 1,
      teamPolicyNotificationsDispatched: 1,
      failed: 0,
    });

    const [remindedCert, expiredCert, perpetual, outsideWindow, insurance, policy, activity] =
      await Promise.all([
        prisma.certificate.findUniqueOrThrow({ where: { id: certificateReminder.id } }),
        prisma.certificate.findUniqueOrThrow({ where: { id: certificateExpired.id } }),
        prisma.certificate.findUniqueOrThrow({ where: { id: perpetualCertificate.id } }),
        prisma.certificate.findUniqueOrThrow({ where: { id: outsideWindowCertificate.id } }),
        prisma.memberInsurance.findUniqueOrThrow({ where: { id: memberInsurance.id } }),
        prisma.teamInsurancePolicy.findUniqueOrThrow({ where: { id: teamPolicy.id } }),
        prisma.activity.findUniqueOrThrow({ where: { id: upcomingActivity.id } }),
      ]);
    expect(remindedCert.expireNotifyDueAt?.toISOString()).toBe(NOW.toISOString());
    expect(expiredCert.certStatusCode).toBe('expired');
    expect(perpetual.expireNotifyDueAt).toBeNull();
    expect(perpetual.certStatusCode).toBe('verified');
    expect(outsideWindow.expireNotifyDueAt).toBeNull();
    expect(insurance.expireNotifiedAt?.toISOString()).toBe(NOW.toISOString());
    expect(policy.expireNotifiedAt?.toISOString()).toBe(NOW.toISOString());
    expect(activity.startReminderSentAt?.toISOString()).toBe(NOW.toISOString());
    expect(activity.title).toBe('24 小时内活动提醒 13900000001');
    expect(activity.location).toBe('https://cos.example/x?q-signature=abc&q-ak=AKID123');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'certificate.expire', resourceId: certificateExpired.id },
    });
    expect(audit.actorUserId).toBeNull();
    expect(audit.actorRoleSnap).toBeNull();
    expect(audit.context).toMatchObject({
      requestId: 'cron:expiry-reminder:2026-07-14',
      ip: null,
      ua: null,
      before: { certStatusCode: 'verified' },
      after: { certStatusCode: 'expired' },
    });
    expect(JSON.stringify(audit.context)).not.toMatch(/certNumber|policyNumber|password|secret/i);

    // 五个业务 marker/status/audit 与五个 root intents 已原子提交；worker 尚未执行任何 Effect。
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.notificationOutboxIntent.count({ where: { status: 'pending' } })).toBe(5);
    expect(await drainAll()).toBe(8); // 5 root + 3 targeted 微信 child(no-template)

    const activityNotifications = await prisma.notification.findMany({
      where: { notificationTypeCode: 'activity-reminder' },
    });
    expect(activityNotifications).toEqual([
      expect.objectContaining({
        title: '活动即将开始',
        body: expect.stringContaining('[REDACTED]'),
        audienceType: 'directed',
        recipientMemberId: members[0].id,
        channels: ['in-app'],
      }),
    ]);
    expect(activityNotifications[0].body).not.toContain('13900000001');
    expect(activityNotifications[0].body).not.toContain('q-signature');

    const notifications = await prisma.notification.findMany({
      where: { notificationTypeCode: 'expiry-reminder' },
      orderBy: { createdAt: 'asc' },
    });
    expect(notifications).toHaveLength(4);
    expect(notifications.filter((row) => row.audienceType === 'directed')).toHaveLength(3);
    expect(notifications.filter((row) => row.audienceType === 'broadcast')).toEqual([
      expect.objectContaining({
        title: '队保单即将到期',
        visibilityCode: 'management',
        sourceType: 'system',
        channels: ['in-app'],
        recipientMemberId: null,
        authorUserId: null,
      }),
    ]);
    expect(JSON.stringify(notifications)).not.toContain('PRIVATE-NOT-IN-AUDIT');
    expect(JSON.stringify(notifications)).not.toContain('TEAM-NOT-IN-NOTIFICATION');
    expect(await prisma.notificationDelivery.count({ where: { reasonCode: 'no-template' } })).toBe(
      3,
    );

    const intentCountBeforeSecondRun = await prisma.notificationOutboxIntent.count();
    const second = await job.runOnce(NOW);
    expect(second).toEqual({
      activityReminderCandidates: 0,
      activityRemindersDispatched: 0,
      certificateReminderCandidates: 0,
      certificateRemindersDispatched: 0,
      certificateExpiryCandidates: 0,
      certificatesExpired: 0,
      certificateExpiryNotificationsDispatched: 0,
      memberInsuranceCandidates: 0,
      memberInsuranceNotificationsDispatched: 0,
      teamPolicyCandidates: 0,
      teamPolicyNotificationsDispatched: 0,
      failed: 0,
    });
    expect(await drainAll()).toBe(0);
    expect(await prisma.notificationOutboxIntent.count()).toBe(intentCountBeforeSecondRun);
    expect(
      await prisma.notification.count({ where: { notificationTypeCode: 'expiry-reminder' } }),
    ).toBe(4);
    expect(
      await prisma.notification.count({ where: { notificationTypeCode: 'activity-reminder' } }),
    ).toBe(1);
    expect(await prisma.auditLog.count({ where: { event: 'certificate.expire' } })).toBe(1);
  });

  it('活动零 pass 首跑不写 marker/intent，新增 pass 后二跑才原子写 marker+intent', async () => {
    const member = await prisma.member.create({
      data: { memberNo: 'ER-ZERO-PASS', displayName: '后续通过者', status: 'ACTIVE' },
    });
    const organization = await prisma.organization.create({
      data: { name: '零收件人提醒组织', nodeTypeCode: 'test-root' },
    });
    const activity = await prisma.activity.create({
      data: {
        title: '先无通过报名的活动',
        activityTypeCode: 'demo-activity-type',
        organizationId: organization.id,
        startAt: new Date(NOW.getTime() + 10 * 3_600_000),
        endAt: new Date(NOW.getTime() + 12 * 3_600_000),
        location: '测试地点',
        statusCode: 'published',
      },
    });

    const first = await job.runOnce(NOW);
    expect(first.activityReminderCandidates).toBe(1);
    expect(first.activityRemindersDispatched).toBe(0);
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: activity.id } })).startReminderSentAt,
    ).toBeNull();
    expect(
      await prisma.notificationOutboxIntent.count({
        where: { aggregateType: 'activity', aggregateId: activity.id },
      }),
    ).toBe(0);

    await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'pass' },
    });
    const second = await job.runOnce(NOW);
    expect(second.activityReminderCandidates).toBe(1);
    expect(second.activityRemindersDispatched).toBe(1);
    expect(
      (
        await prisma.activity.findUniqueOrThrow({ where: { id: activity.id } })
      ).startReminderSentAt?.toISOString(),
    ).toBe(NOW.toISOString());
    expect(
      await prisma.notificationOutboxIntent.count({
        where: { aggregateType: 'activity', aggregateId: activity.id },
      }),
    ).toBe(1);
    expect(await drainAll()).toBe(1);
    expect(
      await prisma.notification.count({
        where: { notificationTypeCode: 'activity-reminder', recipientMemberId: member.id },
      }),
    ).toBe(1);
  });

  // 证书标准库 PR-1 · 冻结稿 §10.5 边界实证(真实 DB)。
  //
  // `expiredAt` 是**最后有效日**,所以最后有效日 = today 的证书:
  //   - **不得**被过期扫描翻成 expired(`expiredAt < today` 严格小于);
  //   - **必须**进提醒窗(`expiredAt BETWEEN today AND today+60`,含 today)。
  // 修正前两条同时错:当天 09:00 就被翻 expired,且从没进过提醒窗。
  //
  // 本用例只断言自己创建的两行,不碰全局 intent/notification 计数 ——
  // 本 spec 只在 beforeAll 做一次 resetDb,同文件用例共享库状态,
  // 全局计数会被前面用例的残留干扰(那是脆弱断言,不是本用例要证的事)。
  it('§10.5:最后有效日 = today 仍 verified 且进提醒窗;前一天才过期', async () => {
    const member = await prisma.member.create({
      data: { memberNo: 'ER9001', displayName: '边界证书', status: 'ACTIVE' },
    });
    const lastValidDayIsToday = await prisma.certificate.create({
      data: {
        memberId: member.id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: new Date('2026-07-14T00:00:00.000Z'), // = today
        certStatusCode: 'verified',
      },
    });
    const lastValidDayWasYesterday = await prisma.certificate.create({
      data: {
        memberId: member.id,
        ...certStd.certificateColumns,
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: new Date('2026-07-13T00:00:00.000Z'), // = today - 1
        certStatusCode: 'verified',
      },
    });

    await job.runOnce(NOW);

    const [todayRow, yesterdayRow] = await Promise.all([
      prisma.certificate.findUniqueOrThrow({ where: { id: lastValidDayIsToday.id } }),
      prisma.certificate.findUniqueOrThrow({ where: { id: lastValidDayWasYesterday.id } }),
    ]);

    // today = 最后有效日 → 仍有效,且已被提醒(水印落在本次 run 的 claimedAt)。
    expect(todayRow.certStatusCode).toBe('verified');
    expect(todayRow.expireNotifyDueAt?.toISOString()).toBe(NOW.toISOString());

    // today-1 → 已过最后有效日,翻 expired;过期路径不写提醒水印。
    expect(yesterdayRow.certStatusCode).toBe('expired');
    expect(yesterdayRow.expireNotifyDueAt).toBeNull();
  });
});

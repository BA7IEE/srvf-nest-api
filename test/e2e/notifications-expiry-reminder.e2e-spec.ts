import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import { ExpiryReminderService } from '../../src/modules/notifications/expiry-reminder.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const NOW = new Date('2026-07-14T09:00:00+08:00');

describe('到期提醒 job（真实 DB 直调 runOnce）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let job: ExpiryReminderService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    job = app.get(ExpiryReminderService);
    await resetDb(app);

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
        certTypeCode: 'first-aid',
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-08-01T00:00:00.000Z'),
        expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        certStatusCode: 'verified',
      },
    });
    const certificateExpired = await prisma.certificate.create({
      data: {
        memberId: members[1].id,
        certTypeCode: 'first-aid',
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: new Date('2026-07-14T00:00:00.000Z'),
        certStatusCode: 'verified',
        verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
      },
    });
    const perpetualCertificate = await prisma.certificate.create({
      data: {
        memberId: members[0].id,
        certTypeCode: 'perpetual',
        issuingOrg: '测试机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiredAt: null,
        certStatusCode: 'verified',
      },
    });
    const outsideWindowCertificate = await prisma.certificate.create({
      data: {
        memberId: members[0].id,
        certTypeCode: 'long-term',
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
        title: '24 小时内活动提醒',
        activityTypeCode: 'demo-activity-type',
        organizationId: organization.id,
        startAt: new Date(NOW.getTime() + 12 * 3_600_000),
        endAt: new Date(NOW.getTime() + 14 * 3_600_000),
        location: '测试地点',
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

    const activityNotifications = await prisma.notification.findMany({
      where: { notificationTypeCode: 'activity-reminder' },
    });
    expect(activityNotifications).toEqual([
      expect.objectContaining({
        title: '活动即将开始',
        audienceType: 'directed',
        recipientMemberId: members[0].id,
        channels: ['in-app'],
      }),
    ]);

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
    expect(
      await prisma.notification.count({ where: { notificationTypeCode: 'expiry-reminder' } }),
    ).toBe(4);
    expect(
      await prisma.notification.count({ where: { notificationTypeCode: 'activity-reminder' } }),
    ).toBe(1);
    expect(await prisma.auditLog.count({ where: { event: 'certificate.expire' } })).toBe(1);
  });
});

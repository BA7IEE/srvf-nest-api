import {
  addDateOnlyDays,
  ExpiryReminderService,
  toBeijingDateOnly,
} from './expiry-reminder.service';

interface TargetedCallInput {
  channels?: string[];
  notificationTypeCode: string;
}

interface CertificateFindManyInput {
  where: { expiredAt?: { gt: Date; lte: Date } };
}

describe('ExpiryReminderService · runOnce', () => {
  function build() {
    const certificateFindMany = jest.fn().mockResolvedValue([]);
    const certificateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txCertificateFindFirst = jest.fn();
    const txCertificateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      certificate: {
        findFirst: txCertificateFindFirst,
        updateMany: txCertificateUpdateMany,
      },
    };
    const prisma = {
      certificate: {
        findMany: certificateFindMany,
        updateMany: certificateUpdateMany,
      },
      memberInsurance: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      teamInsurancePolicy: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = {
      dispatchTargeted: jest.fn().mockResolvedValue({ id: 'notification-directed' }),
      dispatchSystemBroadcast: jest.fn().mockResolvedValue({ id: 'notification-broadcast' }),
    };
    const service = new ExpiryReminderService(
      prisma as never,
      auditLogs as never,
      dispatcher as never,
    );
    return {
      service,
      prisma,
      tx,
      auditLogs,
      dispatcher,
      certificateFindMany,
      certificateUpdateMany,
      txCertificateFindFirst,
      txCertificateUpdateMany,
    };
  }

  it('北京时间日界与日期窗口稳定：15:59Z 仍为当日，16:00Z 进入次日', () => {
    expect(toBeijingDateOnly(new Date('2026-07-14T15:59:59.999Z')).toISOString()).toBe(
      '2026-07-14T00:00:00.000Z',
    );
    expect(toBeijingDateOnly(new Date('2026-07-14T16:00:00.000Z')).toISOString()).toBe(
      '2026-07-15T00:00:00.000Z',
    );
    expect(addDateOnlyDays(new Date('2026-07-14T00:00:00.000Z'), 60).toISOString()).toBe(
      '2026-09-12T00:00:00.000Z',
    );
  });

  it('四路径命中：证书预提醒、到期翻态+audit、个人保险、队保单广播；个人均声明站内+微信', async () => {
    const fixture = build();
    fixture.certificateFindMany
      .mockResolvedValueOnce([
        {
          id: 'cert-reminder',
          memberId: 'member-1',
          expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: 'cert-expired' }]);
    fixture.txCertificateFindFirst.mockResolvedValue({
      id: 'cert-expired',
      memberId: 'member-2',
      certTypeCode: 'first-aid',
      certStatusCode: 'verified',
      expiredAt: new Date('2026-07-14T00:00:00.000Z'),
      verifiedBy: 'reviewer-member',
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    fixture.prisma.memberInsurance.findMany.mockResolvedValue([
      {
        id: 'member-insurance-1',
        memberId: 'member-3',
        coverageEnd: new Date('2026-07-30T00:00:00.000Z'),
      },
    ]);
    fixture.prisma.teamInsurancePolicy.findMany.mockResolvedValue([
      { id: 'team-policy-1', coverageEnd: new Date('2026-07-01T00:00:00.000Z') },
    ]);

    const summary = await fixture.service.runOnce(new Date('2026-07-14T09:00:00+08:00'));

    expect(summary).toEqual({
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
    expect(fixture.dispatcher.dispatchTargeted).toHaveBeenCalledTimes(3);
    const targetedCalls = fixture.dispatcher.dispatchTargeted.mock.calls as Array<
      [TargetedCallInput]
    >;
    for (const [input] of targetedCalls) {
      expect(input.channels).toEqual(['in-app', 'wechat']);
      expect(input.notificationTypeCode).toBe('expiry-reminder');
    }
    expect(fixture.dispatcher.dispatchSystemBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ notificationTypeCode: 'expiry-reminder', title: '队保单已到期' }),
    );
    expect(fixture.auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'certificate.expire',
        actorUserId: null,
        actorRoleSnap: null,
        resourceType: 'certificate',
        resourceId: 'cert-expired',
        meta: {
          requestId: 'cron:expiry-reminder:2026-07-14',
          ip: null,
          ua: null,
        },
        tx: fixture.tx,
      }),
    );
    const auditCalls = fixture.auditLogs.log.mock.calls as Array<[Record<string, unknown>]>;
    const auditInput = auditCalls[0][0];
    expect(JSON.stringify(auditInput)).not.toMatch(/certNumber|policyNumber|password|secret/i);
  });

  it('查询窗口跳过终身证书；条件 claim 失败视为并发败者，不派发', async () => {
    const fixture = build();
    fixture.certificateFindMany
      .mockResolvedValueOnce([
        {
          id: 'cert-raced',
          memberId: 'member-1',
          expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    fixture.certificateUpdateMany.mockResolvedValueOnce({ count: 0 });

    const summary = await fixture.service.runOnce(new Date('2026-07-14T09:00:00+08:00'));

    const findManyCalls = fixture.certificateFindMany.mock.calls as Array<
      [CertificateFindManyInput]
    >;
    expect(findManyCalls[0][0].where.expiredAt).toEqual({
      gt: new Date('2026-07-14T00:00:00.000Z'),
      lte: new Date('2026-09-12T00:00:00.000Z'),
    });
    expect(summary.certificateReminderCandidates).toBe(1);
    expect(summary.certificateRemindersDispatched).toBe(0);
    expect(fixture.dispatcher.dispatchTargeted).not.toHaveBeenCalled();
  });

  it('单项派发失败不阻断后续路径；marker 已 claim 的接受边界由 failed 计数留痕', async () => {
    const fixture = build();
    fixture.certificateFindMany
      .mockResolvedValueOnce([
        {
          id: 'cert-fails',
          memberId: 'member-1',
          expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    fixture.prisma.memberInsurance.findMany.mockResolvedValue([
      {
        id: 'insurance-succeeds',
        memberId: 'member-2',
        coverageEnd: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    fixture.dispatcher.dispatchTargeted
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({ id: 'notification-after-failure' });

    const summary = await fixture.service.runOnce(new Date('2026-07-14T09:00:00+08:00'));

    expect(summary.failed).toBe(1);
    expect(summary.certificateRemindersDispatched).toBe(0);
    expect(summary.memberInsuranceNotificationsDispatched).toBe(1);
    expect(fixture.dispatcher.dispatchTargeted).toHaveBeenCalledTimes(2);
  });
});

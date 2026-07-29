import {
  addDateOnlyDays,
  ExpiryReminderService,
  toBeijingDateOnly,
} from './expiry-reminder.service';

describe('ExpiryReminderService · transactional outbox', () => {
  function build() {
    const activityFindMany = jest.fn().mockResolvedValue([]);
    const activityUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const registrationFindMany = jest.fn().mockResolvedValue([]);
    const certificateFindMany = jest.fn().mockResolvedValue([]);
    const certificateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const certificateFindFirst = jest.fn();
    const memberInsuranceFindMany = jest.fn().mockResolvedValue([]);
    const memberInsuranceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const teamPolicyFindMany = jest.fn().mockResolvedValue([]);
    const teamPolicyUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      activity: { updateMany: activityUpdateMany },
      activityRegistration: { findMany: registrationFindMany },
      certificate: { findFirst: certificateFindFirst, updateMany: certificateUpdateMany },
      memberInsurance: { updateMany: memberInsuranceUpdateMany },
      teamInsurancePolicy: { updateMany: teamPolicyUpdateMany },
    };
    const prisma = {
      activity: { findMany: activityFindMany },
      certificate: { findMany: certificateFindMany },
      memberInsurance: { findMany: memberInsuranceFindMany },
      teamInsurancePolicy: { findMany: teamPolicyFindMany },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'intent' }) };
    const service = new ExpiryReminderService(prisma as never, auditLogs as never, outbox as never);
    return {
      service,
      prisma,
      tx,
      auditLogs,
      outbox,
      activityFindMany,
      activityUpdateMany,
      registrationFindMany,
      certificateFindMany,
      certificateUpdateMany,
      certificateFindFirst,
      memberInsuranceFindMany,
      memberInsuranceUpdateMany,
      teamPolicyFindMany,
      teamPolicyUpdateMany,
    };
  }

  it('北京时间日界与日期窗口稳定', () => {
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

  // ============ 证书标准库 PR-1 · 冻结稿 §10.5 日期边界 ============
  //
  // §10.1 定死 `expiredAt` = **最后有效日**(2026-08-01 表示当天仍有效,08-02 起失效)。
  // 由此 §10.5 的两条 cron 谓词是:
  //   自动过期    status=verified AND expiredAt <  today
  //   提前 60 天  status=verified AND expiredAt BETWEEN today AND today+60
  //
  // 修正前本 service 用 `expiredAt <= today` 过期(最后有效日当天 09:00 就翻 expired,
  // **早一天**)、用 `expiredAt > today` 提醒(把到期日=今天的证书排除在提醒窗外)。
  // 三处过期谓词(外层 findMany / 事务内 findFirst / 原子 updateMany)必须同时收紧,
  // 漏一处就会出现「选中了却 claim 不到」或反过来的静默漂移。
  describe('§10.5 日期边界 — expiredAt 是最后有效日', () => {
    const NOW = new Date('2026-07-14T09:00:00+08:00'); // 北京 07-14 09:00
    const TODAY = new Date('2026-07-14T00:00:00.000Z');
    const TODAY_PLUS_60 = new Date('2026-09-12T00:00:00.000Z');

    // build() 的 mock 是无类型 jest.fn(),直接下标取 mock.calls 会触发
    // no-unsafe-member-access;先把整个 calls 数组收敛成已知形状再取。
    type WhereArgs = [{ where: { expiredAt: unknown } }];
    function whereOf(mock: { mock: { calls: unknown[] } }, callIndex: number): unknown {
      const calls = mock.mock.calls as WhereArgs[];
      return calls[callIndex][0].where.expiredAt;
    }

    it('过期扫描用 expiredAt < today(不含最后有效日当天)', async () => {
      const f = build();
      await f.service.runOnce(NOW);

      // certificate.findMany 调用序:[0]=提醒扫描,[1]=过期扫描。
      expect(whereOf(f.certificateFindMany, 1)).toEqual({ lt: TODAY });
    });

    it('提醒窗用 expiredAt BETWEEN today AND today+60(含到期日=今天)', async () => {
      const f = build();
      await f.service.runOnce(NOW);

      expect(whereOf(f.certificateFindMany, 0)).toEqual({ gte: TODAY, lte: TODAY_PLUS_60 });
    });

    it('最后有效日当天的证书不被过期:事务内 findFirst 与 updateMany 同用 lt today', async () => {
      const f = build();
      f.certificateFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'cert-expired' }]);
      f.certificateFindFirst.mockResolvedValue({
        id: 'cert-expired',
        memberId: 'member-2',
        certTypeCode: 'first-aid',
        certStatusCode: 'verified',
        expiredAt: new Date('2026-07-13T00:00:00.000Z'),
        verifiedBy: 'reviewer',
        verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      await f.service.runOnce(NOW);

      // 三处谓词必须同口径,漏一处就会「扫到却 claim 不到」空转。
      expect(whereOf(f.certificateFindFirst, 0)).toEqual({ lt: TODAY });
      expect(whereOf(f.certificateUpdateMany, 0)).toEqual({ lt: TODAY });
    });

    it('提醒 claim 的原子 updateMany 与外层扫描同窗口(gte today)', async () => {
      const f = build();
      f.certificateFindMany
        .mockResolvedValueOnce([{ id: 'cert-reminder', memberId: 'member-1', expiredAt: TODAY }])
        .mockResolvedValueOnce([]);

      const summary = await f.service.runOnce(NOW);

      // 到期日 = 今天仍应进提醒窗(旧 `gt today` 会直接漏掉这条)。
      expect(summary.certificateRemindersDispatched).toBe(1);
      expect(whereOf(f.certificateUpdateMany, 0)).toEqual({ gte: TODAY, lte: TODAY_PLUS_60 });
    });
  });

  // 证书标准库 PR-1(冻结稿 §10.5):`expiredAt` 是**最后有效日**,过期条件是
  // `expiredAt < today`。本 fixture 原为 `2026-07-14`(= today,旧 `lte` 口径下会过期);
  // 新口径下最后有效日当天仍有效,故下移一天到真正已过期的 07-13,让本用例继续
  // 覆盖 expire 路径。这是 fixture 随语义修正,不是放宽断言(边界本身由下方
  // 「§10.5 日期边界」用例独立钉住)。
  it('marker/status/audit 与各 intent 使用同一个 transaction client', async () => {
    const f = build();
    f.certificateFindMany
      .mockResolvedValueOnce([
        {
          id: 'cert-reminder',
          memberId: 'member-1',
          expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: 'cert-expired' }]);
    f.certificateFindFirst.mockResolvedValue({
      id: 'cert-expired',
      memberId: 'member-2',
      certTypeCode: 'first-aid',
      certStatusCode: 'verified',
      expiredAt: new Date('2026-07-13T00:00:00.000Z'),
      verifiedBy: 'reviewer',
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    f.memberInsuranceFindMany.mockResolvedValue([
      {
        id: 'insurance-1',
        memberId: 'member-3',
        coverageEnd: new Date('2026-07-30T00:00:00.000Z'),
      },
    ]);
    f.teamPolicyFindMany.mockResolvedValue([
      { id: 'policy-1', coverageEnd: new Date('2026-07-01T00:00:00.000Z') },
    ]);

    const summary = await f.service.runOnce(new Date('2026-07-14T09:00:00+08:00'));
    expect(summary).toMatchObject({
      certificateRemindersDispatched: 1,
      certificatesExpired: 1,
      certificateExpiryNotificationsDispatched: 1,
      memberInsuranceNotificationsDispatched: 1,
      teamPolicyNotificationsDispatched: 1,
      failed: 0,
    });
    expect(f.outbox.enqueue).toHaveBeenCalledTimes(4);
    expect(f.outbox.enqueue).toHaveBeenNthCalledWith(1, expect.anything(), f.tx);
    expect(f.outbox.enqueue).toHaveBeenNthCalledWith(2, expect.anything(), f.tx);
    expect(f.outbox.enqueue).toHaveBeenNthCalledWith(3, expect.anything(), f.tx);
    expect(f.outbox.enqueue).toHaveBeenNthCalledWith(4, expect.anything(), f.tx);
    expect(f.auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'certificate.expire', tx: f.tx }),
    );
    const payloadDump = JSON.stringify(f.outbox.enqueue.mock.calls);
    expect(payloadDump).not.toMatch(/phone|openid|token|secret|credential|signedUrl/i);
  });

  it('活动 marker claim 与去重后的全部收件人 intent 同事务；并发败者零 intent', async () => {
    const f = build();
    const now = new Date('2026-07-14T01:00:00.000Z');
    f.activityFindMany.mockResolvedValue([
      {
        id: 'activity-upcoming',
        title: '山野训练',
        startAt: new Date('2026-07-15T00:00:00.000Z'),
        location: '梧桐山',
      },
    ]);
    f.registrationFindMany.mockResolvedValue([
      { memberId: 'member-1' },
      { memberId: 'member-1' },
      { memberId: 'member-2' },
    ]);
    const first = await f.service.runOnce(now);
    expect(first.activityRemindersDispatched).toBe(2);
    expect(f.outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(f.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { startReminderSentAt: now } }),
    );

    f.outbox.enqueue.mockClear();
    f.activityUpdateMany.mockResolvedValue({ count: 0 });
    const second = await f.service.runOnce(now);
    expect(second.activityRemindersDispatched).toBe(0);
    expect(f.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('活动零 pass 收件人时不 claim marker，后续新增 pass 仍可入队', async () => {
    const f = build();
    const now = new Date('2026-07-14T01:00:00.000Z');
    f.activityFindMany.mockResolvedValue([
      {
        id: 'activity-zero-pass',
        title: '山野训练',
        startAt: new Date('2026-07-15T00:00:00.000Z'),
        location: '梧桐山',
      },
    ]);
    f.registrationFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ memberId: 'member-later-pass' }]);

    const first = await f.service.runOnce(now);
    expect(first.activityRemindersDispatched).toBe(0);
    expect(f.activityUpdateMany).not.toHaveBeenCalled();
    expect(f.outbox.enqueue).not.toHaveBeenCalled();

    const second = await f.service.runOnce(now);
    expect(second.activityRemindersDispatched).toBe(1);
    expect(f.activityUpdateMany).toHaveBeenCalledTimes(1);
    expect(f.outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('一条事务内 enqueue 失败只记 failed，后续资源继续处理', async () => {
    const f = build();
    f.certificateFindMany
      .mockResolvedValueOnce([
        {
          id: 'cert-fails',
          memberId: 'member-1',
          expiredAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    f.memberInsuranceFindMany.mockResolvedValue([
      {
        id: 'insurance-ok',
        memberId: 'member-2',
        coverageEnd: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    f.outbox.enqueue
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({ id: 'intent-ok' });

    const summary = await f.service.runOnce(new Date('2026-07-14T09:00:00+08:00'));
    expect(summary.failed).toBe(1);
    expect(summary.certificateRemindersDispatched).toBe(0);
    expect(summary.memberInsuranceNotificationsDispatched).toBe(1);
  });
});

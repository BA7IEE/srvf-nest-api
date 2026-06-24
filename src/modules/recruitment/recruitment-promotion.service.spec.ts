import * as bcrypt from 'bcryptjs';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  PROMOTE_TX_TIMEOUT_MS,
  RecruitmentPromotionService,
} from './recruitment-promotion.service';

// bcryptjs 的 hash 属性不可重定义(jest.spyOn 会 throw),故整模块 mock 为可计数 jest.fn。
jest.mock('bcryptjs', () => ({ hash: jest.fn() }));

// 招新二期 promote 超时硬化(B 档)· 结构断言(不依赖计时,避免 flaky):
// ① bcrypt(rounds=10,~80ms/个)必须在 $transaction **之外**预算完成 —— 杜绝串行 bcrypt
//    撑爆事务超时(大批量公示 → 整批回滚发不出号);
// ② $transaction 必须传显式 timeout(远超 Prisma 默认 5s)。
// 以单测精确锁定调用顺序:记录 bcrypt.hash 与 tx 回调的进出事件,断言所有 bcrypt 事件先于
// tx 回调开始、且回调内零 bcrypt;并断言 $transaction 第二参为 { timeout: PROMOTE_TX_TIMEOUT_MS }。

describe('RecruitmentPromotionService · promote 超时硬化(bcrypt 移出事务 + 显式 timeout)', () => {
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-19T00:00:00.000Z');
  const user = { id: 'admin1', role: 'SUPER_ADMIN' } as unknown as CurrentUserPayload;

  // N 个可发号 publicity 报名(直接构造,绕开提交链路;字段满足 isPromotable + promote 逐字段读取)
  function buildApps(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `app-${i}`,
      openid: `openid-${i}`,
      realName: `报名${String(i).padStart(2, '0')}`,
      genderCode: i % 2 === 0 ? 'male' : 'female',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      isForeigner: false,
      documentTypeCode: 'mainland_id',
      idCardNumber: `IDCARD${String(i).padStart(4, '0')}`,
      phone: `1390000${String(i).padStart(4, '0')}`,
      idCardImageKey: null,
      emergencyContacts: null,
      profileExtra: null,
      detailedAddress: '北京市朝阳区某街道 1 号',
      tempNo: `T2026${String(i + 1).padStart(4, '0')}`,
      createdAt: new Date('2026-06-18T00:00:00.000Z'),
    }));
  }

  function buildService(
    n: number,
    customApps?: ReturnType<typeof buildApps>,
    opts: { volOrg?: { id: string; status: string } | null } = {},
  ) {
    const events: string[] = [];
    let txOptions: { timeout?: number; maxWait?: number } | undefined;

    // bcrypt.hash 全程 mock(快速、可计数):每次调用记一条事件
    const hashSpy = bcrypt.hash as unknown as jest.Mock;
    hashSpy.mockImplementation(() => {
      events.push('bcrypt');
      return Promise.resolve('hashed-pw');
    });

    const apps = customApps ?? buildApps(n);

    // 事务内 tx mock:cycle 自增回显本次 increment(= promotable 数,startSeq=0;支持去重后 <n)+ 各建表桩
    const txMock = {
      recruitmentCycle: {
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: { memberNoSeq: { increment: number } } }) =>
            Promise.resolve({ memberNoSeq: data.memberNoSeq.increment, year: 2026 }),
          ),
      },
      member: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: { memberNo: string } }) =>
            Promise.resolve({ id: `mem-${data.memberNo}` }),
          ),
      },
      user: { create: jest.fn().mockResolvedValue({ id: 'usr' }) },
      memberProfile: { create: jest.fn().mockResolvedValue({ id: 'prof' }) },
      emergencyContact: { create: jest.fn().mockResolvedValue({ id: 'ec' }) },
      // S5:promote 同事务建 VOL 归口部门(每个 member 一条)
      memberDepartment: { create: jest.fn().mockResolvedValue({ id: 'md' }) },
      recruitmentApplication: { update: jest.fn().mockResolvedValue({}) },
    };

    // S5:VOL 归口部门事务前解析(Organization.code='VOL' + ACTIVE);默认 ACTIVE,可注入缺失/inactive
    const volOrg = opts.volOrg === undefined ? { id: 'vol-org-id', status: 'ACTIVE' } : opts.volOrg;
    const orgFindFirst = jest.fn().mockResolvedValue(volOrg);
    // F16:openid 占用一次性批量查(findMany);默认无占用(返回 [])
    const userFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      recruitmentCycle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cyc1', deletedAt: null, year: 2026 }),
      },
      recruitmentApplication: {
        findMany: jest.fn().mockResolvedValue(apps),
      },
      organization: { findFirst: orgFindFirst },
      user: { findMany: userFindMany },
      // $transaction:记录进出事件 + 第二参(超时选项),在回调内运行桩 tx
      $transaction: jest
        .fn()
        .mockImplementation(
          async (
            cb: (tx: unknown) => Promise<unknown>,
            opts?: { timeout?: number; maxWait?: number },
          ) => {
            txOptions = opts;
            events.push('tx:start');
            const result = await cb(txMock);
            events.push('tx:end');
            return result;
          },
        ),
    };

    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };

    const service = new RecruitmentPromotionService(
      prisma as never,
      rbac as never,
      auditLogs as never,
    );

    return {
      service,
      events,
      hashSpy,
      txMock,
      userFindMany,
      orgFindFirst,
      getTxOptions: () => txOptions,
    };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('bcrypt 在事务之外预算 n 个、事务回调内零 bcrypt;$transaction 传显式 timeout', async () => {
    const n = 5;
    const { service, events, hashSpy, txMock, getTxOptions } = buildService(n);

    const res = await service.promote('cyc1', user, meta, now);

    expect(res.promotedCount).toBe(n);
    expect(res.skippedCount).toBe(0);

    // ① bcrypt 调用次数 = n(每个发号项一个随机口令哈希)
    expect(hashSpy).toHaveBeenCalledTimes(n);

    // ② 结构:所有 bcrypt 事件严格先于 tx 回调开始,且回调内(tx:start 之后)零 bcrypt
    const txStartIdx = events.indexOf('tx:start');
    expect(txStartIdx).toBe(n); // 前 n 个事件全是 bcrypt
    expect(events.slice(0, txStartIdx)).toEqual(Array<string>(n).fill('bcrypt'));
    expect(events.slice(txStartIdx)).not.toContain('bcrypt');

    // ③ $transaction 传了显式 timeout(远超 Prisma 默认 5s)
    expect(getTxOptions()).toEqual({ timeout: PROMOTE_TX_TIMEOUT_MS });
    expect(PROMOTE_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);

    // 事务内仍逐个建 User(取预算哈希):n 次
    expect(txMock.user.create).toHaveBeenCalledTimes(n);
  });

  it('空公示集:零 bcrypt、零建表,仍走带 timeout 的事务(原子模型不变);不解析 VOL、不建部门', async () => {
    const { service, events, hashSpy, txMock, orgFindFirst, getTxOptions } = buildService(0);

    const res = await service.promote('cyc1', user, meta, now);

    expect(res.promotedCount).toBe(0);
    expect(hashSpy).not.toHaveBeenCalled();
    expect(events).not.toContain('bcrypt');
    expect(txMock.user.create).not.toHaveBeenCalled();
    // S5:空批不要求 VOL 存在(promotable=0 → 跳过解析),也不建任何 VOL 部门
    expect(orgFindFirst).not.toHaveBeenCalled();
    expect(txMock.memberDepartment.create).not.toHaveBeenCalled();
    expect(getTxOptions()).toEqual({ timeout: PROMOTE_TX_TIMEOUT_MS });
  });

  // ===== #399 P3 promote 健壮批(F12 即时清漏 / F15 批内 openid 去重 / F16 N+1)=====

  it('F12(#399):promote 即时清的 update 同时置 openid=null + reviewNote=null', async () => {
    const { service, txMock } = buildService(2);
    await service.promote('cyc1', user, meta, now);
    expect(txMock.recruitmentApplication.update).toHaveBeenCalledTimes(2);
    const updateCalls = txMock.recruitmentApplication.update.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    for (const [{ data }] of updateCalls) {
      expect(data).toMatchObject({
        statusCode: 'promoted',
        sensitivePurgedAt: now,
        openid: null, // F12:原先漏清 → 在 sensitivePurgedAt 已置行永久残留
        reviewNote: null, // F12:同上
        realName: null,
        idCardNumber: null,
      });
    }
  });

  it('F16(#399):openid 占用批量查一次(user.findMany)而非逐行 findFirst(N→1)', async () => {
    const { service, userFindMany } = buildService(5);
    await service.promote('cyc1', user, meta, now);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    const findManyCalls = userFindMany.mock.calls as Array<
      [{ where: { openid: { in: string[] } }; select: { openid: boolean } }]
    >;
    const arg = findManyCalls[0][0];
    // 单次 in 查询覆盖全部候选 openid(N→1,非逐行 findFirst)
    expect(arg.where.openid.in).toHaveLength(5);
    expect(arg.where.openid.in).toContain('openid-0');
    expect(arg.where.openid.in).toContain('openid-4');
    expect(arg.select).toEqual({ openid: true });
  });

  it('F15(#399):同批共享 openid → 仅发号序首行发号、次行 skip(duplicate-openid-in-batch),不整批回滚', async () => {
    const apps = buildApps(3);
    apps[1].openid = apps[0].openid; // 报名00 与 报名01 共享同一 openid(原先第二行入事务撞 @unique → 整批回滚)
    const { service, txMock } = buildService(0, apps);

    const res = await service.promote('cyc1', user, meta, now);

    // 去重后 2 发号(共享 openid 仅首行)+ 1 skip;不整批回滚(否则 promotedCount=0)
    expect(res.promotedCount).toBe(2);
    expect(res.skippedCount).toBe(1);
    expect(res.skipped[0].reason).toBe('duplicate-openid-in-batch');
    expect(txMock.user.create).toHaveBeenCalledTimes(2);
  });

  // ===== S5(招新闭环优化;评审稿 §5.2a):promote 志愿者化 + VOL 归口部门 =====

  it('S5:promote 建 member 即 gradeCode=volunteer + 每人一条 VOL 部门;VOL 事务前解析一次;号段连续', async () => {
    const n = 3;
    const { service, txMock, orgFindFirst } = buildService(n);

    const res = await service.promote('cyc1', user, meta, now);
    expect(res.promotedCount).toBe(n);

    // VOL 归口部门事务前解析一次(Organization.code='VOL' + 未软删)
    expect(orgFindFirst).toHaveBeenCalledTimes(1);
    const orgCalls = orgFindFirst.mock.calls as Array<
      [{ where: { code: string; deletedAt: null } }]
    >;
    expect(orgCalls[0][0]).toMatchObject({ where: { code: 'VOL', deletedAt: null } });

    // 每个 member.create 都带 gradeCode='volunteer'(志愿者身份显式化),号段连续无空洞(26001..26003)
    const memberCreateCalls = txMock.member.create.mock.calls as Array<
      [{ data: { gradeCode?: string; memberNo: string } }]
    >;
    expect(memberCreateCalls).toHaveLength(n);
    expect(memberCreateCalls.map(([{ data }]) => data.gradeCode)).toEqual([
      'volunteer',
      'volunteer',
      'volunteer',
    ]);
    expect(memberCreateCalls.map(([{ data }]) => data.memberNo)).toEqual([
      '26001',
      '26002',
      '26003',
    ]);

    // 每人一条 VOL 归口部门(organizationId = 解析出的 VOL id;不双建)
    const mdCalls = txMock.memberDepartment.create.mock.calls as Array<
      [{ data: { memberId: string; organizationId: string } }]
    >;
    expect(mdCalls).toHaveLength(n);
    expect(mdCalls.every(([{ data }]) => data.organizationId === 'vol-org-id')).toBe(true);
  });

  it('S5:VOL 归口部门缺失 → 28044 清晰失败,事务前抛、零建 member/部门(不留半成品)', async () => {
    const { service, txMock, orgFindFirst } = buildService(2, undefined, { volOrg: null });

    await expect(service.promote('cyc1', user, meta, now)).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE,
    });
    expect(orgFindFirst).toHaveBeenCalledTimes(1);
    expect(txMock.member.create).not.toHaveBeenCalled();
    expect(txMock.memberDepartment.create).not.toHaveBeenCalled();
  });

  it('S5:VOL 归口部门非 ACTIVE → 28044(同样不建 member)', async () => {
    const { service, txMock } = buildService(2, undefined, {
      volOrg: { id: 'vol-org-id', status: 'INACTIVE' },
    });

    await expect(service.promote('cyc1', user, meta, now)).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE,
    });
    expect(txMock.member.create).not.toHaveBeenCalled();
  });
});

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
      cycleId: 'cyc1',
      statusCode: 'publicity',
      deletedAt: null,
      openid: `openid-${i}`,
      realName: `报名${String(i).padStart(2, '0')}`,
      genderCode: i % 2 === 0 ? 'male' : 'female',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      isForeigner: false,
      documentTypeCode: 'mainland_id',
      idCardNumber: `IDCARD${String(i).padStart(4, '0')}`,
      phone: `1390000${String(i).padStart(4, '0')}`,
      idCardImageKey: null,
      idCardCropImageKey: null as string | null,
      idCardPortraitImageKey: null as string | null,
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
    opts: { volOrg?: { id: string; status: string } | null; dispatchThrows?: boolean } = {},
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
      memberOrganizationMembership: { create: jest.fn().mockResolvedValue({ id: 'md' }) },
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
        findFirst: jest.fn().mockResolvedValue(apps[0] ?? null),
      },
      organization: { findFirst: orgFindFirst },
      user: { findMany: userFindMany, findFirst: jest.fn().mockResolvedValue(null) },
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

    const enqueue = jest.fn().mockImplementation(() => {
      events.push('enqueue');
      return opts.dispatchThrows
        ? Promise.reject(new Error('enqueue boom'))
        : Promise.resolve({ id: 'intent' });
    });
    const notificationOutbox = { enqueue };

    // 主体裁剪图在业务 transaction 前经 provider fail-closed 删除；默认无 key / 删除成功。
    const storageDelete = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const storage = { deleteObject: storageDelete };
    const service = new RecruitmentPromotionService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      notificationOutbox as never,
      storage as never,
    );

    return {
      service,
      events,
      hashSpy,
      txMock,
      prisma,
      userFindMany,
      orgFindFirst,
      enqueue,
      auditLog: auditLogs.log,
      storageDelete,
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
    expect(txMock.memberOrganizationMembership.create).not.toHaveBeenCalled();
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
    const mdCalls = txMock.memberOrganizationMembership.create.mock.calls as Array<
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
    expect(txMock.memberOrganizationMembership.create).not.toHaveBeenCalled();
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

  // ===== D-sensitive crop purge:事务前顺序 fail-closed =====

  it('batch 仅按发号序逐条删除 promotable 的主体 crop；skip/portrait 不删，且在 bcrypt+VOL 后、transaction 前', async () => {
    const apps = buildApps(3);
    Object.assign(apps[0], {
      realName: '张三',
      idCardCropImageKey: 'recruitment/crop/zhang-sensitive.jpg',
      idCardPortraitImageKey: 'recruitment/portrait/zhang.jpg',
    });
    Object.assign(apps[1], {
      realName: '王五',
      idCardCropImageKey: 'recruitment/crop/wang-skip-sensitive.jpg',
      idCardPortraitImageKey: 'recruitment/portrait/wang.jpg',
    });
    Object.assign(apps[2], {
      realName: '李四',
      idCardCropImageKey: 'recruitment/crop/li-sensitive.jpg',
      idCardPortraitImageKey: 'recruitment/portrait/li.jpg',
    });
    const { service, hashSpy, orgFindFirst, prisma, storageDelete, userFindMany } = buildService(
      0,
      apps,
    );
    // 王五的 openid 已被既有 User 占用 → skip；仍带 crop key，用于锁定 skip 行绝不删除。
    userFindMany.mockResolvedValue([{ openid: apps[1].openid }]);

    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    storageDelete.mockImplementation(async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await Promise.resolve();
      activeDeletes -= 1;
    });

    const result = await service.promote('cyc1', user, meta, now);

    expect(result.promoted.map((item) => item.realName)).toEqual(['李四', '张三']);
    expect(result.skipped).toEqual([
      expect.objectContaining({ realName: '王五', reason: 'openid-already-bound' }),
    ]);
    expect(storageDelete.mock.calls.map(([key]) => key)).toEqual([
      'recruitment/crop/li-sensitive.jpg',
      'recruitment/crop/zhang-sensitive.jpg',
    ]);
    expect(storageDelete).not.toHaveBeenCalledWith('recruitment/crop/wang-skip-sensitive.jpg');
    expect(storageDelete).not.toHaveBeenCalledWith(expect.stringContaining('/portrait/'));
    expect(maxActiveDeletes).toBe(1); // 若误用 Promise.all，这里会 >1。

    const firstDeleteOrder = storageDelete.mock.invocationCallOrder[0];
    const lastDeleteOrder = storageDelete.mock.invocationCallOrder[1];
    expect(Math.max(...hashSpy.mock.invocationCallOrder)).toBeLessThan(firstDeleteOrder);
    expect(orgFindFirst.mock.invocationCallOrder[0]).toBeLessThan(firstDeleteOrder);
    expect(lastDeleteOrder).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
  });

  it('batch crop 删除异常收敛为安全 500，transaction 根本不进入且全部业务/audit/outbox 零写', async () => {
    const rawKeyA = 'recruitment/crop/li-raw-sensitive.jpg';
    const rawKeyB = 'recruitment/crop/zhang-raw-sensitive.jpg';
    const rawProviderMessage = `COS bucket=private-bucket delete failed for ${rawKeyB}`;
    const apps = buildApps(2);
    Object.assign(apps[0], { realName: '张三', idCardCropImageKey: rawKeyB });
    Object.assign(apps[1], { realName: '李四', idCardCropImageKey: rawKeyA });
    const { service, prisma, txMock, enqueue, auditLog, storageDelete } = buildService(0, apps);
    storageDelete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(rawProviderMessage));
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn(message: unknown): void } }).logger,
      'warn',
    );

    let caught: unknown;
    try {
      await service.promote('cyc1', user, meta, now);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ biz: BizCode.INTERNAL_ERROR });
    expect((caught as Error).message).toBe(BizCode.INTERNAL_ERROR.message);
    expect((caught as Error).message).not.toContain(rawKeyB);
    expect((caught as Error).message).not.toContain(rawProviderMessage);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(storageDelete.mock.calls.map(([key]) => key)).toEqual([rawKeyA, rawKeyB]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txMock.recruitmentCycle.update).not.toHaveBeenCalled();
    expect(txMock.member.create).not.toHaveBeenCalled();
    expect(txMock.user.create).not.toHaveBeenCalled();
    expect(txMock.memberProfile.create).not.toHaveBeenCalled();
    expect(txMock.emergencyContact.create).not.toHaveBeenCalled();
    expect(txMock.memberOrganizationMembership.create).not.toHaveBeenCalled();
    expect(txMock.recruitmentApplication.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('promote-single crop 删除异常同样安全 fail-closed，transaction 未进入且零业务写', async () => {
    const rawKey = 'recruitment/crop/single-raw-sensitive.jpg';
    const rawProviderMessage = `provider credential error: ${rawKey}`;
    const apps = buildApps(1);
    Object.assign(apps[0], { realName: '单人甲', idCardCropImageKey: rawKey });
    const { service, prisma, txMock, enqueue, auditLog, storageDelete } = buildService(0, apps);
    storageDelete.mockRejectedValueOnce(new Error(rawProviderMessage));
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn(message: unknown): void } }).logger,
      'warn',
    );

    let caught: unknown;
    try {
      await service.promoteSingle(apps[0].id, user, meta, now);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ biz: BizCode.INTERNAL_ERROR });
    expect((caught as Error).message).toBe(BizCode.INTERNAL_ERROR.message);
    expect((caught as Error).message).not.toContain(rawKey);
    expect((caught as Error).message).not.toContain(rawProviderMessage);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txMock.recruitmentCycle.update).not.toHaveBeenCalled();
    expect(txMock.member.create).not.toHaveBeenCalled();
    expect(txMock.user.create).not.toHaveBeenCalled();
    expect(txMock.memberProfile.create).not.toHaveBeenCalled();
    expect(txMock.emergencyContact.create).not.toHaveBeenCalled();
    expect(txMock.recruitmentApplication.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('crop 已删后 transaction 失败可按同 key 重试，absent-delete 幂等后正常发号', async () => {
    const key = 'recruitment/crop/retry-sensitive.jpg';
    const apps = buildApps(1);
    Object.assign(apps[0], { realName: '重试甲', idCardCropImageKey: key });
    const { service, prisma, storageDelete } = buildService(0, apps);
    const presentBeforeDelete: boolean[] = [];
    let objectPresent = true;
    storageDelete.mockImplementation(() => {
      presentBeforeDelete.push(objectPresent);
      objectPresent = false;
      return Promise.resolve();
    });
    prisma.$transaction.mockRejectedValueOnce(new Error('database transaction failed'));

    await expect(service.promote('cyc1', user, meta, now)).rejects.toThrow(
      'database transaction failed',
    );
    const retry = await service.promote('cyc1', user, meta, now);

    expect(retry.promotedCount).toBe(1);
    expect(storageDelete.mock.calls.map(([calledKey]) => calledKey)).toEqual([key, key]);
    expect(presentBeforeDelete).toEqual([true, false]);
  });

  // ===== durable outbox producer: 发号与 intent 同事务 =====

  it('发号逐项 enqueue targeted@1 intent，且全部在业务 transaction 内', async () => {
    const n = 3;
    const { service, events, enqueue, txMock } = buildService(n);

    const res = await service.promote('cyc1', user, meta, now);
    expect(res.promotedCount).toBe(n);

    // ① 派发次数 = 发号数;每次 payload = recruitment 类型 + 站内+微信 + recipientMemberId(= 新建 member)
    expect(enqueue).toHaveBeenCalledTimes(n);
    const calls = enqueue.mock.calls as Array<[Record<string, unknown>, unknown]>;
    for (const [arg, tx] of calls) {
      expect(arg).toMatchObject({
        eventType: 'notification.targeted',
        payloadVersion: 1,
        aggregateType: 'recruitment_application',
        destinationType: 'member',
        payload: { notificationTypeCode: 'recruitment', channels: ['in-app', 'wechat'] },
      });
      expect(tx).toBe(txMock);
    }
    const txEndIdx = events.indexOf('tx:end');
    expect(events.indexOf('enqueue')).toBeLessThan(txEndIdx);
  });

  it('intent enqueue 失败向外抛出，使业务 transaction 回滚', async () => {
    const n = 2;
    const { service, enqueue } = buildService(n, undefined, {
      dispatchThrows: true,
    });
    await expect(service.promote('cyc1', user, meta, now)).rejects.toThrow('enqueue boom');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

// ===== 招新闭环优化 S6(评审稿 §8.2):一键发号前预检 promotePrecheck =====
// goal DoD#5「预检=实发一致性 + 预检六类跳过原因」。promotePrecheck **纯读**、不写、不进 $transaction;
// 逐字复用 promote 事务前分区(loadBoundOpenids + comparePromotionOrder + decidePromotionIssuance)。
// 单测锁:① 六类跳过原因映射;② 批内重复 openid 高亮(双行 highlight,仅次行 skip);③ 缺字段展示 flag;
// ④ proposedMemberNo 从 memberNoSeq+1 依序;⑤ RBAC / 轮次守卫。「预检=实发」端到端一致性由 e2e 同库实跑断言。
describe('RecruitmentPromotionService.promotePrecheck · 预检(同源 decidePromotionIssuance)', () => {
  const user = { id: 'admin1', role: 'SUPER_ADMIN' } as unknown as CurrentUserPayload;
  const auditMeta: AuditMeta = { requestId: 'req-precheck-1', ip: null, ua: 'jest' };

  type PrecheckApp = {
    id: string;
    openid: string | null;
    realName: string | null;
    genderCode: string | null;
    birthDate: Date | null;
    isForeigner: boolean;
    documentTypeCode: string;
    phone: string | null;
  };
  function papp(over: Partial<PrecheckApp> & Pick<PrecheckApp, 'id'>): PrecheckApp {
    return {
      openid: `op-${over.id}`,
      realName: `名${over.id}`,
      genderCode: 'male',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      isForeigner: false,
      documentTypeCode: 'mainland_id',
      phone: '13900000000',
      ...over,
    };
  }

  function buildPrecheck(
    apps: PrecheckApp[],
    opts: {
      canResult?: boolean;
      boundOpenids?: string[];
      boundPhones?: string[];
      cycle?: { id: string; year: number; memberNoSeq: number } | null;
    } = {},
  ) {
    const prisma = {
      recruitmentCycle: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.cycle === undefined
              ? { id: 'cyc1', year: 2026, memberNoSeq: 0, deletedAt: null }
              : opts.cycle,
          ),
      },
      recruitmentApplication: { findMany: jest.fn().mockResolvedValue(apps) },
      user: {
        // v0.40.0 H5 手机通道:promotePrecheck 现两查 user(loadBoundOpenids where openid /
        // loadBoundPhones where phone);mock 按 where 分流返对应占用行。
        findMany: jest
          .fn()
          .mockImplementation((args: { where?: { openid?: unknown; phone?: unknown } }) => {
            if (args?.where?.phone !== undefined) {
              return Promise.resolve((opts.boundPhones ?? []).map((p) => ({ phone: p })));
            }
            return Promise.resolve((opts.boundOpenids ?? []).map((o) => ({ openid: o })));
          }),
      },
    };
    const rbac = { can: jest.fn().mockResolvedValue(opts.canResult ?? true) };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    // promotePrecheck 纯读不派发;dispatcher 注 no-op 仅满足构造签名(断言其零调用见 it 内)。
    const notificationOutbox = { enqueue: jest.fn().mockResolvedValue({ id: 'intent' }) };
    // promotePrecheck 纯读，不触发 transaction 前主体裁剪图删除。
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new RecruitmentPromotionService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      notificationOutbox as never,
      storage as never,
    );
    return { service, prisma, rbac, auditLogs, enqueue: notificationOutbox.enqueue };
  }

  const byId = (rows: Array<{ applicationId: string }>) =>
    Object.fromEntries(rows.map((r) => [r.applicationId, r])) as unknown as Record<
      string,
      { willIssue: boolean; skipReason: string | null } & Record<string, unknown>
    >;

  it('跳过原因映射(+ willIssue):非大陆证件资料齐备可发 / openid-bound / missing-login-channel / missing-derived / incomplete-data', async () => {
    const apps: PrecheckApp[] = [
      papp({ id: 'ok1' }), // 可发(有 openid)
      papp({ id: 'phoneok', openid: null }), // v0.40.0:无 openid 有已验证手机 → 手机通道可发
      papp({ id: 'foreign', isForeigner: true }), // 历史 DB 标志为真,但资料齐备仍可发
      papp({ id: 'bound', openid: 'op-bound' }), // openid-already-bound(boundOpenids 注入)
      papp({ id: 'nochannel', openid: null, phone: null }), // missing-login-channel(openid+phone 皆无)
      papp({ id: 'nobirth', birthDate: null, genderCode: null }), // missing-derived-field
      papp({ id: 'noname', realName: null, phone: null }), // incomplete-data(有 openid,realName 缺)
    ];
    const { service, auditLogs } = buildPrecheck(apps, { boundOpenids: ['op-bound'] });
    const res = await service.promotePrecheck('cyc1', user, auditMeta);

    expect(res.total).toBe(7);
    expect(res.promotableCount).toBe(3); // ok1 + phoneok + 非大陆证件资料齐备
    expect(res.skipCount).toBe(4);

    const m = byId(res.rows);
    expect(m.ok1).toMatchObject({ willIssue: true, skipReason: null });
    expect(m.phoneok).toMatchObject({ willIssue: true, skipReason: null }); // 手机通道发号
    expect(m.foreign).toMatchObject({ willIssue: true, skipReason: null });
    expect(m.bound).toMatchObject({ willIssue: false, skipReason: 'openid-already-bound' });
    expect(m.nochannel).toMatchObject({ willIssue: false, skipReason: 'missing-login-channel' });
    expect(m.nobirth).toMatchObject({ willIssue: false, skipReason: 'missing-derived-field' });
    expect(m.noname).toMatchObject({ willIssue: false, skipReason: 'incomplete-data' });

    // 展示 flag(独立观察,不改判定)。
    expect(m.foreign.isNonMainlandDocument).toBe(true);
    expect(m.bound.openidAlreadyBound).toBe(true);
    expect(m.phoneok.missingOpenid).toBe(true); // 无 openid,但不再阻断(手机通道)
    expect(m.nochannel.missingOpenid).toBe(true);
    expect(m.nochannel.missingPhone).toBe(true);
    expect(m.nobirth.missingBirthDate).toBe(true);
    expect(m.nobirth.missingGender).toBe(true);
    expect(m.noname.missingPhone).toBe(true);
    expect(auditLogs.log).toHaveBeenCalledWith({
      event: 'recruitment-application.read.other',
      actorUserId: 'admin1',
      actorRoleSnap: 'SUPER_ADMIN',
      resourceType: 'recruitment_cycle',
      resourceId: 'cyc1',
      meta: auditMeta,
      extra: { operation: 'promotion-precheck', count: 7 },
    });
  });

  it('v0.40.0 H5 手机通道:phone 被既有账号占用 → phone-already-bound;批内同 phone 仅次行 skip → duplicate-phone-in-batch', async () => {
    const apps: PrecheckApp[] = [
      papp({ id: 'pbound', openid: null, phone: '13911110000' }), // phone-already-bound(boundPhones 注入)
      papp({ id: 'pdupA', openid: null, phone: '13922220000', realName: '甲' }),
      papp({ id: 'pdupB', openid: null, phone: '13922220000', realName: '乙' }),
    ];
    const { service } = buildPrecheck(apps, { boundPhones: ['13911110000'] });
    const res = await service.promotePrecheck('cyc1', user, auditMeta);

    const m = byId(res.rows);
    // phone 占用 → skip + flag。
    expect(m.pbound).toMatchObject({ willIssue: false, skipReason: 'phone-already-bound' });
    expect(m.pbound.phoneAlreadyBound).toBe(true);
    // 批内同 phone:两行高亮,仅发号序次行 skip(与实发同序去重)。
    expect(m.pdupA.duplicatePhoneInBatch).toBe(true);
    expect(m.pdupB.duplicatePhoneInBatch).toBe(true);
    const phoneDupIssued = [m.pdupA, m.pdupB].filter((r) => r.willIssue);
    const phoneDupSkipped = [m.pdupA, m.pdupB].filter((r) => !r.willIssue);
    expect(phoneDupIssued).toHaveLength(1);
    expect(phoneDupSkipped).toHaveLength(1);
    expect(phoneDupSkipped[0].skipReason).toBe('duplicate-phone-in-batch');
    expect(res.promotableCount).toBe(1); // 仅批内首行手机通道发号
  });

  it('批内重复 openid:双行均高亮 duplicateOpenidInBatch,仅发号序次行 skip(duplicate-openid-in-batch)', async () => {
    const apps: PrecheckApp[] = [
      papp({ id: 'dupA', openid: 'op-dup', realName: '甲' }),
      papp({ id: 'dupB', openid: 'op-dup', realName: '乙' }),
    ];
    const { service } = buildPrecheck(apps);
    const res = await service.promotePrecheck('cyc1', user, auditMeta);

    const m = byId(res.rows);
    // 高亮:两行共用 openid → 均 true(展示用)
    expect(m.dupA.duplicateOpenidInBatch).toBe(true);
    expect(m.dupB.duplicateOpenidInBatch).toBe(true);
    // 发号判定:恰一行可发、一行 skip(与实发同序去重);skip 行原因 = duplicate-openid-in-batch
    const issued = res.rows.filter((r) => r.willIssue);
    const skipped = res.rows.filter((r) => !r.willIssue);
    expect(issued).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].skipReason).toBe('duplicate-openid-in-batch');
    expect(res.promotableCount).toBe(1);
  });

  it('proposedMemberNo 从 memberNoSeq+1 依序(仅 willIssue 行占号;与公示/实发同推算)', async () => {
    const apps: PrecheckApp[] = [
      papp({ id: 'p1', realName: '甲' }),
      papp({ id: 'p2', realName: '乙' }),
      papp({ id: 'p3', realName: '丙' }),
    ];
    const { service } = buildPrecheck(apps, { cycle: { id: 'cyc1', year: 2026, memberNoSeq: 5 } });
    const res = await service.promotePrecheck('cyc1', user, auditMeta);

    expect(res.promotableCount).toBe(3);
    // 三行均可发 → 依发号序占 26006/26007/26008(集合断言,避开拼音序细节)
    const nos = res.rows.map((r) => r.proposedMemberNo).sort();
    expect(nos).toEqual(['26006', '26007', '26008']);
  });

  it('RBAC 拒绝 → RBAC_FORBIDDEN(不触库)', async () => {
    const { service, prisma } = buildPrecheck([], { canResult: false });
    await expect(service.promotePrecheck('cyc1', user, auditMeta)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(prisma.recruitmentCycle.findFirst).not.toHaveBeenCalled();
  });

  it('轮次不存在 / 已软删 → RECRUITMENT_CYCLE_NOT_FOUND', async () => {
    const { service } = buildPrecheck([], { cycle: null });
    await expect(service.promotePrecheck('missing', user, auditMeta)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_CYCLE_NOT_FOUND.code },
    });
  });

  it('计算完成后的审计失败直接上抛,不返回预检结果', async () => {
    const { service, auditLogs } = buildPrecheck([papp({ id: 'ok1' })]);
    auditLogs.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.promotePrecheck('cyc1', user, auditMeta)).rejects.toThrow(
      'audit unavailable',
    );
  });
});

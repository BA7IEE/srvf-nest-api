import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { RecruitmentStatsService } from './recruitment-stats.service';

// 招新闭环优化 S2 · 招新工作台 stats 聚合单测(goal DoD#5「unit:各组聚合,构造多态夹具断言计数」)。
//
// 纯聚合服务,直接 new + mock PrismaService/RbacService(无事务、无副作用)。覆盖:
// ① 五组(今日/待处理/门槛/综合评定/公示发号)在一份多态夹具下逐组精确计数;
// ② 今日数据走**北京日界**(含「UTC 日 ≠ 北京日」的两个边界行,证明非 naive UTC 日);
// ③ 待人工 normal/high/system 三栏 = **真 riskLevel 口径**(S4b 落地;去 verifyOutcome 代理);
// ④ 公示「可一键发号/需手动建档」复用 decidePromotionIssuance(外籍 + openid 占用均落 needManualBuild);
// ⑤ RBAC 拒绝 → RBAC_FORBIDDEN;轮次不存在 → RECRUITMENT_CYCLE_NOT_FOUND。

const user = { id: 'admin1', role: 'SUPER_ADMIN' } as unknown as CurrentUserPayload;

// 固定 now = 北京 2026-06-24 20:00(UTC 12:00)→ 北京日界 [2026-06-23T16:00Z, 2026-06-24T16:00Z)
const NOW = new Date('2026-06-24T12:00:00.000Z');
const NOT_TODAY = new Date('2026-06-01T00:00:00.000Z'); // 远离今日,避免污染 today 组

type StatsApp = {
  id: string;
  statusCode: string;
  thresholdMarks: Record<string, { at: string; by: string }> | null;
  tempNo: string | null;
  promotedMemberId: string | null;
  createdAt: Date;
  verifiedAt: Date | null;
  reviewedAt: Date | null;
  riskLevel: string | null;
  eliminationStage: string | null;
  isForeigner: boolean;
  birthDate: Date | null;
  genderCode: string | null;
  openid: string | null;
  realName: string | null;
};

function app(over: Partial<StatsApp> & Pick<StatsApp, 'id' | 'statusCode'>): StatsApp {
  return {
    thresholdMarks: null,
    tempNo: null,
    promotedMemberId: null,
    createdAt: NOT_TODAY,
    verifiedAt: null,
    reviewedAt: null,
    riskLevel: null,
    eliminationStage: null,
    isForeigner: false,
    birthDate: new Date('1995-03-07T00:00:00.000Z'),
    genderCode: 'male',
    openid: null,
    realName: '张三',
    ...over,
  };
}

const mark = (by = 'u1') => ({ at: '2026-06-10T00:00:00.000Z', by });

function buildService(
  apps: StatsApp[],
  opts: {
    canResult?: boolean;
    cycle?: { id: string; year: number } | null;
    boundOpenids?: string[];
  } = {},
) {
  const prismaMock = {
    recruitmentCycle: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.cycle === undefined ? { id: 'cyc1', year: 2026 } : opts.cycle),
    },
    recruitmentApplication: { findMany: jest.fn().mockResolvedValue(apps) },
    user: {
      findMany: jest.fn().mockResolvedValue((opts.boundOpenids ?? []).map((o) => ({ openid: o }))),
    },
  };
  const rbacMock = { can: jest.fn().mockResolvedValue(opts.canResult ?? true) };
  const service = new RecruitmentStatsService(prismaMock as never, rbacMock as never);
  return { service, prismaMock, rbacMock };
}

describe('RecruitmentStatsService.getCycleStats · 五组聚合(多态夹具)', () => {
  // 多态夹具(createdAt/verifiedAt/reviewedAt 全置 NOT_TODAY,本组只验 stage 类计数,today 应全 0):
  const apps: StatsApp[] = [
    // 待人工 3:真 riskLevel 三栏 system / high / normal(S4b;去 verifyOutcome 代理)
    app({ id: 'm1', statusCode: 'manual_review', riskLevel: 'system' }),
    app({ id: 'm2', statusCode: 'manual_review', riskLevel: 'high' }),
    app({ id: 'm3', statusCode: 'manual_review', riskLevel: 'normal' }),
    // 门槛跟踪中 2(verified + 未齐):A {patrol1,patrol2} / B {patrol1,training}
    app({ id: 't1', statusCode: 'verified', thresholdMarks: { patrol1: mark(), patrol2: mark() } }),
    app({
      id: 't2',
      statusCode: 'verified',
      thresholdMarks: { patrol1: mark(), training: mark() },
    }),
    // threshold_done(verified + 5 项齐;瞬态,不计 tracking,但 byThreshold 每项 +1)
    app({
      id: 'td',
      statusCode: 'verified',
      thresholdMarks: {
        patrol1: mark(),
        patrol2: mark(),
        training: mark(),
        redCross: mark(),
        bsafe: mark(),
      },
    }),
    // 待综合评定 2
    app({ id: 'e1', statusCode: 'pending_evaluation' }),
    app({ id: 'e2', statusCode: 'pending_evaluation' }),
    // 公示 3:p1/p2 可发号(大陆 + openid + 字段齐)、pf 外籍(needManualBuild)
    app({ id: 'p1', statusCode: 'publicity', openid: 'oa', realName: '陈一' }),
    app({ id: 'p2', statusCode: 'publicity', openid: 'ob', realName: '陈二' }),
    app({ id: 'pf', statusCode: 'publicity', isForeigner: true, openid: 'oc', realName: '安三' }),
    // 已发号 2(promote 后 birthDate/openid 已清,但仍 promoted 态 + promotedMemberId)
    app({
      id: 'pm1',
      statusCode: 'promoted',
      promotedMemberId: 'mem1',
      birthDate: null,
      openid: null,
    }),
    app({
      id: 'pm2',
      statusCode: 'promoted',
      promotedMemberId: 'mem2',
      birthDate: null,
      openid: null,
    }),
    // 淘汰:评定淘汰 1(rejected + evaluation)/ 人工淘汰 1(rejected + manual,不计 evalEliminated)
    app({ id: 'r1', statusCode: 'rejected', eliminationStage: 'evaluation' }),
    app({ id: 'r2', statusCode: 'rejected', eliminationStage: 'manual' }),
  ];

  it('待处理事项:manualTotal=3 + 真 riskLevel 三栏 normal/high/system + 待评定 + 待发号', async () => {
    const { service } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.pending).toEqual({
      manualTotal: 3, // stage=manual + manual_high(high 行派生 manual_high 仍计入)
      manualNormal: 1, // riskLevel=normal(= manualTotal − high − system)
      manualHigh: 1, // 真 riskLevel=high
      manualSystem: 1, // 真 riskLevel=system
      pendingEvaluation: 2,
      pendingIssuance: 3, // = publicity 态(p1/p2/pf)
    });
  });

  it('门槛进度:tracking=2(threshold_done 不计)+ 各门槛完成分布(真投影)', async () => {
    const { service } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.threshold.tracking).toBe(2);
    expect(res.threshold.byThreshold).toEqual([
      { code: 'patrol1', name: '巡山一', completedCount: 3 }, // t1 + t2 + td
      { code: 'patrol2', name: '巡山二', completedCount: 2 }, // t1 + td
      { code: 'training', name: '培训', completedCount: 2 }, // t2 + td
      { code: 'redCross', name: '红十字', completedCount: 1 }, // td
      { code: 'bsafe', name: 'BSAFE', completedCount: 1 }, // td
    ]);
  });

  it('综合评定:待评定 / 已通过(publicity)/ 评定淘汰(rejected+evaluation,人工淘汰不计)', async () => {
    const { service } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.evaluation).toEqual({ pending: 2, passed: 3, eliminated: 1 });
  });

  it('公示发号:公示中 3 / 可一键发号 2 / 需手动建档 1(外籍)/ 已发号 2 —— 复用 decidePromotionIssuance', async () => {
    const { service, prismaMock } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.issuance).toEqual({
      inPublicity: 3,
      oneClickIssuable: 2, // p1/p2 大陆可发;pf 外籍跳过
      needManualBuild: 1,
      promoted: 2,
    });
    // openid 占用判定只查公示子集的 openid(oa/ob/oc),不跨轮全表扫描
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { openid: { in: ['oa', 'ob', 'oc'] } },
      select: { openid: true },
    });
  });

  it('今日数据:本组时间戳全 NOT_TODAY → 今日三项全 0', async () => {
    const { service } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.today).toEqual({ newApplications: 0, tempNoIssued: 0, manualProcessed: 0 });
  });

  it('cycleId / cycleYear 回显轮次本体', async () => {
    const { service } = buildService(apps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.cycleId).toBe('cyc1');
    expect(res.cycleYear).toBe(2026);
  });
});

describe('RecruitmentStatsService.getCycleStats · 今日数据(北京日界,含 UTC 日边界)', () => {
  // 北京日界 [2026-06-23T16:00Z, 2026-06-24T16:00Z):
  const todayApps: StatsApp[] = [
    // createdAt 命中今日:正午(UTC 24 日)
    app({ id: 'c1', statusCode: 'manual_review', createdAt: new Date('2026-06-24T00:00:00.000Z') }),
    // createdAt:UTC 23 日 20:00 = 北京 24 日 04:00 → **今日**(naive UTC 日会漏算 → 证明北京日界)
    app({ id: 'c2', statusCode: 'manual_review', createdAt: new Date('2026-06-23T20:00:00.000Z') }),
    // createdAt:UTC 24 日 18:00 = 北京 25 日 02:00 → **非今日**(naive UTC 日会误算)
    app({ id: 'c3', statusCode: 'manual_review', createdAt: new Date('2026-06-24T18:00:00.000Z') }),
    // verifiedAt 命中今日(createdAt 非今日,验 verifiedAt 独立计数)
    app({
      id: 'v1',
      statusCode: 'verified',
      createdAt: NOT_TODAY,
      verifiedAt: new Date('2026-06-24T02:00:00.000Z'),
      thresholdMarks: { patrol1: mark() },
    }),
    // reviewedAt 命中今日
    app({
      id: 'rv1',
      statusCode: 'rejected',
      createdAt: NOT_TODAY,
      reviewedAt: new Date('2026-06-23T23:00:00.000Z'),
      eliminationStage: 'manual',
    }),
  ];

  it('createdAt 今日=2(含 UTC23→北京24 边界,排除 UTC24→北京25)/ verifiedAt 今日=1 / reviewedAt 今日=1', async () => {
    const { service } = buildService(todayApps);
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.today).toEqual({ newApplications: 2, tempNoIssued: 1, manualProcessed: 1 });
  });
});

describe('RecruitmentStatsService.getCycleStats · openid 占用复用 decidePromotionIssuance', () => {
  const publicity: StatsApp[] = [
    app({ id: 'p1', statusCode: 'publicity', openid: 'dup', realName: '陈一' }),
    app({ id: 'p2', statusCode: 'publicity', openid: 'free', realName: '陈二' }),
  ];

  it('某公示 openid 已被既有 User 占用 → 计入需手动建档,可发号 -1', async () => {
    const { service } = buildService(publicity, { boundOpenids: ['dup'] });
    const res = await service.getCycleStats('cyc1', user, NOW);
    expect(res.issuance.inPublicity).toBe(2);
    expect(res.issuance.oneClickIssuable).toBe(1); // 仅 'free' 可发;'dup' openid 占用 → 跳过
    expect(res.issuance.needManualBuild).toBe(1);
  });
});

describe('RecruitmentStatsService.getCycleStats · 守卫', () => {
  it('RBAC 拒绝 → RBAC_FORBIDDEN(不触库)', async () => {
    const { service, prismaMock } = buildService([], { canResult: false });
    await expect(service.getCycleStats('cyc1', user, NOW)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(prismaMock.recruitmentCycle.findFirst).not.toHaveBeenCalled();
  });

  it('轮次不存在 / 已软删 → RECRUITMENT_CYCLE_NOT_FOUND', async () => {
    const { service } = buildService([], { cycle: null });
    await expect(service.getCycleStats('missing', user, NOW)).rejects.toBeInstanceOf(BizException);
    await expect(service.getCycleStats('missing', user, NOW)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_CYCLE_NOT_FOUND.code },
    });
  });
});

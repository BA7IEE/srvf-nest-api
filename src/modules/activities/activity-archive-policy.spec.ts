import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ActivityArchivePolicy,
  STALE_DRAFT_ARCHIVE_DAYS,
  isStaleDraft,
  type ActivityArchiveInput,
} from './activity-archive-policy';

/*
 * 归档**两套开工条件**的判据(goal §2)。
 *
 * 🔴 本文件的形状要求(goal §7,今天另一条 lane 实测踩过):
 *    **每一维各自成一个 `it`**。jest 首个失败即停 —— 把「未达阈值拒 / 达阈值准 /
 *    未关账拒 / 未满等待期拒 / 交叉反向两条」塞进同一个 `it`,第一条一红后面全不执行,
 *    「判据有判别力」在结构上就观测不到,而**基线全绿时完全看不出来**。
 *
 * 🔴 只测「满足条件能归档」= 判据可能恒真。所以每条正向都配一条同形反向,
 *    并额外给**两条交叉反向**:用另一套条件的事实去撬这一套,必须被拒。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-25T12:00:00.000Z');

/** 造一份输入:默认是「刚建的草稿、从未关账」—— 两套条件都不满足的中性起点。 */
function input(overrides: Partial<ActivityArchiveInput> = {}): ActivityArchiveInput {
  return {
    statusCode: 'draft',
    updatedAt: NOW,
    now: NOW,
    archiveWaitingDays: 7,
    activeClosure: null,
    ...overrides,
  };
}

/** now 往前推 n 天当作 updatedAt。 */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe('ActivityArchivePolicy', () => {
  let policy: ActivityArchivePolicy;

  beforeEach(() => {
    policy = new ActivityArchivePolicy();
  });

  // ===== 第一套:草稿「长期无人处理」=====
  describe('草稿路径', () => {
    it('刚碰过的草稿 ⇒ 拒(20155)', () => {
      expect(policy.decide(input({ updatedAt: NOW }))).toEqual({
        allowed: false,
        biz: BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE,
      });
    });

    it('差一毫秒到阈值的草稿 ⇒ 拒(20155)', () => {
      const justUnder = new Date(NOW.getTime() - STALE_DRAFT_ARCHIVE_DAYS * DAY_MS + 1);
      expect(policy.decide(input({ updatedAt: justUnder }))).toEqual({
        allowed: false,
        biz: BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE,
      });
    });

    it('恰好到阈值的草稿 ⇒ 准,reasonCode=stale_draft(边界含端点)', () => {
      const exactly = daysAgo(STALE_DRAFT_ARCHIVE_DAYS);
      expect(policy.decide(input({ updatedAt: exactly }))).toEqual({
        allowed: true,
        reasonCode: 'stale_draft',
      });
    });

    it('远超阈值的草稿 ⇒ 准,reasonCode=stale_draft', () => {
      expect(policy.decide(input({ updatedAt: daysAgo(400) }))).toEqual({
        allowed: true,
        reasonCode: 'stale_draft',
      });
    });

    it('草稿路径不读关账事实:有没有 closure、等待期多长都不改变结论', () => {
      const stale = daysAgo(STALE_DRAFT_ARCHIVE_DAYS + 1);
      const withoutClosure = policy.decide(input({ updatedAt: stale, activeClosure: null }));
      const withClosure = policy.decide(
        input({
          updatedAt: stale,
          activeClosure: { closedAt: NOW },
          archiveWaitingDays: 365,
        }),
      );
      expect(withClosure).toEqual(withoutClosure);
    });
  });

  // ===== 第二套:办完的活动「已关账 且 过了 archiveWaitingDays」=====
  describe('结算路径', () => {
    it('未关账 ⇒ 拒(20156),且不是「等待期」那个码', () => {
      expect(policy.decide(input({ statusCode: 'completed', activeClosure: null }))).toEqual({
        allowed: false,
        biz: BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED,
      });
    });

    it('刚关账、等待期未过 ⇒ 拒(20157),且不是「未关账」那个码', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'completed',
            archiveWaitingDays: 7,
            activeClosure: { closedAt: daysAgo(1) },
          }),
        ),
      ).toEqual({ allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_WAITING_PERIOD_NOT_ELAPSED });
    });

    it('差一毫秒满等待期 ⇒ 拒(20157)', () => {
      const closedAt = new Date(NOW.getTime() - 7 * DAY_MS + 1);
      expect(
        policy.decide(
          input({ statusCode: 'completed', archiveWaitingDays: 7, activeClosure: { closedAt } }),
        ),
      ).toEqual({ allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_WAITING_PERIOD_NOT_ELAPSED });
    });

    it('恰好满等待期 ⇒ 准,reasonCode=settled(边界含端点)', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'completed',
            archiveWaitingDays: 7,
            activeClosure: { closedAt: daysAgo(7) },
          }),
        ),
      ).toEqual({ allowed: true, reasonCode: 'settled' });
    });

    it('archiveWaitingDays=0 时关账当刻即可归档(合同允许的配置,不特判成至少等一天)', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'completed',
            archiveWaitingDays: 0,
            activeClosure: { closedAt: NOW },
          }),
        ),
      ).toEqual({ allowed: true, reasonCode: 'settled' });
    });

    it.each(['published', 'terminated'] as const)(
      '%s 也走结算路径(关账不要求先手动 complete)',
      (statusCode) => {
        expect(
          policy.decide(
            input({
              statusCode,
              archiveWaitingDays: 7,
              activeClosure: { closedAt: daysAgo(8) },
            }),
          ),
        ).toEqual({ allowed: true, reasonCode: 'settled' });
      },
    );

    it('结算路径不读 updatedAt:昨天刚改过也照样准(条件在账不在人手)', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'completed',
            updatedAt: NOW,
            archiveWaitingDays: 7,
            activeClosure: { closedAt: daysAgo(8) },
          }),
        ),
      ).toEqual({ allowed: true, reasonCode: 'settled' });
    });
  });

  // ===== 🔴 交叉反向:两套条件互不越界 =====
  //
  // 只测「满足条件能归档」时,一个恒返回 allowed 的实现也能全绿。下面两条是唯一能
  // 把「这两套条件真的各判各的」证出来的形状:拿 A 套的事实去撬 B 套,必须被拒。
  describe('交叉反向', () => {
    it('用草稿的条件去归档已办完的活动 ⇒ 拒(20156):陈旧 400 天但没关账,不得放行', () => {
      expect(
        policy.decide(
          input({ statusCode: 'completed', updatedAt: daysAgo(400), activeClosure: null }),
        ),
      ).toEqual({ allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED });
    });

    it('用草稿的条件去归档已终止的活动 ⇒ 拒(20156)', () => {
      expect(
        policy.decide(
          input({ statusCode: 'terminated', updatedAt: daysAgo(400), activeClosure: null }),
        ),
      ).toEqual({ allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED });
    });

    it('用结算的条件去归档草稿 ⇒ 拒(20155):有生效 closure 且等待期早过,仍不得放行', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'draft',
            updatedAt: daysAgo(1),
            archiveWaitingDays: 0,
            activeClosure: { closedAt: daysAgo(365) },
          }),
        ),
      ).toEqual({ allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE });
    });

    it('两套条件同时满足时,草稿仍走草稿的码(路由只由 statusCode 决定,不看谁先满足)', () => {
      expect(
        policy.decide(
          input({
            statusCode: 'draft',
            updatedAt: daysAgo(STALE_DRAFT_ARCHIVE_DAYS + 1),
            archiveWaitingDays: 0,
            activeClosure: { closedAt: daysAgo(365) },
          }),
        ),
      ).toEqual({ allowed: true, reasonCode: 'stale_draft' });
    });
  });

  it('阈值常量是 30 天(改它是业务决策,要连这条一起改 —— 不许悄悄挪)', () => {
    expect(STALE_DRAFT_ARCHIVE_DAYS).toBe(30);
  });

  // AC-004 的「工作台提示」半格。提示与闸必须是同一个判据 —— 各写一遍就会漂移成
  // 「亮着可归档、点下去被拒」或「能归档却不提示」。
  describe('isStaleDraft:工作台提示与归档闸同源', () => {
    it('刚碰过的草稿 ⇒ false', () => {
      expect(isStaleDraft('draft', NOW, NOW)).toBe(false);
    });

    it('恰好到阈值的草稿 ⇒ true', () => {
      expect(isStaleDraft('draft', daysAgo(STALE_DRAFT_ARCHIVE_DAYS), NOW)).toBe(true);
    });

    it.each(['published', 'completed', 'terminated', 'cancelled', 'archived'])(
      '非草稿(%s)恒 false —— 「陈旧」这个概念只对草稿成立',
      (statusCode) => {
        expect(isStaleDraft(statusCode, daysAgo(400), NOW)).toBe(false);
      },
    );

    it.each([0, 1, STALE_DRAFT_ARCHIVE_DAYS - 1, STALE_DRAFT_ARCHIVE_DAYS, 400])(
      '与归档闸逐点同结论(闲置 %s 天)',
      (idleDays) => {
        const updatedAt = daysAgo(idleDays);
        const gateAllows = policy.decide(input({ statusCode: 'draft', updatedAt })).allowed;
        expect(isStaleDraft('draft', updatedAt, NOW)).toBe(gateAllows);
      },
    );
  });
});

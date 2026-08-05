import {
  LEDGER_COMMIT_LOCK_SLOT_COUNT,
  LEDGER_COMMIT_MEMBERS_PER_SLOT,
  POSTGRES_SHARED_LOCK_TABLE_FLOOR,
  ledgerCommitExceedsTotalBudget,
  ledgerCommitRequiredSlots,
} from './ledger-commit-lock-budget';

// 「万人统一生效恒串行」执行位的**算术**判据。
//
// 运行期判据(槽位真的被占住 ⇒ 第二场收 20087)在
// `test/e2e/activity-ledger-posting-concurrency.e2e-spec.ts`;本 spec 守的是
// 那道闸背后的数字:换掉任何一个常量,下面就会有用例变红。
describe('ledger commit lock budget —— 恒串行闸的算术(维护者 2026-08-04 拍板)', () => {
  describe('① 预算总量必须严格低于 PostgreSQL 共享锁表公式保底', () => {
    it('并发放行的队员锁总量 ≤ 10000,低于保底 12800 且留有余量', () => {
      const budget = LEDGER_COMMIT_LOCK_SLOT_COUNT * LEDGER_COMMIT_MEMBERS_PER_SLOT;
      expect(budget).toBe(10_000);
      expect(budget).toBeLessThan(POSTGRES_SHARED_LOCK_TABLE_FLOOR);
      // 余量不是可有可无的:同时在跑的其它 backend 的普通查询也要占表级锁槽。
      // 把余量写成判据,免得日后有人把槽数调到"刚好等于保底"。
      expect(POSTGRES_SHARED_LOCK_TABLE_FLOOR - budget).toBeGreaterThanOrEqual(2_000);
    });

    it('槽位换算不会放大预算:requiredSlots(m) × MEMBERS_PER_SLOT 恒 ≥ m', () => {
      for (const memberCount of [0, 1, 999, 1_000, 1_001, 4_999, 8_000, 9_999, 10_000]) {
        expect(
          ledgerCommitRequiredSlots(memberCount) * LEDGER_COMMIT_MEMBERS_PER_SLOT,
        ).toBeGreaterThanOrEqual(memberCount);
      }
    });
  });

  describe('② 槽位换算', () => {
    it('向上取整,且零人也占一个槽(零成本绕过闸不成立)', () => {
      expect(ledgerCommitRequiredSlots(0)).toBe(1);
      expect(ledgerCommitRequiredSlots(1)).toBe(1);
      expect(ledgerCommitRequiredSlots(1_000)).toBe(1);
      expect(ledgerCommitRequiredSlots(1_001)).toBe(2);
      expect(ledgerCommitRequiredSlots(10_000)).toBe(10);
    });

    it('非法人数直接抛,不返回一个"看起来合法"的槽数', () => {
      expect(() => ledgerCommitRequiredSlots(-1)).toThrow(RangeError);
      expect(() => ledgerCommitRequiredSlots(1.5)).toThrow(RangeError);
      expect(() => ledgerCommitRequiredSlots(Number.NaN)).toThrow(RangeError);
    });
  });

  // =========================================================================
  // ⭐ ③ 拍板里点名的那个反例:**人数阈值 T 不严格成立**
  //
  //    「4999 + 8000 两场都在阈值下却合计 12999 > 12800」——
  //    任何"单场人数 ≤ T 就放行"的判据都会同时放行这两场,然后一起炸。
  //    本闸按**并发总量**扣减,所以这两场在算术上就不可能同时进来。
  // =========================================================================
  describe('⭐ ③ 4999 + 8000:两场都"不算万人",合计却越过保底', () => {
    it('两场需要的槽位合计超过总槽数 ⇒ 至少一场进不来', () => {
      const a = ledgerCommitRequiredSlots(4_999);
      const b = ledgerCommitRequiredSlots(8_000);
      expect(a).toBe(5);
      expect(b).toBe(8);
      // 合计 13 > 10:先到者拿走自己那份之后,后到者**一定**凑不齐。
      expect(a + b).toBeGreaterThan(LEDGER_COMMIT_LOCK_SLOT_COUNT);
      // 而它们的真实锁需求确实越过了保底 —— 证明这条拒绝不是保守过头。
      expect(4_999 + 8_000).toBeGreaterThan(POSTGRES_SHARED_LOCK_TABLE_FLOOR);
    });

    it('两场万人同理(10 + 10 > 10)', () => {
      expect(ledgerCommitRequiredSlots(10_000) * 2).toBeGreaterThan(LEDGER_COMMIT_LOCK_SLOT_COUNT);
    });

    it('小场次仍可并发:1000 人 × 10 场恰好用满,第 11 场才被拒', () => {
      expect(ledgerCommitRequiredSlots(1_000) * LEDGER_COMMIT_LOCK_SLOT_COUNT).toBe(
        LEDGER_COMMIT_LOCK_SLOT_COUNT,
      );
    });
  });

  describe('④ 单场超过预算总量 ⇒ 重试无用,与"此刻并发满了"分码', () => {
    it('10000 人正好装得下;10001 人恒不可能通过', () => {
      expect(ledgerCommitExceedsTotalBudget(10_000)).toBe(false);
      expect(ledgerCommitExceedsTotalBudget(10_001)).toBe(true);
      expect(ledgerCommitExceedsTotalBudget(30_000)).toBe(true);
    });
  });
});

import {
  evaluateCorrectionPostingShape,
  type CorrectionPostingShapeFacts,
} from './correction-posting-shape';

// ===== 第七刀:更正批次配对判据的红集矩阵(纯函数层)=====
//
// ⭐ 本 spec 的组织方式就是报告要的那张矩阵:
//    ① 先钉住**正对照**(配平的批次放行)—— 没有它,后面每一条红都可能只是
//       facts 本身造坏了;
//    ② 三条判据**逐条只拨一项**,断言返回的正是那一种违例。
//    ⇒ 「红集互不重叠」不是事后统计出来的,是每条用例自己断言的。
//
// 🔴 三条判据在 service 层一一对应三个具名 BizCode(20108 / 20109 / 20110),
//    映射表 `CORRECTION_SHAPE_TO_BIZ_CODE` 用 `Record<违例, 码>` 写死 —— 漏一种编译不过。

/**
 * 配平的更正批次:2 个人 × 1 天。
 *
 * 旧账 4 条(每人 service_credit + contribution_credit),全部被冲回(4 条 reversal、
 * 4 条 claim);新账同样 4 条 credit,覆盖新版本的 2 行 `ParticipantSettlementDay`。
 */
const BALANCED: CorrectionPostingShapeFacts = {
  creditEntryCount: 4,
  creditPairCount: 2,
  settlementDayCount: 2,
  reversalEntryCount: 4,
  reversalPairCount: 2,
  reversalClaimCount: 4,
  unreversedOriginalCount: 0,
  reversalOfUncommittedCount: 0,
  mismatchedReversalAmountCount: 0,
};

describe('更正批次配对判据 (合同 §5.14 ④ + §3.23.5)', () => {
  // ===== ① 正对照 =========================================================
  describe('① 配平的批次放行', () => {
    it('冲回与补记都齐 ⇒ 无违例', () => {
      expect(evaluateCorrectionPostingShape(BALANCED)).toBeNull();
    });

    it('一个人被改成"不参加"(旧账要冲、新账没有)⇒ 两侧条数天然不等,仍放行', () => {
      // 🔴 这一条是**防误杀**的正对照:更正完全可以让一个人从 present 变 absent。
      //    若判据写成"补记条数 == 冲回条数",这种合法更正会被判死。
      expect(
        evaluateCorrectionPostingShape({
          ...BALANCED,
          creditEntryCount: 2,
          creditPairCount: 1,
          settlementDayCount: 1,
        }),
      ).toBeNull();
    });

    it('全员改成"不参加"(只冲不补是合法终态)⇒ 补记侧全零,仍放行', () => {
      expect(
        evaluateCorrectionPostingShape({
          ...BALANCED,
          creditEntryCount: 0,
          creditPairCount: 0,
          settlementDayCount: 0,
        }),
      ).toBeNull();
    });
  });

  // ===== ② 只冲不补(20108)=================================================
  describe('② replacement_missing —— 补记侧与新版本应记日行数对不上', () => {
    it('新版本有 2 行日结果、批次只补了 1 对 ⇒ replacement_missing', () => {
      expect(
        evaluateCorrectionPostingShape({
          ...BALANCED,
          creditEntryCount: 2,
          creditPairCount: 1,
          // settlementDayCount 仍是 2 —— 少补的那一天没有分录。
        }),
      ).toBe('replacement_missing');
    });

    it('对数对上但每对不是恰好两条(漏了 contribution_credit)⇒ replacement_missing', () => {
      expect(evaluateCorrectionPostingShape({ ...BALANCED, creditEntryCount: 3 })).toBe(
        'replacement_missing',
      );
    });
  });

  // ===== ③ 只补不冲(20109)=================================================
  describe('③ reversal_missing —— 旧账没冲干净 / 冲回侧不完整', () => {
    it('🔴 基础版本还有 1 条已生效分录没被冲回 ⇒ reversal_missing', () => {
      // 这是整条判据里**最像钱**的一项:少冲一条,那笔钱就在队员账上留了两遍。
      expect(evaluateCorrectionPostingShape({ ...BALANCED, unreversedOriginalCount: 1 })).toBe(
        'reversal_missing',
      );
    });

    it('冲回不是每对恰好两条 ⇒ reversal_missing', () => {
      expect(evaluateCorrectionPostingShape({ ...BALANCED, reversalEntryCount: 3 })).toBe(
        'reversal_missing',
      );
    });

    it('冲回分录缺少 LedgerEntryReversalClaim ⇒ reversal_missing', () => {
      // 缺 claim ⇒「一条原 entry 至多被一个 committed reversal 冲回」失去 DB 锚点,
      // 下一次更正可以把同一条原分录**再冲一遍**。
      expect(evaluateCorrectionPostingShape({ ...BALANCED, reversalClaimCount: 3 })).toBe(
        'reversal_missing',
      );
    });

    it('冲了一条从没生效过的分录 ⇒ reversal_missing', () => {
      expect(evaluateCorrectionPostingShape({ ...BALANCED, reversalOfUncommittedCount: 1 })).toBe(
        'reversal_missing',
      );
    });
  });

  // ===== ④ 金额不相反(20110)===============================================
  describe('④ reversal_amount_invalid —— 冲回不是原分录逐列的相反数', () => {
    it('🔴 配对计数全对、金额只冲了一部分 ⇒ reversal_amount_invalid', () => {
      // 光"有一条冲回"不够:冲 1.2 分的账只冲 0.2 分,配对计数**完全正确**,
      // 而队员账上凭空多出 1.0 分 —— 正是"看起来完全正常的账"。
      expect(
        evaluateCorrectionPostingShape({ ...BALANCED, mismatchedReversalAmountCount: 1 }),
      ).toBe('reversal_amount_invalid');
    });
  });

  // ===== ⑤ 红集互不重叠 ====================================================
  describe('⑤ 三条判据互不重叠', () => {
    it('三种单项残缺分别只命中自己那一条', () => {
      const readings = {
        replacement: evaluateCorrectionPostingShape({ ...BALANCED, settlementDayCount: 3 }),
        reversal: evaluateCorrectionPostingShape({ ...BALANCED, unreversedOriginalCount: 1 }),
        amount: evaluateCorrectionPostingShape({
          ...BALANCED,
          mismatchedReversalAmountCount: 1,
        }),
      };
      expect(readings).toEqual({
        replacement: 'replacement_missing',
        reversal: 'reversal_missing',
        amount: 'reversal_amount_invalid',
      });
      // 三个返回值两两不同 ⇒ 卸掉任一条判据,只有它那一格会变。
      expect(new Set(Object.values(readings)).size).toBe(3);
    });
  });
});

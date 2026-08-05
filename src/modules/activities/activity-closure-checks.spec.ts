import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_CLOSURE_GAP_ORDER,
  buildClosureChecksJson,
  collectClosureGaps,
  computeClosureChecksHash,
  summarizeClosureChecks,
  type ActivityClosureCheckCounts,
  type ActivityClosureGapCode,
  type ActivityClosureTotals,
} from './activity-closure-checks';

// 第 2 批第六刀:关账**判定层**的单元判据(合同 §5.15 ④–⑨ + §3.26)。
//
// 这里钉的是"判定与呈现",不是"取数" —— 取数在 service 里、由 e2e 逐类跑真库。
// 分开的理由:八类互不重叠、count 的口径、checksJson 里不许有人员明细,这三件事
// **与数据库无关**,不该只在一个要起库的 e2e 里才有执法位。

const ZERO: ActivityClosureCheckCounts = {
  execution: { notEnded: 0, cancelled: 0 },
  evidence: { missingActiveSeal: 0, staleSeal: 0 },
  pendingWork: {
    pendingChangeReview: 0,
    pendingCorrection: 0,
    manualReviewPending: 0,
    openSegment: 0,
    unfinishedJob: 0,
  },
  participation: {
    nonTerminalRegistration: 0,
    pendingInvitation: 0,
    unresolvedIdentity: 0,
    populationIdentityNotParticipating: 0,
    participatingIdentityOutOfPopulation: 0,
    participatingRegistrationWithoutIdentity: 0,
  },
  settlement: {
    runNotPosted: 0,
    postedVersionMissing: 0,
    populationWithoutResult: 0,
    resultOutOfPopulation: 0,
    uncommittedResult: 0,
  },
  resultConsistency: {
    presentWithoutSegment: 0,
    zeroResultWithNonZeroTotals: 0,
    flagMismatch: 0,
    earlyDepartureFlagMissing: 0,
  },
  ledger: {
    committedBatchMissing: 0,
    entriesInUncommittedBatch: 0,
    resultWithoutLedgerEntry: 0,
    dayCapExceeded: 0,
    duplicatePosting: 0,
    overlappingSegment: 0,
    capacityReconciliationMismatch: 0,
  },
  closure: { activeClosure: 0 },
};

const TOTALS: ActivityClosureTotals = {
  personCount: 2,
  sessionParticipationCount: 2,
  resultCountsJson: { present: 2 },
  serviceHours: '8.00',
  contributionPoints: '2.40',
};

/** 每一类各挑一个字段拨到非零 —— 用来证明"这一类只由它自己的计数决定"。 */
const ONE_PER_CLASS: ReadonlyArray<[ActivityClosureGapCode, ActivityClosureCheckCounts]> = [
  ['execution_not_ended', { ...ZERO, execution: { notEnded: 1, cancelled: 0 } }],
  ['evidence_not_sealed', { ...ZERO, evidence: { missingActiveSeal: 1, staleSeal: 0 } }],
  ['pending_work_exists', { ...ZERO, pendingWork: { ...ZERO.pendingWork, openSegment: 3 } }],
  [
    'participation_unresolved',
    { ...ZERO, participation: { ...ZERO.participation, unresolvedIdentity: 30 } },
  ],
  [
    'settlement_incomplete',
    { ...ZERO, settlement: { ...ZERO.settlement, populationWithoutResult: 30 } },
  ],
  [
    'result_inconsistent',
    { ...ZERO, resultConsistency: { ...ZERO.resultConsistency, flagMismatch: 2 } },
  ],
  ['ledger_incomplete', { ...ZERO, ledger: { ...ZERO.ledger, dayCapExceeded: 1 } }],
  ['closure_already_active', { ...ZERO, closure: { activeClosure: 1 } }],
];

describe('activity closure checks —— 八类判定层 (合同 §5.15 ④–⑨)', () => {
  it('全零 ⇒ 零缺口,八类摘要仍然逐类留痕(「查过了且是 0」本身是证据)', () => {
    expect(collectClosureGaps(ZERO)).toEqual([]);
    const checks = summarizeClosureChecks(ZERO);
    expect(checks).toHaveLength(8);
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checks.map((check) => check.gapCode)).toEqual([...ACTIVITY_CLOSURE_GAP_ORDER]);
  });

  // ⭐ 红集不重叠的**结构判据**:拨动任意一类的任意一项,只有那一类变红。
  //    这条在这里成立,e2e 才只需要证明"取数落在对的那一项上"。
  it.each(ONE_PER_CLASS)('拨动 %s 一项 ⇒ 恰好且只有这一类变红', (gapCode, counts) => {
    const gaps = collectClosureGaps(counts);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapCode).toBe(gapCode);
    const failed = summarizeClosureChecks(counts).filter((check) => !check.passed);
    expect(failed.map((check) => check.gapCode)).toEqual([gapCode]);
  });

  it('八类的 details 键集两两不交 —— 「互不重叠」不是靠自觉', () => {
    const seen = new Map<string, ActivityClosureGapCode>();
    for (const check of summarizeClosureChecks(ZERO)) {
      for (const key of Object.keys(check.details)) {
        expect(seen.has(key)).toBe(false);
        seen.set(key, check.gapCode);
      }
    }
    // 合计 = 2 + 2 + 5 + 6 + 5 + 4 + 7 + 1 项。数字写死:日后有人加一项而忘了
    // 想清楚它属于哪一类,这里会变红。
    expect(seen.size).toBe(32);
  });

  it('每一类都有自己的 BizCode,八个码互不相同(合并成一个码 = 看不出哪一道没执法位)', () => {
    const codes = summarizeClosureChecks(ZERO).map((check) => check.bizCode);
    expect(new Set(codes).size).toBe(8);
    expect(codes).toEqual([
      BizCode.ACTIVITY_CLOSURE_EXECUTION_NOT_ENDED.code,
      BizCode.ACTIVITY_CLOSURE_EVIDENCE_NOT_SEALED.code,
      BizCode.ACTIVITY_CLOSURE_PENDING_WORK_EXISTS.code,
      BizCode.ACTIVITY_CLOSURE_PARTICIPATION_UNRESOLVED.code,
      BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE.code,
      BizCode.ACTIVITY_CLOSURE_RESULT_INCONSISTENT.code,
      BizCode.ACTIVITY_CLOSURE_LEDGER_INCOMPLETE.code,
      BizCode.ACTIVITY_CLOSURE_ALREADY_ACTIVE.code,
    ]);
  });

  // §5.15 ⑫ + §9.2:「必须清楚提示 30 个队员×场次尚未处理」——「30」要真的出现在返回体里。
  it('count = details 之和,且缺口清单带得动 §9.2 那个「30」', () => {
    const counts: ActivityClosureCheckCounts = {
      ...ZERO,
      settlement: {
        runNotPosted: 1,
        postedVersionMissing: 1,
        populationWithoutResult: 30,
        resultOutOfPopulation: 0,
        uncommittedResult: 0,
      },
    };
    const [gap] = collectClosureGaps(counts);
    expect(gap.gapCode).toBe('settlement_incomplete');
    expect(gap.bizCode).toBe(BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE.code);
    expect(gap.count).toBe(32);
    expect(gap.details.populationWithoutResult).toBe(30);
    expect(gap.message).toBe(BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE.message);
  });

  it('多类同时缺 ⇒ 一次全部交出去,顺序恒为合同步骤序(不 fail-fast)', () => {
    const counts: ActivityClosureCheckCounts = {
      ...ZERO,
      execution: { notEnded: 1, cancelled: 0 },
      ledger: { ...ZERO.ledger, duplicatePosting: 2 },
      closure: { activeClosure: 1 },
    };
    expect(collectClosureGaps(counts).map((gap) => gap.gapCode)).toEqual([
      'execution_not_ended',
      'ledger_incomplete',
      'closure_already_active',
    ]);
  });

  // 🔴 §3.26:「仅保存非敏感摘要和失败计数,**不复制人员明细**」。
  //    这条在判定层就该有执法位 —— checksJson 的形状完全由本文件决定。
  it('checksJson 只含数字 / 稳定标识 / 幂等键 —— 没有任何逐人字段名', () => {
    const checksJson = buildClosureChecksJson({
      counts: ZERO,
      totals: TOTALS,
      operationKey: 'close-key-1',
      requestHash: 'hash-1',
    });
    const serialized = JSON.stringify(checksJson);
    for (const forbidden of [
      'memberId',
      'memberNo',
      'displayName',
      'identityId',
      'participationIdentityId',
      'userId',
      'phone',
      'idCard',
      'latitude',
      'longitude',
      'name',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(checksJson.schemaVersion).toBe(1);
    expect(checksJson.failedClassCount).toBe(0);
    expect(checksJson.failureCount).toBe(0);
    expect(checksJson.idempotency).toEqual({
      operationKey: 'close-key-1',
      requestHash: 'hash-1',
    });
  });

  it('checksHash:同样事实同一 hash,任一计数变化即变(canonical,不许漂移)', () => {
    const base = buildClosureChecksJson({
      counts: ZERO,
      totals: TOTALS,
      operationKey: 'k',
      requestHash: 'h',
    });
    const same = buildClosureChecksJson({
      counts: ZERO,
      totals: TOTALS,
      operationKey: 'k',
      requestHash: 'h',
    });
    expect(computeClosureChecksHash(base)).toBe(computeClosureChecksHash(same));

    const drifted = buildClosureChecksJson({
      counts: { ...ZERO, ledger: { ...ZERO.ledger, overlappingSegment: 1 } },
      totals: TOTALS,
      operationKey: 'k',
      requestHash: 'h',
    });
    expect(computeClosureChecksHash(drifted)).not.toBe(computeClosureChecksHash(base));

    const otherTotals = buildClosureChecksJson({
      counts: ZERO,
      totals: { ...TOTALS, contributionPoints: '2.50' },
      operationKey: 'k',
      requestHash: 'h',
    });
    expect(computeClosureChecksHash(otherTotals)).not.toBe(computeClosureChecksHash(base));
  });
});

import {
  MANUAL_REASON_FORGERY_SUSPECTED,
  MANUAL_REASON_OCR_MISMATCH_CONFIRMED,
  MANUAL_REASON_SPECIAL_DOCUMENT,
  MANUAL_REASON_SYSTEM_OCR_ERROR,
  RISK_LEVEL_HIGH,
  RISK_LEVEL_NORMAL,
  RISK_LEVEL_SYSTEM,
  VERIFY_OUTCOME_FORGERY_WARNING,
  VERIFY_OUTCOME_MANUAL,
  VERIFY_OUTCOME_MATCHED,
  VERIFY_OUTCOME_MISMATCH,
  VERIFY_OUTCOME_OCR_ERROR,
  VERIFY_OUTCOME_OCR_UNCLEAR,
} from './recruitment.constants';
import { type OcrOutcome, classifyOcrResult, routeOcrOutcome } from './recruitment-ocr-routing';

// 招新闭环优化 S4b 单测:OCR 六分流纯函数(classifyOcrResult + routeOcrOutcome)逐路精确锁定
// (评审稿 §2.1 判定树 + Q-P4-2/3/4)。无 I/O、无 mock —— 纯输入→输出断言。

describe('classifyOcrResult(原始 OCR 信号 → 六分流 outcome)', () => {
  const typed = { realName: '张三', idCardNumber: '110101199003070038' };

  it('不清晰/读不出(recognized=false)→ ocr_unclear(优先于一切)', () => {
    expect(
      classifyOcrResult({ recognized: false, name: null, idCardNumber: null, warnings: [] }, typed),
    ).toBe('ocr_unclear');
  });

  it('防伪告警(warnings 非空)→ forgery_warning(防伪先于匹配,即便值匹配)', () => {
    expect(
      classifyOcrResult(
        { recognized: true, name: '张三', idCardNumber: '110101199003070038', warnings: ['PS'] },
        typed,
      ),
    ).toBe('forgery_warning');
  });

  it('清晰+无告警+姓名证件号双匹配 → matched', () => {
    expect(
      classifyOcrResult(
        { recognized: true, name: '张三', idCardNumber: '110101199003070038', warnings: [] },
        typed,
      ),
    ).toBe('matched');
  });

  it('清晰+无告警+姓名不一致 → mismatch', () => {
    expect(
      classifyOcrResult(
        { recognized: true, name: '李四', idCardNumber: '110101199003070038', warnings: [] },
        typed,
      ),
    ).toBe('mismatch');
  });

  it('清晰+无告警+证件号不一致 → mismatch', () => {
    expect(
      classifyOcrResult(
        { recognized: true, name: '张三', idCardNumber: '110101199003070046', warnings: [] },
        typed,
      ),
    ).toBe('mismatch');
  });

  it('识别端预览(无 typed):清晰+无告警 → matched(不判 mismatch,提交端权威判)', () => {
    expect(
      classifyOcrResult({
        recognized: true,
        name: '张三',
        idCardNumber: '110101199003070038',
        warnings: [],
      }),
    ).toBe('matched');
  });
});

describe('routeOcrOutcome(六分流路由 §2.1;Q-P4-2/3/4)', () => {
  // 无会话默认入参(小程序链);H5 会话用 withSession 覆盖
  function args(over: Partial<Parameters<typeof routeOcrOutcome>[0]> & { outcome: OcrOutcome }) {
    return {
      applicantConfirmedOcrWrong: false,
      sessionPriorCount: null,
      sessionPriorLastOutcome: null,
      ...over,
    };
  }

  it('matched → 落记录 verified + 无 risk/reason(唯一放行,行为锁)', () => {
    const d = routeOcrOutcome(args({ outcome: 'matched' }));
    expect(d.disposition).toBe('submitted');
    expect(d.record).toMatchObject({
      statusCode: 'verified',
      verifyOutcome: VERIFY_OUTCOME_MATCHED,
      manualReviewReason: null,
      riskLevel: null,
      lastOcrOutcome: VERIFY_OUTCOME_MATCHED,
    });
    expect(d.sessionBump).toBeNull();
  });

  it('manual(特殊证件/非 OCR)→ 落记录 普通人工(special_document, normal)', () => {
    const d = routeOcrOutcome(args({ outcome: 'manual' }));
    expect(d.disposition).toBe('submitted');
    expect(d.record).toMatchObject({
      statusCode: 'manual_review',
      verifyOutcome: VERIFY_OUTCOME_MANUAL,
      manualReviewReason: MANUAL_REASON_SPECIAL_DOCUMENT,
      riskLevel: RISK_LEVEL_NORMAL,
    });
  });

  // ===== mismatch:三选一(§2.1 / Q-P4-2)=====
  it('mismatch + 无确认标记 → 延迟 confirm(不落记录;有会话则计数 lastOutcome=mismatch)', () => {
    const d = routeOcrOutcome(
      args({ outcome: 'mismatch', sessionPriorCount: 0, sessionPriorLastOutcome: null }),
    );
    expect(d.disposition).toBe('confirm');
    expect(d.record).toBeNull();
    expect(d.sessionBump).toMatchObject({
      lastOcrOutcome: VERIFY_OUTCOME_MISMATCH,
      requiresRetake: false,
    });
  });

  it('mismatch + applicantConfirmedOcrWrong(③)→ 落记录 普通人工(ocr_mismatch_confirmed, normal, 标记 true)', () => {
    const d = routeOcrOutcome(args({ outcome: 'mismatch', applicantConfirmedOcrWrong: true }));
    expect(d.disposition).toBe('submitted');
    expect(d.record).toMatchObject({
      statusCode: 'manual_review',
      verifyOutcome: VERIFY_OUTCOME_MISMATCH,
      manualReviewReason: MANUAL_REASON_OCR_MISMATCH_CONFIRMED,
      riskLevel: RISK_LEVEL_NORMAL,
      applicantConfirmedOcrWrong: true,
    });
  });

  it('mismatch ①② 就地纠正 = 改填写后重判为 matched(非 routing 责;此处验 confirm 不落人工)', () => {
    // ①用 OCR 回填 / ②改填写 → 申请人改后重提 → OCR 重判 matched(见 matched 用例);仅③落人工。
    const d = routeOcrOutcome(args({ outcome: 'mismatch' }));
    expect(d.disposition).not.toBe('submitted');
  });

  // ===== ocr_unclear:永不进人工(§2.1 row 2 / DoD#2)=====
  it('ocr_unclear → 延迟 retake + requiresRetake=true;永不升级(即便高计数)', () => {
    const low = routeOcrOutcome(
      args({ outcome: 'ocr_unclear', sessionPriorCount: 0, sessionPriorLastOutcome: null }),
    );
    expect(low.disposition).toBe('retake');
    expect(low.sessionBump).toMatchObject({
      lastOcrOutcome: VERIFY_OUTCOME_OCR_UNCLEAR,
      requiresRetake: true,
      ocrAttemptCount: 1,
    });
    // 即便已连续 5 次 unclear,仍 retake(不落记录)
    const high = routeOcrOutcome(
      args({
        outcome: 'ocr_unclear',
        sessionPriorCount: 5,
        sessionPriorLastOutcome: 'ocr_unclear',
      }),
    );
    expect(high.disposition).toBe('retake');
    expect(high.record).toBeNull();
    expect(high.sessionBump?.ocrAttemptCount).toBe(6);
  });

  // ===== forgery_warning:连续达 2 次才落高风险(§2.1 / Q-P4-3)=====
  it('forgery_warning 首次(会话 count 0)→ 延迟 retake(重拍原件);count→1', () => {
    const d = routeOcrOutcome(
      args({ outcome: 'forgery_warning', sessionPriorCount: 0, sessionPriorLastOutcome: null }),
    );
    expect(d.disposition).toBe('retake');
    expect(d.record).toBeNull();
    expect(d.sessionBump).toMatchObject({
      lastOcrOutcome: VERIFY_OUTCOME_FORGERY_WARNING,
      requiresRetake: true,
      ocrAttemptCount: 1,
    });
  });

  it('forgery_warning 连续第 2 次(prior=1,last=forgery)→ 落高风险(forgery_suspected, high)', () => {
    const d = routeOcrOutcome(
      args({
        outcome: 'forgery_warning',
        sessionPriorCount: 1,
        sessionPriorLastOutcome: 'forgery_warning',
      }),
    );
    expect(d.disposition).toBe('submitted');
    expect(d.record).toMatchObject({
      statusCode: 'manual_review',
      verifyOutcome: VERIFY_OUTCOME_FORGERY_WARNING,
      manualReviewReason: MANUAL_REASON_FORGERY_SUSPECTED,
      riskLevel: RISK_LEVEL_HIGH,
    });
    expect(d.sessionBump).toBeNull();
  });

  // ===== ocr_error:首次重试、连续 2 次才落系统异常(§2.1 / Q-P4-4)=====
  it('ocr_error 首次(会话 count 0)→ 延迟 retry;count→1,requiresRetake=false', () => {
    const d = routeOcrOutcome(
      args({ outcome: 'ocr_error', sessionPriorCount: 0, sessionPriorLastOutcome: null }),
    );
    expect(d.disposition).toBe('retry');
    expect(d.record).toBeNull();
    expect(d.sessionBump).toMatchObject({
      lastOcrOutcome: VERIFY_OUTCOME_OCR_ERROR,
      requiresRetake: false,
      ocrAttemptCount: 1,
    });
  });

  it('ocr_error 连续第 2 次 → 落系统异常(system_ocr_error, system〔顺修口径〕)', () => {
    const d = routeOcrOutcome(
      args({ outcome: 'ocr_error', sessionPriorCount: 1, sessionPriorLastOutcome: 'ocr_error' }),
    );
    expect(d.disposition).toBe('submitted');
    expect(d.record).toMatchObject({
      statusCode: 'manual_review',
      verifyOutcome: VERIFY_OUTCOME_OCR_ERROR,
      manualReviewReason: MANUAL_REASON_SYSTEM_OCR_ERROR,
      riskLevel: RISK_LEVEL_SYSTEM,
    });
  });

  it('「连续」语义:上次结论不同则计数归 1、不升级(ocr_error 之后 forgery 仍首次)', () => {
    const d = routeOcrOutcome(
      args({
        outcome: 'forgery_warning',
        sessionPriorCount: 1,
        sessionPriorLastOutcome: 'ocr_error',
      }),
    );
    expect(d.disposition).toBe('retake'); // 非连续 → 不升级
    expect(d.sessionBump?.ocrAttemptCount).toBe(1);
  });

  // ===== 无会话(小程序链/无 token):延迟到底、不服务端升级(Q-P4-1 退化)=====
  it('无会话 forgery_warning → 延迟 retake,sessionBump=null(不持久计数、不升级)', () => {
    const d = routeOcrOutcome(args({ outcome: 'forgery_warning', sessionPriorCount: null }));
    expect(d.disposition).toBe('retake');
    expect(d.sessionBump).toBeNull();
  });

  it('无会话 ocr_error → 延迟 retry,sessionBump=null', () => {
    const d = routeOcrOutcome(args({ outcome: 'ocr_error', sessionPriorCount: null }));
    expect(d.disposition).toBe('retry');
    expect(d.sessionBump).toBeNull();
  });

  it('无会话 mismatch + 确认③ → 仍落普通人工(无需会话)', () => {
    const d = routeOcrOutcome(
      args({ outcome: 'mismatch', applicantConfirmedOcrWrong: true, sessionPriorCount: null }),
    );
    expect(d.disposition).toBe('submitted');
    expect(d.record?.riskLevel).toBe(RISK_LEVEL_NORMAL);
  });
});

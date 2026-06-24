import { normalizeIdForMatch, normalizeNameForMatch } from '../realname/realname.constants';
import {
  APP_STATUS_MANUAL,
  APP_STATUS_VERIFIED,
  MANUAL_REASON_FORGERY_SUSPECTED,
  MANUAL_REASON_OCR_MISMATCH_CONFIRMED,
  MANUAL_REASON_SPECIAL_DOCUMENT,
  MANUAL_REASON_SYSTEM_OCR_ERROR,
  OCR_DEFER_MAX_ATTEMPTS,
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

// 招新闭环优化 S4b(OCR 六分流;评审稿 recruitment-phase4-loop-optimization-review.md §2.1;goal「招新闭环优化 S4b」)。
//
// 把现「5 分支全塞 manual_review」拆为六分流的**纯函数判定**(srvf-god-service-refactor:OCR 判定抽离,
// 不堆进 900 行 RecruitmentApplicationsService)。本模块零 I/O、零 Prisma、零副作用 —— 全部入参显式传入,
// 全部分流结论显式返回,供 service 据此执行(落报名记录 / 延迟响应 + 写会话行计数)与单测逐路精确锁定。
//
// **职责边界**:本模块只算「这次 OCR 结果 + 会话计数 + 三选一标记 → 该落记录还是延迟、落什么字段、计数怎么走」;
// 真正的付费 OCR 调用、落库事务、会话行读写由 service 做。`ocr_error`(上游失败/通道未配)由 service 的
// try/catch 另判后以 outcome='ocr_error' 传入(不在本模块判异常)。
//
// **既有行为锁(评审稿 §2.5)**:matched+清晰+无告警 = `verified` 唯一放行(本模块只在此路返 verified);
// 既有 verifyOutcome 值全保留、语义不改(复用扩展)。

// 六分流 outcome(= 既有 verifyOutcome 机器判定值的子集 + manual;评审稿 §2.1)
export type OcrOutcome =
  | 'matched'
  | 'mismatch'
  | 'forgery_warning'
  | 'ocr_unclear'
  | 'ocr_error'
  | 'manual';

// 原始 OCR 信号(RealnameOcrResult 子集;classifyOcrResult 入参)
export interface OcrSignal {
  recognized: boolean;
  name: string | null;
  idCardNumber: string | null;
  warnings: string[];
}

// 申请人填写待比对值(提交端有;识别端预览无 → 不判 mismatch,清晰+无告警即「可提交」)
export interface OcrTypedValues {
  realName: string;
  idCardNumber: string;
}

/**
 * 纯:OCR 原始信号 → 六分流 outcome(评审稿 §3.6 矩阵「防伪先于匹配」)。
 * - 不清晰/读不出 → `ocr_unclear`;有防伪告警 → `forgery_warning`(优先于匹配);
 * - 有 typed(提交端):姓名+证件号双匹配 → `matched`,否则 `mismatch`;
 * - 无 typed(识别端预览):清晰+无告警即 `matched`(mismatch 由提交端权威判)。
 * `ocr_error`(上游失败)不在此 —— 由调用方 try/catch 另判后直接路由。
 */
export function classifyOcrResult(ocr: OcrSignal, typed?: OcrTypedValues): OcrOutcome {
  if (!ocr.recognized) return 'ocr_unclear';
  if (ocr.warnings.length > 0) return 'forgery_warning';
  if (!typed) return 'matched';
  const nameMatch =
    ocr.name != null && normalizeNameForMatch(ocr.name) === normalizeNameForMatch(typed.realName);
  const idMatch =
    ocr.idCardNumber != null &&
    normalizeIdForMatch(ocr.idCardNumber) === normalizeIdForMatch(typed.idCardNumber);
  return nameMatch && idMatch ? 'matched' : 'mismatch';
}

export interface OcrRoutingArgs {
  outcome: OcrOutcome;
  // mismatch 三选一之③:申请人坚持填写为准、确认 OCR 错(submit payload;默认 false)
  applicantConfirmedOcrWrong: boolean;
  // H5 报名前身份会话行先前计数(Q-P4-1;**无会话(小程序链/无 token)传 null**)。
  // forgery/ocr_error「连续 2 次才落记录」与重拍累计计数据此推进。
  sessionPriorCount: number | null;
  sessionPriorLastOutcome: string | null;
}

// 落报名记录时写入 application 的 OCR 字段集(disposition='submitted')
export interface OcrRecordFields {
  statusCode: string; // verified | manual_review
  verifyOutcome: string;
  manualReviewReason: string | null;
  riskLevel: string | null;
  applicantConfirmedOcrWrong: boolean;
  lastOcrOutcome: string; // 快照
}

// 延迟(不落记录)时写会话行的计数(仅有会话时;§2.3 落 recruitment_identity_sessions 预建列)
export interface OcrSessionBump {
  lastOcrOutcome: string;
  requiresRetake: boolean;
  ocrAttemptCount: number; // 连续计数(forgery/ocr_error 达 OCR_DEFER_MAX_ATTEMPTS 即升级落记录)
}

export interface OcrRoutingDecision {
  // 'submitted' = 落报名记录;'retake'/'confirm'/'retry' = 不落记录(申请人侧延迟引导)
  disposition: 'submitted' | 'retake' | 'confirm' | 'retry';
  record: OcrRecordFields | null;
  sessionBump: OcrSessionBump | null;
}

function submitted(record: OcrRecordFields): OcrRoutingDecision {
  return { disposition: 'submitted', record, sessionBump: null };
}

function defer(
  disposition: 'retake' | 'confirm' | 'retry',
  hasSession: boolean,
  bump: OcrSessionBump,
): OcrRoutingDecision {
  // 无会话(小程序链/无 token):延迟引导但不持久计数(Q-P4-1 退化为客户端计数 + IP 限流;不服务端强制升级)
  return { disposition, record: null, sessionBump: hasSession ? bump : null };
}

/**
 * 六分流路由(评审稿 §2.1 判定树;Q-P4-2/3/4 已拍板)。纯函数,零副作用。
 * - matched → verified + 临时号(**唯一放行,行为锁不变**);
 * - manual(特殊证件/非 OCR)→ 普通人工(special_document, normal);
 * - mismatch → 三选一:①②就地纠正重判(不进人工)/ 仅③ applicantConfirmedOcrWrong → 普通人工(normal);否则延迟 confirm;
 * - ocr_unclear → 永不进人工、不落记录、延迟 retake(会话行 requiresRetake + 计数累积);
 * - forgery_warning → 先延迟 retake(重拍原件),连续达 OCR_DEFER_MAX_ATTEMPTS → 高风险复核(high);
 * - ocr_error → 先延迟 retry,连续达 OCR_DEFER_MAX_ATTEMPTS → 系统异常通道(system〔§2.4,顺修 §2.1〕)。
 * 升级落记录仅在**有会话**时服务端强制(无会话延迟到底,靠 IP 限流兜底)。
 */
export function routeOcrOutcome(args: OcrRoutingArgs): OcrRoutingDecision {
  const { outcome, applicantConfirmedOcrWrong, sessionPriorCount, sessionPriorLastOutcome } = args;
  const hasSession = sessionPriorCount !== null;
  // 连续计数:与上次同结论 +1,否则归 1(「连续 N 次」语义);无会话恒 1(不升级)。
  const consecutive = hasSession
    ? sessionPriorLastOutcome === outcome
      ? sessionPriorCount + 1
      : 1
    : 1;

  switch (outcome) {
    case 'matched':
      return submitted({
        statusCode: APP_STATUS_VERIFIED,
        verifyOutcome: VERIFY_OUTCOME_MATCHED,
        manualReviewReason: null,
        riskLevel: null,
        applicantConfirmedOcrWrong: false,
        lastOcrOutcome: VERIFY_OUTCOME_MATCHED,
      });

    case 'manual':
      return submitted({
        statusCode: APP_STATUS_MANUAL,
        verifyOutcome: VERIFY_OUTCOME_MANUAL,
        manualReviewReason: MANUAL_REASON_SPECIAL_DOCUMENT,
        riskLevel: RISK_LEVEL_NORMAL,
        applicantConfirmedOcrWrong: false,
        lastOcrOutcome: VERIFY_OUTCOME_MANUAL,
      });

    case 'mismatch':
      if (applicantConfirmedOcrWrong) {
        return submitted({
          statusCode: APP_STATUS_MANUAL,
          verifyOutcome: VERIFY_OUTCOME_MISMATCH,
          manualReviewReason: MANUAL_REASON_OCR_MISMATCH_CONFIRMED,
          riskLevel: RISK_LEVEL_NORMAL,
          applicantConfirmedOcrWrong: true,
          lastOcrOutcome: VERIFY_OUTCOME_MISMATCH,
        });
      }
      return defer('confirm', hasSession, {
        lastOcrOutcome: VERIFY_OUTCOME_MISMATCH,
        requiresRetake: false,
        ocrAttemptCount: consecutive,
      });

    case 'ocr_unclear':
      return defer('retake', hasSession, {
        lastOcrOutcome: VERIFY_OUTCOME_OCR_UNCLEAR,
        requiresRetake: true,
        ocrAttemptCount: consecutive,
      });

    case 'forgery_warning':
      if (hasSession && consecutive >= OCR_DEFER_MAX_ATTEMPTS) {
        return submitted({
          statusCode: APP_STATUS_MANUAL,
          verifyOutcome: VERIFY_OUTCOME_FORGERY_WARNING,
          manualReviewReason: MANUAL_REASON_FORGERY_SUSPECTED,
          riskLevel: RISK_LEVEL_HIGH,
          applicantConfirmedOcrWrong: false,
          lastOcrOutcome: VERIFY_OUTCOME_FORGERY_WARNING,
        });
      }
      return defer('retake', hasSession, {
        lastOcrOutcome: VERIFY_OUTCOME_FORGERY_WARNING,
        requiresRetake: true,
        ocrAttemptCount: consecutive,
      });

    case 'ocr_error':
      if (hasSession && consecutive >= OCR_DEFER_MAX_ATTEMPTS) {
        return submitted({
          statusCode: APP_STATUS_MANUAL,
          verifyOutcome: VERIFY_OUTCOME_OCR_ERROR,
          manualReviewReason: MANUAL_REASON_SYSTEM_OCR_ERROR,
          riskLevel: RISK_LEVEL_SYSTEM,
          applicantConfirmedOcrWrong: false,
          lastOcrOutcome: VERIFY_OUTCOME_OCR_ERROR,
        });
      }
      return defer('retry', hasSession, {
        lastOcrOutcome: VERIFY_OUTCOME_OCR_ERROR,
        requiresRetake: false,
        ocrAttemptCount: consecutive,
      });
  }
}

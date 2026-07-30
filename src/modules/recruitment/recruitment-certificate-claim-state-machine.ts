import { RecruitmentCertificateClaimStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// 证书标准库 PR-4a(冻结稿 §8.2 / §8.4):招新证书申报的**纯**状态机与门槛派生。
//
// 零 DB、零 mock、零 Prisma client —— 与 certificate-standard-policy.ts 同款理由:
// 这是本刀最容易被后续改动悄悄放松的部分,放在纯函数里可穷举单测,
// service 只能调、不能绕。

// ============ §8.2 Claim 状态机 ============
//
// 允许(逐条对应 §8.2):
//   SUBMITTED   → NEEDS_INFO / APPROVED / REJECTED
//   NEEDS_INFO  → SUBMITTED            (申请人补充材料后重新提交)
//   REJECTED    → SUBMITTED            (申请人修正后重投)
//   APPROVED    → PROMOTED             (发号搬运)
//   APPROVED    → SUBMITTED            (§8.2 末:管理员「撤回审核」独立动作)
//   SUBMITTED / NEEDS_INFO / APPROVED / REJECTED → WITHDRAWN
//
// 禁止:
//   PROMOTED → 任何状态   —— 已生成正式 Certificate,回退等于让档案与申报事实脱钩
//   WITHDRAWN → 任何状态  —— 终态;要重来就新建一条 Claim(一证一行,不复用行)
const CLAIM_ALLOWED: ReadonlyMap<
  RecruitmentCertificateClaimStatus,
  ReadonlySet<RecruitmentCertificateClaimStatus>
> = new Map<RecruitmentCertificateClaimStatus, ReadonlySet<RecruitmentCertificateClaimStatus>>([
  [
    RecruitmentCertificateClaimStatus.SUBMITTED,
    new Set([
      RecruitmentCertificateClaimStatus.NEEDS_INFO,
      RecruitmentCertificateClaimStatus.APPROVED,
      RecruitmentCertificateClaimStatus.REJECTED,
      RecruitmentCertificateClaimStatus.WITHDRAWN,
    ]),
  ],
  [
    RecruitmentCertificateClaimStatus.NEEDS_INFO,
    new Set([
      RecruitmentCertificateClaimStatus.SUBMITTED,
      RecruitmentCertificateClaimStatus.WITHDRAWN,
    ]),
  ],
  [
    RecruitmentCertificateClaimStatus.REJECTED,
    new Set([
      RecruitmentCertificateClaimStatus.SUBMITTED,
      RecruitmentCertificateClaimStatus.WITHDRAWN,
    ]),
  ],
  [
    RecruitmentCertificateClaimStatus.APPROVED,
    new Set([
      RecruitmentCertificateClaimStatus.PROMOTED,
      // 撤回审核:回 SUBMITTED 而不是 NEEDS_INFO —— 撤回是「审核结论错了」,
      // 不是「材料不足」,不该给申请人推一条补材料通知(§8.2 末段)。
      RecruitmentCertificateClaimStatus.SUBMITTED,
      RecruitmentCertificateClaimStatus.WITHDRAWN,
    ]),
  ],
  // 两个终态:空集 = 任何转移都拒。
  [RecruitmentCertificateClaimStatus.PROMOTED, new Set<RecruitmentCertificateClaimStatus>()],
  [RecruitmentCertificateClaimStatus.WITHDRAWN, new Set<RecruitmentCertificateClaimStatus>()],
]);

export function assertClaimTransitionAllowed(
  from: RecruitmentCertificateClaimStatus,
  to: RecruitmentCertificateClaimStatus,
): void {
  if (!CLAIM_ALLOWED.get(from)?.has(to)) {
    throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID);
  }
}

// 申请人可自行改动的状态(重传 / 撤回)。管理员动作走 review / revoke-review,
// 不复用这个判断 —— §8.2 明确「APPROVED 不可由申请人直接修改」。
export function assertApplicantMayMutate(status: RecruitmentCertificateClaimStatus): void {
  const mutable =
    status === RecruitmentCertificateClaimStatus.SUBMITTED ||
    status === RecruitmentCertificateClaimStatus.NEEDS_INFO ||
    status === RecruitmentCertificateClaimStatus.REJECTED;
  if (!mutable) {
    throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID);
  }
}

// ============ §15.5 / §15.9 证据可读状态闸 ============
//
// 「谁能看这条申报的证据图」不是只看权限码,还要看**这条申报此刻处于什么状态**。
// 两个终态各有各的理由被拒:
//
//   WITHDRAWN  申请人已经把材料撤回了。撤回的语义就是「别再看了」——
//              继续按 read.sensitive 放行,等于撤回只撤了个列表可见性(§15.5)。
//   PROMOTED   证据已经成为一张正式证书的认定依据。此后它只能经
//              `GET /admin/v1/members/:memberId/certificates/:id/evidence-urls` 读 ——
//              那条路走的是 Certificate 的 **scoped** authz(能看这个队员才能看),
//              而招新审核码是 GLOBAL 的。留着 Claim 端点等于给 promoted 队员的
//              档案开了一条绕过 scope 的旁路(§15.9)。
//
// 非终态(SUBMITTED / NEEDS_INFO / APPROVED / REJECTED)一律放行:它们都还在审核流里,
// REJECTED 尤其不能拒 —— 申请人可以从 REJECTED 重投,审核员必须能回看「当初拒的是什么」。
const CLAIM_EVIDENCE_DENIED: ReadonlySet<RecruitmentCertificateClaimStatus> = new Set([
  RecruitmentCertificateClaimStatus.WITHDRAWN,
  RecruitmentCertificateClaimStatus.PROMOTED,
]);

export function assertClaimEvidenceReadable(status: RecruitmentCertificateClaimStatus): void {
  if (CLAIM_EVIDENCE_DENIED.has(status)) {
    throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID);
  }
}

// CAS:申请人重传与管理员审核可能同时进行,靠 version 防互相覆盖(§5.5)。
export function assertClaimVersionMatches(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT);
  }
}

// ============ §8.4 门槛派生 ============
//
// 「某证书门槛完成 = 当前报名下至少存在一条 status ∈ {APPROVED, PROMOTED}
//   且 Standard.categoryCode 对应该门槛 且未软删的 Claim」
//
// 关键是**聚合**而不是「最后一次 review 写 true/false」:
// 两张急救证中拒掉一张,不该清除另一张已通过证书带来的门槛(§8.4 第一条推论)。
// 这就是为什么门槛必须是派生投影而不是可写标记 —— 可写标记天然记不住「还有另一张」。
const THRESHOLD_CONTRIBUTING_STATUSES: ReadonlySet<RecruitmentCertificateClaimStatus> = new Set([
  RecruitmentCertificateClaimStatus.APPROVED,
  RecruitmentCertificateClaimStatus.PROMOTED,
]);

export function claimContributesToThreshold(status: RecruitmentCertificateClaimStatus): boolean {
  return THRESHOLD_CONTRIBUTING_STATUSES.has(status);
}

/**
 * 从该报名的全部未软删 Claim 聚合出「哪些证书类别已满足」。
 *
 * 入参刻意只要 `{ status, categoryCode }` 两个字段 —— 让调用方无法把整行 Claim
 * (含 imageKeys / certNumber 等敏感字段)顺手传进这个纯函数。
 * `categoryCode` 取自**已解析的 Standard**,不是申请人填的 categoryHintCode:
 * 提示只是提示,门槛只认审核结论(D-CERT-016)。
 */
export function deriveSatisfiedCertificateCategories(
  claims: ReadonlyArray<{ status: RecruitmentCertificateClaimStatus; categoryCode: string | null }>,
): ReadonlySet<string> {
  const satisfied = new Set<string>();
  for (const c of claims) {
    if (c.categoryCode !== null && claimContributesToThreshold(c.status)) {
      satisfied.add(c.categoryCode);
    }
  }
  return satisfied;
}

// ============ §8.4 报名状态随门槛重算 ============
//
// 证书门槛由完成变为未完成:
//   pending_evaluation → verified
//   publicity          → verified
//   verified           → verified
// 证书门槛由未完成变为全部完成:
//   verified                 → pending_evaluation
//   publicity 且仍全部完成   → publicity
//
// 从 publicity 回退时必须同步清空评定字段并写审计(见 service;此处只算目标状态)——
// §8.4 明确「不能保留『已评定通过』字段却把状态退回」。

export const APP_STATUS_VERIFIED = 'verified';
export const APP_STATUS_PENDING_EVALUATION = 'pending_evaluation';
export const APP_STATUS_PUBLICITY = 'publicity';

export interface ThresholdRecalcResult {
  nextStatus: string;
  /** 从 publicity 掉下来 → 调用方必须清 evaluatedByUserId / evaluatedAt / evaluationNote 并写审计 */
  mustClearEvaluation: boolean;
}

/**
 * 只处理「门槛变化会波及」的三个状态;其余状态(pending_verification / rejected /
 * withdrawn / promoted)一律原样返回 —— 发号后门槛不可再动,已拒/已撤的报名也不该被
 * 一条 Claim 的审核结论拉回流程。
 */
export function recalcApplicationStatusForThresholds(
  currentStatus: string,
  allThresholdsComplete: boolean,
): ThresholdRecalcResult {
  if (
    currentStatus !== APP_STATUS_VERIFIED &&
    currentStatus !== APP_STATUS_PENDING_EVALUATION &&
    currentStatus !== APP_STATUS_PUBLICITY
  ) {
    return { nextStatus: currentStatus, mustClearEvaluation: false };
  }

  if (allThresholdsComplete) {
    // publicity 已全完成 → 留在 publicity(不把已公示的人拉回评定队列)。
    if (currentStatus === APP_STATUS_PUBLICITY) {
      return { nextStatus: APP_STATUS_PUBLICITY, mustClearEvaluation: false };
    }
    return { nextStatus: APP_STATUS_PENDING_EVALUATION, mustClearEvaluation: false };
  }

  // 未全完成 → 一律回 verified;从 publicity 掉下来的那一路要清评定字段。
  return {
    nextStatus: APP_STATUS_VERIFIED,
    mustClearEvaluation: currentStatus === APP_STATUS_PUBLICITY,
  };
}

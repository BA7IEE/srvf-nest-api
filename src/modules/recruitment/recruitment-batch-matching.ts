// 招新闭环优化 S6(评审稿 docs/archive/reviews/recruitment-phase4-loop-optimization-review.md §8.1):
// 批量标门槛「匹配键 → 唯一报名行 id」的**纯函数**解析(零 DB、零副作用;沿 recruitment-ocr-routing.ts
// 纯 helper + 同名 spec 范式,把可测的匹配逻辑从 god-service 抽离)。
//
// **「签到记录导入」边界收敛**:评审稿 §8.1 四匹配键之一的「签到记录导入」= 前端把签到表/名单解析为
// 本 `matches` 数组(每行一个匹配项,携带临时编号 / 手机 / 姓名),后端**不碰文件解析**(避免本刀匹配过重;
// 与 goal「签到记录导入匹配过重无法收敛 → 人话简报停」对齐:收敛在前端解析,后端只认归一数组)。
//
// **匹配优先级(每项独立判定)**:tempNo > (realName + phone) > phone;三键皆空 → insufficient-key。
// **命中裁决**:0 → no-match;>1 → ambiguous(**绝不猜**,歧义安全留人工);恰好 1 → matched(id)。
// 同轮内手机/姓名+手机通常唯一;跨轮或「rejected 后重报」可能多命中 → ambiguous 不误标(安全优先)。

export interface BatchMatchInput {
  tempNo?: string | null;
  phone?: string | null;
  realName?: string | null;
}

export interface BatchMatchCandidate {
  id: string;
  tempNo: string | null;
  phone: string | null;
  realName: string | null;
}

export type BatchMatchedBy = 'tempNo' | 'name+phone' | 'phone';
export type BatchUnmatchedReason = 'no-match' | 'ambiguous' | 'insufficient-key';

export type BatchMatchResolution =
  | { status: 'matched'; applicationId: string; matchedBy: BatchMatchedBy }
  | { status: 'unmatched'; reason: BatchUnmatchedReason };

/** 归一:去首尾空白;空串视为缺省(null)。 */
function normalize(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 单个匹配项解析(纯函数)。 */
export function resolveBatchMatch(
  input: BatchMatchInput,
  candidates: readonly BatchMatchCandidate[],
): BatchMatchResolution {
  const tempNo = normalize(input.tempNo);
  const phone = normalize(input.phone);
  const realName = normalize(input.realName);

  let matchedBy: BatchMatchedBy;
  let hits: readonly BatchMatchCandidate[];
  if (tempNo != null) {
    matchedBy = 'tempNo';
    hits = candidates.filter((c) => c.tempNo != null && c.tempNo === tempNo);
  } else if (realName != null && phone != null) {
    matchedBy = 'name+phone';
    hits = candidates.filter((c) => c.phone === phone && c.realName === realName);
  } else if (phone != null) {
    matchedBy = 'phone';
    hits = candidates.filter((c) => c.phone === phone);
  } else {
    // 仅给 realName(无 phone)亦不足:姓名单键歧义过大,不作为匹配键。
    return { status: 'unmatched', reason: 'insufficient-key' };
  }

  if (hits.length === 0) return { status: 'unmatched', reason: 'no-match' };
  if (hits.length > 1) return { status: 'unmatched', reason: 'ambiguous' };
  return { status: 'matched', applicationId: hits[0].id, matchedBy };
}

/** 批量匹配项解析(与入参同序)。 */
export function resolveBatchMatches(
  inputs: readonly BatchMatchInput[],
  candidates: readonly BatchMatchCandidate[],
): BatchMatchResolution[] {
  return inputs.map((input) => resolveBatchMatch(input, candidates));
}

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// ===== 活动改造 v1.1 第 2 批第七刀:更正申请的 `requestedChangeJson` 形状(纯函数)=====
//
// 🔴 **这份 Json 是"账要改成什么样"的唯一输入。** 它解析错了不会报错 ——
//    会安静地按一份不是申请人本意的内容重记一遍账。因此本模块**只接受完全合规的形状**,
//    任何多余键、缺失键、类型不符、越界数值一律**拒绝**(20102),没有一处走"忽略后继续"。
//
// ## 为什么形状定在这里,而不是 DTO
//
// 本刀**零端点 / 零 DTO**(对外入口归第 ⑧ 刀)。而 §3.25 只给了 `requestedChangeJson`
// 这个列名,**没有给它的字段表** —— 合同在这里是空的。空着不填是不行的:更正应用算法
// (§5.14 ③)必须知道"改哪些人的哪些值"才能生成新的 Result revisions。
// ⇒ 本模块给出一份**带 schemaVersion 的显式闭集**,并在报告里作为"合同未定义、由本刀
//   补齐"的偏离逐条列明。第 ⑧ 刀开端点时,DTO 只需照抄本闭集,不必再发明第二套。
//
// ## 两类变更,分开表达(❌ 不合并成一个"万能 patch")
//
//   ① `results`  —— 人员结果层(§3.20):resultCode / 认定时长 / 认定贡献值 / 两个标签。
//   ② `segments` —— 服务段层(§3.18):签到签退时刻与段结果码。
//
// §5.14 ③ 逐字要求「新的 SettlementVersion revision **和** Result／Segment revisions」
// ⇒ 两层都要能被更正。分开表达的理由是硬的:段变了**必然**改变日拆分的权重
// (`splitRecognizedIntoDays` 拿段当权重),而结果值变了**不**改变权重 ——
// 合成一个结构就再也分不清"这次要不要重算日拆分"。
//
// ## 数值一律走字符串入口
//
// 认定时长与贡献值在 DB 上是 `numeric(5,2)`。Json 里若直接写 number,`0.1+0.2` 这类
// 浮点表示会在往返中漂;而账上漂一分就是账不平(沿 `ledger-day-allocation.ts` 的同一立场)。
// ⇒ 本模块只接受**两位小数以内的十进制字符串**,越界 / 多余小数位一律拒绝,
//   不做"四舍五入后接受"(那正是 `numeric(5,2)` 静默归一的坑,第 1 批已实测)。

/** 本闭集的版本。日后扩展必须递增,**不得**在同一版本号下悄悄加键。 */
export const CORRECTION_CHANGE_SCHEMA_VERSION = 1;
export const TIME_CORRECTION_CHANGE_SCHEMA_VERSION = 2;
/**
 * D7-2 fact correction deliberately gets a new closed shape: a signed V2
 * request can never silently acquire segment/allocation semantics.
 */
export const FACT_CORRECTION_CHANGE_SCHEMA_VERSION = 3;

const FACT_CORRECTION_CATEGORIES = [
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;

/** §3.20 十值闭集,与 `participant_settlement_result_result_code_check` 逐字一致。 */
export const CORRECTION_RESULT_CODES = [
  'present',
  'leave',
  'absent',
  'cancelled',
  'not_selected',
  'waitlist_expired',
  'review_expired',
  'invitation_expired',
  'exempt',
  'early_departure_zero',
] as const;

/** §3.18 段结果码闭集(与第五刀 `WEIGHT_BEARING_SEGMENT_RESULT_CODES` 同一真源域)。 */
export const CORRECTION_SEGMENT_RESULT_CODES = [
  'valid',
  'early_departure_zero',
  'voided',
  'replaced',
] as const;

export interface CorrectionResultChange {
  readonly participationIdentityId: string;
  readonly resultCode: string;
  /** 认定服务时长(小时,两位小数)。 */
  readonly recognizedServiceHours: number;
  /** 认定贡献值(两位小数)。 */
  readonly recognizedContributionPoints: number;
  /** §3.20:认定与计算不同**必填**(DB CHECK 兜底)。 */
  readonly adjustmentReason: string | null;
  readonly lateFlag: boolean;
  readonly earlyLeaveFlag: boolean;
}

export interface CorrectionSegmentChange {
  readonly participationIdentityId: string;
  /** 被更正的段。同 identity 下按 `segmentKey` 定位既有段并追加新 revision。 */
  readonly segmentKey: string;
  readonly checkInAt: Date;
  readonly checkOutAt: Date;
  readonly resultCode: string;
  /** 段自身的时长(小时,两位小数)。 */
  readonly serviceHours: number;
}

export interface CorrectionChangeSet {
  readonly schemaVersion: number;
  readonly results: readonly CorrectionResultChange[];
  readonly segments: readonly CorrectionSegmentChange[];
  readonly timeCorrection?: CorrectionTimeChange;
  readonly allocations?: readonly CorrectionAllocationChange[];
}

export interface CorrectionTimeChange {
  readonly baseSettlementVersionId: string;
  readonly baseTimeLedgerHash: string;
  readonly reason: string;
  readonly items: readonly {
    readonly rootEntryId: string;
    readonly recognizedSeconds: number;
  }[];
}

export interface CorrectionAllocationSliceChange {
  readonly categoryCode: (typeof FACT_CORRECTION_CATEGORIES)[number];
  readonly intervalKindCode: 'service_segment';
  readonly startAt: Date;
  readonly endAt: Date;
}

/** A V3 allocation replaces one declared source segment; it is never a patch. */
export interface CorrectionAllocationChange {
  readonly participationIdentityId: string;
  readonly segmentKey: string;
  readonly baseSegmentRevisionId: string;
  readonly baseAllocationRevisionId: string;
  readonly recognitionModeCode: 'automatic' | 'manual';
  readonly manualReason: string | null;
  readonly slices: readonly CorrectionAllocationSliceChange[];
  readonly evidenceAttachmentIds: readonly string[];
}

/**
 * The parser intentionally materializes instants as `Date`, while the shared
 * fingerprint primitive accepts JSON values only.  Passing those Dates through
 * would canonicalize them as empty objects and make distinct V3 facts collide.
 *
 * This is a serialization boundary, not a second parser: callers must pass the
 * already accepted closed change set. V1/V2 retain their existing values; V3
 * rewrites decimal values back to their parser-compatible canonical text form,
 * because the immutable JSON is parsed again when its application is prepared.
 */
export function serializeCorrectionChangeSetForHash(
  changeSet: CorrectionChangeSet,
): Record<string, unknown> {
  const v3 = changeSet.schemaVersion === FACT_CORRECTION_CHANGE_SCHEMA_VERSION;
  const serialized: Record<string, unknown> = {
    schemaVersion: changeSet.schemaVersion,
    results: changeSet.results.map((result) =>
      v3
        ? {
            ...result,
            recognizedServiceHours: decimal2Text(result.recognizedServiceHours),
            recognizedContributionPoints: decimal2Text(result.recognizedContributionPoints),
          }
        : { ...result },
    ),
    segments: changeSet.segments.map((segment) => ({
      ...segment,
      checkInAt: segment.checkInAt.toISOString(),
      checkOutAt: segment.checkOutAt.toISOString(),
      ...(v3 ? { serviceHours: decimal2Text(segment.serviceHours) } : {}),
    })),
  };
  if (changeSet.timeCorrection) {
    serialized.timeCorrection = {
      ...changeSet.timeCorrection,
      items: changeSet.timeCorrection.items.map((item) => ({ ...item })),
    };
  }
  if (changeSet.allocations) {
    serialized.allocations = changeSet.allocations.map((allocation) => ({
      ...allocation,
      slices: allocation.slices.map((slice) => ({
        categoryCode: slice.categoryCode,
        startAt: slice.startAt.toISOString(),
        endAt: slice.endAt.toISOString(),
      })),
      evidenceAttachmentIds: [...allocation.evidenceAttachmentIds],
    }));
  }
  return serialized;
}

function decimal2Text(value: number): string {
  return value.toFixed(2);
}

/**
 * 解析并校验 `requestedChangeJson`。
 *
 * 🔴 **全部走拒绝**:任何一条不合规都抛 20102,不存在"取默认值后继续"的路径。
 *    更正是钱语义 —— 一个被静默补上默认值的字段,就是一笔没人授权过的账。
 */
export function parseCorrectionChangeSet(raw: unknown): CorrectionChangeSet {
  if (!isPlainObject(raw)) throw invalid();
  const v2 = raw.schemaVersion === TIME_CORRECTION_CHANGE_SCHEMA_VERSION;
  const v3 = raw.schemaVersion === FACT_CORRECTION_CHANGE_SCHEMA_VERSION;
  if (raw.schemaVersion !== CORRECTION_CHANGE_SCHEMA_VERSION && !v2 && !v3) throw invalid();

  // 顶层键闭集:多一个键就拒。守的是"调用方以为自己传了某个字段、而我们默默丢掉了"。
  assertExactKeys(
    raw,
    v3
      ? ['schemaVersion', 'results', 'segments', 'timeCorrection', 'allocations']
      : v2
        ? ['schemaVersion', 'results', 'segments', 'timeCorrection']
        : ['schemaVersion', 'results', 'segments'],
  );

  const results = parseResults(raw.results, v3);
  const segments = parseSegments(raw.segments, v3);
  if (v3) {
    if (segments.length === 0) throw invalid();
    return {
      schemaVersion: FACT_CORRECTION_CHANGE_SCHEMA_VERSION,
      results: sortResults(results),
      segments: sortSegments(segments),
      timeCorrection: parseTimeCorrection(raw.timeCorrection),
      allocations: parseAllocations(raw.allocations, segments),
    };
  }
  if (v2) {
    if (segments.length !== 0) throw invalid();
    return {
      schemaVersion: TIME_CORRECTION_CHANGE_SCHEMA_VERSION,
      results,
      segments,
      timeCorrection: parseTimeCorrection(raw.timeCorrection),
    };
  }

  // 空更正没有意义:它会生成一个与旧版逐字相同的新版本 + 一整轮冲回补记,
  // 白白在账上留两倍分录却什么都没改。
  if (results.length === 0 && segments.length === 0) throw invalid();

  return { schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION, results, segments };
}

function parseTimeCorrection(raw: unknown): CorrectionTimeChange {
  if (!isPlainObject(raw)) throw invalid();
  assertExactKeys(raw, ['baseSettlementVersionId', 'baseTimeLedgerHash', 'reason', 'items']);
  const baseSettlementVersionId = requireId(raw.baseSettlementVersionId);
  if (!baseSettlementVersionId.trim()) throw invalid();
  if (typeof raw.baseTimeLedgerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.baseTimeLedgerHash))
    throw invalid();
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500)
    throw invalid();
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 8000)
    throw invalid();
  const seen = new Set<string>();
  const items = raw.items
    .map((item: unknown) => {
      if (!isPlainObject(item)) throw invalid();
      assertExactKeys(item, ['rootEntryId', 'recognizedSeconds']);
      const rootEntryId = requireId(item.rootEntryId);
      if (!rootEntryId.trim() || seen.has(rootEntryId)) throw invalid();
      seen.add(rootEntryId);
      const recognizedSeconds = item.recognizedSeconds;
      if (
        typeof recognizedSeconds !== 'number' ||
        !Number.isInteger(recognizedSeconds) ||
        recognizedSeconds < 0 ||
        recognizedSeconds > 2147483647
      )
        throw invalid();
      return { rootEntryId, recognizedSeconds: recognizedSeconds === 0 ? 0 : recognizedSeconds };
    })
    .sort((a, b) => (a.rootEntryId < b.rootEntryId ? -1 : a.rootEntryId > b.rootEntryId ? 1 : 0));
  return {
    baseSettlementVersionId,
    baseTimeLedgerHash: raw.baseTimeLedgerHash,
    reason: raw.reason,
    items,
  };
}

function parseResults(raw: unknown, v3 = false): CorrectionResultChange[] {
  if (!Array.isArray(raw)) throw invalid();
  if (v3 && raw.length > 2000) throw invalid();
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!isPlainObject(item)) throw invalid();
    assertExactKeys(item, [
      'participationIdentityId',
      'resultCode',
      'recognizedServiceHours',
      'recognizedContributionPoints',
      'adjustmentReason',
      'lateFlag',
      'earlyLeaveFlag',
    ]);
    const participationIdentityId = v3
      ? requireNonBlankId(item.participationIdentityId)
      : requireId(item.participationIdentityId);
    // 同一个人在同一份申请里被改两次 ⇒ 后一条覆盖前一条,而"哪一条生效"取决于
    // 数组顺序 —— 那是隐式规则。直接拒绝。
    if (seen.has(participationIdentityId)) throw invalid();
    seen.add(participationIdentityId);

    const resultCode = requireEnum(item.resultCode, CORRECTION_RESULT_CODES);
    const recognizedServiceHours = requireDecimal2(item.recognizedServiceHours, 0, 24);
    const recognizedContributionPoints = requireDecimal2(item.recognizedContributionPoints, 0, 999);

    // §3.20 的十值闭集里只有 present 带时长与贡献,其余九个必须为零。
    // 用**补集**写法:日后闭集扩展时新值默认必须为零(fail-closed),
    // 与第六刀 `zeroResultWithNonZeroTotals` 同一口径。
    if (
      resultCode !== 'present' &&
      (recognizedServiceHours !== 0 || recognizedContributionPoints !== 0)
    ) {
      throw invalid();
    }

    return {
      participationIdentityId,
      resultCode,
      recognizedServiceHours,
      recognizedContributionPoints,
      adjustmentReason: requireNullableText(item.adjustmentReason),
      lateFlag: requireBoolean(item.lateFlag),
      earlyLeaveFlag: requireBoolean(item.earlyLeaveFlag),
    };
  });
}

function parseSegments(raw: unknown, v3 = false): CorrectionSegmentChange[] {
  if (!Array.isArray(raw)) throw invalid();
  if (v3 && raw.length > 10000) throw invalid();
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!isPlainObject(item)) throw invalid();
    assertExactKeys(item, [
      'participationIdentityId',
      'segmentKey',
      'checkInAt',
      'checkOutAt',
      'resultCode',
      'serviceHours',
    ]);
    const participationIdentityId = v3
      ? requireNonBlankId(item.participationIdentityId)
      : requireId(item.participationIdentityId);
    const segmentKey = v3 ? requireNonBlankId(item.segmentKey) : requireId(item.segmentKey);
    const dedupeKey = `${participationIdentityId}|${segmentKey}`;
    if (seen.has(dedupeKey)) throw invalid();
    seen.add(dedupeKey);

    const checkInAt = requireInstant(item.checkInAt);
    const checkOutAt = requireInstant(item.checkOutAt);
    // 签退不得早于签到。等于允许(零时长段是合法形态,如 early_departure_zero)。
    if (checkOutAt.getTime() < checkInAt.getTime()) throw invalid();

    return {
      participationIdentityId,
      segmentKey,
      checkInAt,
      checkOutAt,
      resultCode: requireEnum(item.resultCode, CORRECTION_SEGMENT_RESULT_CODES),
      serviceHours: requireDecimal2(item.serviceHours, 0, 24),
    };
  });
}

function parseAllocations(
  raw: unknown,
  segments: readonly CorrectionSegmentChange[],
): readonly CorrectionAllocationChange[] {
  if (!Array.isArray(raw) || raw.length !== segments.length || raw.length > 10000) throw invalid();
  const expected = new Set(segments.map(segmentPairKey));
  const seen = new Set<string>();
  const attachmentIds = new Set<string>();
  const segmentsByKey = new Map(segments.map((segment) => [segmentPairKey(segment), segment]));
  const allocations = raw.map((item) => {
    if (!isPlainObject(item)) throw invalid();
    assertExactKeys(item, [
      'participationIdentityId',
      'segmentKey',
      'baseSegmentRevisionId',
      'baseAllocationRevisionId',
      'recognitionModeCode',
      'manualReason',
      'slices',
      'evidenceAttachmentIds',
    ]);
    const participationIdentityId = requireNonBlankId(item.participationIdentityId);
    const segmentKey = requireNonBlankId(item.segmentKey);
    const pairKey = `${participationIdentityId}\u0000${segmentKey}`;
    if (!expected.has(pairKey) || seen.has(pairKey)) throw invalid();
    seen.add(pairKey);
    const baseSegmentRevisionId = requireNonBlankId(item.baseSegmentRevisionId);
    const baseAllocationRevisionId = requireNonBlankId(item.baseAllocationRevisionId);
    const recognitionModeCode = parseRecognitionMode(item.recognitionModeCode);
    const manualReason = parseAllocationReason(item.manualReason);
    const slices = parseAllocationSlices(item.slices);
    const evidenceAttachmentIds = parseAllocationEvidence(item.evidenceAttachmentIds);
    for (const attachmentId of evidenceAttachmentIds) attachmentIds.add(attachmentId);
    const segment = segmentsByKey.get(pairKey);
    if (!segment || attachmentIds.size > 2000) throw invalid();
    const zeroOnly =
      segment.serviceHours === 0 ||
      segment.checkInAt.getTime() === segment.checkOutAt.getTime() ||
      segment.resultCode === 'voided' ||
      segment.resultCode === 'replaced' ||
      segment.resultCode === 'early_departure_zero';
    if (recognitionModeCode === 'automatic') {
      if (manualReason !== null || slices.length !== 0) throw invalid();
    } else if (manualReason === null || slices.length === 0 || zeroOnly) {
      throw invalid();
    }
    return {
      participationIdentityId,
      segmentKey,
      baseSegmentRevisionId,
      baseAllocationRevisionId,
      recognitionModeCode,
      manualReason,
      slices: sortSlices(slices),
      evidenceAttachmentIds: [...evidenceAttachmentIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  });
  if (seen.size !== expected.size) throw invalid();
  const sliceCount = allocations.reduce((total, allocation) => total + allocation.slices.length, 0);
  if (sliceCount > 50000) throw invalid();
  return allocations.sort((left, right) =>
    segmentPairKey(left).localeCompare(segmentPairKey(right)),
  );
}

function parseAllocationReason(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 1024 ||
    hasControlCharacter(value)
  )
    throw invalid();
  return value;
}

function parseRecognitionMode(value: unknown): 'automatic' | 'manual' {
  if (value === 'automatic' || value === 'manual') return value;
  throw invalid();
}

function parseAllocationSlices(value: unknown): readonly CorrectionAllocationSliceChange[] {
  if (!Array.isArray(value) || value.length > 500) throw invalid();
  return value.map((item) => {
    if (!isPlainObject(item)) throw invalid();
    // Keep the V3 request surface exactly aligned with D3's existing manual
    // command: callers never choose an interval kind; the server fixes it to
    // the source service segment.
    assertExactKeys(item, ['categoryCode', 'startAt', 'endAt']);
    if (!FACT_CORRECTION_CATEGORIES.includes(item.categoryCode as never)) throw invalid();
    const startAt = requireInstant(item.startAt);
    const endAt = requireInstant(item.endAt);
    if (startAt.getTime() >= endAt.getTime()) throw invalid();
    return {
      categoryCode: item.categoryCode as (typeof FACT_CORRECTION_CATEGORIES)[number],
      intervalKindCode: 'service_segment' as const,
      startAt,
      endAt,
    };
  });
}

function parseAllocationEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) throw invalid();
  const seen = new Set<string>();
  return value.map((item) => {
    const attachmentId = requireNonBlankId(item);
    if (seen.has(attachmentId)) throw invalid();
    seen.add(attachmentId);
    return attachmentId;
  });
}

function segmentPairKey(
  segment: Pick<CorrectionSegmentChange, 'participationIdentityId' | 'segmentKey'>,
): string {
  return `${segment.participationIdentityId}\u0000${segment.segmentKey}`;
}

function sortResults(
  results: readonly CorrectionResultChange[],
): readonly CorrectionResultChange[] {
  return [...results].sort((left, right) =>
    left.participationIdentityId.localeCompare(right.participationIdentityId),
  );
}

function sortSegments(
  segments: readonly CorrectionSegmentChange[],
): readonly CorrectionSegmentChange[] {
  return [...segments].sort((left, right) =>
    segmentPairKey(left).localeCompare(segmentPairKey(right)),
  );
}

function sortSlices(
  slices: readonly CorrectionAllocationSliceChange[],
): readonly CorrectionAllocationSliceChange[] {
  return [...slices].sort((left, right) => {
    const byStart = left.startAt.getTime() - right.startAt.getTime();
    if (byStart !== 0) return byStart;
    const byEnd = left.endAt.getTime() - right.endAt.getTime();
    if (byEnd !== 0) return byEnd;
    return left.categoryCode.localeCompare(right.categoryCode);
  });
}

// ===== 取值原语(全部走拒绝)=================================================

function invalid(): BizException {
  return new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 键集必须**恰好**等于闭集:少一个是缺字段,多一个是调用方以为传进来了。 */
function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) throw invalid();
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw invalid();
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw invalid();
  return value;
}

function requireNonBlankId(value: unknown): string {
  const id = requireId(value);
  if (!id.trim() || hasControlCharacter(id)) throw invalid();
  return id;
}

function requireEnum(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid();
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function requireNullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw invalid();
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

/**
 * ISO 8601 瞬时值。**只接受字符串**,不接受 number(纪元毫秒在 Json 里与业务数字
 * 长得一样,写错一位不会有任何提示)。
 */
function requireInstant(value: unknown): Date {
  if (typeof value !== 'string') throw invalid();
  const parsed = new Date(value);
  // ⚠️ `new Date(null)` = 1970-01-01(**不是** Invalid Date)—— 本仓已栽过一次。
  //    这里入口已经限死 string,再加 NaN 判定作第二道。
  if (Number.isNaN(parsed.getTime())) throw invalid();
  return parsed;
}

/**
 * 两位小数以内的十进制**字符串** → number。
 *
 * 🔴 拒绝多余小数位,**不四舍五入**:`numeric(5,2)` 在 DB 侧对 1.005 是静默归一成 1.00
 *    (第 1 批已实测,不报错)⇒ 若这里也放行,申请人写下的值与最终入账的值可以不同,
 *    而两边都不会有任何提示。执行位必须在这一层。
 */
function requireDecimal2(value: unknown, min: number, max: number): number {
  if (typeof value !== 'string') throw invalid();
  if (!/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(value)) throw invalid();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw invalid();
  return parsed;
}

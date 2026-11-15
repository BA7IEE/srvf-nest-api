// ===== 活动改造 v1.1 第 2 批第二刀:服务段重建(合同 §5.9 / §4.5 / §3.18)=====
//
// 🔴 本文件是整刀最危险的一段代码 —— 它算出来的每一个小时最终会变成队员的贡献值,
//    而**算错不会报错**。全文件只做一件事:把打卡事件链投影成服务段,一个数都不发明。
//
// ## 第一红线:绝不用计划时间补签退(§5.9 明文 / AC-039)
//
// 「已签到、没签退、签退窗口已过」的正确产出是一个**开放段**:
//   checkOutAt = null,serviceHours = null。
// ❌ 绝不允许拿 `session.endAt`(或 checkOutCloseAt、terminationCheckOutDeadline、
//    任何计划时间)当签退时刻 —— 那会安静地给出一个"看起来合理"的时长。
// 本文件**确实**收下了 `sessionEndAt`,但它的唯一用途是**早退标签的比较基准**
// (§5.9「迟到／早退按冻结阈值计算成标签」);`checkOutAt` 只有一个来源:
// 一条真实存在的闭合事件的 `occurredAt`。这条性质由 `closeSegment()` 的签名
// 结构性保证 —— 它只接受事件对象,拿不到 sessionEndAt(见该函数注释)。
//
// ## 为什么是纯函数
//
// 无 Prisma、无 ConfigService、无 `process.env`、无 `new Date()`:
//   - 阈值只能从入参来(§5.9「按**冻结**阈值」= `ActivitySession` 行上的两列),
//     结构上读不到运行时配置,也读不到模板;
//   - 每一条判据都可以在单测里用几行事件数组钉死,不需要起 Nest / 连库。
//
// ## 日期口径
//
// 本文件只做**瞬间之差**(毫秒),不做任何日历换算 ⇒ 不需要、也刻意不引入日界工具。
// 北京日拆分归第五刀账本准备(`splitSpanByBeijingDay`,第一刀已收口)。

// §3.16 eventTypeCode 闭集里"能投影成段"的三种。void / replace 是**操作**不是事实。
const PROJECTION_EVENT_TYPES = new Set(['check_in', 'check_out', 'early_departure_close']);

// §4.5 / §5.5:普通签退必须距本段签到至少 30 分钟。
// 这条闸的执行位在**打卡命令路径**(第 3 批),本文件是重建路径 —— 重建时只能观测到
// 违反(例如 replace 把签退改到更早),不能拒绝一条已经落库的事实,故只打标签。
const NORMAL_CHECK_OUT_MIN_MINUTES = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ProjectorPunchEvent {
  id: string;
  eventTypeCode: string;
  occurredAt: Date;
  supersedesEventId: string | null;
}

export interface SessionThresholds {
  sessionStartAt: Date;
  // ⚠️ 只用于早退标签的比较基准。**不是** checkOutAt 的候选值。
  sessionEndAt: Date;
  lateGraceMinutes: number;
  earlyLeaveThresholdMinutes: number;
}

// §3.18 的 resultCode 闭集里,重建路径只会产出这两个:
// `voided` / `replaced` 是**旧 revision 被顶掉后**的终态标记,不是重建的产物 ——
// 被顶掉的事实在本文件里根本不参与投影(它们直接从事件链里消失)。
export type ProjectedSegmentResultCode = 'valid' | 'early_departure_zero';

export interface ProjectedSegment {
  // (identityId, segmentKey) 是 §3.18 partial unique 的键。取**同一 identity 内的
  // 时序序号**(1-based、零填充)而不是"签到事件 id":§4.5 要求「相关 event 被
  // void／replace → 生成**新的 segment revision**」,同一个逻辑段在事件被替换后
  // 必须保持同一个 key 才能形成 revision 链;用事件 id 当 key 会变成"新段"而不是"新修订"。
  segmentKey: string;
  sourceCheckInEventId: string;
  sourceCloseEventId: string | null;
  resultCode: ProjectedSegmentResultCode;
  checkInAt: Date;
  // null = 开放段(见文件头第一红线)。
  checkOutAt: Date | null;
  serviceHours: number | null;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlags: string[];
}

export interface SegmentProjection {
  segments: ProjectedSegment[];
  // 事件链本身自相矛盾(§4.5「open＋第二次 check_in → 拒绝」/ 无开放段却来了闭合事件)。
  // 重建路径不能拒绝已落库的事实,只能如实上报 —— 调用方据此把该人**判成待定**,
  // 而不是猜一个结果出来。
  chainAnomalies: string[];
}

interface EffectiveFact {
  eventId: string;
  eventTypeCode: string;
  occurredAt: Date;
}

/** Invalid source graph; consumers may map this TypeError to their existing source error. */
export class PunchOperationGraphError extends TypeError {}

// 事件链 → **当前有效的现场事实**列表(已解析 void / replace,已按时序稳定排序)。
export function resolveEffectiveFacts(events: ProjectorPunchEvent[]): EffectiveFact[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  if (byId.size !== events.length) {
    throw new PunchOperationGraphError('Punch operation graph has duplicate IDs');
  }
  const successorByTarget = new Map<string, ProjectorPunchEvent>();
  for (const event of events) {
    if (event.eventTypeCode !== 'void' && event.eventTypeCode !== 'replace') continue;
    if (event.supersedesEventId === null || !byId.has(event.supersedesEventId)) {
      throw new PunchOperationGraphError('Punch operation graph has a missing target');
    }
    // The database unique index also rejects two operations against the same target.
    if (successorByTarget.has(event.supersedesEventId)) {
      throw new PunchOperationGraphError('Punch operation graph has conflicting successors');
    }
    successorByTarget.set(event.supersedesEventId, event);
  }

  // Supported operation chains are acyclic; detect cycles even when disconnected from a fact.
  // Do not recurse, so a long or malformed chain cannot exhaust the call stack.
  const visited = new Set<string>();
  for (const event of events) {
    const path = new Set<string>();
    let cursor: ProjectorPunchEvent | undefined = event;
    while (cursor !== undefined && !visited.has(cursor.id)) {
      if (path.has(cursor.id))
        throw new PunchOperationGraphError('Punch operation graph has a cycle');
      path.add(cursor.id);
      cursor = successorByTarget.get(cursor.id);
    }
    for (const id of path) visited.add(id);
  }

  const facts: EffectiveFact[] = [];
  for (const event of events) {
    if (!PROJECTION_EVENT_TYPES.has(event.eventTypeCode)) continue;

    // The database's unique-target index makes each operation chain linear.
    // Find its tail by relationships, never by occurredAt or input order.
    let cursor = event;
    for (;;) {
      const next = successorByTarget.get(cursor.id);
      if (next === undefined) break;
      cursor = next;
    }

    // A replacement is the final representative of the original fact. A void
    // removes itself and its target, after which the earlier chain is evaluated.
    let effective: ProjectorPunchEvent | undefined = cursor;
    while (effective?.eventTypeCode === 'void') {
      const target = byId.get(effective.supersedesEventId ?? '');
      if (target === undefined || PROJECTION_EVENT_TYPES.has(target.eventTypeCode)) {
        effective = undefined;
        break;
      }
      effective = byId.get(target.supersedesEventId ?? '');
    }
    if (effective !== undefined) {
      facts.push({
        eventId: effective.id,
        eventTypeCode: event.eventTypeCode,
        occurredAt: effective.occurredAt,
      });
    }
  }

  // 稳定排序:occurredAt 相同时按 id —— 不依赖数据库返回顺序,重建必须可复现
  // (contentHash 与幂等判定都建立在"同样的事实得到同样的段"上)。
  return facts.sort((a, b) => {
    const delta = a.occurredAt.getTime() - b.occurredAt.getTime();
    return delta !== 0 ? delta : a.eventId.localeCompare(b.eventId);
  });
}

function roundHours(milliseconds: number): number {
  return Math.round((milliseconds / HOUR_MS) * 100) / 100;
}

interface ClosedSegmentFacts {
  sourceCloseEventId: string;
  resultCode: ProjectedSegmentResultCode;
  checkOutAt: Date;
  serviceHours: number;
  exceptionFlags: string[];
}

// 🔴 这个函数的入参里**没有** sessionEndAt,也没有任何计划时间 —— 它拿不到,
//    所以它在结构上不可能用计划时间补出一个 checkOutAt。签退时刻的唯一来源
//    是 `closeFact.occurredAt`,即一条真实落库的闭合事件。
function closeSegment(openCheckIn: EffectiveFact, closeFact: EffectiveFact): ClosedSegmentFacts {
  const spanMs = closeFact.occurredAt.getTime() - openCheckIn.occurredAt.getTime();
  const exceptionFlags: string[] = [];

  // §4.5:`early_departure_close` ⇒ 固定 0 时长 0 分,并且不再算在场。
  // 时长**不看**实际跨度 —— 这是合同定死的 zero outcome,不是计算结果。
  if (closeFact.eventTypeCode === 'early_departure_close') {
    return {
      sourceCloseEventId: closeFact.eventId,
      resultCode: 'early_departure_zero',
      checkOutAt: closeFact.occurredAt,
      serviceHours: 0,
      exceptionFlags,
    };
  }

  if (spanMs < NORMAL_CHECK_OUT_MIN_MINUTES * MINUTE_MS) {
    exceptionFlags.push('short_service_span');
  }

  // 🟢 **`spanMs` 不可能为负,而且这是结构性质不是假设**:facts 已按 occurredAt 升序
  //    (同刻按 id)排好,一条闭合事实只可能配到**排在它之前**的那个开放签到 ⇒
  //    open.occurredAt <= close.occurredAt 恒成立。
  //    replace 把签退改到签到之前的那种链,排序后闭合事实排到了签到**前面**,
  //    于是走的是 `close_without_open` 那条异常分支,根本到不了这里(有用例钉住)。
  //    ⇒ 这里刻意**不写** `Math.max(0, …)` 之类的夹取:那会是一条永远不触发的假护栏,
  //      还会掩盖"排序性质哪天被改坏"这件事(DB 上 `serviceHours >= 0` 与
  //      `checkOutAt >= checkInAt` 两条 CHECK 才是最后的执行位)。
  return {
    sourceCloseEventId: closeFact.eventId,
    resultCode: 'valid',
    checkOutAt: closeFact.occurredAt,
    serviceHours: roundHours(spanMs),
    exceptionFlags,
  };
}

// 单个 identity(= 一个队员 × 一个场次)的服务段重建。
export function rebuildServiceSegments(
  events: ProjectorPunchEvent[],
  thresholds: SessionThresholds,
): SegmentProjection {
  const facts = resolveEffectiveFacts(events);
  const chainAnomalies: string[] = [];

  const lateAfter = thresholds.sessionStartAt.getTime() + thresholds.lateGraceMinutes * MINUTE_MS;
  const earlyBefore =
    thresholds.sessionEndAt.getTime() - thresholds.earlyLeaveThresholdMinutes * MINUTE_MS;

  const drafts: Array<{ checkIn: EffectiveFact; close: ClosedSegmentFacts | null }> = [];
  let open: EffectiveFact | null = null;

  for (const fact of facts) {
    if (fact.eventTypeCode === 'check_in') {
      if (open !== null) {
        // §4.5「open＋第二次 check_in → 拒绝」。重建路径拒不掉已落库的事实,
        // 故记异常并**丢弃这条重复签到**(保留先到的那个开放段)——
        // 调用方会因为这条异常把该人判成待定,不会有任何数字被静默采信。
        chainAnomalies.push('duplicate_check_in');
        continue;
      }
      open = fact;
      drafts.push({ checkIn: fact, close: null });
      continue;
    }

    if (open === null) {
      chainAnomalies.push('close_without_open');
      continue;
    }
    drafts[drafts.length - 1].close = closeSegment(open, fact);
    open = null;
  }

  const segments = drafts.map((draft, index): ProjectedSegment => {
    const close = draft.close;
    return {
      // 1-based、零填充四位:与 §5.1 `compareStableServiceOrder` 的 segmentKey 位置一致
      // (排序第一键是 startAt,segmentKey 只做同起点 tiebreaker),字典序即时序。
      segmentKey: String(index + 1).padStart(4, '0'),
      sourceCheckInEventId: draft.checkIn.eventId,
      sourceCloseEventId: close?.sourceCloseEventId ?? null,
      // 开放段的 resultCode 取 `valid`:§3.18 闭集里只有它能表达"尚未判负";
      // 第一刀 `EvidenceSealService.countOpenSegments` 正是按
      // 「checkOutAt IS NULL 且 resultCode 不在 (voided, replaced)」数开放段。
      resultCode: close?.resultCode ?? 'valid',
      checkInAt: draft.checkIn.occurredAt,
      // 🔴 第一红线落点:没有闭合事件 ⇒ null。这里没有任何 fallback 表达式。
      checkOutAt: close?.checkOutAt ?? null,
      serviceHours: close?.serviceHours ?? null,
      lateFlag: draft.checkIn.occurredAt.getTime() > lateAfter,
      // 开放段没有签退时刻 ⇒ 早退无从判定,固定 false(不是"没早退",是"还不知道")。
      earlyLeaveFlag: close !== null && close.checkOutAt.getTime() < earlyBefore,
      exceptionFlags: close?.exceptionFlags ?? [],
    };
  });

  return { segments, chainAnomalies };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rebuildServiceSegments,
  resolveEffectiveFacts,
  type ProjectorPunchEvent,
  type SessionThresholds,
} from './settlement-segment-projector';

// ===== 活动改造 v1.1 第 2 批第二刀:服务段重建的判据(合同 §5.9 / §4.5)=====
//
// 投影器是纯函数,所以每一条硬判据都能用几行事件数组钉死 —— 不需要起 Nest、不需要连库,
// 红也一定红在**断言**上而不是"某处崩了"。
//
// ⭐ 三条硬判据(goal DoD 3)在本文件里各自独立成段,并且各自设计成
//    **只由它对应的那一处实现触发**(卸掉哪一处,就只有那一段红)。

const SESSION_START = new Date('2020-03-01T00:00:00.000Z');
const SESSION_END = new Date('2020-03-01T04:00:00.000Z');

const THRESHOLDS: SessionThresholds = {
  sessionStartAt: SESSION_START,
  sessionEndAt: SESSION_END,
  lateGraceMinutes: 15,
  earlyLeaveThresholdMinutes: 15,
};

function event(
  id: string,
  eventTypeCode: string,
  occurredAt: string,
  supersedesEventId: string | null = null,
): ProjectorPunchEvent {
  return { id, eventTypeCode, occurredAt: new Date(occurredAt), supersedesEventId };
}

describe('settlement segment projector — 正常闭合', () => {
  it('check_in + check_out → 一个 valid 段,时长取两条事实之差', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T00:05:00.000Z'),
        event('e2', 'check_out', '2020-03-01T03:35:00.000Z'),
      ],
      THRESHOLDS,
    );

    expect(projection.chainAnomalies).toStrictEqual([]);
    expect(projection.segments).toHaveLength(1);
    const segment = projection.segments[0];
    expect(segment.segmentKey).toBe('0001');
    expect(segment.resultCode).toBe('valid');
    expect(segment.sourceCheckInEventId).toBe('e1');
    expect(segment.sourceCloseEventId).toBe('e2');
    expect(segment.checkOutAt?.toISOString()).toBe('2020-03-01T03:35:00.000Z');
    expect(segment.serviceHours).toBe(3.5);
    expect(segment.exceptionFlags).toStrictEqual([]);
  });

  it('同一 identity 两段服务 → segmentKey 按时序 0001 / 0002', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
        event('e2', 'check_out', '2020-03-01T01:00:00.000Z'),
        event('e3', 'check_in', '2020-03-01T02:00:00.000Z'),
        event('e4', 'check_out', '2020-03-01T03:00:00.000Z'),
      ],
      THRESHOLDS,
    );
    expect(projection.segments.map((segment) => segment.segmentKey)).toStrictEqual([
      '0001',
      '0002',
    ]);
    expect(projection.segments.map((segment) => segment.serviceHours)).toStrictEqual([1, 1]);
  });
});

// ===== ⭐ 硬判据一:绝不用计划时间补签退(§5.9 明文 / AC-039)=====
//
// 🔴 这是本刀最危险的一条 —— 补一个"看起来合理"的签退时间,系统会安静地给出一个错的时长。

describe('settlement segment projector — ⭐ 绝不用计划 endAt 补签退', () => {
  const CHECK_IN_ONLY = [event('e1', 'check_in', '2020-03-01T00:05:00.000Z')];

  it('只有签到、无签退 → 段保持开放:checkOutAt 与 serviceHours 都是 null', () => {
    const projection = rebuildServiceSegments(CHECK_IN_ONLY, THRESHOLDS);

    expect(projection.segments).toHaveLength(1);
    const segment = projection.segments[0];
    expect(segment.checkOutAt).toBeNull();
    expect(segment.serviceHours).toBeNull();
    expect(segment.sourceCloseEventId).toBeNull();
    // 逐字钉住"不是 endAt":哪怕将来 checkOutAt 变成非 null,也不许是这个值。
    expect(segment.checkOutAt).not.toStrictEqual(SESSION_END);
  });

  it('把 sessionEndAt 换成任意别的值 → 开放段的产出一字不变(证明它进不了 checkOutAt)', () => {
    // 这一条是判据的**结构**部分:sessionEndAt 只允许影响早退标签。
    // 若有人加一句 `checkOutAt ?? session.endAt` 的 fallback,两次读数立刻分叉。
    const withEarlyEnd = rebuildServiceSegments(CHECK_IN_ONLY, {
      ...THRESHOLDS,
      sessionEndAt: new Date('2020-03-01T04:00:00.000Z'),
    }).segments[0];
    const withLateEnd = rebuildServiceSegments(CHECK_IN_ONLY, {
      ...THRESHOLDS,
      sessionEndAt: new Date('2099-09-09T09:09:09.000Z'),
    }).segments[0];

    expect(withEarlyEnd.checkOutAt).toBeNull();
    expect(withLateEnd.checkOutAt).toBeNull();
    expect(withEarlyEnd.serviceHours).toBeNull();
    expect(withLateEnd.serviceHours).toBeNull();
    expect(withEarlyEnd).toStrictEqual(withLateEnd);
  });

  it('开放段的早退标签固定 false —— 没有签退时刻就不是"没早退",是"还不知道"', () => {
    const segment = rebuildServiceSegments(CHECK_IN_ONLY, THRESHOLDS).segments[0];
    expect(segment.earlyLeaveFlag).toBe(false);
  });
});

// ===== ⭐ 硬判据二:void / replace 链必须解析 =====

describe('settlement segment projector — ⭐ void / replace 链解析', () => {
  const BASE = [
    event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
    event('e2', 'check_out', '2020-03-01T03:00:00.000Z'),
  ];

  it('同一组事件:有 void 与无 void 产出不同的段', () => {
    const withoutVoid = rebuildServiceSegments(BASE, THRESHOLDS);
    const withVoid = rebuildServiceSegments(
      [...BASE, event('e3', 'void', '2020-03-01T05:00:00.000Z', 'e2')],
      THRESHOLDS,
    );

    expect(withoutVoid.segments[0].checkOutAt?.toISOString()).toBe('2020-03-01T03:00:00.000Z');
    expect(withoutVoid.segments[0].serviceHours).toBe(3);
    // 签退被作废 ⇒ 段回到开放态,**不是**保留旧签退、也不是补一个计划时间。
    expect(withVoid.segments[0].checkOutAt).toBeNull();
    expect(withVoid.segments[0].serviceHours).toBeNull();
  });

  it('签到被 void → 该段整条消失(不是留一个无签到的段)', () => {
    const projection = rebuildServiceSegments(
      [...BASE, event('e3', 'void', '2020-03-01T05:00:00.000Z', 'e1')],
      THRESHOLDS,
    );
    // 签到没了,剩下一条孤立的签退 ⇒ 零段 + 一条链异常。
    expect(projection.segments).toStrictEqual([]);
    expect(projection.chainAnomalies).toStrictEqual(['close_without_open']);
  });

  it('replace 顶掉签退 → 以替代者的 occurredAt 为准', () => {
    const projection = rebuildServiceSegments(
      [...BASE, event('e3', 'replace', '2020-03-01T02:00:00.000Z', 'e2')],
      THRESHOLDS,
    );
    expect(projection.segments).toHaveLength(1);
    expect(projection.segments[0].sourceCloseEventId).toBe('e3');
    expect(projection.segments[0].checkOutAt?.toISOString()).toBe('2020-03-01T02:00:00.000Z');
    expect(projection.segments[0].serviceHours).toBe(2);
  });

  it('replace 自己被 void → 被替代的原事实复活(链是整体重建的,不是逐条打补丁)', () => {
    const projection = rebuildServiceSegments(
      [
        ...BASE,
        event('e3', 'replace', '2020-03-01T02:00:00.000Z', 'e2'),
        event('e4', 'void', '2020-03-01T06:00:00.000Z', 'e3'),
      ],
      THRESHOLDS,
    );
    expect(projection.segments[0].sourceCloseEventId).toBe('e2');
    expect(projection.segments[0].checkOutAt?.toISOString()).toBe('2020-03-01T03:00:00.000Z');
  });

  it('replace 替代 replace → 沿链上溯拿到最初那条事实的角色', () => {
    const projection = rebuildServiceSegments(
      [
        ...BASE,
        event('e3', 'replace', '2020-03-01T02:00:00.000Z', 'e2'),
        event('e4', 'replace', '2020-03-01T01:30:00.000Z', 'e3'),
      ],
      THRESHOLDS,
    );
    expect(projection.segments[0].sourceCloseEventId).toBe('e4');
    expect(projection.segments[0].checkOutAt?.toISOString()).toBe('2020-03-01T01:30:00.000Z');
  });

  it('有效事实按时序稳定排序,不依赖入参顺序', () => {
    const shuffled = [
      event('e2', 'check_out', '2020-03-01T03:00:00.000Z'),
      event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
    ];
    expect(resolveEffectiveFacts(shuffled).map((fact) => fact.eventId)).toStrictEqual(['e1', 'e2']);
  });
});

// ===== ⭐ 硬判据三:early_departure_close ⇒ 0 时长 0 分 =====

describe('settlement segment projector — ⭐ early_departure_close 固定零结果', () => {
  it('早退闭合 → resultCode=early_departure_zero 且 serviceHours 恒 0(不看实际跨度)', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
        // 跨度足足 3 小时 —— 若按跨度算会是 3;合同定死 zero outcome。
        event('e2', 'early_departure_close', '2020-03-01T03:00:00.000Z'),
      ],
      THRESHOLDS,
    );
    expect(projection.segments[0].resultCode).toBe('early_departure_zero');
    expect(projection.segments[0].serviceHours).toBe(0);
    expect(projection.segments[0].checkOutAt?.toISOString()).toBe('2020-03-01T03:00:00.000Z');
  });
});

// ===== 迟到 / 早退标签只由**入参阈值**决定(goal DoD 5)=====

describe('settlement segment projector — 冻结阈值', () => {
  const LATE_CHECK_IN = [
    event('e1', 'check_in', '2020-03-01T00:20:00.000Z'),
    event('e2', 'check_out', '2020-03-01T03:00:00.000Z'),
  ];

  it('迟到 20 分钟:宽限 15 → late;宽限 30 → 不 late(同一组事实,只换阈值)', () => {
    expect(
      rebuildServiceSegments(LATE_CHECK_IN, { ...THRESHOLDS, lateGraceMinutes: 15 }).segments[0]
        .lateFlag,
    ).toBe(true);
    expect(
      rebuildServiceSegments(LATE_CHECK_IN, { ...THRESHOLDS, lateGraceMinutes: 30 }).segments[0]
        .lateFlag,
    ).toBe(false);
  });

  it('提前 60 分钟签退:阈值 15 → earlyLeave;阈值 60 → 不算(边界是严格早于)', () => {
    expect(
      rebuildServiceSegments(LATE_CHECK_IN, { ...THRESHOLDS, earlyLeaveThresholdMinutes: 15 })
        .segments[0].earlyLeaveFlag,
    ).toBe(true);
    expect(
      rebuildServiceSegments(LATE_CHECK_IN, { ...THRESHOLDS, earlyLeaveThresholdMinutes: 60 })
        .segments[0].earlyLeaveFlag,
    ).toBe(false);
  });

  // 「改全局配置 ⇒ 标签不变」的执行位:投影器**结构上读不到**任何全局配置。
  // 它是纯函数,阈值只能从入参来;这条断言会在有人引入配置读取的那一刻变红。
  it('投影器源码不读 process.env / ConfigService(阈值只能来自 session 行)', () => {
    // ⚠️ 必须先剥注释再匹配:本文件的说明性注释里就写着这几个词,
    //    直接对全文匹配会变成一条**永远红**的假判据(初版实测就栽在这里)。
    const code = readFileSync(join(__dirname, 'settlement-segment-projector.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/ConfigService/);
    // 也不许自己造"现在":重建必须完全由事实决定,不能随跑的时刻漂移。
    expect(code).not.toMatch(/Date\.now\(\)/);
    // 反向对照:剥注释后代码里确实还留着 `sessionEndAt`(它是早退标签的比较基准)——
    // 否则上面三条会因为"什么都没剩下"而空绿。
    expect(code).toMatch(/sessionEndAt/);
  });
});

// ===== 链自相矛盾:如实上报,不猜 =====

describe('settlement segment projector — 链异常', () => {
  it('开放段上再来一次 check_in → duplicate_check_in,且保留先到的开放段', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
        event('e2', 'check_in', '2020-03-01T01:00:00.000Z'),
      ],
      THRESHOLDS,
    );
    expect(projection.chainAnomalies).toStrictEqual(['duplicate_check_in']);
    expect(projection.segments).toHaveLength(1);
    expect(projection.segments[0].sourceCheckInEventId).toBe('e1');
  });

  it('无开放段却来了签退 → close_without_open,零段', () => {
    const projection = rebuildServiceSegments(
      [event('e1', 'check_out', '2020-03-01T01:00:00.000Z')],
      THRESHOLDS,
    );
    expect(projection.chainAnomalies).toStrictEqual(['close_without_open']);
    expect(projection.segments).toStrictEqual([]);
  });

  it('普通签退不足 30 分钟 → 段照常闭合但打 short_service_span 标签(重建路径拒不掉既成事实)', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T00:00:00.000Z'),
        event('e2', 'check_out', '2020-03-01T00:10:00.000Z'),
      ],
      THRESHOLDS,
    );
    expect(projection.segments[0].exceptionFlags).toStrictEqual(['short_service_span']);
    expect(projection.segments[0].serviceHours).toBe(0.17);
  });

  // 这一条同时是「时长恒非负」那条**结构性质**的正面证据:
  // replace 把签退改到签到之前之后,排序让闭合事实排到了签到前面 ⇒ 走链异常分支,
  // 根本产生不出一个负跨度的闭合段(所以投影器里刻意没有 Math.max(0, …) 假护栏)。
  it('replace 把签退改到签到之前 → 退化成 close_without_open + 一个开放段,不产生负时长', () => {
    const projection = rebuildServiceSegments(
      [
        event('e1', 'check_in', '2020-03-01T02:00:00.000Z'),
        event('e2', 'check_out', '2020-03-01T03:00:00.000Z'),
        event('e3', 'replace', '2020-03-01T01:00:00.000Z', 'e2'),
      ],
      THRESHOLDS,
    );
    expect(projection.chainAnomalies).toStrictEqual(['close_without_open']);
    expect(projection.segments).toHaveLength(1);
    expect(projection.segments[0].checkOutAt).toBeNull();
    expect(projection.segments[0].serviceHours).toBeNull();
    // 全仓不许出现负时长:这里连"闭合段"都没形成。
    expect(
      projection.segments.every(
        (segment) => segment.serviceHours === null || segment.serviceHours >= 0,
      ),
    ).toBe(true);
  });

  it('零事件 → 零段、零异常(是"没有事实",不是"有问题")', () => {
    expect(rebuildServiceSegments([], THRESHOLDS)).toStrictEqual({
      segments: [],
      chainAnomalies: [],
    });
  });
});

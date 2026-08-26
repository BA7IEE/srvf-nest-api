/**
 * 账本统一生效链的**规模档登记**(合同 §13.7 固定 fixture 四档;§14「规模门 + 保存复现命令与读数」)。
 *
 * 本文件是**唯一真源**:跑哪几档、哪一档已判定不做、不做的理由与拍板人,全在这里。
 * 三个消费者共读它,谁都不另立一份 ——
 *   ① `test/e2e/activity-ledger-commit-scale-tiers.e2e-spec.ts` 用 `describe.each` **从这张表生成用例**;
 *   ② `scripts/cutover-check.ts` 把它采成签字对拍读数 `scale-tiers-passing`;
 *   ③ `docs/ai-harness/CUTOVER_SIGNOFF.md` 的 ⑨-b 签字锚在那个读数上。
 *
 * ⇒ 删掉一档 = 同时删掉它的用例、改掉读数、让 ⑨-b 签字当场过期变红。
 *   「档位清单」与「真跑的用例」在结构上不可能各说各话,因为它们是同一个数组。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴🔴 与 `scripts/probe-member-lock-scale.ts` 头注那条判断的关系(**必读,别当成破例**)
 *
 * 那份探针逐字写着「为什么是脚本而不是 spec:读数与机器规格强相关,挂进 jest 会给 CI
 * 引入**性能相关的假红** …… 故它是手动、可重复的探针,**不进 CI**」。
 *
 * ⭐ **那条判断没有错,而且现在依然有效。** 它反对的是把**耗时**当判据 ——
 *    CI 机器慢一点就假红,那是造 flake 机器,不是执法。
 *
 * ⭐ 本文件这条链判的是**另一件事**:
 *
 *    | 判据 | 判什么 | 与机器快慢的关系 |
 *    |---|---|---|
 *    | `probe-member-lock-scale.ts` | 万人档**耗时**能不能压进 7 秒事务预算 | 强相关 ⇒ 不进 CI |
 *    | 本档位表驱动的 e2e | **能不能跑完 + 数字对不对 + 规模变了结果变没变** | **无关** ⇒ 可进 CI |
 *
 *    ⇒ 两者管的不是同一件事,不构成矛盾;探针那条口径**不因本刀而放宽一个字**。
 *
 * 🔴 由此得出本链的**一票否决线**(改本文件或那份 e2e 的人请照此办理):
 *    判据里**不许出现任何耗时阈值 / 超时断言 / `Date.now()` 差值比较**。
 *    出现一个,上面那张表的右列就不再成立,这条链存在的全部理由随之作废。
 *    ⚠️ 唯一例外是 jest 自己的**看门狗**(`beforeAll(fn, ms)` 的第二参),那不是判据 ——
 *    仓内每个用例都有一个(`test/jest-e2e.config.ts` 的 `testTimeout: 30000`),无法退订。
 *    故那边刻意取一个远高于任何合理运行时的值,好让它**永远不是**下结论的那一格,
 *    并且**没有任何断言读取墙钟**。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 合同 §13.7 逐字点名的四档固定 fixture。**不是本批跑几档** —— 它是分母。 */
export const LEDGER_COMMIT_CONTRACT_SCALE_TIERS = [30, 500, 2000, 10000] as const;

/**
 * 本批**真跑**的规模档。
 *
 * 🔴 这一行就是签字对拍读数 `scale-tiers-passing` 的来源。改它 = 让 ⑨-b 签字过期。
 * ⚠️ 采集器按源码正则读本行(见 `scripts/cutover-check.ts` 的 `collectScaleTiers`),
 *    故**保持字面量数组、纯十进制、不用下划线分隔符**;写成变量拼接会让采集器读不到、
 *    读数退化成非法形状 ⇒ 判据 fail-closed 当场红(不是静默放行)。
 */
export const LEDGER_COMMIT_SCALE_TIERS = [30, 500, 2000] as const;

/** 一条「已判定不做」的规模档登记。六个字段缺一即红(同 `PERMANENT_WAIVER_ACCEPTANCE_DESTINATIONS` 的形状)。 */
export interface ScaleTierWaiver {
  /** 被豁免的档位人数。 */
  readonly tier: number;
  /** 闭集,只认「已判定不做」—— 「暂缓」「以后再说」不是结论。 */
  readonly verdict: '已判定不做';
  /** 🔴 维护者拍板原文,**逐字**。同一段字必须原样出现在 `CUTOVER_SIGNOFF.md` 的 ⑨-b 块里(判据逐字比对)。 */
  readonly reason: string;
  readonly decidedBy: string;
  /** `YYYY-MM-DD`,且必须是合法日历日。 */
  readonly decidedOn: string;
  /** 残余:被豁免掉之后,合同这一档还有什么没被覆盖。写「无」是不诚实的,必须写实。 */
  readonly residual: string;
}

/**
 * 规模档的**永久豁免登记**。
 *
 * 🔴 与「还没做」是两回事:「还没做」会随时间自己消失,「已判定不做」不会 ——
 *    所以它必须有拍板人、日期与残余,并且被机器数着。
 * 🔴 **不许直接把档位从合同四档里删掉**:删了就没人知道合同里还有这一档。
 *    落点是第三种渲染 —— 真登记,写明理由与拍板人。
 */
export const LEDGER_COMMIT_SCALE_TIER_WAIVERS: readonly ScaleTierWaiver[] = [
  {
    tier: 10000,
    verdict: '已判定不做',
    reason:
      '**已判定不做。** 一场万人活动要占 PostgreSQL 共享锁表 10000 把(保底 12800 的 **78%**),' +
      '两场并发即越过保底、落进 `out of shared memory` —— **硬 ERROR,不走可重试路径,事务直接中止**;' +
      '而那张表**整实例共享** ⇒ 硬错误会**撒到别的 spec 上**。队里不会有一万人。' +
      '**拍板人:维护者,2026-08-26。**',
    decidedBy: '维护者',
    decidedOn: '2026-08-26',
    residual:
      '合同 §13.7 的万人档读数**没有**、也不会有。本链最大跑到 2000;' +
      '既有 `test/e2e/activity-ledger-posting-scale.e2e-spec.ts` 另有一条 8192 人的 bind 上限用例,' +
      '但那是**另一条判据**(每条语句的 bind 参数不随人数增长),不是本档位表的成员。',
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 纯判据(不 import 任何有能力的东西 —— 好让 cutover-check 与 e2e 共用同一套判定)
// ══════════════════════════════════════════════════════════════════════════

/**
 * 闭合:**真跑的档 ∪ 已豁免的档 = 合同四档**,且两侧不相交。
 *
 * ⭐ 它挡的是本仓已两次栽过的形状:把跑不动的那一档**悄悄删掉**,于是「零缺口」——
 *   缺口不是被填上,是被洗掉了。
 */
export function scaleTierClosureDefects(
  run: readonly number[] = LEDGER_COMMIT_SCALE_TIERS,
  waivers: readonly ScaleTierWaiver[] = LEDGER_COMMIT_SCALE_TIER_WAIVERS,
  contract: readonly number[] = LEDGER_COMMIT_CONTRACT_SCALE_TIERS,
): string[] {
  const defects: string[] = [];
  const waived = waivers.map((w) => w.tier);
  const union = [...run, ...waived];
  for (const t of run.filter((x) => waived.includes(x))) {
    defects.push(`档位 ${t} 既在真跑清单又在豁免清单 —— 两种结局互斥`);
  }
  for (const t of contract) {
    if (!union.includes(t))
      defects.push(`合同 §13.7 点名的档位 ${t} 既没跑也没登记豁免 —— 缺口被洗掉了`);
  }
  for (const t of union) {
    if (!contract.includes(t))
      defects.push(`档位 ${t} 不在合同 §13.7 的四档里 —— 登记了一个合同没有的档`);
  }
  if (run.length === 0) defects.push('真跑清单为空 ⇒ 采集失真或整族被删,不许当「没有缺口」');
  return defects;
}

/** 豁免登记的六要素完整性 + 日期必须是合法日历日(`2026-02-30` 形状对但不存在)。 */
export function scaleTierWaiverFieldDefects(
  waivers: readonly ScaleTierWaiver[] = LEDGER_COMMIT_SCALE_TIER_WAIVERS,
): string[] {
  const defects: string[] = [];
  for (const w of waivers) {
    const at = `档位 ${w.tier}`;
    if (!Number.isInteger(w.tier) || w.tier <= 0) defects.push(`${at}:档位不是正整数`);
    if (w.verdict !== '已判定不做') defects.push(`${at}:结论不是闭集里的「已判定不做」`);
    if (w.reason.trim().length === 0) defects.push(`${at}:理由为空`);
    if (w.decidedBy.trim().length === 0) defects.push(`${at}:拍板人为空`);
    if (w.residual.trim().length === 0) defects.push(`${at}:残余为空 —— 豁免必须写清还缺什么`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.decidedOn)) {
      defects.push(`${at}:日期不是 YYYY-MM-DD`);
    } else {
      // `new Date('2026-02-30')` 会静默回卷成 3 月 2 日 —— 回查字面量才判得出非法日历日。
      const d = new Date(`${w.decidedOn}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== w.decidedOn) {
        defects.push(`${at}:日期不是合法日历日(${w.decidedOn})`);
      }
    }
  }
  return defects;
}

/**
 * 把一段文本压成「只看字」的形状:去掉所有空白。
 *
 * ⚠️ 用途只有一个 —— 让 TS 字符串拼接的换行与 markdown 的软换行**不影响逐字比对**。
 * 它不做任何大小写 / 标点归一化:那会把「改了一个字」也归一化掉,正是不该放过的那种改动。
 */
export function squeezeForVerbatimCompare(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 豁免理由必须**逐字**出现在签字登记表里(否则代码与文档各说各话,而两边都看着挺像回事)。 */
export function scaleTierWaiverMirrorDefects(
  signoffDocText: string | null,
  waivers: readonly ScaleTierWaiver[] = LEDGER_COMMIT_SCALE_TIER_WAIVERS,
): string[] {
  if (signoffDocText === null) return ['签字登记表读不到 ⇒ 无从比对豁免理由'];
  const squeezed = squeezeForVerbatimCompare(signoffDocText);
  return waivers
    .filter((w) => !squeezed.includes(squeezeForVerbatimCompare(w.reason)))
    .map((w) => `档位 ${w.tier} 的豁免理由未逐字出现在签字登记表里 ⇒ 代码与文档已分叉`);
}

// ══════════════════════════════════════════════════════════════════════════
// 运行期读数与逐维判据
//
// 🔴 每一个函数只判**一维**,e2e 侧一维一个 `it`。
//    (jest 在一个 `it` 内首个失败即停 ⇒ 塞在一起时后面的断言从未被执行过,
//     而这在基线全绿时完全看不出来。本仓已实测栽过。)
// ══════════════════════════════════════════════════════════════════════════

/** 一档跑完后从库里读回来的观测量。**全部是计数与金额,没有一个是时间。** */
export interface LedgerCommitScaleOutcome {
  /** 准备被切成几个 chunk(= `ceil(人数 / 500)`)。30 / 500 档是 1,2000 档是 4。 */
  readonly prepareItemCount: number;
  /** 生效返回的 distinct 队员数。 */
  readonly memberCount: number;
  /** 生效返回的 (member, date) 对数。 */
  readonly dayStateCount: number;
  /** 生效返回的分录条数。 */
  readonly entryCount: number;
  /** 库里真数出来的分录条数(与 `entryCount` 互为独立证人)。 */
  readonly entryRowsInDb: number;
  /** 库里真数出来的 distinct 队员数。 */
  readonly distinctMembersInDb: number;
  /** 库里真数出来的 day-state 行数。 */
  readonly dayStateRowsInDb: number;
  /** 分录侧贡献值合计(单位:百分之一分,整数,避免浮点)。 */
  readonly ledgerCreditedHundredths: number;
  /** day-state 侧贡献值合计(独立聚合,必须与上一行相等)。 */
  readonly dayStateCreditedHundredths: number;
  /** 分录侧时长合计(百分之一小时)。 */
  readonly ledgerServiceHundredths: number;
  /** 出现过的分录类型码(排序去重)。 */
  readonly entryTypeCodes: readonly string[];
  /** 批次与 run 的终态。 */
  readonly batchStatus: string;
  readonly runStatus: string;
}

/** ① 能跑完:准备与生效两段都没抛。 */
export function scaleRanToCompletionDefect(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return `这一档没跑完:${error.name}: ${error.message}`;
  // ⚠️ 非 Error 抛出物一律 JSON 化 —— `String(obj)` 会得到 `[object Object]`,
  //    那等于把「哪一档因为什么没跑完」这条信息在报错里丢掉。
  return `这一档没跑完:${typeof error === 'string' ? error : JSON.stringify(error)}`;
}

/** ② 结算结果行数 = 人数(生效返回值与库里两个证人都得对上)。 */
export function scaleMemberCountDefect(tier: number, o: LedgerCommitScaleOutcome): string | null {
  if (o.memberCount !== tier) return `生效返回 memberCount=${o.memberCount},应为 ${tier}`;
  if (o.distinctMembersInDb !== tier)
    return `库里 distinct 队员 ${o.distinctMembersInDb},应为 ${tier}`;
  return null;
}

/** ③ 分录数 = 人数 × 2(每人 service_credit + contribution_credit 各一条)。 */
export function scaleEntryCountDefect(tier: number, o: LedgerCommitScaleOutcome): string | null {
  const want = tier * 2;
  if (o.entryCount !== want) return `生效返回 entryCount=${o.entryCount},应为 ${want}`;
  if (o.entryRowsInDb !== want) return `库里分录 ${o.entryRowsInDb} 条,应为 ${want}`;
  if ([...o.entryTypeCodes].sort().join(',') !== 'contribution_credit,service_credit') {
    return `分录类型码是 ${o.entryTypeCodes.join('/')},应恰为 contribution_credit + service_credit 两类`;
  }
  return null;
}

/** ④ day-state 每人恰一行。 */
export function scaleDayStateCountDefect(tier: number, o: LedgerCommitScaleOutcome): string | null {
  if (o.dayStateCount !== tier) return `生效返回 dayStateCount=${o.dayStateCount},应为 ${tier}`;
  if (o.dayStateRowsInDb !== tier) return `库里 day-state ${o.dayStateRowsInDb} 行,应为 ${tier}`;
  return null;
}

/**
 * ⑤ 账本总额 = 各人之和。
 *
 * 两条**独立**聚合必须相等:分录侧 `sum(creditedPointsDelta)` 与 day-state 侧
 * `sum(committedCreditedPoints)`。它们由生效事务里两段不同的 SQL 各自写出 ——
 * 「部分生效」「回写打偏」在这一格上表现为两个数不相等,而不是某一个数变小。
 * 再与「每人金额 × 人数」对一次,挡住「两边一起错」。
 */
export function scaleLedgerTotalDefect(
  tier: number,
  perMemberCreditedHundredths: number,
  o: LedgerCommitScaleOutcome,
): string | null {
  if (o.ledgerCreditedHundredths !== o.dayStateCreditedHundredths) {
    return `分录侧合计 ${o.ledgerCreditedHundredths} ≠ day-state 侧合计 ${o.dayStateCreditedHundredths}(两条独立聚合对不上)`;
  }
  const want = tier * perMemberCreditedHundredths;
  if (o.ledgerCreditedHundredths !== want) {
    return `贡献值合计 ${o.ledgerCreditedHundredths},应为 每人 ${perMemberCreditedHundredths} × ${tier} 人 = ${want}`;
  }
  return null;
}

/** ⑥ 终态:批次 committed、run posted。 */
export function scaleTerminalStatusDefect(o: LedgerCommitScaleOutcome): string | null {
  if (o.batchStatus !== 'committed') return `批次终态 ${o.batchStatus},应为 committed`;
  if (o.runStatus !== 'posted') return `run 终态 ${o.runStatus},应为 posted`;
  return null;
}

/**
 * 一档的**归一化形状** = 把人数除掉之后剩下的东西。
 *
 * ⭐ 「不退化」判的就是它:2000 档与 30 档的形状必须**逐字相等**。
 *   注意 30 / 500 档准备只有 1 个 chunk,2000 档是 4 个 —— 分块数**刻意不进形状**,
 *   因为它本来就该随人数变;进形状的是「分块之后每人拿到的东西有没有变」。
 */
export function scaleShapeOf(tier: number, o: LedgerCommitScaleOutcome): string {
  return JSON.stringify({
    entriesPerMember: o.entryRowsInDb / tier,
    dayStatesPerMember: o.dayStateRowsInDb / tier,
    creditedPerMember: o.ledgerCreditedHundredths / tier,
    servicePerMember: o.ledgerServiceHundredths / tier,
    entryTypeCodes: [...o.entryTypeCodes].sort(),
    batchStatus: o.batchStatus,
    runStatus: o.runStatus,
  });
}

/**
 * ⑦ 不退化:每一档的归一化形状必须与**第一档**逐字相等。
 *
 * ⚠️ 判的是「结果不同」,**不是**「变慢」。缺档(某档没跑出 outcome)同样算不退化失败 ——
 *    否则「把 2000 档跑挂了」会表现为「没有形状可比 ⇒ 无事发生」。
 */
export function scaleNoDegradationDefects(
  byTier: ReadonlyMap<number, LedgerCommitScaleOutcome | null>,
  tiers: readonly number[] = LEDGER_COMMIT_SCALE_TIERS,
): string[] {
  const defects: string[] = [];
  const shapes = new Map<number, string>();
  for (const tier of tiers) {
    const o = byTier.get(tier);
    if (o === undefined || o === null) {
      defects.push(`档位 ${tier} 没有产出可比的形状 ⇒ 它根本没跑完`);
      continue;
    }
    shapes.set(tier, scaleShapeOf(tier, o));
  }
  const baseTier = tiers[0];
  const base = shapes.get(baseTier);
  if (base === undefined) return defects;
  for (const [tier, shape] of shapes) {
    if (tier === baseTier) continue;
    if (shape !== base)
      defects.push(`档位 ${tier} 的每人形状与 ${baseTier} 档不同:${shape} ≠ ${base}`);
  }
  return defects;
}

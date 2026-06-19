// 招新三期(入队:志愿者 → 队员)T2(2026-06-19):team-join 模块常量 + 纯函数 helper。
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md(下称"评审稿")。
// 入口态 = phase-2 promote 出的无部门、无级别志愿者(member);入队才赋部门 + 级别 level-1。

import { Prisma } from '@prisma/client';

// ===== 入队轮状态(String;后台开关;沿 recruitment CYCLE_STATUS 范式)=====
export const CYCLE_STATUS_OPEN = 'open';
export const CYCLE_STATUS_CLOSED = 'closed';

// ===== 入队申请状态机(String,无 enum;评审稿 E-J-3)=====
export const APP_STATUS_JOINING = 'joining'; // 考核中(初态)
export const APP_STATUS_PENDING_EVALUATION = 'pending_evaluation'; // 通用门槛全过自动推进,待综合评估
export const APP_STATUS_APPROVED = 'approved'; // 综合评估通过,待入队
export const APP_STATUS_JOINED = 'joined'; // 已入队(设部门 + 级别;终态;T4 enrollment)
export const APP_STATUS_REJECTED = 'rejected'; // 已拒(终态)

// ===== 淘汰环节(eliminationStage;rejected 时记)=====
export const ELIM_STAGE_EVALUATION = 'evaluation'; // 综合评估不通过
export const ELIM_STAGE_GATE_TIMEOUT = 'gate-timeout'; // 门槛超期 / 人工淘汰

// ===== 10 项考核拆解(评审稿 §4.1;Q1 维护者会议纪要纠正后冻结)=====
// 通用必过 = 8 admin gate(落 gateMarks JSON,各带完成日 → 有效期)+ 1 系统自动 contribution
// (实时算、不落 gateMarks)= 9 必过项;第 10「项」= 综合评估人工闸(evaluate transition)。
export const GENERAL_GATE_CODES = [
  'fitness', // 基础体能(参加即可)— 本轮
  'first-aid-training', // 初级救援培训(完成)— 3年
  'military', // 军训 2天2夜(完成)— 2年
  'psych', // 心理测试(通过)— 本轮
  'interview', // 部门面试 + 附件4(通过)— 本轮
  'dept-assessment', // 部门考核(通过)— 本轮 ★可延长期
  'entry-exam', // 入队普考 医疗/信息/通讯(通过)— 本轮
  'intermediate-outdoor', // 中级户外资质(人工审核)— 长期
] as const;

// 4 条件性专业队 gate(同落 gateMarks;仅选对应专业队时才要求;**不计入**通用 8 自动推进)。
export const PROFESSIONAL_GATE_CODES = [
  'team-water', // 水域救援队
  'team-urban', // 城市搜救队
  'team-mountain', // 山地救援队
  'team-high', // 高空救援队
] as const;

export const ALL_GATE_CODES = [...GENERAL_GATE_CODES, ...PROFESSIONAL_GATE_CODES] as const;
export type GateCode = (typeof ALL_GATE_CODES)[number];

export function isGateCode(code: string): code is GateCode {
  return (ALL_GATE_CODES as ReadonlyArray<string>).includes(code);
}

// ===== gate 有效期(评审稿 §4.2)=====
export type GateValidity = 'cycle' | 'long-term' | { years: number };
export const GATE_VALIDITY: Readonly<Record<GateCode, GateValidity>> = {
  fitness: 'cycle',
  'first-aid-training': { years: 3 },
  military: { years: 2 },
  psych: 'cycle',
  interview: 'cycle',
  'dept-assessment': 'cycle', // ★可延长期(gateMark.extendedUntil)
  'entry-exam': 'cycle',
  'intermediate-outdoor': 'long-term',
  'team-water': 'cycle',
  'team-urban': 'cycle',
  'team-mountain': 'cycle',
  'team-high': 'cycle',
};

// 可延长期的 gate(仅 dept-assessment;综合评估延长期在 application.evaluationExtendedUntil,不在此)。
export const EXTENDABLE_GATE_CODES: ReadonlyArray<GateCode> = ['dept-assessment'];

export function isExtendableGate(code: GateCode): boolean {
  return EXTENDABLE_GATE_CODES.includes(code);
}

// ===== wrinkle① 专业队识别(评审稿 §4.4;W-J-1)=====
// node_type dict code 约定 → 该队 gate code;选目标部门时查 org.nodeTypeCode 命中即专业队。
export const PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE: Readonly<Record<string, GateCode>> = {
  'professional-water': 'team-water',
  'professional-urban': 'team-urban',
  'professional-mountain': 'team-mountain',
  'professional-high': 'team-high',
};

/** 某 node_type 是否专业队(命中约定);返回该队要求的 gate code,否则 null(非专业队)。 */
export function professionalGateForNodeType(nodeTypeCode: string): GateCode | null {
  return PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE[nodeTypeCode] ?? null;
}

// ===== 贡献值(评审稿 §4.3;W-J-3 / Q4)=====
// approved-only:字面镜像 attendances `ATTENDANCE_SHEET_STATUS.APPROVED`('approved' = attendance_sheet_status
// 字典稳定值,终审通过);不 import attendances 内部,保持 team-join 自洽(评审稿 §4.3)。
export const ATTENDANCE_SHEET_STATUS_APPROVED = 'approved';
export const CONTRIBUTION_THRESHOLD = new Prisma.Decimal(5);
const BEIJING_UTC_OFFSET_HOURS = 8;

/**
 * 贡献值 cutoff:入队轮 year 的 3-31 北京日界(= {year}-04-01 00:00:00 +08:00 的 UTC 瞬间,exclusive)。
 * 历史累计、approved sheet only、anchor = checkInAt(在记录上,免连表)。
 */
export function contributionCutoff(cycleYear: number): Date {
  return new Date(Date.UTC(cycleYear, 3, 1, 0, 0, 0) - BEIJING_UTC_OFFSET_HOURS * 3600_000);
}

// ===== gateMarks JSON 形(评审稿 §3.1)=====
export interface GateMark {
  at: string; // ISO 标记时刻
  by: string; // 标记人 User.id
  passed: boolean; // 通过 / 未通过
  completionDate: string; // ISO 实际完成日(算有效期)
  extendedUntil?: string; // ISO 延长期(仅 dept-assessment;admin 设;超本轮仍认)
}
export type GateMarks = Partial<Record<GateCode, GateMark>>;

/**
 * 单个 gate 是否满足(passed + 在有效期内)。评审稿 §4.2:
 * - 'cycle'(本轮):completionDate >= cycle.openedAt;或 extendedUntil(dept-assessment)未到则仍认。
 * - { years: N }:completionDate + N 年 > now。
 * - 'long-term':一经 passed 永久有效。
 */
export function isGateSatisfied(
  code: GateCode,
  mark: GateMark | undefined,
  cycleOpenedAt: Date | null,
  now: Date,
): boolean {
  if (!mark || !mark.passed) return false;
  const validity = GATE_VALIDITY[code];
  if (validity === 'long-term') return true;
  const completion = new Date(mark.completionDate);
  if (validity === 'cycle') {
    if (mark.extendedUntil && now.getTime() <= new Date(mark.extendedUntil).getTime()) {
      return true; // 延长期(仅 dept-assessment 会设)
    }
    if (cycleOpenedAt == null) return false;
    return completion.getTime() >= cycleOpenedAt.getTime();
  }
  // { years: N }
  const expiry = new Date(completion);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + validity.years);
  return now.getTime() < expiry.getTime();
}

/** 8 通用门槛是否全满足(contribution 另算,不在此)。 */
export function allGeneralGatesSatisfied(
  marks: GateMarks | null | undefined,
  cycleOpenedAt: Date | null,
  now: Date,
): boolean {
  if (!marks) return false;
  return GENERAL_GATE_CODES.every((c) => isGateSatisfied(c, marks[c], cycleOpenedAt, now));
}

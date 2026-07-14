// 招新三期(入队:志愿者 → 队员)T2(2026-06-19):team-join 模块常量 + 纯函数 helper。
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md(下称"评审稿")。
// 入口态 = phase-2 promote 出的无部门、无级别志愿者(member);入队才赋部门 + 级别 level-1。

import { Prisma } from '@prisma/client';

// ===== 入队轮状态(String;后台开关;沿 recruitment CYCLE_STATUS 范式)=====
export const CYCLE_STATUS_OPEN = 'open';
export const CYCLE_STATUS_CLOSED = 'closed';
export const TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS = 8;
export const TEAM_JOIN_MAX_TARGET_ORGS = 8;

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

// ===== 级别(评审稿 E-J-6 / §3.4;T4 一键入队)=====
// 入队设 gradeCode='level-1'(seed 1-7 member_grade 的第一级);MEMBER_GRADE_DICT_CODE 与
// members.service 同口径(dict_type code);enrollment 直连 prisma 复刻 assertGradeCodeValid 校验
// (level-1 须存在 + ACTIVE,理论 seed 已保证;缺失 → MEMBER_GRADE_CODE_INVALID)。
export const JOIN_GRADE_CODE = 'level-1';
export const MEMBER_GRADE_DICT_CODE = 'member_grade';

// ===== 入队入口身份判定(招新闭环优化 S5;评审稿 §5.2b;推翻 phase-3 E-J-6 双表示取舍)=====
// 「未入队志愿者」= 可发起入队申请 / 可被一键入队的入口态。两处门禁(自助发起 app.service +
// 一键入队 enrollment.service)共享本纯函数,零漂移。
// VOL / volunteer 字面镜像 seed 稳定契约(Organization.code='VOL' 长期契约 + member_grade 'volunteer'
// 项);不 import recruitment 内部,保持 team-join 自洽(沿本文件 ATTENDANCE_SHEET_STATUS_APPROVED 范式)。
export const VOLUNTEER_GRADE_CODE = 'volunteer';
export const VOL_ORG_CODE = 'VOL';

export interface UnenrolledVolunteerMember {
  gradeCode: string | null;
}
export interface ActiveDeptWithOrgCode {
  organization: { code: string | null }; // Organization.code 为可空(String?;legacy org 无 code)
}

/**
 * 是否「未入队志愿者」(可发起入队申请 / 可被一键入队)。评审稿 §5.2b 双口径(命中任一即放行):
 * - 新口径(S5 后 promote 出):gradeCode==='volunteer' 且 **仅一条** active 部门且其 org=VOL;
 * - legacy 口径(phase-3 promote 出的历史志愿者):gradeCode==null 且 **零** active 部门。
 * 其余(已设 level-* 级别 / 已有非 VOL 部门 / 身份不一致)= 已入队 / 非志愿者 → 拦截。
 * activeDepts 仅传 deletedAt IS NULL 的归属;org.code 由调用方 include 带入(纯函数不查库)。
 */
export function isUnenrolledVolunteer(
  member: UnenrolledVolunteerMember,
  activeDepts: readonly ActiveDeptWithOrgCode[],
): boolean {
  if (
    member.gradeCode === VOLUNTEER_GRADE_CODE &&
    activeDepts.length === 1 &&
    activeDepts[0].organization.code === VOL_ORG_CODE
  ) {
    return true;
  }
  if (member.gradeCode == null && activeDepts.length === 0) {
    return true;
  }
  return false;
}

// ===== 贡献值(评审稿 §4.3;W-J-3 / Q4)=====
// approved-only:字面镜像 attendances `ATTENDANCE_SHEET_STATUS.APPROVED`('approved' = attendance_sheet_status
// 字典稳定值,终审通过);不 import attendances 内部,保持 team-join 自洽(评审稿 §4.3)。
export const ATTENDANCE_SHEET_STATUS_APPROVED = 'approved';
export const CONTRIBUTION_THRESHOLD = new Prisma.Decimal(5);
// 全局每日封顶(活动闭环硬化 2026-06-21):一个队员单个北京日历日的贡献值总分封顶在统一值。
// 由「每条记录各自封顶」改为「全局每日上限」——封顶落在汇总处 computeContribution(不落库、
// 不在 calculator 每条钳制)。v1 常量(配置化后置);ContributionRule.dailyCap 列已 deprecated 不再读。
export const GLOBAL_DAILY_CONTRIBUTION_CAP = new Prisma.Decimal('3');
const BEIJING_UTC_OFFSET_HOURS = 8;

/**
 * 贡献值 cutoff:入队轮 year 的 3-31 北京日界(= {year}-04-01 00:00:00 +08:00 的 UTC 瞬间,exclusive)。
 * 历史累计、approved sheet only、anchor = checkInAt(在记录上,免连表)。
 */
export function contributionCutoff(cycleYear: number): Date {
  return new Date(Date.UTC(cycleYear, 3, 1, 0, 0, 0) - BEIJING_UTC_OFFSET_HOURS * 3600_000);
}

// 北京日历日序号(UTC+8 偏移后按整天 floor)。「本轮」边界按北京日比较,化解
// completionDate date-only(`new Date('YYYY-MM-DD')` = UTC 00:00)与 cycle.openedAt 精确时刻
// 跨日界误判 —— 入队轮开启当天(北京白天 openedAt > 当日 UTC 0 点)完成的 gate 不再被误判
// 「本轮之前」失效(bug HIGH,2026-06-19 维护者元核验)。
// 导出复用:gate 本轮边界判定 + 贡献值全局每日封顶分组(computeContribution)共用同一北京日序号口径。
export function beijingDayNumber(d: Date): number {
  return Math.floor((d.getTime() + BEIJING_UTC_OFFSET_HOURS * 3600_000) / 86_400_000);
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
    // 按北京日历日比较(同日完成算本轮内;bug HIGH 修复,不再用精确时刻 >=)
    return beijingDayNumber(completion) >= beijingDayNumber(cycleOpenedAt);
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

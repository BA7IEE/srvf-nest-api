import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  ALL_GATE_CODES,
  ATTENDANCE_SHEET_STATUS_APPROVED,
  CONTRIBUTION_THRESHOLD,
  type GateMarks,
  GENERAL_GATE_CODES,
  GLOBAL_DAILY_CONTRIBUTION_CAP,
  allGeneralGatesSatisfied,
  beijingDayNumber,
  contributionCutoff,
  isGateSatisfied,
} from './team-join.constants';
import type { GateStatusDto, TeamJoinApplicationAdminDto } from './team-join.dto';

// 招新三期(入队)进度派生(贡献值汇总 + gate 实况);admin 面与 app 自助面共用,避免逻辑分叉
// (评审稿 §4.2/§4.3;2026-06-19 元核验后抽出:同一份「本轮按北京日 / years / 延长期」判定单一真相源)。

export interface ContributionResult {
  points: Prisma.Decimal;
  satisfied: boolean;
}

// 贡献值只读汇总:approved sheet + checkInAt < 入队年 3-31 cutoff,历史累计,Decimal 精度,实时算不落库。
// 全局每日封顶(活动闭环硬化 2026-06-21):一个队员单个北京日历日的贡献值总分封顶在
// GLOBAL_DAILY_CONTRIBUTION_CAP(默认 1.5)。按记录 checkInAt 的北京日历日分组 → 每日总和封顶 →
// 再加总。封顶在此汇总处、不落库 → 旧记录存值照旧,无 migration / 无回溯重算;直接影响入队 ≥5 gate 值
//(原「每条各自封顶、一天多条叠加超额」语义改为「一人一北京日总分封顶」)。in-memory 取数分组
//(成员记录有界);contributionPoints 为 null(APD 未填 / 无匹配规则)按 0 计,沿旧 SQL SUM 跳 NULL 语义。
export async function computeContribution(
  client: PrismaService | Prisma.TransactionClient,
  memberId: string,
  cycleYear: number,
): Promise<ContributionResult> {
  const cutoff = contributionCutoff(cycleYear);
  const records = await client.attendanceRecord.findMany({
    where: {
      memberId,
      deletedAt: null,
      checkInAt: { lt: cutoff },
      sheet: { statusCode: ATTENDANCE_SHEET_STATUS_APPROVED, deletedAt: null },
    },
    select: { checkInAt: true, contributionPoints: true },
  });
  // 按北京日历日分组求和(null 贡献值按 0 计)。
  const dayTotals = new Map<number, Prisma.Decimal>();
  for (const r of records) {
    const day = beijingDayNumber(r.checkInAt);
    const prev = dayTotals.get(day) ?? new Prisma.Decimal(0);
    dayTotals.set(day, prev.add(r.contributionPoints ?? new Prisma.Decimal(0)));
  }
  // 每日总和封顶在全局上限,再加总。
  let points = new Prisma.Decimal(0);
  for (const daySum of dayTotals.values()) {
    const capped = daySum.greaterThan(GLOBAL_DAILY_CONTRIBUTION_CAP)
      ? GLOBAL_DAILY_CONTRIBUTION_CAP
      : daySum;
    points = points.add(capped);
  }
  return { points, satisfied: points.gte(CONTRIBUTION_THRESHOLD) };
}

const GENERAL_GATE_SET = new Set<string>(GENERAL_GATE_CODES);

// 各 gate 实况(是否标记 / 通过 / 在有效期内满足);纯函数,admin/app 共用。
export function buildGateStatus(
  marks: GateMarks | null,
  cycleOpenedAt: Date | null,
  now: Date,
): GateStatusDto[] {
  return ALL_GATE_CODES.map((code) => {
    const mark = marks?.[code];
    return {
      code,
      professional: !GENERAL_GATE_SET.has(code),
      marked: mark != null,
      passed: mark ? mark.passed : null,
      satisfied: isGateSatisfied(code, mark, cycleOpenedAt, now),
      completionDate: mark?.completionDate ?? null,
      extendedUntil: mark?.extendedUntil ?? null,
    };
  });
}

// ===== admin 行查询 include + presenter(admin list/detail/标 gate/评估/一键入队 共用)=====
// cycle.statusCode 供一键入队判「综合评估本轮有效 / 延长期」(T4);member 供展示编号/称呼。
export const TEAM_JOIN_APPLICATION_INCLUDE = {
  cycle: { select: { openedAt: true, year: true, statusCode: true, name: true } },
  member: { select: { memberNo: true, displayName: true } },
} as const;

export type TeamJoinApplicationRow = Prisma.TeamJoinApplicationGetPayload<{
  include: typeof TEAM_JOIN_APPLICATION_INCLUDE;
}>;

export function buildAdminDto(
  row: TeamJoinApplicationRow,
  contribution: ContributionResult | null,
  now: Date,
): TeamJoinApplicationAdminDto {
  const marks = (row.gateMarks as GateMarks | null) ?? null;
  return {
    id: row.id,
    cycleId: row.cycleId,
    memberId: row.memberId,
    memberNo: row.member.memberNo,
    memberDisplayName: row.member.displayName,
    statusCode: row.statusCode,
    targetOrganizationIds: (row.targetOrganizationIds as string[] | null) ?? [],
    selectedOrganizationId: row.selectedOrganizationId,
    gates: buildGateStatus(marks, row.cycle.openedAt, now),
    generalGatesSatisfied: allGeneralGatesSatisfied(marks, row.cycle.openedAt, now),
    contributionPoints: contribution ? contribution.points.toString() : null,
    contributionSatisfied: contribution ? contribution.satisfied : null,
    evaluationNote: row.evaluationNote,
    evaluatedAt: row.evaluatedAt,
    evaluationExtendedUntil: row.evaluationExtendedUntil,
    eliminationStage: row.eliminationStage,
    joinedAt: row.joinedAt,
    createdAt: row.createdAt,
  };
}

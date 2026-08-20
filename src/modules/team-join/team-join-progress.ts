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
import { formatMemberLabel } from '../../common/identity/member-label.util';

// 招新三期(入队)进度派生(贡献值汇总 + gate 实况);admin 面与 app 自助面共用,避免逻辑分叉
// (评审稿 §4.2/§4.3;2026-06-19 元核验后抽出:同一份「本轮按北京日 / years / 延长期」判定单一真相源)。

export interface ContributionResult {
  points: Prisma.Decimal;
  satisfied: boolean;
}

// 贡献值封顶核(单一真相源):approved sheet only,Decimal 精度,实时算不落库。
// 全局每日封顶(活动闭环硬化 2026-06-21):一个队员单个北京日历日的贡献值总分封顶在
// GLOBAL_DAILY_CONTRIBUTION_CAP(当前 3)。按记录 checkInAt 的北京日历日分组 → 每日总和封顶 →
// 再加总。封顶在此汇总处、不落库 → 旧记录存值照旧、读取时按当前上限重算,无 migration / 无数据回填。in-memory 取数分组
//(成员记录有界);contributionPoints 为 null(APD 未填 / 无匹配规则)按 0 计,沿旧 SQL SUM 跳 NULL 语义。
//
// cutoff 参数化(2026-06-23,队员 360 跨轴只读复用):
//   - Date  → 仅计 checkInAt < cutoff 的记录(入队 gate「本轮 3-31 截至」语义,team-join 调用方传入)
//   - null  → 不设上界,**生涯累计**(admin 队员贡献汇总,无入队年 cutoff)
// **禁裸 SUM**:任何贡献值总分都必须走本函数的北京日分组封顶,绕过会算多(超 3/日)。
interface ContributionRecordRow {
  checkInAt: Date;
  contributionPoints: Prisma.Decimal | null;
}

/**
 * 封顶核的**纯函数**部分:按北京日历日分组求和 → 每日封顶 → 再加总。
 *
 * 单人版与批量版都必须经过这里。抽出来的唯一理由是 M3 要把逐人查询批量化,
 * 而本目录 CLAUDE.md 明文禁止「复制 cap 算法或用原始分反推」—— 两份实现迟早读数不同,
 * 而贡献值差 0.5 分就是「够不够 5 分入队」的分界。
 */
function capByBeijingDay(records: readonly ContributionRecordRow[]): Prisma.Decimal {
  const dayTotals = new Map<number, Prisma.Decimal>();
  for (const r of records) {
    const day = beijingDayNumber(r.checkInAt);
    const prev = dayTotals.get(day) ?? new Prisma.Decimal(0);
    dayTotals.set(day, prev.add(r.contributionPoints ?? new Prisma.Decimal(0)));
  }
  let points = new Prisma.Decimal(0);
  for (const daySum of dayTotals.values()) {
    const capped = daySum.greaterThan(GLOBAL_DAILY_CONTRIBUTION_CAP)
      ? GLOBAL_DAILY_CONTRIBUTION_CAP
      : daySum;
    points = points.add(capped);
  }
  return points;
}

function approvedRecordsWhere(
  memberId: string | { in: readonly string[] },
  cutoff: Date | null,
): Prisma.AttendanceRecordWhereInput {
  return {
    memberId: typeof memberId === 'string' ? memberId : { in: [...memberId.in] },
    deletedAt: null,
    ...(cutoff ? { checkInAt: { lt: cutoff } } : {}),
    sheet: { statusCode: ATTENDANCE_SHEET_STATUS_APPROVED, deletedAt: null },
  };
}

export async function computeCappedContribution(
  client: PrismaService | Prisma.TransactionClient,
  memberId: string,
  cutoff: Date | null,
): Promise<Prisma.Decimal> {
  const records = await client.attendanceRecord.findMany({
    where: approvedRecordsWhere(memberId, cutoff),
    select: { checkInAt: true, contributionPoints: true },
  });
  return capByBeijingDay(records);
}

/**
 * 批量版(M3):**一次** SQL 取回整批人的 approved 记录,在内存里按人分组后走同一个封顶核。
 *
 * 为什么必须批量:考勤终审的每条 record 都要一次 before 与一次 after 贡献值快照,
 * 逐人查在 200 人的考勤单上就是 400 次往返 —— 加上逐条 outbox,整个事务约 1000+ 次 SQL,
 * 直接把 Prisma 默认 5s 交互事务预算跑穿(评审实测)。调大 timeout 只是把锁持有得更久,
 * 让 convoy 更严重,所以刀口只能落在查询次数上。
 *
 * 返回的 Map 对**每一个**入参 memberId 都有值(无记录者为 0),调用方不必再补默认值。
 */
export async function computeCappedContributionBatch(
  client: PrismaService | Prisma.TransactionClient,
  memberIds: readonly string[],
  cutoff: Date | null,
): Promise<Map<string, Prisma.Decimal>> {
  const unique = [...new Set(memberIds)];
  const result = new Map<string, Prisma.Decimal>(unique.map((id) => [id, new Prisma.Decimal(0)]));
  if (unique.length === 0) return result;

  const records = await client.attendanceRecord.findMany({
    where: approvedRecordsWhere({ in: unique }, cutoff),
    select: { memberId: true, checkInAt: true, contributionPoints: true },
  });
  const byMember = new Map<string, ContributionRecordRow[]>();
  for (const r of records) {
    const list = byMember.get(r.memberId);
    if (list) list.push(r);
    else byMember.set(r.memberId, [r]);
  }
  for (const [memberId, rows] of byMember) result.set(memberId, capByBeijingDay(rows));
  return result;
}

// 入队三期(招新)贡献值只读汇总:封顶核 + 入队年 3-31 cutoff + ≥5 gate 判定。
// 行为零变化(2026-06-23 抽出封顶核后):cutoff = contributionCutoff(cycleYear),points 委托
// computeCappedContribution,satisfied 仍按 CONTRIBUTION_THRESHOLD 判。team-join 各调用方签名不变。
export async function computeContribution(
  client: PrismaService | Prisma.TransactionClient,
  memberId: string,
  cycleYear: number,
): Promise<ContributionResult> {
  const points = await computeCappedContribution(client, memberId, contributionCutoff(cycleYear));
  return { points, satisfied: points.gte(CONTRIBUTION_THRESHOLD) };
}

/**
 * 批量版(M3):同一个 cycleYear 下的一批队员,**一次** SQL 算完。
 * cutoff 随 cycleYear 变,所以调用方必须先按年分组再调 —— 实践中终审单里的候选人
 * 几乎总落在同一轮,分组后通常只有一次查询。
 */
export async function computeContributionBatch(
  client: PrismaService | Prisma.TransactionClient,
  memberIds: readonly string[],
  cycleYear: number,
): Promise<Map<string, ContributionResult>> {
  const points = await computeCappedContributionBatch(
    client,
    memberIds,
    contributionCutoff(cycleYear),
  );
  return new Map(
    [...points].map(([memberId, value]) => [
      memberId,
      { points: value, satisfied: value.gte(CONTRIBUTION_THRESHOLD) },
    ]),
  );
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
  cycle: {
    select: {
      openedAt: true,
      year: true,
      statusCode: true,
      name: true,
      openOrganizationIds: true,
    },
  },
  member: { select: { memberNo: true, realName: true, nickname: true } },
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
    memberRealName: row.member.realName,
    memberLabel: formatMemberLabel(row.member),
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

import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import type { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ContributionLedgerReader } from './contribution-ledger-reader';
import {
  ALL_GATE_CODES,
  CONTRIBUTION_THRESHOLD,
  type GateMarks,
  GENERAL_GATE_CODES,
  allGeneralGatesSatisfied,
  beijingDayNumber,
  contributionCutoff,
  isGateSatisfied,
} from './team-join.constants';
import type { GateStatusDto, TeamJoinApplicationAdminDto } from './team-join.dto';
import { formatMemberLabel } from '../../common/identity/member-label.util';

export { contributionMilestoneIntent } from './team-join-contribution-milestone';
export { APP_STATUS_JOINING } from './team-join.constants';

// 招新三期(入队)进度派生(贡献值汇总 + gate 实况);admin 面与 app 自助面共用,避免逻辑分叉
// (评审稿 §4.2/§4.3;2026-06-19 元核验后抽出:同一份「本轮按北京日 / years / 延长期」判定单一真相源)。

export interface ContributionResult {
  points: Prisma.Decimal;
  satisfied: boolean;
}

// Only committed credited deltas are supported. The ledger already applies the daily cap;
// reversal and replacement entries remain part of the net total. A disabled workflow
// fails closed rather than reading retired attendance data or returning a fabricated zero.
type ContributionReadGate = Pick<ActivityWorkflowGate, 'participationReadSource'>;

function assertCommittedContributionSource(activityWorkflowGate: ContributionReadGate): void {
  if (activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
    throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
  }
}

function contributionLedgerCutoff(cutoff: Date | null): Date | null {
  // The entry DATE stores a civil day at UTC midnight, not the cutoff's UTC instant.
  return cutoff ? new Date(beijingDayNumber(cutoff) * 86_400_000) : null;
}

function assertFiniteLedgerTotal(value: unknown): asserts value is Prisma.Decimal {
  if (!Prisma.Decimal.isDecimal(value) || !value.isFinite()) {
    throw new Error('Contribution ledger snapshot is incomplete or contains non-finite totals');
  }
}

export async function computeCappedContribution(
  client: PrismaService | Prisma.TransactionClient,
  memberId: string,
  cutoff: Date | null,
  activityWorkflowGate: ContributionReadGate,
  contributionLedgerReader: ContributionLedgerReader,
): Promise<Prisma.Decimal> {
  assertCommittedContributionSource(activityWorkflowGate);
  const total = await contributionLedgerReader.sumCommittedCreditedPointsForMemberInTx(
    client,
    memberId,
    contributionLedgerCutoff(cutoff),
  );
  assertFiniteLedgerTotal(total);
  return total;
}

/**
 * Batch through the ledger owner once, retaining zero entries for absent members.
 * The gate is checked even for an empty batch so disabled does not masquerade as success.
 */
export async function computeCappedContributionBatch(
  client: PrismaService | Prisma.TransactionClient,
  memberIds: readonly string[],
  cutoff: Date | null,
  activityWorkflowGate: ContributionReadGate,
  contributionLedgerReader: ContributionLedgerReader,
): Promise<Map<string, Prisma.Decimal>> {
  assertCommittedContributionSource(activityWorkflowGate);
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return new Map();
  const totals = await contributionLedgerReader.sumCommittedCreditedPointsForMembersInTx(
    client,
    unique,
    contributionLedgerCutoff(cutoff),
  );
  if (totals.size !== unique.length) {
    throw new Error('Contribution ledger snapshot is incomplete or contains non-finite totals');
  }
  for (const memberId of unique) assertFiniteLedgerTotal(totals.get(memberId));
  return totals;
}

// 入队三期(招新)贡献值只读汇总:封顶核 + 入队年 3-31 cutoff + ≥5 gate 判定。
// cutoff 和门槛不变；Gate 与只读端口均显式传入，调用方保留事务和成员锁。
export async function computeContribution(
  client: PrismaService | Prisma.TransactionClient,
  memberId: string,
  cycleYear: number,
  activityWorkflowGate: ContributionReadGate,
  contributionLedgerReader: ContributionLedgerReader,
): Promise<ContributionResult> {
  const points = await computeCappedContribution(
    client,
    memberId,
    contributionCutoff(cycleYear),
    activityWorkflowGate,
    contributionLedgerReader,
  );
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
  activityWorkflowGate: ContributionReadGate,
  contributionLedgerReader: ContributionLedgerReader,
): Promise<Map<string, ContributionResult>> {
  const points = await computeCappedContributionBatch(
    client,
    memberIds,
    contributionCutoff(cycleYear),
    activityWorkflowGate,
    contributionLedgerReader,
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

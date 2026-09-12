import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { TimePolicyDefinition } from './activity-time-policy-definition';
import type { ActivityTimeAllocationSliceInput } from './activity-time-allocation-command';
import type { ActivityTimePolicySelectionResolutionTarget } from './activity-time-policy-selection';

function unavailable(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE);
}

function invalid(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_INVALID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface HistoricalSnapshotPosition {
  readonly positionId: string;
  readonly attendanceRoleCode: string;
}

interface HistoricalSnapshotSession {
  readonly sessionId: string;
  readonly positions: readonly HistoricalSnapshotPosition[];
}

function historicalSnapshotSessions(value: unknown): readonly HistoricalSnapshotSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return unavailable();
  const sessions = value.sessions.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.sessionId !== 'string') return unavailable();
    if (!Array.isArray(candidate.positions)) return unavailable();
    const positions = candidate.positions.map((position) => {
      if (
        !isRecord(position) ||
        typeof position.positionId !== 'string' ||
        typeof position.attendanceRoleCode !== 'string' ||
        position.positionId.length < 1 ||
        position.positionId.length > 64 ||
        position.attendanceRoleCode.length < 1 ||
        position.attendanceRoleCode.length > 64
      ) {
        return unavailable();
      }
      return {
        positionId: position.positionId,
        attendanceRoleCode: position.attendanceRoleCode,
      };
    });
    if (new Set(positions.map((position) => position.positionId)).size !== positions.length)
      return unavailable();
    return { sessionId: candidate.sessionId, positions };
  });
  if (
    new Set(sessions.map((session) => session.sessionId)).size !== sessions.length ||
    new Set(sessions.flatMap((session) => session.positions.map((position) => position.positionId)))
      .size !== sessions.flatMap((session) => session.positions).length
  ) {
    return unavailable();
  }
  return sessions;
}

export function historicalTimePolicySelectionTargetsFromRuleSnapshot(
  resolvedConfig: unknown,
): readonly ActivityTimePolicySelectionResolutionTarget[] {
  return historicalSnapshotSessions(resolvedConfig)
    .map((session) => ({
      sessionId: session.sessionId,
      positionIds: session.positions.map((position) => position.positionId),
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/**
 * RuleSnapshot is the historical configuration source.  We only read the two identifiers and
 * immutable attendance role needed by the D3 evaluator; a malformed historical snapshot fails
 * closed instead of falling back to today's SessionPosition row.
 */
export function historicalAttendanceRoleFromRuleSnapshot(
  resolvedConfig: unknown,
  sessionId: string,
  sourcePositionId: string | null,
): string | null {
  if (sourcePositionId === null) return null;
  const session = historicalSnapshotSessions(resolvedConfig).find(
    (candidate) => candidate.sessionId === sessionId,
  );
  const position = session?.positions.find(
    (candidate) => candidate.positionId === sourcePositionId,
  );
  if (!position) return unavailable();
  return position.attendanceRoleCode;
}

export function automaticTimeAllocationSlices(
  definition: TimePolicyDefinition,
  attendanceRoleCode: string | null,
  sourceStartAt: Date,
  sourceEndAt: Date,
): readonly ActivityTimeAllocationSliceInput[] {
  if (
    definition.evidence.requireManualRecognition ||
    Object.values(definition.specialIntervals).some((interval) => interval.mode !== 'exclude')
  ) {
    return unavailable();
  }
  const category =
    definition.roleMappings.find((mapping) => mapping.attendanceRoleCode === attendanceRoleCode)
      ?.category ?? definition.defaultCategory;
  return [
    {
      categoryCode: category,
      intervalKindCode: 'service_segment',
      startAt: sourceStartAt.toISOString(),
      endAt: sourceEndAt.toISOString(),
    },
  ];
}

export function assertManualTimeAllocationAllowed(definition: TimePolicyDefinition): void {
  if (!definition.manualAdjustment.enabled) unavailable();
}

export function assertAllocationSlicesWithinSource(
  slices: readonly ActivityTimeAllocationSliceInput[],
  sourceStartAt: Date,
  sourceEndAt: Date,
  allowSplit: boolean,
): void {
  if (slices.length < 1 || slices.length > 500) invalid();
  const sourceStart = sourceStartAt.toISOString();
  const sourceEnd = sourceEndAt.toISOString();
  let previousEnd: string | null = null;
  let totalMilliseconds = 0;
  for (const slice of slices) {
    if (
      slice.intervalKindCode !== 'service_segment' ||
      slice.startAt < sourceStart ||
      slice.endAt > sourceEnd ||
      slice.startAt >= slice.endAt ||
      (previousEnd !== null && slice.startAt < previousEnd)
    ) {
      invalid();
    }
    previousEnd = slice.endAt;
    totalMilliseconds += new Date(slice.endAt).getTime() - new Date(slice.startAt).getTime();
  }
  if (totalMilliseconds > sourceEndAt.getTime() - sourceStartAt.getTime()) invalid();
  if (
    !allowSplit &&
    (slices.length !== 1 || slices[0].startAt !== sourceStart || slices[0].endAt !== sourceEnd)
  ) {
    invalid();
  }
}

/**
 * The D2 chain satisfies service-segment and punch-event evidence. Attachments are the only extra
 * evidence family D3 can receive, so every required attachment rule is explicit here.
 */
export function assertTimeAllocationEvidence(
  definition: TimePolicyDefinition,
  recognitionModeCode: 'automatic' | 'manual',
  evidenceAttachmentCount: number,
): void {
  const attachmentRequired = definition.evidence.requiredSources.includes('attachment');
  const manualEvidenceRequired =
    recognitionModeCode === 'manual' &&
    definition.manualAdjustment.enabled &&
    definition.manualAdjustment.evidenceRequired;
  if ((attachmentRequired || manualEvidenceRequired) && evidenceAttachmentCount < 1) invalid();
}

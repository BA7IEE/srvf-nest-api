import type {
  ActivitySettlementContributionRevision,
  ParticipantContributionEvaluation,
} from '@prisma/client';

export type ContributionSummaryEvaluation = Pick<
  ParticipantContributionEvaluation,
  | 'participationIdentityId'
  | 'policyVersionId'
  | 'definitionHash'
  | 'evaluatorVersion'
  | 'attendanceRoleCode'
  | 'timeCategoryCode'
  | 'durationSeconds'
  | 'calculatedPoints'
  | 'recognizedPoints'
  | 'explanationCode'
>;

/** Bounded evidence metadata only: no policy definition, source JSON, reason payload or current-policy lookup. */
export function presentContributionProof(
  root: ActivitySettlementContributionRevision | null,
  evaluations: readonly ContributionSummaryEvaluation[],
  current = true,
) {
  const pending = !root || !current;
  return {
    regimeCode: 'policy_v1' as const,
    pending,
    revisionId: pending ? null : root.id,
    sourceKindCode: pending ? null : root.sourceKindCode,
    selectionHash: pending ? null : root.selectionRevisionHash,
    sourceSetHash: pending ? null : root.sourceSetHash,
    evaluationSetHash: pending ? null : root.evaluationSetHash,
    recognizedPointsTotal: pending ? null : root.recognizedPointsTotal.toFixed(2),
    evaluationCount: pending ? null : root.evaluationCount,
    hasMore: !pending && root.evaluationCount > 100,
    evaluations: pending
      ? []
      : evaluations.slice(0, 100).map((row) => ({
          participationIdentityId: row.participationIdentityId,
          policyVersionId: row.policyVersionId,
          definitionHash: row.definitionHash,
          evaluatorVersion: row.evaluatorVersion,
          attendanceRoleCode: row.attendanceRoleCode,
          timeCategoryCode: row.timeCategoryCode,
          durationSeconds: row.durationSeconds,
          calculatedPoints: row.calculatedPoints.toFixed(2),
          recognizedPoints: row.recognizedPoints.toFixed(2),
          explanationCode: row.explanationCode,
        })),
  };
}
export type ContributionProofSummary = ReturnType<typeof presentContributionProof>;

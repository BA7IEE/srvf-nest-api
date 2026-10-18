import { Prisma, type ActivitySettlementContributionRevision } from '@prisma/client';
import {
  presentContributionProof,
  type ContributionSummaryEvaluation,
} from './activity-contribution-settlement-presenter';

function root(count = 1) {
  return {
    id: 'proof-one',
    sourceKindCode: 'time_revision',
    selectionRevisionHash: 'a'.repeat(64),
    sourceSetHash: 'b'.repeat(64),
    evaluationSetHash: 'c'.repeat(64),
    recognizedPointsTotal: new Prisma.Decimal('0.00'),
    evaluationCount: count,
  } as ActivitySettlementContributionRevision;
}
function row() {
  return {
    participationIdentityId: 'identity-one',
    policyVersionId: 'policy-version-one',
    definitionHash: 'd'.repeat(64),
    evaluatorVersion: 1,
    attendanceRoleCode: 'member',
    timeCategoryCode: 'training',
    durationSeconds: 60,
    calculatedPoints: new Prisma.Decimal(0),
    recognizedPoints: new Prisma.Decimal(0),
    explanationCode: 'explicit_zero',
    definitionJson: { secret: 'must-not-leak' },
    sourceRefsJson: [{ payload: 'must-not-leak' }],
  } as ContributionSummaryEvaluation;
}
describe('E4 compact proof presentation', () => {
  it.each([null, root()])(
    'shows unavailable/stale proof as pending, never as recognized zero',
    (proof) => {
      const result = presentContributionProof(proof, [row()], false);
      expect(result).toMatchObject({
        pending: true,
        recognizedPointsTotal: null,
        revisionId: null,
        evaluationCount: null,
        sourceSetHash: null,
        hasMore: false,
        evaluations: [],
      });
    },
  );
  it('keeps explicit policy zero distinguishable from pending and returns only allowed fields', () => {
    const result = presentContributionProof(root(), [row()]);
    expect(result.pending).toBe(false);
    expect(result.recognizedPointsTotal).toBe('0.00');
    expect(result.evaluations[0]).toEqual({
      participationIdentityId: 'identity-one',
      policyVersionId: 'policy-version-one',
      definitionHash: 'd'.repeat(64),
      evaluatorVersion: 1,
      attendanceRoleCode: 'member',
      timeCategoryCode: 'training',
      durationSeconds: 60,
      calculatedPoints: '0.00',
      recognizedPoints: '0.00',
      explanationCode: 'explicit_zero',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
  it('bounds preview to 100 and makes truncation explicit', () => {
    const result = presentContributionProof(root(2000), Array.from({ length: 2000 }, row));
    expect(result.evaluations).toHaveLength(100);
    expect(result.hasMore).toBe(true);
    expect(result.evaluationCount).toBe(2000);
  });
  it('can represent a verified empty population without inventing evaluation rows', () => {
    expect(presentContributionProof(root(0), [])).toMatchObject({
      pending: false,
      recognizedPointsTotal: '0.00',
      evaluationCount: 0,
      hasMore: false,
      evaluations: [],
    });
  });
});

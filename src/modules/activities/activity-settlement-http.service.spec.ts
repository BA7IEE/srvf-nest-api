import { buildActivitySettlementRequestHash } from './activity-settlement-http.service';

describe('buildActivitySettlementRequestHash', () => {
  it('递归忽略 HTTP JSON object 的键序，但保留数组和动作语义', () => {
    const first = buildActivitySettlementRequestHash('settlement-first-approve', {
      activityId: 'activity-1',
      expectation: {
        evidenceSealId: 'seal-1',
        workflowRevision: 7,
      },
    });
    const reordered = buildActivitySettlementRequestHash('settlement-first-approve', {
      expectation: {
        workflowRevision: 7,
        evidenceSealId: 'seal-1',
      },
      activityId: 'activity-1',
    });

    expect(reordered).toBe(first);
    expect(
      buildActivitySettlementRequestHash('settlement-final-approve', {
        activityId: 'activity-1',
        expectation: {
          evidenceSealId: 'seal-1',
          workflowRevision: 7,
        },
      }),
    ).not.toBe(first);
  });
});

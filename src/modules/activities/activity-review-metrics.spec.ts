import { readFrozenReviewMetrics } from './activity-review-metrics';

describe('readFrozenReviewMetrics', () => {
  const pointer = {
    id: 'metric-set',
    code: 'sample',
    schemaVersion: 1,
    version: 1,
    definitionHash: 'e'.repeat(64),
  };
  const findUnique = jest.fn();
  const db = { activityMetricSetVersion: { findUnique } } as unknown as Parameters<
    typeof readFrozenReviewMetrics
  >[0];
  beforeEach(() => findUnique.mockReset());
  it('never queries the catalogue for missing or malformed references', async () => {
    for (const p of [null, { ...pointer, version: 0 }])
      expect(
        await readFrozenReviewMetrics(db, {
          schemaVersion: 7,
          base: {},
          metricRequirementCode: 'required',
          metricSetPointer: p,
        }),
      ).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });
  it('omits an unavailable version while preserving the readable review', async () => {
    findUnique.mockResolvedValue({
      ...pointer,
      definitionHash: '0'.repeat(64),
      statusCode: 'active',
      items: [],
    });
    expect(
      await readFrozenReviewMetrics(db, {
        schemaVersion: 7,
        base: {},
        metricRequirementCode: 'required',
        metricSetPointer: pointer,
      }),
    ).toEqual([]);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pointer.id } }));
  });
});

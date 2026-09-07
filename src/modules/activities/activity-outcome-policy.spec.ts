import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { nextActivityOutcomeRevision } from './activity-outcome-policy';

describe('C2 outcome new-write policy', () => {
  it.each(['draft', 'published', 'completed', 'terminated'])('accepts %s', (status) => {
    expect(nextActivityOutcomeRevision(status, 0, null)).toEqual({
      revision: 1,
      priorRevisionId: null,
      supersedeId: null,
    });
  });
  it.each(['cancelled', 'archived', 'unknown'])('rejects %s', (status) => {
    expect(() => nextActivityOutcomeRevision(status, 0, null)).toThrow(
      new BizException(BizCode.ACTIVITY_STATUS_INVALID),
    );
  });
  it('appends to a draft without changing its content', () => {
    const latest = Object.freeze({ id: 'prior', revision: 2, statusCode: 'draft' });
    expect(nextActivityOutcomeRevision('completed', 2, latest)).toEqual({
      revision: 3,
      priorRevisionId: 'prior',
      supersedeId: 'prior',
    });
    expect(latest).toEqual({ id: 'prior', revision: 2, statusCode: 'draft' });
  });
  it.each(['confirmed', 'superseded', 'unknown'])('never replaces %s', (statusCode) => {
    expect(() =>
      nextActivityOutcomeRevision('published', 2, { id: 'prior', revision: 2, statusCode }),
    ).toThrow(new BizException(BizCode.ACTIVITY_OUTCOME_STALE));
  });
  it.each([-1, 1, 1.5, NaN, 2147483647])(
    'rejects stale or invalid expected revision %s',
    (expected) => {
      expect(() => nextActivityOutcomeRevision('draft', expected, null)).toThrow(
        new BizException(BizCode.ACTIVITY_OUTCOME_STALE),
      );
    },
  );
});

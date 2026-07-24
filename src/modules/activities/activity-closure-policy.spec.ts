import { ActivityClosurePolicy, type ActivityClosureInput } from './activity-closure-policy';

describe('ActivityClosurePolicy', () => {
  const now = new Date('2026-07-24T08:00:00.000Z');
  const base: ActivityClosureInput = {
    statusCode: 'published',
    endAt: new Date('2026-07-24T07:00:00.000Z'),
    attendanceDeclaredCompleteAt: new Date('2026-07-24T07:30:00.000Z'),
    latestPublishReviewStatus: null,
    attendance: {
      total: 0,
      pending: 0,
      returned: 0,
      pendingFinalReview: 0,
      unresolved: 0,
    },
  };
  const policy = new ActivityClosurePolicy();

  it.each([
    [
      'draft',
      { statusCode: 'draft', attendanceDeclaredCompleteAt: null },
      { status: 'draft', nextAction: '提交发布审核' },
    ],
    [
      'publish review pending',
      {
        statusCode: 'draft',
        attendanceDeclaredCompleteAt: null,
        latestPublishReviewStatus: 'pending',
      },
      { status: 'publish-review-pending', nextAction: '等待发布审核' },
    ],
    [
      'waiting for owner declaration',
      { attendanceDeclaredCompleteAt: null },
      {
        status: 'waiting-attendance-declaration',
        nextAction: '声明考勤已全部提交',
      },
    ],
    [
      'returned takes owner-action priority',
      {
        attendance: {
          total: 3,
          pending: 1,
          returned: 1,
          pendingFinalReview: 1,
          unresolved: 3,
        },
      },
      { status: 'attendance-returned', nextAction: '修改并重提退回考勤单' },
    ],
    [
      'first review',
      {
        attendance: {
          total: 2,
          pending: 1,
          returned: 0,
          pendingFinalReview: 1,
          unresolved: 2,
        },
      },
      { status: 'attendance-first-review', nextAction: '等待考勤一审' },
    ],
    [
      'final review',
      {
        attendance: {
          total: 1,
          pending: 0,
          returned: 0,
          pendingFinalReview: 1,
          unresolved: 1,
        },
      },
      { status: 'attendance-final-review', nextAction: '等待考勤终审' },
    ],
    [
      'all attendance approved but activity not completed',
      {},
      { status: 'published', nextAction: '等待活动完结' },
    ],
    [
      'closed only when activity completed',
      { statusCode: 'completed' },
      { status: 'closed', nextAction: null },
    ],
  ] as const)('%s', (_label, patch, expected) => {
    expect(
      policy.decide(
        {
          ...base,
          ...patch,
          attendance: {
            ...base.attendance,
            ...('attendance' in patch ? patch.attendance : {}),
          },
        },
        now,
      ),
    ).toEqual(expected);
  });

  it('does not let rejected or final-rejected sheets prevent closure when unresolved is zero', () => {
    expect(
      policy.decide(
        {
          ...base,
          statusCode: 'completed',
          attendance: { ...base.attendance, total: 2, unresolved: 0 },
        },
        now,
      ),
    ).toEqual({ status: 'closed', nextAction: null });
  });
});

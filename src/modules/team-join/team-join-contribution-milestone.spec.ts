import { Prisma } from '@prisma/client';

import { contributionMilestoneIntent } from './team-join-contribution-milestone';

function intent(before: string, after: string, applicationId = 'application-1') {
  return contributionMilestoneIntent({
    applicationId,
    memberId: 'member-1',
    beforePoints: new Prisma.Decimal(before),
    afterPoints: new Prisma.Decimal(after),
  });
}

describe('contribution threshold milestone intent', () => {
  it('preserves the existing application-scoped event and recipient payload', () => {
    expect(intent('4.99', '5')).toEqual({
      eventKey: 'team-join-contribution-met:application-1:5',
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: 'member-1',
        notificationTypeCode: 'recruitment',
        title: '入队贡献值已达标',
        body: '您的贡献值已达到入队要求（5 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。',
        channels: ['in-app'],
      },
      aggregateType: 'team_join_application',
      aggregateId: 'application-1',
      destinationType: 'member',
      destinationRef: 'member-1',
    });
  });

  it.each([
    ['0', '0'],
    ['-2', '4.99'],
    ['5', '5'],
    ['5', '8'],
    ['7', '4'],
  ])('does not create an intent for %s → %s', (before, after) => {
    expect(intent(before, after)).toBeNull();
  });

  it('uses the same key and payload for a replay or a later crossing after reversal', () => {
    const first = intent('4', '5');
    expect(intent('4', '5')).toEqual(first);
    expect(intent('4.5', '7')).toEqual(first);
    expect(intent('4', '5', 'application-2')?.eventKey).toBe(
      'team-join-contribution-met:application-2:5',
    );
  });

  it('recognizes a crossing from a negative net', () => {
    expect(intent('-2', '5')?.eventKey).toBe('team-join-contribution-met:application-1:5');
  });

  it.each([
    ['NaN', '5'],
    ['4', 'NaN'],
    ['-Infinity', '5'],
    ['4', 'Infinity'],
  ])(
    'rejects invalid totals %s → %s instead of silently dropping the milestone',
    (before, after) => {
      expect(() => intent(before, after)).toThrow('finite ledger totals');
    },
  );
});

import { ActivityMemberOffboardImpactService } from './activity-member-offboard-impact.service';
import { ActivityClosurePolicy } from './activity-closure-policy';

const now = new Date('2099-11-13T10:00:00.000Z');

function activity(futureIdentityIds: string[]) {
  return {
    id: 'activity-1',
    title: 'Multi-session activity',
    statusCode: 'published',
    endAt: new Date('2099-11-20T00:00:00.000Z'),
    attendanceDeclaredCompleteAt: null,
    initiatorMemberId: null,
    publishReviews: [],
    responsibilityAssignments: [],
    attendanceSheets: [],
    registrations: [
      {
        id: 'registration-1',
        statusCode: 'pass',
        activityCheckIns: [{ id: 'earlier-check-in' }],
        attendanceRecords: [],
        participationIdentities: futureIdentityIds.map((id) => ({ id })),
      },
    ],
  };
}

describe('ActivityMemberOffboardImpactService mixed-session guard', () => {
  it('keeps a future identity blocking even when the same registration has historical evidence', async () => {
    const findMany = jest.fn().mockResolvedValue([activity(['future-identity'])]);
    const service = new ActivityMemberOffboardImpactService(
      { activity: { findMany } } as never,
      new ActivityClosurePolicy(),
    );

    const result = await service.getImpact('member-1', undefined, now);

    expect(result.canOffboard).toBe(false);
    expect(result.blockingReasons).toContain('registration-cleanup-required');
    expect(result.futureRegistrations).toMatchObject([
      {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        hasParticipationEvidence: true,
      },
    ]);
    expect(result.historicalRegistrationsWithEvidence).toMatchObject([
      {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        hasParticipationEvidence: true,
      },
    ]);
    const [query] = findMany.mock.calls[0] as unknown as [
      { select: { registrations: { select: { participationIdentities: unknown } } } },
    ];
    expect(query.select.registrations.select.participationIdentities).toEqual({
      where: {
        memberId: 'member-1',
        currentStatusCode: { in: ['pending', 'waitlisted', 'pass'] },
        session: { deletedAt: null, statusCode: 'scheduled', endAt: { gte: now } },
      },
      take: 1,
      select: { id: true },
    });
  });

  it('retains the historical-only result when no future identity is returned', async () => {
    const service = new ActivityMemberOffboardImpactService(
      { activity: { findMany: jest.fn().mockResolvedValue([activity([])]) } } as never,
      new ActivityClosurePolicy(),
    );
    const result = await service.getImpact('member-1', undefined, now);
    expect(result.canOffboard).toBe(true);
    expect(result.futureRegistrations).toEqual([]);
    expect(result.historicalRegistrationsWithEvidence).toHaveLength(1);
  });
});

import type { Prisma } from '@prisma/client';
import { AttendanceAccessService } from './attendance-access.service';
import {
  PARTICIPATION_SEGMENT_FACADE_LIMITS,
  ParticipationSegmentFacade,
} from './participation-segment.facade';

describe('ParticipationSegmentFacade', () => {
  const access = { lockActivityForAttendanceWrite: jest.fn().mockResolvedValue(undefined) };
  const service = new ParticipationSegmentFacade(access as unknown as AttendanceAccessService);

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'segment',
      participationIdentityId: 'identity',
      segmentKey: 'segment-key',
      revision: 1,
      sourceCheckInEventId: 'check-in',
      sourceCloseEventId: null,
      resultCode: 'valid',
      statusCode: 'draft',
      checkInAt: new Date('2026-09-01T01:00:00.000Z'),
      checkOutAt: null,
      lateFlag: false,
      earlyLeaveFlag: false,
      exceptionFlagsJson: null,
      identity: {
        id: 'identity',
        activityId: 'activity',
        sessionId: 'session',
        memberId: 'member',
      },
      sourceCheckInEvent: {
        id: 'check-in',
        activityId: 'activity',
        sessionId: 'session',
        participationIdentityId: 'identity',
        memberId: 'member',
        positionId: 'historic-position',
      },
      sourceCloseEvent: null,
      ...overrides,
    };
  }

  function forIdentity(identityId: string) {
    return row({
      id: `segment-${identityId}`,
      participationIdentityId: identityId,
      identity: {
        id: identityId,
        activityId: 'activity',
        sessionId: 'session',
        memberId: `member-${identityId}`,
      },
      sourceCheckInEvent: {
        id: `check-in-${identityId}`,
        activityId: 'activity',
        sessionId: 'session',
        participationIdentityId: identityId,
        memberId: `member-${identityId}`,
        positionId: null,
      },
      sourceCheckInEventId: `check-in-${identityId}`,
    });
  }

  function fixture(rows: unknown[] = []) {
    const db = {
      participantServiceSegmentRevision: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    return { db, tx: db as unknown as Prisma.TransactionClient };
  }

  it('exposes only the D3 narrow activity lock bridge', async () => {
    const tx = {} as Prisma.TransactionClient;
    await service.lockActivityForTimeAllocationWrite(tx, 'activity');
    expect(access.lockActivityForAttendanceWrite).toHaveBeenCalledWith('activity', tx);
  });

  it('uses the supplied transaction and the exact bounded current projection', async () => {
    const f = fixture();

    await expect(service.readActivityCurrentSegmentsTrusted(f.tx, 'activity')).resolves.toEqual([]);

    expect(f.db.participantServiceSegmentRevision.findMany).toHaveBeenCalledWith({
      where: {
        identity: { activityId: 'activity' },
        statusCode: { not: 'superseded' },
      },
      take: 10001,
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }, { revision: 'asc' }],
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        sourceCheckInEventId: true,
        sourceCloseEventId: true,
        resultCode: true,
        statusCode: true,
        checkInAt: true,
        checkOutAt: true,
        lateFlag: true,
        earlyLeaveFlag: true,
        exceptionFlagsJson: true,
        identity: {
          select: { id: true, activityId: true, sessionId: true, memberId: true },
        },
        sourceCheckInEvent: {
          select: {
            id: true,
            activityId: true,
            sessionId: true,
            participationIdentityId: true,
            memberId: true,
            positionId: true,
          },
        },
        sourceCloseEvent: {
          select: {
            id: true,
            activityId: true,
            sessionId: true,
            participationIdentityId: true,
            memberId: true,
          },
        },
      },
    });
  });

  it('rejects an empty activity before issuing a query', async () => {
    const f = fixture();

    await expect(service.readActivityCurrentSegmentsTrusted(f.tx, '')).rejects.toThrow(TypeError);

    expect(f.db.participantServiceSegmentRevision.findMany).not.toHaveBeenCalled();
  });

  it('keeps exact segment and identity limits but rejects cap plus one without truncation', async () => {
    const segmentRows = Array.from(
      { length: PARTICIPATION_SEGMENT_FACADE_LIMITS.segments },
      (_, index) =>
        row({
          id: `segment-${index}`,
          segmentKey: `segment-${index}`,
        }),
    );
    const f = fixture(segmentRows);

    await expect(
      service.readActivityCurrentSegmentsTrusted(f.tx, 'activity'),
    ).resolves.toHaveLength(PARTICIPATION_SEGMENT_FACADE_LIMITS.segments);

    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      ...segmentRows,
      row({ id: 'cap-plus-one', segmentKey: 'cap-plus-one' }),
    ]);
    await expect(service.readActivityCurrentSegmentsTrusted(f.tx, 'activity')).rejects.toThrow(
      RangeError,
    );

    const identityRows = Array.from(
      { length: PARTICIPATION_SEGMENT_FACADE_LIMITS.identities },
      (_, index) => forIdentity(String(index)),
    );
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue(identityRows);
    await expect(
      service.readActivityCurrentSegmentsTrusted(f.tx, 'activity'),
    ).resolves.toHaveLength(PARTICIPATION_SEGMENT_FACADE_LIMITS.identities);

    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      ...identityRows,
      forIdentity('cap-plus-one'),
    ]);
    await expect(service.readActivityCurrentSegmentsTrusted(f.tx, 'activity')).rejects.toThrow(
      RangeError,
    );
  });

  it('preserves the database order, current state distinctions and open segments', async () => {
    const f = fixture([
      row({
        id: 'draft-valid',
        segmentKey: 'alpha',
        resultCode: 'valid',
        statusCode: 'draft',
        checkOutAt: null,
      }),
      row({
        id: 'committed-early',
        segmentKey: 'beta',
        resultCode: 'early_departure_zero',
        statusCode: 'committed',
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'close',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
        },
        checkOutAt: new Date('2026-09-01T02:00:00.000Z'),
      }),
      row({ id: 'voided', segmentKey: 'gamma', resultCode: 'voided' }),
      row({ id: 'replaced', segmentKey: 'omega', resultCode: 'replaced' }),
    ]);

    const result = await service.readActivityCurrentSegmentsTrusted(f.tx, 'activity');

    expect(result.map((item) => item.id)).toEqual([
      'draft-valid',
      'committed-early',
      'voided',
      'replaced',
    ]);
    expect(result.map((item) => [item.resultCode, item.statusCode])).toEqual([
      ['valid', 'draft'],
      ['early_departure_zero', 'committed'],
      ['voided', 'draft'],
      ['replaced', 'draft'],
    ]);
    expect(result[0].checkOutAt).toBeNull();
  });

  it('uses the historic check-in position and does not expose the raw relation', async () => {
    const f = fixture([
      row({
        identity: {
          id: 'identity',
          activityId: 'activity',
          sessionId: 'session',
          memberId: 'member',
          currentPositionId: 'current-position',
        },
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
          positionId: 'historic-position',
        },
      }),
    ]);

    const [result] = await service.readActivityCurrentSegmentsTrusted(f.tx, 'activity');

    expect(result.sourcePositionId).toBe('historic-position');
    expect(result).not.toHaveProperty('sourceCheckInEvent');
    expect(result).not.toHaveProperty('serviceHours');
  });

  it('does not impose event-type, event-time or close-anchor pairing rules on persisted replace facts', async () => {
    const f = fixture([
      row({
        resultCode: 'replaced',
        checkOutAt: new Date('2099-01-01T00:00:00.000Z'),
        sourceCloseEventId: null,
        sourceCloseEvent: null,
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
          positionId: null,
          eventTypeCode: 'replace',
          occurredAt: new Date('2000-01-01T00:00:00.000Z'),
        },
      }),
    ]);

    await expect(
      service.readActivityCurrentSegmentsTrusted(f.tx, 'activity'),
    ).resolves.toHaveLength(1);
  });

  it.each([
    ['identity id', row({ participationIdentityId: 'other-identity' })],
    [
      'identity activity',
      row({
        identity: { id: 'identity', activityId: 'other', sessionId: 'session', memberId: 'member' },
      }),
    ],
    [
      'empty identity session',
      row({
        identity: { id: 'identity', activityId: 'activity', sessionId: '', memberId: 'member' },
      }),
    ],
    [
      'empty identity member',
      row({
        identity: { id: 'identity', activityId: 'activity', sessionId: 'session', memberId: '' },
      }),
    ],
    ['unknown status', row({ statusCode: 'superseded' })],
    ['unknown result', row({ resultCode: 'unknown' })],
    ['missing check-in relation', row({ sourceCheckInEvent: null })],
    [
      'check-in id',
      row({
        sourceCheckInEvent: {
          id: 'other',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
          positionId: null,
        },
      }),
    ],
    [
      'check-in activity',
      row({
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'other',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
          positionId: null,
        },
      }),
    ],
    [
      'check-in session',
      row({
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'activity',
          sessionId: 'other',
          participationIdentityId: 'identity',
          memberId: 'member',
          positionId: null,
        },
      }),
    ],
    [
      'check-in identity',
      row({
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'other',
          memberId: 'member',
          positionId: null,
        },
      }),
    ],
    [
      'check-in member',
      row({
        sourceCheckInEvent: {
          id: 'check-in',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'other',
          positionId: null,
        },
      }),
    ],
    ['missing close relation', row({ sourceCloseEventId: 'close', sourceCloseEvent: null })],
    [
      'close id',
      row({
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'other',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
        },
      }),
    ],
    [
      'close activity',
      row({
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'close',
          activityId: 'other',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'member',
        },
      }),
    ],
    [
      'close session',
      row({
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'close',
          activityId: 'activity',
          sessionId: 'other',
          participationIdentityId: 'identity',
          memberId: 'member',
        },
      }),
    ],
    [
      'close identity',
      row({
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'close',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'other',
          memberId: 'member',
        },
      }),
    ],
    [
      'close member',
      row({
        sourceCloseEventId: 'close',
        sourceCloseEvent: {
          id: 'close',
          activityId: 'activity',
          sessionId: 'session',
          participationIdentityId: 'identity',
          memberId: 'other',
        },
      }),
    ],
  ])('fails closed for a bad %s chain', async (_name, invalidRow) => {
    const f = fixture([invalidRow]);

    await expect(service.readActivityCurrentSegmentsTrusted(f.tx, 'activity')).rejects.toThrow(
      TypeError,
    );
  });
});

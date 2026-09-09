import type { Prisma } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttendanceSegmentProjectorService } from './attendance-segment-projector.service';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';

describe('C3-1 complete current participation source', () => {
  function fixture() {
    const gate = { isV11Enabled: jest.fn().mockReturnValue(true) };
    const owner = {
      readActivityPunchProjectionInputTrusted: jest.fn().mockResolvedValue([]),
      readCommittedCorrectionAnchorsTrusted: jest.fn().mockResolvedValue([]),
    };
    const db = {
      activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity' }) },
      participantServiceSegmentRevision: { findMany: jest.fn().mockResolvedValue([]) },
      activityParticipationIdentity: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const tx = db as unknown as Prisma.TransactionClient;
    const service = new ActivityMetricCandidateSourceQuery(
      gate as unknown as ActivityWorkflowGate,
      owner,
      new AttendanceSegmentProjectorService(),
    );
    const run = () => service.readTrusted(tx, 'activity');
    const identity = {
      id: 'identity',
      activityId: 'activity',
      sessionId: 'session',
      memberId: 'member',
      session: {
        id: 'session',
        activityId: 'activity',
        deletedAt: null,
        startAt: new Date(0),
        endAt: new Date(3600000),
        lateGraceMinutes: 15,
        earlyLeaveThresholdMinutes: 15,
      },
    };
    const segment = {
      id: 'segment',
      participationIdentityId: 'identity',
      segmentKey: 'seg_0001',
      revision: 1,
      resultCode: 'valid',
      statusCode: 'draft',
      checkInAt: new Date(0),
      checkOutAt: new Date(3600000),
      baseRevisionId: null,
      effectiveBatchId: null,
      baseRevision: null,
      effectiveBatch: null,
      identity,
    };
    const events = [
      {
        id: 'in',
        activityId: 'activity',
        sessionId: 'session',
        participationIdentityId: 'identity',
        eventTypeCode: 'check_in',
        occurredAt: new Date(0),
        supersedesEventId: null,
      },
      {
        id: 'out',
        activityId: 'activity',
        sessionId: 'session',
        participationIdentityId: 'identity',
        eventTypeCode: 'check_out',
        occurredAt: new Date(3600000),
        supersedesEventId: null,
      },
    ];
    // Obtain the established projector's real key instead of inventing a key convention.
    segment.segmentKey = new AttendanceSegmentProjectorService().rebuild(events, {
      sessionStartAt: identity.session.startAt,
      sessionEndAt: identity.session.endAt,
      lateGraceMinutes: 15,
      earlyLeaveThresholdMinutes: 15,
    }).segments[0].segmentKey;
    const populate = () => {
      db.participantServiceSegmentRevision.findMany.mockResolvedValue([segment]);
      db.activityParticipationIdentity.findMany.mockResolvedValue([identity]);
      owner.readActivityPunchProjectionInputTrusted.mockResolvedValue(events);
    };
    return { gate, owner, db, tx, service, run, identity, segment, events, populate };
  }
  it('rejects a closed Gate without looking at data', async () => {
    const f = fixture();
    f.gate.isV11Enabled.mockReturnValue(false);
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE),
    );
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
  });
  it('proves an empty activity using the event owner instead of assuming no segments means zero', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ sources: [] });
    expect(f.owner.readActivityPunchProjectionInputTrusted).toHaveBeenCalledWith(
      f.tx,
      'activity',
      20000,
    );
    expect(f.db.participantServiceSegmentRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { identity: { activityId: 'activity' }, statusCode: { in: ['draft', 'committed'] } },
        take: 10001,
        orderBy: { id: 'asc' },
      }),
    );
  });
  it('returns persisted-source inputs only after matching the real event projection', async () => {
    const f = fixture();
    f.populate();
    const result = await f.run();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ sourceRevisionId: 'segment', memberGroupOrdinal: 0 });
    expect(JSON.stringify(result)).not.toContain('"memberId"');
  });
  it('rejects an event chain with a missing materialized segment', async () => {
    const f = fixture();
    f.populate();
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([]);
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE),
    );
  });
  it('rejects a projection that has not caught up to changed punches', async () => {
    const f = fixture();
    f.populate();
    f.owner.readActivityPunchProjectionInputTrusted.mockResolvedValue([
      f.events[0],
      { ...f.events[1], occurredAt: new Date(7200000) },
    ]);
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE),
    );
  });
  it('rejects open intervals without substituting a clock or session end', async () => {
    const f = fixture();
    f.populate();
    f.owner.readActivityPunchProjectionInputTrusted.mockResolvedValue([f.events[0]]);
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE),
    );
  });
  it('requires valid effective batch anchors for committed segments', async () => {
    const f = fixture();
    f.populate();
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      { ...f.segment, statusCode: 'committed' },
    ]);
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE),
    );
  });
  it('accepts a correctly anchored committed segment without changing its source digest', async () => {
    const f = fixture();
    f.populate();
    const draft = await f.run();
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      {
        ...f.segment,
        statusCode: 'committed',
        effectiveBatchId: 'batch',
        effectiveBatch: {
          id: 'batch',
          statusCode: 'committed',
          settlementRunId: 'run',
          settlementVersionId: 'version',
          settlementRun: { activityId: 'activity' },
          settlementVersion: { settlementRunId: 'run' },
        },
      },
    ]);
    expect((await f.run()).sourceDigest).toBe(draft.sourceDigest);
  });
  it('accepts a committed correction only with its exact predecessor and applied correction chain', async () => {
    const f = fixture();
    f.populate();
    const prior = await f.run();
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      {
        ...f.segment,
        id: 'corrected-segment',
        revision: 2,
        statusCode: 'committed',
        baseRevisionId: 'prior-segment',
        baseRevision: {
          id: 'prior-segment',
          participationIdentityId: f.identity.id,
          segmentKey: f.segment.segmentKey,
          revision: 1,
        },
        effectiveBatchId: 'batch',
        effectiveBatch: {
          id: 'batch',
          statusCode: 'committed',
          settlementRunId: 'run',
          settlementVersionId: 'version',
          settlementRun: { activityId: 'activity' },
          settlementVersion: { settlementRunId: 'run' },
        },
      },
    ]);
    f.owner.readCommittedCorrectionAnchorsTrusted.mockResolvedValue([
      {
        statusCode: 'committed',
        newPostingBatchId: 'batch',
        newSettlementVersionId: 'version',
        correctionRequest: { statusCode: 'applied', settlementRunId: 'run' },
      },
    ]);

    const corrected = await f.run();
    expect(corrected.sources).toMatchObject([{ sourceRevisionId: 'corrected-segment' }]);
    expect(corrected.sourceDigest).not.toBe(prior.sourceDigest);
  });
  it('still rejects a stale draft projection beside an otherwise valid committed correction', async () => {
    const f = fixture();
    f.populate();
    f.db.participantServiceSegmentRevision.findMany.mockResolvedValue([
      {
        ...f.segment,
        id: 'corrected-segment',
        revision: 2,
        statusCode: 'committed',
        baseRevisionId: 'prior-segment',
        baseRevision: {
          id: 'prior-segment',
          participationIdentityId: f.identity.id,
          segmentKey: f.segment.segmentKey,
          revision: 1,
        },
        effectiveBatchId: 'batch',
        effectiveBatch: {
          id: 'batch',
          statusCode: 'committed',
          settlementRunId: 'run',
          settlementVersionId: 'version',
          settlementRun: { activityId: 'activity' },
          settlementVersion: { settlementRunId: 'run' },
        },
      },
      { ...f.segment, id: 'draft-segment', segmentKey: 'stale-draft-segment' },
    ]);
    f.owner.readCommittedCorrectionAnchorsTrusted.mockResolvedValue([
      {
        statusCode: 'committed',
        newPostingBatchId: 'batch',
        newSettlementVersionId: 'version',
        correctionRequest: { statusCode: 'applied', settlementRunId: 'run' },
      },
    ]);

    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE),
    );
  });
  it('maps source limits separately from incomplete data and preserves infrastructure errors', async () => {
    const f = fixture();
    f.owner.readActivityPunchProjectionInputTrusted.mockRejectedValue(new RangeError('limit'));
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED),
    );
    const failure = new Error('test connection failure');
    f.owner.readActivityPunchProjectionInputTrusted.mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure);
  });
});

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttendanceMetricSourceQueryService } from '../attendances/attendance-metric-source-query.service';
import { AttendanceSegmentProjectorService } from './attendance-segment-projector.service';
import {
  fingerprintMetricCandidateSources,
  METRIC_CANDIDATE_LIMITS,
  METRIC_SOURCE_MODE,
  METRIC_SOURCE_PROVIDER_VERSION,
  MetricSourceInterval,
  normalizeMetricCandidateSources,
} from './activity-metric-rule';

@Injectable()
export class ActivityMetricCandidateSourceQuery {
  constructor(
    private readonly gate: ActivityWorkflowGate,
    private readonly attendance: AttendanceMetricSourceQueryService,
    private readonly projector: AttendanceSegmentProjectorService,
  ) {}

  /** Caller authorizes and holds Activity FOR UPDATE for this entire read and subsequent write. */
  async readTrusted(tx: Prisma.TransactionClient, activityId: string) {
    if (!this.gate.isV11Enabled())
      throw new BizException(BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE);
    try {
      return await this.readSources(tx, activityId);
    } catch (error) {
      if (error instanceof RangeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED);
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE);
      throw error;
    }
  }

  private async readSources(tx: Prisma.TransactionClient, activityId: string) {
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true },
    });
    if (!activity) throw new TypeError('activity source unavailable');
    const segments = await tx.participantServiceSegmentRevision.findMany({
      where: { identity: { activityId }, statusCode: { in: ['draft', 'committed'] } },
      take: METRIC_CANDIDATE_LIMITS.segments + 1,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        resultCode: true,
        statusCode: true,
        checkInAt: true,
        checkOutAt: true,
        baseRevisionId: true,
        effectiveBatchId: true,
        baseRevision: {
          select: { id: true, participationIdentityId: true, segmentKey: true, revision: true },
        },
        identity: { select: { id: true, activityId: true, sessionId: true, memberId: true } },
        effectiveBatch: {
          select: {
            id: true,
            statusCode: true,
            settlementRunId: true,
            settlementVersionId: true,
            settlementRun: { select: { activityId: true } },
            settlementVersion: { select: { settlementRunId: true } },
          },
        },
      },
    });
    if (segments.length > METRIC_CANDIDATE_LIMITS.segments)
      throw new RangeError('metric segment limit exceeded');
    const events = await this.attendance.readActivityPunchProjectionInputTrusted(
      tx,
      activityId,
      METRIC_CANDIDATE_LIMITS.events,
    );
    const identityIds = [
      ...new Set([
        ...segments.map((s) => s.participationIdentityId),
        ...events.map((e) => e.participationIdentityId),
      ]),
    ];
    // Both upstream lists are bounded. Do not enumerate unbounded registrations/history.
    const identities = identityIds.length
      ? await tx.activityParticipationIdentity.findMany({
          where: { id: { in: identityIds }, activityId },
          take: identityIds.length + 1,
          select: {
            id: true,
            memberId: true,
            activityId: true,
            sessionId: true,
            session: {
              select: {
                id: true,
                activityId: true,
                deletedAt: true,
                startAt: true,
                endAt: true,
                lateGraceMinutes: true,
                earlyLeaveThresholdMinutes: true,
              },
            },
          },
        })
      : [];
    if (identities.length !== identityIds.length) throw new TypeError('missing metric identity');
    const byIdentity = new Map(identities.map((identity) => [identity.id, identity]));
    for (const identity of identities) {
      if (
        !identity.memberId ||
        identity.activityId !== activityId ||
        identity.session.id !== identity.sessionId ||
        identity.session.activityId !== activityId ||
        identity.session.deletedAt !== null
      )
        throw new TypeError('invalid metric identity/session chain');
    }
    const eventsByIdentity = new Map<string, typeof events>();
    for (const event of events) {
      const identity = byIdentity.get(event.participationIdentityId);
      if (!identity || event.sessionId !== identity.sessionId)
        throw new TypeError('invalid metric event identity chain');
      const list = eventsByIdentity.get(identity.id) ?? [];
      list.push(event);
      eventsByIdentity.set(identity.id, list);
    }
    const batchIds = [
      ...new Set(
        segments.flatMap((s) =>
          s.statusCode === 'committed' && s.effectiveBatchId ? [s.effectiveBatchId] : [],
        ),
      ),
    ];
    const corrections = await this.attendance.readCommittedCorrectionAnchorsTrusted(
      tx,
      activityId,
      batchIds,
    );
    const byBatch = new Map(corrections.map((c) => [c.newPostingBatchId, c]));
    const segmentsByIdentity = new Map<string, typeof segments>();
    for (const segment of segments) {
      const list = segmentsByIdentity.get(segment.participationIdentityId) ?? [];
      if (list.some((other) => other.segmentKey === segment.segmentKey))
        throw new TypeError('duplicate current metric segment');
      list.push(segment);
      segmentsByIdentity.set(segment.participationIdentityId, list);
      if (segment.statusCode === 'committed') {
        const batch = segment.effectiveBatch;
        if (
          !batch ||
          batch.id !== segment.effectiveBatchId ||
          batch.statusCode !== 'committed' ||
          batch.settlementRun.activityId !== activityId ||
          batch.settlementVersion.settlementRunId !== batch.settlementRunId
        )
          throw new TypeError('invalid committed metric batch');
        const correction = byBatch.get(batch.id);
        if (correction) {
          if (
            correction.statusCode !== 'committed' ||
            correction.correctionRequest.statusCode !== 'applied' ||
            correction.correctionRequest.settlementRunId !== batch.settlementRunId ||
            correction.newSettlementVersionId !== batch.settlementVersionId
          )
            throw new TypeError('invalid committed metric correction');
          const base = segment.baseRevision;
          if (
            !base ||
            base.id !== segment.baseRevisionId ||
            base.participationIdentityId !== segment.participationIdentityId ||
            base.segmentKey !== segment.segmentKey ||
            base.revision + 1 !== segment.revision
          )
            throw new TypeError('invalid corrected metric segment predecessor');
        }
      }
    }
    for (const identity of identities) {
      const current = segmentsByIdentity.get(identity.id) ?? [];
      const projected = this.projector.rebuild(eventsByIdentity.get(identity.id) ?? [], {
        sessionStartAt: identity.session.startAt,
        sessionEndAt: identity.session.endAt,
        lateGraceMinutes: identity.session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: identity.session.earlyLeaveThresholdMinutes,
      });
      const hasFormalCorrection = current.some(
        (s) =>
          s.statusCode === 'committed' && s.effectiveBatchId && byBatch.has(s.effectiveBatchId),
      );
      // A committed correction is authoritative, not a request to undo it by replaying old punches.
      // Draft projection must still be checked even when other segments have a formal correction.
      if (!hasFormalCorrection || current.some((s) => s.statusCode === 'draft')) {
        if (projected.chainAnomalies.length || projected.segments.some((s) => !s.checkOutAt))
          throw new TypeError('unclosed or anomalous metric event chain');
        const expected = new Map(projected.segments.map((s) => [s.segmentKey, s]));
        for (const segment of current.filter((s) => s.statusCode === 'draft')) {
          if (segment.resultCode === 'voided' || segment.resultCode === 'replaced') continue;
          const source = expected.get(segment.segmentKey);
          if (
            !source ||
            source.resultCode !== segment.resultCode ||
            source.checkInAt.getTime() !== segment.checkInAt.getTime() ||
            source.checkOutAt?.getTime() !== segment.checkOutAt?.getTime()
          )
            throw new TypeError('metric segment projection is not current');
        }
        for (const source of projected.segments) {
          if (
            !current.some(
              (s) =>
                s.segmentKey === source.segmentKey &&
                (s.resultCode === 'valid' || s.resultCode === 'early_departure_zero'),
            )
          )
            throw new TypeError('metric event projection has missing segments');
        }
      }
    }
    const intervals: MetricSourceInterval[] = [];
    for (const segment of segments) {
      if (segment.resultCode === 'voided' || segment.resultCode === 'replaced') continue;
      if (
        (segment.resultCode !== 'valid' && segment.resultCode !== 'early_departure_zero') ||
        !segment.checkOutAt ||
        segment.checkOutAt.getTime() < segment.checkInAt.getTime()
      )
        throw new TypeError('unclosed or invalid metric interval');
      if (segment.checkOutAt.getTime() === segment.checkInAt.getTime()) continue;
      intervals.push({
        sourceRevisionId: segment.id,
        identityId: segment.participationIdentityId,
        sessionId: segment.identity.sessionId,
        memberId: segment.identity.memberId,
        checkInAt: segment.checkInAt,
        checkOutAt: segment.checkOutAt,
        resultCode: segment.resultCode,
      });
    }
    const sources = normalizeMetricCandidateSources(intervals);
    return {
      sourceMode: METRIC_SOURCE_MODE,
      providerVersion: METRIC_SOURCE_PROVIDER_VERSION,
      sources,
      ...fingerprintMetricCandidateSources(activityId, sources),
    };
  }
}

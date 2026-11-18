import { Injectable } from '@nestjs/common';
import { Prisma, type TeamJoinContributionMilestone } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type {
  NotificationOutboxEnqueueInput,
  TargetedNotificationOutboxPayload,
} from '../notifications/notification-outbox.types';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_RECRUITMENT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { APP_STATUS_JOINING, CONTRIBUTION_THRESHOLD } from '../team-join/team-join.constants';
import { computeContributionBatch } from '../team-join/team-join-progress';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { LedgerQueryService } from './ledger-query.service';

interface MilestoneApplication {
  id: string;
  memberId: string;
  cycleId: string;
  contributionNoticeProtocol: number | null;
  cycle: { year: number };
}

export interface ContributionMilestoneSnapshot extends MilestoneApplication {
  beforePoints: Prisma.Decimal;
}

function invariant(): never {
  // Do not include application data, payloads or SQL in error messages.
  throw new Error('CONTRIBUTION_MILESTONE_INVARIANT');
}

function assertPoints(points: Prisma.Decimal | undefined): asserts points is Prisma.Decimal {
  if (!Prisma.Decimal.isDecimal(points) || !points.isFinite()) invariant();
}

function intentFor(application: MilestoneApplication): NotificationOutboxEnqueueInput {
  const threshold = CONTRIBUTION_THRESHOLD.toString();
  return {
    eventKey: `team-join-contribution-met:${application.id}:${threshold}`,
    eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      recipientMemberId: application.memberId,
      notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
      title: '入队贡献值已达标',
      body: `您的贡献值已达到入队要求（${threshold} 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。`,
      channels: [NOTIFICATION_CHANNEL_IN_APP],
    } satisfies TargetedNotificationOutboxPayload,
    aggregateType: 'team_join_application',
    aggregateId: application.id,
    destinationType: 'member',
    destinationRef: application.memberId,
  };
}

function intentHash(application: MilestoneApplication): string {
  return createHash('sha256')
    .update(JSON.stringify(intentFor(application)))
    .digest('hex');
}

@Injectable()
export class ContributionMilestoneRecorder {
  constructor(
    private readonly outbox: NotificationOutboxService,
    private readonly gate: ActivityWorkflowGate,
  ) {}

  /**
   * Caller holds the existing sorted member locks. App row locks additionally
   * serialize cycle edits (which lock live applications before changing a cycle).
   * No independent transaction, queue, timer or permission cache.
   */
  async captureBefore(
    tx: Prisma.TransactionClient,
    lockedMemberIds: readonly string[],
  ): Promise<ContributionMilestoneSnapshot[]> {
    if (lockedMemberIds.length === 0) return [];
    if (this.gate.participationReadSource() !== 'committed-ledger') invariant();
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a.id FROM public.team_join_applications a
      WHERE a."memberId" IN (${Prisma.join([...new Set(lockedMemberIds)].sort())})
        AND a."statusCode" = ${APP_STATUS_JOINING} AND a."deletedAt" IS NULL
      ORDER BY a.id FOR SHARE OF a
    `;
    if (locked.length === 0) return [];
    const applications = await tx.teamJoinApplication.findMany({
      where: notDeletedWhere({
        id: { in: locked.map((row) => row.id) },
        statusCode: APP_STATUS_JOINING,
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        memberId: true,
        cycleId: true,
        contributionNoticeProtocol: true,
        cycle: { select: { year: true } },
      },
    });
    const byMember = new Map<string, MilestoneApplication>();
    for (const application of applications) {
      if (!byMember.has(application.memberId)) byMember.set(application.memberId, application);
    }
    const candidates = [...byMember.values()];
    const points = await this.pointsByApplication(tx, candidates);
    return candidates.map((application) => {
      const beforePoints = points.get(application.id);
      assertPoints(beforePoints);
      if (![null, 1].includes(application.contributionNoticeProtocol)) invariant();
      return { ...application, beforePoints };
    });
  }

  /** Runs after ready -> committed, still inside the caller's uncommitted tx. */
  async recordAfter(
    tx: Prisma.TransactionClient,
    postingBatchId: string,
    snapshots: readonly ContributionMilestoneSnapshot[],
  ): Promise<void> {
    const snapshotInput: unknown = snapshots;
    if (!Array.isArray(snapshotInput)) invariant();
    if (snapshots.length === 0) return;
    if (new Set(snapshots.map((row) => row.id)).size !== snapshots.length) invariant();
    for (const snapshot of snapshots) {
      assertPoints(snapshot.beforePoints);
      if (![null, 1].includes(snapshot.contributionNoticeProtocol)) invariant();
    }
    const after = await this.pointsByApplication(tx, snapshots);
    const crossings = snapshots.filter((snapshot) => {
      const points = after.get(snapshot.id);
      assertPoints(points);
      return snapshot.beforePoints.lt(CONTRIBUTION_THRESHOLD) && points.gte(CONTRIBUTION_THRESHOLD);
    });
    if (crossings.length === 0) return;
    const existing = await tx.teamJoinContributionMilestone.findMany({
      where: {
        applicationId: { in: crossings.map((row) => row.id) },
        threshold: CONTRIBUTION_THRESHOLD.toNumber(),
      },
    });
    const existingByApplication = new Map(existing.map((row) => [row.applicationId, row]));
    const fresh = crossings.filter((snapshot) => {
      const recorded = existingByApplication.get(snapshot.id);
      if (!recorded) return true;
      this.assertRecordedSemantics(recorded, snapshot);
      return false;
    });
    if (fresh.length === 0) return;
    const entries = await tx.participationLedgerEntry.groupBy({
      by: ['memberId'],
      where: { postingBatchId, memberId: { in: fresh.map((row) => row.memberId) } },
      _min: { id: true },
    });
    const entryByMember = new Map(entries.map((row) => [row.memberId, row._min.id]));
    const intents: NotificationOutboxEnqueueInput[] = [];
    const facts: Prisma.TeamJoinContributionMilestoneCreateManyInput[] = [];
    for (const snapshot of fresh) {
      const sourceEntryId = entryByMember.get(snapshot.memberId);
      if (!sourceEntryId) invariant();
      const intent = snapshot.contributionNoticeProtocol === 1 ? intentFor(snapshot) : null;
      if (intent) {
        intents.push(intent);
      }
      facts.push({
        applicationId: snapshot.id,
        memberId: snapshot.memberId,
        cycleId: snapshot.cycleId,
        cycleYear: snapshot.cycle.year,
        threshold: CONTRIBUTION_THRESHOLD.toNumber(),
        sourceEntryId,
        postingBatchId,
        beforePoints: snapshot.beforePoints,
        afterPoints: after.get(snapshot.id)!,
        outcomeCode: intent ? 'notice_registered' : 'history_pending',
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        intentId: null,
        payloadHash: intent ? intentHash(snapshot) : null,
      });
    }
    // Fresh-only mode rejects pre-existing or racing intents, including equal
    // payloads. Never absorb a unique conflict and certify an unrelated intent.
    const enqueued = await this.outbox.enqueueMany(intents, tx, true);
    const intentByApplication = new Map(enqueued.map((row) => [row.aggregateId, row.id]));
    for (const fact of facts) {
      if (fact.outcomeCode !== 'notice_registered') continue;
      const intentId = intentByApplication.get(fact.applicationId);
      if (!intentId) invariant();
      fact.intentId = intentId;
    }
    await tx.teamJoinContributionMilestone.createMany({ data: facts });
  }

  private assertRecordedSemantics(
    row: TeamJoinContributionMilestone,
    snapshot: ContributionMilestoneSnapshot,
  ): void {
    assertPoints(row.beforePoints);
    assertPoints(row.afterPoints);
    const native = snapshot.contributionNoticeProtocol === 1;
    if (
      row.applicationId !== snapshot.id ||
      row.memberId !== snapshot.memberId ||
      row.cycleId !== snapshot.cycleId ||
      row.threshold !== CONTRIBUTION_THRESHOLD.toNumber() ||
      row.payloadVersion !== OUTBOX_PAYLOAD_VERSION ||
      !row.beforePoints.lt(CONTRIBUTION_THRESHOLD) ||
      !row.afterPoints.gte(CONTRIBUTION_THRESHOLD) ||
      (native
        ? row.outcomeCode !== 'notice_registered' ||
          !row.intentId ||
          row.payloadHash !== intentHash(snapshot)
        : row.outcomeCode !== 'history_pending' ||
          row.intentId !== null ||
          row.payloadHash !== null)
    )
      invariant();
    // The original cutoff, before/after values and source batch remain history.
    // A recrossing does not rewrite them, retract a receipt or recreate an outbox.
  }

  private async pointsByApplication(
    tx: Prisma.TransactionClient,
    applications: readonly MilestoneApplication[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const byYear = new Map<number, MilestoneApplication[]>();
    for (const application of applications) {
      if (!Number.isInteger(application.cycle.year)) invariant();
      const group = byYear.get(application.cycle.year) ?? [];
      group.push(application);
      byYear.set(application.cycle.year, group);
    }
    const result = new Map<string, Prisma.Decimal>();
    for (const [year, group] of byYear) {
      const computed = await computeContributionBatch(
        tx,
        group.map((row) => row.memberId),
        year,
        this.gate,
        LedgerQueryService,
      );
      for (const application of group) {
        const points = computed.get(application.memberId)?.points;
        assertPoints(points);
        result.set(application.id, points);
      }
    }
    return result;
  }
}

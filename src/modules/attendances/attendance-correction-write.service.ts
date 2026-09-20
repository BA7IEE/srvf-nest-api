import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';

const correctionRequestLockedSelect = {
  id: true,
  version: true,
  activityId: true,
  settlementRunId: true,
  participationIdentityId: true,
  baseSettlementVersionId: true,
  baseResultRevisionId: true,
  baseClosureRevision: true,
  requestedChangeJson: true,
  statusCode: true,
  submittedByUserId: true,
  reviewedByUserId: true,
  reviewNote: true,
  operationKey: true,
  requestHash: true,
  resubmittedFromRequestId: true,
} satisfies Prisma.AttendanceCorrectionRequestSelect;

export type LockedAttendanceCorrectionRequest = Prisma.AttendanceCorrectionRequestGetPayload<{
  select: typeof correctionRequestLockedSelect;
}>;

export interface CreateAttendanceCorrectionRequestInput {
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly participationIdentityId: string | null;
  readonly baseSettlementVersionId: string;
  readonly baseResultRevisionId: string | null;
  readonly baseClosureRevision: number;
  readonly requestTypeCode: string;
  readonly requestedChangeJson: Prisma.InputJsonValue;
  readonly reason: string;
  readonly attachmentIds?: readonly string[];
  readonly submittedByUserId: string;
  readonly submittedAt: Date;
  readonly operationKey: string;
  readonly requestHash: string;
  readonly resubmittedFromRequestId?: string;
}

export interface ReviewAttendanceCorrectionRequestInput {
  readonly correctionRequestId: string;
  readonly statusCode: string;
  readonly reviewedByUserId: string;
  readonly reviewedAt: Date;
  readonly reviewNote: string | null;
}

export interface CreateCorrectionApplicationInput {
  readonly correctionRequestId: string;
  readonly newSettlementVersionId: string;
  readonly newResultRevisionIds: readonly string[];
  readonly newPostingBatchId: string;
}

/**
 * Attendance-owned write boundary for the two fact-correction aggregates.
 *
 * The caller owns authorization, aggregate locks, ordering, and the enclosing
 * transaction. Each public mutator still asks the shared v1.1 cutover gate so
 * this ownership boundary cannot bypass the settlement-write switch. This
 * service deliberately has no PrismaService and never opens a transaction: it
 * only keeps `AttendanceCorrectionRequest` and `CorrectionApplication`
 * mutations at their declared owner.
 */
@Injectable()
export class AttendanceCorrectionWriteService {
  constructor(private readonly activityWorkflowGate: ActivityWorkflowGate) {}

  async createRequest(
    tx: Prisma.TransactionClient,
    input: CreateAttendanceCorrectionRequestInput,
  ): Promise<LockedAttendanceCorrectionRequest> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    return tx.attendanceCorrectionRequest.create({
      data: {
        activityId: input.activityId,
        settlementRunId: input.settlementRunId,
        participationIdentityId: input.participationIdentityId,
        baseSettlementVersionId: input.baseSettlementVersionId,
        baseResultRevisionId: input.baseResultRevisionId,
        baseClosureRevision: input.baseClosureRevision,
        requestTypeCode: input.requestTypeCode,
        requestedChangeJson: input.requestedChangeJson,
        reason: input.reason,
        attachmentIds: input.attachmentIds === undefined ? undefined : [...input.attachmentIds],
        statusCode: 'pending',
        submittedByUserId: input.submittedByUserId,
        submittedAt: input.submittedAt,
        operationKey: input.operationKey,
        requestHash: input.requestHash,
        resubmittedFromRequestId: input.resubmittedFromRequestId,
      },
      select: correctionRequestLockedSelect,
    });
  }

  async voidRequest(tx: Prisma.TransactionClient, correctionRequestId: string): Promise<void> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    await tx.attendanceCorrectionRequest.update({
      where: { id: correctionRequestId },
      data: { statusCode: 'voided', version: { increment: 1 } },
    });
  }

  async reviewRequest(
    tx: Prisma.TransactionClient,
    input: ReviewAttendanceCorrectionRequestInput,
  ): Promise<void> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    await tx.attendanceCorrectionRequest.update({
      where: { id: input.correctionRequestId },
      data: {
        statusCode: input.statusCode,
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
        reviewNote: input.reviewNote,
        version: { increment: 1 },
      },
    });
  }

  async markRequestApplying(
    tx: Prisma.TransactionClient,
    correctionRequestId: string,
  ): Promise<void> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    await tx.attendanceCorrectionRequest.update({
      where: { id: correctionRequestId },
      data: { statusCode: 'applying', version: { increment: 1 } },
    });
  }

  async markRequestApplied(
    tx: Prisma.TransactionClient,
    correctionRequestId: string,
  ): Promise<void> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    await tx.attendanceCorrectionRequest.update({
      where: { id: correctionRequestId },
      data: { statusCode: 'applied', version: { increment: 1 } },
    });
  }

  async createApplication(
    tx: Prisma.TransactionClient,
    input: CreateCorrectionApplicationInput,
  ): Promise<{ id: string }> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    return tx.correctionApplication.create({
      data: {
        correctionRequestId: input.correctionRequestId,
        newSettlementVersionId: input.newSettlementVersionId,
        newResultRevisionIds: [...input.newResultRevisionIds],
        newPostingBatchId: input.newPostingBatchId,
        statusCode: 'preparing',
      },
      select: { id: true },
    });
  }

  async markApplicationCommitted(
    tx: Prisma.TransactionClient,
    correctionApplicationId: string,
  ): Promise<void> {
    this.activityWorkflowGate.assertV11WriteAllowed();
    await tx.correctionApplication.update({
      where: { id: correctionApplicationId },
      data: { statusCode: 'committed' },
    });
  }
}

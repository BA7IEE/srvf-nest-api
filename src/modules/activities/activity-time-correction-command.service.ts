import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  presentActivityTimeCorrectionCommit,
  presentActivityTimeCorrectionPrepare,
  presentActivityTimeCorrectionResubmit,
  presentActivityTimeCorrectionReview,
  presentActivityTimeCorrectionSubmit,
} from './activity-time-correction.presenter';
import {
  type CorrectionApplyInput,
  type CorrectionResubmitOutcome,
  type CorrectionSubmitInput,
  CorrectionApplicationService,
} from './correction-application.service';
import {
  parseCorrectionChangeSet,
  serializeCorrectionChangeSetForHash,
} from './correction-change-set';
import type {
  AppCommitActivityTimeCorrectionDto,
  AppPrepareActivityTimeCorrectionDto,
  AppReviewActivityTimeCorrectionDto,
  AppSubmitActivityTimeCorrectionDto,
} from './dto/app/app-activity-time-correction.dto';

/**
 * App Human command boundary.  It owns client-to-domain mapping and all
 * server-derived hashes; the lower correction service owns lock order,
 * current qualification, replay, and immutable facts.
 */
@Injectable()
export class ActivityTimeCorrectionCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corrections: CorrectionApplicationService,
  ) {}

  async submit(
    activityId: string,
    dto: AppSubmitActivityTimeCorrectionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const input = this.toHumanSubmitInput(activityId, dto, user);
    const result = await this.corrections.submit(input, user, auditMeta, { human: true });
    return presentActivityTimeCorrectionSubmit(result);
  }

  async resubmit(
    activityId: string,
    requestId: string,
    dto: AppSubmitActivityTimeCorrectionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const input = this.toHumanSubmitInput(activityId, dto, user);
    const outcome: CorrectionResubmitOutcome = await this.corrections.resubmit(
      { ...input, resubmittedFromRequestId: requestId },
      user,
      auditMeta,
      { human: true },
    );
    return presentActivityTimeCorrectionResubmit(outcome);
  }

  async review(
    activityId: string,
    requestId: string,
    dto: AppReviewActivityTimeCorrectionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const operationHash = fingerprintMetricEnvelope('attendance-correction-human-review-v1', {
      actorUserId: user.id,
      activityId,
      requestId,
      expectedRequestVersion: dto.expectedRequestVersion,
      actionCode: dto.actionCode,
      note: dto.note ?? null,
    }).definitionHash;
    const outcome = await this.corrections.review(
      { correctionRequestId: requestId, actionCode: dto.actionCode, note: dto.note, operationHash },
      user,
      auditMeta,
      {
        human: true,
        expectedActivityId: activityId,
        expectedRequestVersion: dto.expectedRequestVersion,
      },
    );
    return presentActivityTimeCorrectionReview(outcome);
  }

  async prepare(
    activityId: string,
    requestId: string,
    dto: AppPrepareActivityTimeCorrectionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const operation = this.humanOperation(
      'attendance-correction-human-prepare-v1',
      activityId,
      requestId,
      user,
      dto.operationKey,
      { expectedBaseSettlementVersionId: dto.expectedBaseSettlementVersionId },
    );
    const result = await this.corrections.prepare(operation, user, auditMeta, {
      human: true,
      expectedActivityId: activityId,
      expectedBaseSettlementVersionId: dto.expectedBaseSettlementVersionId,
    });
    const frozen = await this.readPreparedHashes(
      activityId,
      requestId,
      result.correctionApplicationId,
    );
    return presentActivityTimeCorrectionPrepare(result, frozen);
  }

  async commit(
    activityId: string,
    requestId: string,
    dto: AppCommitActivityTimeCorrectionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const operation = this.humanOperation(
      'attendance-correction-human-commit-v1',
      activityId,
      requestId,
      user,
      dto.operationKey,
      {
        expectedBaseSettlementVersionId: dto.expectedBaseSettlementVersionId,
        correctionApplicationId: dto.correctionApplicationId,
        postingBatchId: dto.postingBatchId,
      },
    );
    const result = await this.corrections.commit(operation, user, auditMeta, {
      human: true,
      expectedActivityId: activityId,
      expectedBaseSettlementVersionId: dto.expectedBaseSettlementVersionId,
      expectedCorrectionApplicationId: dto.correctionApplicationId,
      expectedPostingBatchId: dto.postingBatchId,
    });
    return presentActivityTimeCorrectionCommit(result);
  }

  private toHumanSubmitInput(
    activityId: string,
    dto: AppSubmitActivityTimeCorrectionDto,
    user: CurrentUserPayload,
  ): CorrectionSubmitInput {
    const changeSet = parseCorrectionChangeSet(dto.requestedChangeJson);
    if (changeSet.schemaVersion !== 2 && changeSet.schemaVersion !== 3) {
      throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    }
    const requestedChangeJson = serializeCorrectionChangeSetForHash(changeSet);
    const businessHash = fingerprintMetricEnvelope(
      `attendance-correction-request-v${changeSet.schemaVersion}`,
      {
        activityId,
        participationIdentityId: dto.participationIdentityId,
        requestTypeCode: dto.requestTypeCode,
        requestedChangeJson,
        reason: dto.reason,
        attachmentIds: dto.attachmentIds ?? null,
      },
    ).definitionHash;
    return {
      activityId,
      participationIdentityId: dto.participationIdentityId,
      requestTypeCode: dto.requestTypeCode,
      requestedChangeJson,
      reason: dto.reason,
      attachmentIds: dto.attachmentIds,
      operationKey: dto.operationKey,
      requestHash: fingerprintMetricEnvelope('attendance-correction-human-submit-v1', {
        actorUserId: user.id,
        activityId,
        operationKey: dto.operationKey,
        businessHash,
      }).definitionHash,
    };
  }

  private humanOperation(
    domain: 'attendance-correction-human-prepare-v1' | 'attendance-correction-human-commit-v1',
    activityId: string,
    correctionRequestId: string,
    user: CurrentUserPayload,
    operationKey: string,
    expected: Record<string, string>,
  ): CorrectionApplyInput {
    return {
      correctionRequestId,
      operationKey,
      requestHash: fingerprintMetricEnvelope(domain, {
        actorUserId: user.id,
        activityId,
        correctionRequestId,
        operationKey,
        ...expected,
      }).definitionHash,
    };
  }

  private async readPreparedHashes(
    activityId: string,
    requestId: string,
    applicationId: string,
  ): Promise<{ requestHash: string; sourceProofHash: string | null }> {
    const [request, proof] = await this.prisma.$transaction([
      this.prisma.attendanceCorrectionRequest.findFirst({
        where: { id: requestId, activityId },
        select: { requestHash: true },
      }),
      this.prisma.correctionTimeSourceProof.findUnique({
        where: { applicationId },
        select: { sourceSetHash: true },
      }),
    ]);
    if (!request?.requestHash) throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
    return { requestHash: request.requestHash, sourceProofHash: proof?.sourceSetHash ?? null };
  }
}

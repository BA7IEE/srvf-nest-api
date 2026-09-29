import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import {
  presentActivityTimeCorrectionDetail,
  presentActivityTimeCorrectionListItem,
} from './activity-time-correction.presenter';
import { parseCorrectionChangeSet } from './correction-change-set';
import type {
  AppActivityTimeCorrectionDetailQueryDto,
  AppActivityTimeCorrectionListQueryDto,
} from './dto/app/app-activity-time-correction.dto';

type CorrectionListRow = {
  id: string;
  version: number;
  baseSettlementVersionId: string;
  statusCode: string;
  submittedAt: Date;
  reviewedAt: Date | null;
};

@Injectable()
export class ActivityTimeCorrectionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeCorrectionAccessService,
  ) {}

  async list(
    activityId: string,
    query: AppActivityTimeCorrectionListQueryDto,
    user: CurrentUserPayload,
  ) {
    return await this.prisma.$transaction(async (tx) => {
      const access = await this.access.authorizeListRead(
        tx,
        user,
        activityId,
        query.baseSettlementVersionId,
      );
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const where = {
        activityId,
        ...(access.baseSettlementVersionId
          ? { baseSettlementVersionId: access.baseSettlementVersionId }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.attendanceCorrectionRequest.findMany({
          where,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            version: true,
            baseSettlementVersionId: true,
            statusCode: true,
            submittedAt: true,
            reviewedAt: true,
          },
        }),
        tx.attendanceCorrectionRequest.count({ where }),
      ]);
      // Authorization is repeated at the output boundary; the reads above may
      // have waited on a concurrent state change even without taking row locks.
      await this.access.authorizeListRead(tx, user, activityId, query.baseSettlementVersionId);
      return {
        items: (rows as CorrectionListRow[]).map(presentActivityTimeCorrectionListItem),
        total,
        page,
        pageSize,
      };
    });
  }

  async detail(
    activityId: string,
    requestId: string,
    query: AppActivityTimeCorrectionDetailQueryDto,
    user: CurrentUserPayload,
  ) {
    return await this.prisma.$transaction(async (tx) => {
      const request = await tx.attendanceCorrectionRequest.findFirst({
        where: { id: requestId, activityId },
        select: {
          id: true,
          version: true,
          baseSettlementVersionId: true,
          statusCode: true,
          submittedAt: true,
          reviewedAt: true,
          submittedByUserId: true,
          requestTypeCode: true,
          requestedChangeJson: true,
          reason: true,
          attachmentIds: true,
          reviewNote: true,
          resubmittedFromRequestId: true,
          resubmittedSuccessor: { select: { id: true } },
          applications: {
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: {
              timeSourceProof: {
                select: { id: true, sourceSetHash: true, expectedSegmentCount: true },
              },
            },
          },
        },
      });
      if (!request) {
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
      }
      const actor = await this.access.authorizeRead(
        tx,
        user,
        activityId,
        request.baseSettlementVersionId,
      );
      const fullDetail = await this.mayReadSensitiveDetail(tx, actor, activityId, request);
      // Recheck after the precise qualification and before returning any
      // reason/attachment fields.  Losing access never leaks a prior result.
      await this.access.authorizeRead(tx, user, activityId, request.baseSettlementVersionId);
      const sourceProof = request.applications[0]?.timeSourceProof;
      return presentActivityTimeCorrectionDetail({
        id: request.id,
        version: request.version,
        baseSettlementVersionId: request.baseSettlementVersionId,
        statusCode: request.statusCode,
        submittedAt: request.submittedAt,
        reviewedAt: request.reviewedAt,
        requestTypeCode: request.requestTypeCode,
        requestedChangeJson: fullDetail ? objectJson(request.requestedChangeJson) : null,
        reason: fullDetail ? request.reason : null,
        attachmentIds: fullDetail ? stringArrayJson(request.attachmentIds) : null,
        reviewNote: fullDetail ? request.reviewNote : null,
        resubmittedFromRequestId: request.resubmittedFromRequestId,
        resubmittedSuccessorRequestId: request.resubmittedSuccessor?.id ?? null,
        sourceProofHash: sourceProof?.sourceSetHash ?? null,
        evidenceStatusCode: sourceProof === undefined ? 'not_frozen' : 'frozen',
        sourcePage:
          fullDetail && sourceProof ? await this.readSourcePage(tx, sourceProof, query) : null,
      });
    });
  }

  /**
   * `sourceSnapshotJson` can hold 10,000 sources and 50,000 slices.  Detail
   * pagination must therefore happen in PostgreSQL rather than loading the
   * full immutable proof into the application and slicing it afterward.
   */
  private async readSourcePage(
    tx: Prisma.TransactionClient,
    proof: { id: string; expectedSegmentCount: number },
    query: AppActivityTimeCorrectionDetailQueryDto,
  ): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const rows = await tx.$queryRaw<Array<{ source: Prisma.JsonValue }>>`
      SELECT item.value AS source
      FROM "CorrectionTimeSourceProof" AS proof
      CROSS JOIN LATERAL jsonb_array_elements(proof."sourceSnapshotJson")
        WITH ORDINALITY AS item(value, ordinal)
      WHERE proof.id = ${proof.id}
      ORDER BY item.ordinal
      OFFSET ${offset} LIMIT ${pageSize}
    `;
    if (rows.length > pageSize) throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    return {
      items: rows.map((row) => objectJson(row.source)),
      total: proof.expectedSegmentCount,
      page,
      pageSize,
    };
  }

  private async mayReadSensitiveDetail(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    activityId: string,
    request: {
      submittedByUserId: string | null;
      baseSettlementVersionId: string;
      requestedChangeJson: Prisma.JsonValue;
    },
  ): Promise<boolean> {
    if (request.submittedByUserId === actor.id) {
      try {
        const changeSet = parseCorrectionChangeSet(request.requestedChangeJson);
        await this.access.authorizeSubmission(tx, actor, activityId, changeSet.schemaVersion);
        return true;
      } catch (error) {
        if (!(error instanceof BizException)) throw error;
      }
    }
    try {
      await this.access.authorizeReview(tx, actor, activityId, request.baseSettlementVersionId);
      return true;
    } catch (error) {
      if (!(error instanceof BizException)) throw error;
      return false;
    }
  }
}

function objectJson(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
  }
  return value;
}

function stringArrayJson(value: Prisma.JsonValue | null): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
  }
  return [...value];
}

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { metricInteger, metricText } from './activity-metric-definition';
import {
  ActivityMetricSelectionAccess,
  lockMetricSelectionReference,
  type MetricSelectionSurface,
} from './activity-metric-selection-access';
import {
  ActivityMetricSelectionAuditRecorder,
  type MetricSelectionSource,
} from './activity-metric-selection-audit-recorder';
import {
  parseActivityMetricSelection,
  parseActivityMetricSelectionReceipt,
  metricSelectionColumns,
  type ActivityMetricSelection,
  type ActivityMetricSelectionResult,
} from './activity-metric-selection';

@Injectable()
export class ActivityMetricSelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityMetricSelectionAccess,
    private readonly audit: ActivityMetricSelectionAuditRecorder,
  ) {}

  async select(
    activityId: string,
    command: { operationKey: string; expectedRevision: number; metricSelection: unknown },
    user: CurrentUserPayload,
    surface: MetricSelectionSurface,
    meta: AuditMeta,
  ): Promise<ActivityMetricSelectionResult> {
    let selection: ActivityMetricSelection;
    let key: string;
    let expected: number;
    try {
      selection = parseActivityMetricSelection(instanceToPlain(command.metricSelection));
      key = metricText(command.operationKey, 128);
      expected = metricInteger(command.expectedRevision, 0, 2147483647);
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_INVALID);
      throw error;
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(['select_metric_set', activityId, expected, selection]))
      .digest('hex');
    return this.prisma.$transaction(async (tx) => {
      let actor = await this.access.authorizeWrite(tx, user, surface, activityId);
      const lockKey = JSON.stringify(['activity-metric', actor.id, 'select_metric_set', key]);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
      actor = await this.access.authorizeWrite(tx, user, surface, activityId);
      await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
      actor = await this.access.authorizeWrite(tx, user, surface, activityId);
      const before = await this.access.writable(tx, actor, activityId);
      const identity = {
        actorUserId: actor.id,
        operationCode: 'select_metric_set',
        operationKey: key,
      };
      const prior = await tx.activityMetricCommandReceipt.findUnique({
        where: { actorUserId_operationCode_operationKey: identity },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_COMMAND_CONFLICT);
        if (
          prior.activityId !== activityId ||
          prior.templateVersionId !== null ||
          prior.definitionId !== null ||
          prior.setVersionId !== null
        )
          throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_RECEIPT_INVALID);
        return parseActivityMetricSelectionReceipt(prior.resultJson, activityId);
      }
      if (before.metricSelectionRevision !== expected || expected === 2147483647)
        throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_STALE);
      await lockMetricSelectionReference(tx, selection, async () => {
        actor = await this.access.authorizeWrite(tx, user, surface, activityId);
        await this.access.writable(tx, actor, activityId);
      });
      const result = { activityId, ...selection, metricSelectionRevision: expected + 1 };
      await tx.activity.update({
        where: { id: activityId },
        data: metricSelectionColumns(selection, result.metricSelectionRevision),
      });
      await tx.activityMetricCommandReceipt.create({
        data: {
          ...identity,
          requestHash,
          activityId,
          resultJson: result as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.log(tx, actor, meta, surface, result, before);
      return result;
    });
  }

  /** Existing creation/Series/clone transaction owns idempotency and the root lock. */
  async initializeWithinTransaction(args: {
    tx: Prisma.TransactionClient;
    activityId: string;
    selection: ActivityMetricSelection;
    actor: CurrentUserPayload;
    meta: AuditMeta;
    source: MetricSelectionSource;
    revalidate: () => Promise<CurrentUserPayload>;
  }): Promise<void> {
    let actor = args.actor;
    await lockMetricSelectionReference(args.tx, args.selection, async () => {
      actor = await args.revalidate();
    });
    const count = await args.tx.activity.updateMany({
      where: {
        id: args.activityId,
        metricSelectionRevision: 0,
        metricRequirementCode: null,
        selectedMetricSetVersionId: null,
        selectedMetricSetDefinitionHash: null,
      },
      data: metricSelectionColumns(args.selection),
    });
    if (count.count !== 1) throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_STALE);
    await this.audit.log(
      args.tx,
      actor,
      args.meta,
      args.source,
      { activityId: args.activityId, ...args.selection, metricSelectionRevision: 1 },
      null,
    );
  }
}

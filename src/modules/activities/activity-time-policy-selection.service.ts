import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { timePolicyObject, timePolicyText } from './activity-time-policy-command';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';
import {
  ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  applyActivityTimePolicySelectionChanges,
  emptyActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionItem,
  parseActivityTimePolicySelectionReceipt,
  resolveActivityTimePolicySelection,
  type ActivityTimePolicyPointer,
  type ActivityTimePolicySelectionChange,
  type ActivityTimePolicySelectionDocument,
  type ActivityTimePolicySelectionReceiptResult,
} from './activity-time-policy-selection';
import {
  ActivityTimePolicySelectionAccess,
  type ActivityTimePolicySelectionSurface,
} from './activity-time-policy-selection-access';
import { ActivityTimePolicySelectionAuditRecorder } from './activity-time-policy-selection-audit-recorder';

const OPERATION_CODE = 'patch_time_policy_selection';
const MAX_BATCH_ROWS = 500;

export type ActivityTimePolicySelectionInitializationSource =
  | {
      readonly originCode: 'template_creation';
      readonly templateId: string;
      readonly templateDefinitionHash: string;
    }
  | {
      readonly originCode: 'creation_receipt';
      readonly creationReceiptId: string;
      readonly templateId?: string;
      readonly templateDefinitionHash?: string;
    }
  | {
      readonly originCode: 'series_occurrence';
      readonly seriesOccurrenceId: string;
      readonly templateId: string;
      readonly templateDefinitionHash: string;
    }
  | {
      readonly originCode: 'publish_review';
      readonly publishReviewId: string;
      readonly proposalSelectionHash: string;
      readonly templateId?: string;
      readonly templateDefinitionHash?: string;
    };

interface PatchCommand {
  readonly operationKey: string;
  readonly expectedRevision: number;
  readonly changes: readonly ActivityTimePolicySelectionChange[];
}

function invalidCommand(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_INVALID);
}

function parsePatchCommand(value: unknown): PatchCommand {
  try {
    const root = timePolicyObject(value, ['operationKey', 'expectedRevision', 'changes']);
    const operationKey = timePolicyText(root.operationKey, 128);
    if (operationKey.length < 8) return invalidCommand();
    const expectedRevision = root.expectedRevision;
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > 2147483646
    ) {
      return invalidCommand();
    }
    if (!Array.isArray(root.changes) || root.changes.length < 1 || root.changes.length > 100)
      return invalidCommand();
    const changes = root.changes.map((change) => {
      const item = parseActivityTimePolicySelectionItem(change);
      if (item.scope.layerCode === 'template') return invalidCommand();
      return item;
    });
    const keys = changes.map((change) => activityTimePolicySelectionScopeKey(change.scope));
    if (new Set(keys).size !== keys.length) return invalidCommand();
    const sorted = [...changes].sort((left, right) => {
      const a = activityTimePolicySelectionScopeKey(left.scope);
      const b = activityTimePolicySelectionScopeKey(right.scope);
      return a.localeCompare(b);
    });
    if (Buffer.byteLength(JSON.stringify({ changes: sorted }), 'utf8') > 64 * 1024)
      return invalidCommand();
    return { operationKey, expectedRevision, changes: sorted };
  } catch (error) {
    if (error instanceof BizException) throw error;
    if (error instanceof TypeError) return invalidCommand();
    throw error;
  }
}

function requestHash(activityId: string, actorUserId: string, command: PatchCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        OPERATION_CODE,
        actorUserId,
        activityId,
        command.expectedRevision,
        command.changes,
      ]),
    )
    .digest('hex');
}

function intervalIsCovered(
  pointer: ActivityTimePolicyPointer,
  version: { effectiveFrom: Date; effectiveUntil: Date | null },
  startAt: Date,
  endAt: Date,
): boolean {
  return (
    version.effectiveFrom <= startAt &&
    (version.effectiveUntil === null || version.effectiveUntil >= endAt) &&
    pointer.definitionHash.length === 64
  );
}

@Injectable()
export class ActivityTimePolicySelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimePolicySelectionAccess,
    private readonly audit: ActivityTimePolicySelectionAuditRecorder,
  ) {}

  async patch(
    activityId: string,
    input: unknown,
    user: CurrentUserPayload,
    surface: ActivityTimePolicySelectionSurface,
    meta: AuditMeta,
  ): Promise<ActivityTimePolicySelectionReceiptResult> {
    const command = parsePatchCommand(instanceToPlain(input, { exposeUnsetFields: false }));
    return this.prisma.$transaction(
      async (tx) => {
        let { actor } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.time-policy.select',
        );
        const hash = requestHash(activityId, actor.id, command);
        const lockKey = JSON.stringify([
          'activity-time-policy-selection',
          actor.id,
          OPERATION_CODE,
          command.operationKey,
        ]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        ({ actor } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.time-policy.select',
        ));
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        ({ actor } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.time-policy.select',
        ));

        const identity = {
          actorUserId: actor.id,
          operationCode: OPERATION_CODE,
          operationKey: command.operationKey,
        };
        const prior = await tx.activityTimePolicySelectionCommandReceipt.findUnique({
          where: { actorUserId_operationCode_operationKey: identity },
          include: { revision: true },
        });
        if (prior) {
          if (prior.requestHash !== hash) {
            throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_COMMAND_CONFLICT);
          }
          if (
            prior.activityId !== activityId ||
            prior.revision.activityId !== activityId ||
            prior.revision.id !== prior.selectionRevisionId ||
            prior.revision.createdByUserId !== actor.id
          ) {
            throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_RECEIPT_INVALID);
          }
          return parseActivityTimePolicySelectionReceipt(prior.resultJson, activityId);
        }

        const activity = await tx.activity.findFirst({
          where: { id: activityId, deletedAt: null },
          select: {
            id: true,
            startAt: true,
            endAt: true,
            timePolicySelectionRevision: true,
            currentTimePolicySelectionRevisionId: true,
          },
        });
        if (!activity)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
        if (
          activity.timePolicySelectionRevision !== command.expectedRevision ||
          command.expectedRevision >= 2147483646
        ) {
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
        }
        await this.access.assertStandaloneWritable(tx, activityId);

        const current = await this.loadCurrent(tx, activity);
        const next = applyActivityTimePolicySelectionChanges(current, command.changes);
        const nextHash = activityTimePolicySelectionHash(next);
        if (nextHash === activityTimePolicySelectionHash(current)) {
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_UNCHANGED);
        }

        await this.lockChangedTargets(tx, activityId, command.changes);
        const targetCount = await this.assertChangedReferencesCurrentAndAvailable(
          tx,
          activity,
          next,
          command.changes,
          async () => {
            ({ actor } = await this.access.authorize(
              tx,
              user,
              surface,
              activityId,
              'activity.time-policy.select',
            ));
            await this.access.assertStandaloneWritable(tx, activityId);
          },
        );

        const createdAt = new Date();
        const revision = await tx.activityTimePolicySelectionRevision.create({
          data: {
            activityId,
            revision: command.expectedRevision + 1,
            schemaVersion: ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
            selectionHash: nextHash,
            selectionJson: next as unknown as Prisma.InputJsonValue,
            itemCount: Object.keys(next.items).length,
            templateId: null,
            templateDefinitionHash: null,
            originCode: 'select',
            creationReceiptId: null,
            seriesOccurrenceId: null,
            publishReviewId: null,
            proposalSelectionHash: null,
            createdAt,
            createdByUserId: actor.id,
          },
        });
        const items = Object.values(next.items).map((item) => ({
          selectionRevisionId: revision.id,
          activityId,
          layerCode: item.scope.layerCode,
          sessionId: item.scope.sessionId,
          positionId: item.scope.positionId,
          mode: item.selection.mode,
          policyId: item.selection.pointer?.policyId ?? null,
          versionId: item.selection.pointer?.versionId ?? null,
          definitionHash: item.selection.pointer?.definitionHash ?? null,
        }));
        for (let index = 0; index < items.length; index += MAX_BATCH_ROWS) {
          await tx.activityTimePolicySelectionItem.createMany({
            data: items.slice(index, index + MAX_BATCH_ROWS),
          });
        }
        await tx.activity.update({
          where: { id: activityId },
          data: {
            timePolicySelectionRevision: command.expectedRevision + 1,
            currentTimePolicySelectionRevisionId: revision.id,
          },
        });
        const result: ActivityTimePolicySelectionReceiptResult = {
          activityId,
          selectionRevisionId: revision.id,
          revision: revision.revision,
          selectionHash: revision.selectionHash,
          createdAt: createdAt.toISOString(),
        };
        await tx.activityTimePolicySelectionCommandReceipt.create({
          data: {
            ...identity,
            requestHash: hash,
            activityId,
            selectionRevisionId: revision.id,
            resultJson: result as unknown as Prisma.InputJsonValue,
            createdAt,
          },
        });
        await this.audit.log(tx, actor, meta, result, targetCount);
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 2000,
        timeout: 10000,
      },
    );
  }

  /** Template definitions have no concrete activity interval yet, so this validates immutable
   * catalogue identity/lifecycle only; materialization later validates each real target window. */
  async assertTemplateReferencesWithinTransaction(
    tx: Prisma.TransactionClient,
    selection: ActivityTimePolicySelectionDocument,
    revalidate: () => Promise<void>,
  ): Promise<void> {
    const document = parseActivityTimePolicySelectionDocument(selection, { allowTemplate: true });
    await this.assertPointersAvailableWithinTransaction(
      tx,
      Object.values(document.items).flatMap((item) =>
        item.selection.pointer ? [item.selection.pointer] : [],
      ),
      revalidate,
    );
  }

  async assertPointersAvailableWithinTransaction(
    tx: Prisma.TransactionClient,
    pointers: readonly ActivityTimePolicyPointer[],
    revalidate: () => Promise<void>,
  ): Promise<void> {
    const policyIds = [...new Set(pointers.map((pointer) => pointer.policyId))].sort();
    const versionIds = [...new Set(pointers.map((pointer) => pointer.versionId))].sort();
    if (policyIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "TimePolicy" WHERE "id" IN (${Prisma.join(policyIds)}) ORDER BY "id" FOR SHARE`,
      );
      await revalidate();
    }
    if (versionIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "TimePolicyVersion" WHERE "id" IN (${Prisma.join(versionIds)}) ORDER BY "id" FOR SHARE`,
      );
      await revalidate();
    }
    const rows = versionIds.length
      ? await tx.timePolicyVersion.findMany({ where: { id: { in: versionIds } } })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const pointer of pointers) {
      const row = byId.get(pointer.versionId);
      if (
        !row ||
        row.policyId !== pointer.policyId ||
        row.definitionHash !== pointer.definitionHash ||
        row.statusCode !== 'active' ||
        row.schemaVersion !== 1 ||
        row.evaluatorVersion !== 1
      ) {
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      try {
        if (timePolicyVersionDocument(row).definitionHash !== pointer.definitionHash)
          throw new TypeError('stored policy version hash differs');
      } catch (error) {
        if (error instanceof BizException || error instanceof TypeError)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
        throw error;
      }
    }
  }

  /**
   * The outer creation transaction owns its own receipt and root lock.  This method only adds the
   * immutable selection fact; it never creates the standalone PATCH receipt.
   */
  async initializeWithinTransaction(args: {
    tx: Prisma.TransactionClient;
    activityId: string;
    selection: ActivityTimePolicySelectionDocument;
    actor: CurrentUserPayload;
    meta: AuditMeta;
    source: ActivityTimePolicySelectionInitializationSource;
    revalidate: () => Promise<CurrentUserPayload>;
  }): Promise<void> {
    const document = parseActivityTimePolicySelectionDocument(args.selection, {
      allowTemplate: true,
    });
    const selectionHash = activityTimePolicySelectionHash(document);
    const templateId = args.source.templateId ?? null;
    const templateDefinitionHash = args.source.templateDefinitionHash ?? null;
    if ((templateId === null) !== (templateDefinitionHash === null)) invalidCommand();
    const activity = await args.tx.activity.findFirst({
      where: { id: args.activityId, deletedAt: null },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
      },
    });
    if (
      !activity ||
      activity.timePolicySelectionRevision !== 0 ||
      activity.currentTimePolicySelectionRevisionId
    )
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
    let actor = args.actor;
    const changes = Object.values(document.items);
    await this.lockChangedTargets(args.tx, args.activityId, changes);
    const targetCount = await this.assertChangedReferencesCurrentAndAvailable(
      args.tx,
      activity,
      document,
      changes,
      async () => {
        actor = await args.revalidate();
      },
    );
    const createdAt = new Date();
    const revision = await args.tx.activityTimePolicySelectionRevision.create({
      data: {
        activityId: args.activityId,
        revision: 1,
        schemaVersion: ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
        selectionHash,
        selectionJson: document as unknown as Prisma.InputJsonValue,
        itemCount: Object.keys(document.items).length,
        templateId,
        templateDefinitionHash,
        originCode: args.source.originCode,
        creationReceiptId:
          args.source.originCode === 'creation_receipt' ? args.source.creationReceiptId : null,
        seriesOccurrenceId:
          args.source.originCode === 'series_occurrence' ? args.source.seriesOccurrenceId : null,
        publishReviewId:
          args.source.originCode === 'publish_review' ? args.source.publishReviewId : null,
        proposalSelectionHash:
          args.source.originCode === 'publish_review' ? args.source.proposalSelectionHash : null,
        createdAt,
        createdByUserId: actor.id,
      },
    });
    const items = Object.values(document.items).map((item) => ({
      selectionRevisionId: revision.id,
      activityId: args.activityId,
      layerCode: item.scope.layerCode,
      sessionId: item.scope.sessionId,
      positionId: item.scope.positionId,
      mode: item.selection.mode,
      policyId: item.selection.pointer?.policyId ?? null,
      versionId: item.selection.pointer?.versionId ?? null,
      definitionHash: item.selection.pointer?.definitionHash ?? null,
    }));
    for (let index = 0; index < items.length; index += MAX_BATCH_ROWS) {
      await args.tx.activityTimePolicySelectionItem.createMany({
        data: items.slice(index, index + MAX_BATCH_ROWS),
      });
    }
    const update = await args.tx.activity.updateMany({
      where: {
        id: args.activityId,
        timePolicySelectionRevision: 0,
        currentTimePolicySelectionRevisionId: null,
      },
      data: { timePolicySelectionRevision: 1, currentTimePolicySelectionRevisionId: revision.id },
    });
    if (update.count !== 1) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
    await this.audit.log(
      args.tx,
      actor,
      args.meta,
      {
        activityId: args.activityId,
        selectionRevisionId: revision.id,
        revision: 1,
        selectionHash,
        createdAt: createdAt.toISOString(),
      },
      targetCount,
      'initialize_time_policy_selection',
    );
  }

  /**
   * V8 approval is the only published-path writer.  It either retains the exact current immutable
   * revision or appends one physical revision after proposal-local clientRefs have been resolved.
   * The caller has already locked Activity/review and marked the review approved in this same
   * transaction, which is required by the migration's deferred source guard.
   */
  async applyPublishReviewSelectionWithinTransaction(args: {
    tx: Prisma.TransactionClient;
    activityId: string;
    selection: ActivityTimePolicySelectionDocument;
    expectedSelectionRevision: number;
    actor: CurrentUserPayload;
    meta: AuditMeta;
    publishReviewId: string;
    proposalSelectionHash: string;
    revalidate: () => Promise<CurrentUserPayload>;
  }): Promise<{
    readonly selectionRevisionId: string;
    readonly revision: number;
    readonly selectionHash: string;
    readonly selection: ActivityTimePolicySelectionDocument;
  }> {
    const document = parseActivityTimePolicySelectionDocument(args.selection, {
      allowTemplate: true,
    });
    const selectionHash = activityTimePolicySelectionHash(document);
    const activity = await args.tx.activity.findFirst({
      where: { id: args.activityId, deletedAt: null },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
      },
    });
    if (!activity)
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    if (
      (activity.timePolicySelectionRevision === 0) !==
      (activity.currentTimePolicySelectionRevisionId === null)
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    let prior:
      | {
          id: string;
          revision: number;
          selectionHash: string;
          selectionJson: Prisma.JsonValue;
          itemCount: number;
          templateId: string | null;
          templateDefinitionHash: string | null;
        }
      | undefined;
    if (activity.timePolicySelectionRevision > 0) {
      prior =
        (await args.tx.activityTimePolicySelectionRevision.findFirst({
          where: {
            id: activity.currentTimePolicySelectionRevisionId!,
            activityId: args.activityId,
            revision: activity.timePolicySelectionRevision,
          },
          select: {
            id: true,
            revision: true,
            selectionHash: true,
            selectionJson: true,
            itemCount: true,
            templateId: true,
            templateDefinitionHash: true,
          },
        })) ?? undefined;
      if (!prior)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
      try {
        const priorDocument = parseActivityTimePolicySelectionDocument(prior.selectionJson);
        if (
          activityTimePolicySelectionHash(priorDocument) !== prior.selectionHash ||
          Object.keys(priorDocument.items).length !== prior.itemCount
        ) {
          throw new TypeError('stored selection revision is inconsistent');
        }
      } catch (error) {
        if (error instanceof TypeError) {
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
        }
        throw error;
      }
    }
    if (args.expectedSelectionRevision === activity.timePolicySelectionRevision) {
      if (
        !prior ||
        prior.selectionHash !== selectionHash ||
        Object.keys(document.items).length !== prior.itemCount
      ) {
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
      }
      return {
        selectionRevisionId: prior.id,
        revision: prior.revision,
        selectionHash: prior.selectionHash,
        selection: document,
      };
    }
    if (
      args.expectedSelectionRevision !== activity.timePolicySelectionRevision + 1 ||
      args.expectedSelectionRevision > 2147483647
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
    }
    let actor = args.actor;
    const changes = Object.values(document.items);
    await this.lockChangedTargets(args.tx, args.activityId, changes);
    const targetCount = await this.assertChangedReferencesCurrentAndAvailable(
      args.tx,
      activity,
      document,
      changes,
      async () => {
        actor = await args.revalidate();
      },
    );
    const createdAt = new Date();
    const revision = await args.tx.activityTimePolicySelectionRevision.create({
      data: {
        activityId: args.activityId,
        revision: args.expectedSelectionRevision,
        schemaVersion: ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
        selectionHash,
        selectionJson: document as unknown as Prisma.InputJsonValue,
        itemCount: Object.keys(document.items).length,
        templateId: prior?.templateId ?? null,
        templateDefinitionHash: prior?.templateDefinitionHash ?? null,
        originCode: 'publish_review',
        creationReceiptId: null,
        seriesOccurrenceId: null,
        publishReviewId: args.publishReviewId,
        proposalSelectionHash: args.proposalSelectionHash,
        createdAt,
        createdByUserId: actor.id,
      },
    });
    const items = Object.values(document.items).map((item) => ({
      selectionRevisionId: revision.id,
      activityId: args.activityId,
      layerCode: item.scope.layerCode,
      sessionId: item.scope.sessionId,
      positionId: item.scope.positionId,
      mode: item.selection.mode,
      policyId: item.selection.pointer?.policyId ?? null,
      versionId: item.selection.pointer?.versionId ?? null,
      definitionHash: item.selection.pointer?.definitionHash ?? null,
    }));
    for (let index = 0; index < items.length; index += MAX_BATCH_ROWS) {
      await args.tx.activityTimePolicySelectionItem.createMany({
        data: items.slice(index, index + MAX_BATCH_ROWS),
      });
    }
    const update = await args.tx.activity.updateMany({
      where: {
        id: args.activityId,
        timePolicySelectionRevision: activity.timePolicySelectionRevision,
        currentTimePolicySelectionRevisionId: activity.currentTimePolicySelectionRevisionId,
      },
      data: {
        timePolicySelectionRevision: args.expectedSelectionRevision,
        currentTimePolicySelectionRevisionId: revision.id,
      },
    });
    if (update.count !== 1) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
    await this.audit.log(
      args.tx,
      actor,
      args.meta,
      {
        activityId: args.activityId,
        selectionRevisionId: revision.id,
        revision: revision.revision,
        selectionHash,
        createdAt: createdAt.toISOString(),
      },
      targetCount,
      'publish_review_time_policy_selection',
    );
    return {
      selectionRevisionId: revision.id,
      revision: revision.revision,
      selectionHash,
      selection: document,
    };
  }

  private async loadCurrent(
    tx: Prisma.TransactionClient,
    activity: {
      id: string;
      timePolicySelectionRevision: number;
      currentTimePolicySelectionRevisionId: string | null;
    },
  ): Promise<ActivityTimePolicySelectionDocument> {
    if (activity.timePolicySelectionRevision === 0) {
      if (activity.currentTimePolicySelectionRevisionId !== null)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
      return emptyActivityTimePolicySelectionDocument();
    }
    if (!activity.currentTimePolicySelectionRevisionId)
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    const revision = await tx.activityTimePolicySelectionRevision.findFirst({
      where: {
        id: activity.currentTimePolicySelectionRevisionId,
        activityId: activity.id,
        revision: activity.timePolicySelectionRevision,
      },
      select: { selectionJson: true, selectionHash: true, itemCount: true },
    });
    if (!revision)
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    try {
      const document = parseActivityTimePolicySelectionDocument(revision.selectionJson);
      if (
        activityTimePolicySelectionHash(document) !== revision.selectionHash ||
        Object.keys(document.items).length !== revision.itemCount
      ) {
        throw new TypeError('stored selection is not self-consistent');
      }
      return document;
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
      throw error;
    }
  }

  private async lockChangedTargets(
    tx: Prisma.TransactionClient,
    activityId: string,
    changes: readonly ActivityTimePolicySelectionChange[],
  ): Promise<void> {
    const sessionIds = [
      ...new Set(
        changes.flatMap((change) => (change.scope.sessionId ? [change.scope.sessionId] : [])),
      ),
    ].sort();
    const positionIds = [
      ...new Set(
        changes.flatMap((change) => (change.scope.positionId ? [change.scope.positionId] : [])),
      ),
    ].sort();
    if (sessionIds.length) {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ActivitySession" WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL AND "id" IN (${Prisma.join(sessionIds)}) ORDER BY "id" FOR UPDATE`,
      );
      if (locked.length !== sessionIds.length)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    if (positionIds.length) {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ActivitySessionPosition" WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL AND "id" IN (${Prisma.join(positionIds)}) ORDER BY "id" FOR UPDATE`,
      );
      if (locked.length !== positionIds.length)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
  }

  private async assertChangedReferencesCurrentAndAvailable(
    tx: Prisma.TransactionClient,
    activity: { id: string; startAt: Date; endAt: Date },
    document: ActivityTimePolicySelectionDocument,
    changes: readonly ActivityTimePolicySelectionChange[],
    reauthorize: () => Promise<void>,
  ): Promise<number> {
    const sessions = await tx.activitySession.findMany({
      where: { activityId: activity.id },
      select: { id: true, deletedAt: true, startAt: true, endAt: true },
      orderBy: { id: 'asc' },
    });
    const positions = await tx.activitySessionPosition.findMany({
      where: { activityId: activity.id },
      select: { id: true, sessionId: true, deletedAt: true, startAt: true, endAt: true },
      orderBy: { id: 'asc' },
    });
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const positionsById = new Map(positions.map((position) => [position.id, position]));
    for (const change of changes) {
      if (change.scope.layerCode === 'session') {
        const session = sessionsById.get(change.scope.sessionId!);
        if (!session || session.deletedAt !== null)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
      }
      if (change.scope.layerCode === 'position') {
        const position = positionsById.get(change.scope.positionId!);
        if (
          !position ||
          position.deletedAt !== null ||
          position.sessionId !== change.scope.sessionId ||
          sessionsById.get(position.sessionId)?.deletedAt !== null
        ) {
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
        }
      }
    }
    const liveTargets = sessions
      .filter((session) => session.deletedAt === null)
      .map((session) => ({
        sessionId: session.id,
        positionIds: positions
          .filter((position) => position.deletedAt === null && position.sessionId === session.id)
          .map((position) => position.id),
      }));
    let resolved;
    try {
      // Historical selections may retain deleted scopes.  Resolve against all known scopes to
      // preserve them, then validate only newly selected pointers on current live targets.
      resolved = resolveActivityTimePolicySelection(
        document,
        sessions.map((session) => ({
          sessionId: session.id,
          positionIds: positions
            .filter((position) => position.sessionId === session.id)
            .map((position) => position.id),
        })),
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
      throw error;
    }
    const changedScopes = new Set(
      changes.map((change) => activityTimePolicySelectionScopeKey(change.scope)),
    );
    const selected = resolved.filter(
      (entry) =>
        entry.pointer !== null &&
        entry.sourceScope !== null &&
        changedScopes.has(activityTimePolicySelectionScopeKey(entry.sourceScope)) &&
        (entry.scope.layerCode === 'activity' ||
          (entry.scope.layerCode === 'session' &&
            sessionsById.get(entry.scope.sessionId!)?.deletedAt === null) ||
          (entry.scope.layerCode === 'position' &&
            positionsById.get(entry.scope.positionId!)?.deletedAt === null)),
    );
    const policyIds = [...new Set(selected.map((entry) => entry.pointer!.policyId))].sort();
    const versionIds = [...new Set(selected.map((entry) => entry.pointer!.versionId))].sort();
    if (policyIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "TimePolicy" WHERE "id" IN (${Prisma.join(policyIds)}) ORDER BY "id" FOR SHARE`,
      );
      await reauthorize();
    }
    if (versionIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "TimePolicyVersion" WHERE "id" IN (${Prisma.join(versionIds)}) ORDER BY "id" FOR SHARE`,
      );
      await reauthorize();
    }
    const versions = versionIds.length
      ? await tx.timePolicyVersion.findMany({ where: { id: { in: versionIds } } })
      : [];
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    for (const entry of selected) {
      const pointer = entry.pointer!;
      const version = versionsById.get(pointer.versionId);
      if (
        !version ||
        version.policyId !== pointer.policyId ||
        version.definitionHash !== pointer.definitionHash ||
        version.statusCode !== 'active' ||
        version.schemaVersion !== 1 ||
        version.evaluatorVersion !== 1
      ) {
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      try {
        if (timePolicyVersionDocument(version).definitionHash !== pointer.definitionHash)
          throw new TypeError('stored policy version hash differs');
      } catch (error) {
        if (error instanceof BizException || error instanceof TypeError)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
        throw error;
      }
      const interval = (() => {
        if (entry.scope.layerCode === 'activity')
          return { startAt: activity.startAt, endAt: activity.endAt };
        if (entry.scope.layerCode === 'session') {
          const session = sessionsById.get(entry.scope.sessionId!);
          return session ? { startAt: session.startAt, endAt: session.endAt } : null;
        }
        const position = positionsById.get(entry.scope.positionId!);
        const session = position ? sessionsById.get(position.sessionId) : null;
        if (!position || !session) return null;
        return {
          startAt: position.startAt ?? session.startAt,
          endAt: position.endAt ?? session.endAt,
        };
      })();
      if (!interval || !intervalIsCovered(pointer, version, interval.startAt, interval.endAt))
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
    }
    return (
      liveTargets.length +
      liveTargets.reduce((total, target) => total + target.positionIds.length, 0) +
      1
    );
  }
}

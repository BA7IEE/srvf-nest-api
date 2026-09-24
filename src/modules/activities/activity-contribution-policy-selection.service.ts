import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  contributionPolicyObject,
  contributionPolicyText,
} from './activity-contribution-policy-command';
import { contributionPolicyVersionDocument } from './activity-contribution-policy-presenter';
import {
  ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  applyActivityContributionPolicySelectionChanges,
  emptyActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionItem,
  parseActivityContributionPolicySelectionReceipt,
  resolveActivityContributionPolicySelection,
  type ActivityContributionPolicyPointer,
  type ActivityContributionPolicySelectionChange,
  type ActivityContributionPolicySelectionDocument,
  type ActivityContributionPolicySelectionReceiptResult,
  type ActivityContributionPolicyTemplateSelection,
} from './activity-contribution-policy-selection';
import {
  ActivityContributionPolicySelectionAccess,
  type ActivityContributionPolicySelectionSurface,
} from './activity-contribution-policy-selection-access';
import { ActivityContributionPolicySelectionAuditRecorder } from './activity-contribution-policy-selection-audit-recorder';
import {
  activityTemplateContributionPolicyRuntimeSelection,
  parseActivityTemplateDefinitionV5,
} from './activity-template-definition-v5';

const OPERATION_CODE = 'patch_contribution_policy_selection';
const MAX_BATCH_ROWS = 5_000;

export type ActivityContributionPolicySelectionInitializationSource =
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
  readonly changes: readonly ActivityContributionPolicySelectionChange[];
}

interface CurrentSelection {
  readonly document: ActivityContributionPolicySelectionDocument;
  readonly templateId: string | null;
  readonly templateDefinitionHash: string | null;
  readonly templateSelection: ActivityContributionPolicyTemplateSelection | null;
}

function invalidCommand(): never {
  throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_INVALID);
}

function parsePatchCommand(value: unknown): PatchCommand {
  try {
    const root = contributionPolicyObject(value, ['operationKey', 'expectedRevision', 'changes']);
    const operationKey = contributionPolicyText(root.operationKey, 128);
    if (operationKey.length < 8) return invalidCommand();
    const expectedRevision = root.expectedRevision;
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > 2_147_483_646
    ) {
      return invalidCommand();
    }
    if (!Array.isArray(root.changes) || root.changes.length < 1 || root.changes.length > 10_001) {
      return invalidCommand();
    }
    const changes = root.changes.map(parseActivityContributionPolicySelectionItem);
    const keys = changes.map((change) => activityContributionPolicySelectionScopeKey(change.scope));
    if (new Set(keys).size !== keys.length) return invalidCommand();
    const sorted = [...changes].sort((left, right) =>
      activityContributionPolicySelectionScopeKey(left.scope).localeCompare(
        activityContributionPolicySelectionScopeKey(right.scope),
      ),
    );
    if (Buffer.byteLength(JSON.stringify({ changes: sorted }), 'utf8') > 4 * 1024 * 1024) {
      return invalidCommand();
    }
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
  pointer: ActivityContributionPolicyPointer,
  version: {
    definitionHash: string;
    evaluatorVersion: number;
    effectiveFrom: Date;
    effectiveUntil: Date | null;
  },
  startAt: Date,
  endAt: Date,
): boolean {
  return (
    version.definitionHash === pointer.definitionHash &&
    version.evaluatorVersion === pointer.evaluatorVersion &&
    version.effectiveFrom <= startAt &&
    (version.effectiveUntil === null || version.effectiveUntil >= endAt)
  );
}

function uniquePointers(
  pointers: readonly ActivityContributionPolicyPointer[],
): ActivityContributionPolicyPointer[] {
  const byKey = new Map<string, ActivityContributionPolicyPointer>();
  for (const pointer of pointers) {
    byKey.set(
      JSON.stringify([
        pointer.policyId,
        pointer.versionId,
        pointer.definitionHash,
        pointer.evaluatorVersion,
      ]),
      pointer,
    );
  }
  return [...byKey.values()];
}

@Injectable()
export class ActivityContributionPolicySelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityContributionPolicySelectionAccess,
    private readonly audit: ActivityContributionPolicySelectionAuditRecorder,
  ) {}

  async patch(
    activityId: string,
    input: unknown,
    user: CurrentUserPayload,
    surface: ActivityContributionPolicySelectionSurface,
    meta: AuditMeta,
  ): Promise<ActivityContributionPolicySelectionReceiptResult> {
    const command = parsePatchCommand(instanceToPlain(input, { exposeUnsetFields: false }));
    return this.prisma.$transaction(
      async (tx) => {
        let { actor } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.contribution-policy.select',
        );
        const hash = requestHash(activityId, actor.id, command);
        const lockKey = JSON.stringify([
          'activity-contribution-policy-selection',
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
          'activity.contribution-policy.select',
        ));
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        ({ actor } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.contribution-policy.select',
        ));

        const identity = {
          actorUserId: actor.id,
          operationCode: OPERATION_CODE,
          operationKey: command.operationKey,
        };
        const prior = await tx.activityContributionPolicySelectionCommandReceipt.findUnique({
          where: { actorUserId_operationCode_operationKey: identity },
          include: { revision: true },
        });
        if (prior) {
          if (prior.requestHash !== hash) {
            throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_COMMAND_CONFLICT);
          }
          if (
            prior.activityId !== activityId ||
            prior.revision.activityId !== activityId ||
            prior.revision.id !== prior.selectionRevisionId ||
            prior.revision.createdByUserId !== actor.id
          ) {
            throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_RECEIPT_INVALID);
          }
          return parseActivityContributionPolicySelectionReceipt(prior.resultJson, activityId);
        }

        const activity = await tx.activity.findFirst({
          where: { id: activityId, deletedAt: null },
          select: {
            id: true,
            startAt: true,
            endAt: true,
            contributionPolicySelectionRevision: true,
            currentContributionPolicySelectionRevisionId: true,
          },
        });
        if (!activity) {
          throw new BizException(
            BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
          );
        }
        if (command.expectedRevision >= 2_147_483_646) {
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REVISION_LIMIT);
        }
        if (activity.contributionPolicySelectionRevision !== command.expectedRevision) {
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
        }
        await this.access.assertStandaloneWritable(tx, activityId);

        const current = await this.loadCurrent(tx, activity);
        const next = applyActivityContributionPolicySelectionChanges(
          current.document,
          command.changes,
        );
        const nextHash = activityContributionPolicySelectionHash(next);
        if (nextHash === activityContributionPolicySelectionHash(current.document)) {
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_UNCHANGED);
        }

        await this.lockChangedTargets(tx, activityId, command.changes);
        const validation = await this.assertReferencesCurrentAndAvailable(
          tx,
          activity,
          next,
          current.templateSelection,
          command.changes,
          async () => {
            ({ actor } = await this.access.authorize(
              tx,
              user,
              surface,
              activityId,
              'activity.contribution-policy.select',
            ));
            await this.access.assertStandaloneWritable(tx, activityId);
          },
        );

        const createdAt = new Date();
        const revision = await tx.activityContributionPolicySelectionRevision.create({
          data: {
            activityId,
            revision: command.expectedRevision + 1,
            schemaVersion: ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
            selectionHash: nextHash,
            selectionJson: next as unknown as Prisma.InputJsonValue,
            itemCount: Object.keys(next.items).length,
            templateId: current.templateId,
            templateDefinitionHash: current.templateDefinitionHash,
            originCode: 'select',
            creationReceiptId: null,
            seriesOccurrenceId: null,
            publishReviewId: null,
            proposalSelectionHash: null,
            createdAt,
            createdByUserId: actor.id,
          },
        });
        await this.writeItems(tx, activityId, revision.id, next);
        await tx.activity.update({
          where: { id: activityId },
          data: {
            contributionPolicySelectionRevision: command.expectedRevision + 1,
            currentContributionPolicySelectionRevisionId: revision.id,
          },
        });
        const result: ActivityContributionPolicySelectionReceiptResult = {
          activityId,
          selectionRevisionId: revision.id,
          revision: revision.revision,
          selectionHash: revision.selectionHash,
          createdAt: createdAt.toISOString(),
        };
        await tx.activityContributionPolicySelectionCommandReceipt.create({
          data: {
            ...identity,
            requestHash: hash,
            activityId,
            selectionRevisionId: revision.id,
            resultJson: result as unknown as Prisma.InputJsonValue,
            createdAt,
          },
        });
        await this.audit.log(tx, actor, meta, result, {
          changedLayerCount: command.changes.length,
          targetCount: validation.targetCount,
          pointers: validation.pointers,
        });
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 2_000,
        timeout: 10_000,
      },
    );
  }

  async assertTemplateReferencesWithinTransaction(
    tx: Prisma.TransactionClient,
    selection: ActivityContributionPolicyTemplateSelection,
    revalidate: () => Promise<void>,
  ): Promise<void> {
    const pointers = [
      ...(selection.activityDefault.pointer ? [selection.activityDefault.pointer] : []),
      ...selection.positionOverrides.map((item) => item.pointer),
    ];
    await this.assertPointersAvailableWithinTransaction(tx, pointers, revalidate);
  }

  async assertPointersAvailableWithinTransaction(
    tx: Prisma.TransactionClient,
    pointers: readonly ActivityContributionPolicyPointer[],
    revalidate: () => Promise<void>,
  ): Promise<void> {
    const unique = uniquePointers(pointers);
    const policyIds = [...new Set(unique.map((pointer) => pointer.policyId))].sort();
    const versionIds = [...new Set(unique.map((pointer) => pointer.versionId))].sort();
    if (policyIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ContributionPolicy" WHERE "id" IN (${Prisma.join(policyIds)}) ORDER BY "id" FOR SHARE`,
      );
      await revalidate();
    }
    if (versionIds.length) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ContributionPolicyVersion" WHERE "id" IN (${Prisma.join(versionIds)}) ORDER BY "id" FOR SHARE`,
      );
      await revalidate();
    }
    const rows = versionIds.length
      ? await tx.contributionPolicyVersion.findMany({ where: { id: { in: versionIds } } })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const pointer of unique) {
      const row = byId.get(pointer.versionId);
      if (
        !row ||
        row.policyId !== pointer.policyId ||
        row.definitionHash !== pointer.definitionHash ||
        row.evaluatorVersion !== pointer.evaluatorVersion ||
        row.statusCode !== 'active' ||
        row.schemaVersion !== 1 ||
        row.evaluatorVersion !== 1
      ) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      try {
        if (contributionPolicyVersionDocument(row).definitionHash !== pointer.definitionHash) {
          throw new TypeError('stored policy version hash differs');
        }
      } catch (error) {
        if (error instanceof BizException || error instanceof TypeError) {
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
        }
        throw error;
      }
    }
  }

  async initializeWithinTransaction(args: {
    tx: Prisma.TransactionClient;
    activityId: string;
    selection: ActivityContributionPolicySelectionDocument;
    templateSelection: ActivityContributionPolicyTemplateSelection | null;
    actor: CurrentUserPayload;
    meta: AuditMeta;
    source: ActivityContributionPolicySelectionInitializationSource;
    revalidate: () => Promise<CurrentUserPayload>;
  }): Promise<void> {
    const document = parseActivityContributionPolicySelectionDocument(args.selection);
    const selectionHash = activityContributionPolicySelectionHash(document);
    const templateId = args.source.templateId ?? null;
    const templateDefinitionHash = args.source.templateDefinitionHash ?? null;
    if (
      (templateId === null) !== (templateDefinitionHash === null) ||
      (templateId === null) !== (args.templateSelection === null)
    ) {
      invalidCommand();
    }
    const activity = await args.tx.activity.findFirst({
      where: { id: args.activityId, deletedAt: null },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
      },
    });
    if (
      !activity ||
      activity.contributionPolicySelectionRevision !== 0 ||
      activity.currentContributionPolicySelectionRevisionId
    ) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
    }
    let actor = args.actor;
    const changes = Object.values(document.items);
    await this.lockChangedTargets(args.tx, args.activityId, changes);
    const validation = await this.assertReferencesCurrentAndAvailable(
      args.tx,
      activity,
      document,
      args.templateSelection,
      changes,
      async () => {
        actor = await args.revalidate();
      },
    );
    const createdAt = new Date();
    const revision = await args.tx.activityContributionPolicySelectionRevision.create({
      data: {
        activityId: args.activityId,
        revision: 1,
        schemaVersion: ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
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
    await this.writeItems(args.tx, args.activityId, revision.id, document);
    const update = await args.tx.activity.updateMany({
      where: {
        id: args.activityId,
        contributionPolicySelectionRevision: 0,
        currentContributionPolicySelectionRevisionId: null,
      },
      data: {
        contributionPolicySelectionRevision: 1,
        currentContributionPolicySelectionRevisionId: revision.id,
      },
    });
    if (update.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
    }
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
      {
        changedLayerCount: Object.keys(document.items).length,
        targetCount: validation.targetCount,
        pointers: validation.pointers,
        operation: 'initialize_contribution_policy_selection',
      },
    );
  }

  async applyPublishReviewSelectionWithinTransaction(args: {
    tx: Prisma.TransactionClient;
    activityId: string;
    selection: ActivityContributionPolicySelectionDocument;
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
    readonly selection: ActivityContributionPolicySelectionDocument;
  }> {
    const document = parseActivityContributionPolicySelectionDocument(args.selection);
    const selectionHash = activityContributionPolicySelectionHash(document);
    const activity = await args.tx.activity.findFirst({
      where: { id: args.activityId, deletedAt: null },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
      },
    });
    if (!activity) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    const current = await this.loadCurrent(args.tx, activity);
    if (args.expectedSelectionRevision === activity.contributionPolicySelectionRevision) {
      if (
        activity.contributionPolicySelectionRevision === 0 ||
        selectionHash !== activityContributionPolicySelectionHash(current.document) ||
        !activity.currentContributionPolicySelectionRevisionId
      ) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
      }
      return {
        selectionRevisionId: activity.currentContributionPolicySelectionRevisionId,
        revision: activity.contributionPolicySelectionRevision,
        selectionHash,
        selection: document,
      };
    }
    if (
      args.expectedSelectionRevision !== activity.contributionPolicySelectionRevision + 1 ||
      args.expectedSelectionRevision > 2_147_483_647
    ) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
    }
    let actor = args.actor;
    const changes = Object.values(document.items);
    await this.lockChangedTargets(args.tx, args.activityId, changes);
    const validation = await this.assertReferencesCurrentAndAvailable(
      args.tx,
      activity,
      document,
      current.templateSelection,
      changes,
      async () => {
        actor = await args.revalidate();
      },
    );
    const createdAt = new Date();
    const revision = await args.tx.activityContributionPolicySelectionRevision.create({
      data: {
        activityId: args.activityId,
        revision: args.expectedSelectionRevision,
        schemaVersion: ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
        selectionHash,
        selectionJson: document as unknown as Prisma.InputJsonValue,
        itemCount: Object.keys(document.items).length,
        templateId: current.templateId,
        templateDefinitionHash: current.templateDefinitionHash,
        originCode: 'publish_review',
        creationReceiptId: null,
        seriesOccurrenceId: null,
        publishReviewId: args.publishReviewId,
        proposalSelectionHash: args.proposalSelectionHash,
        createdAt,
        createdByUserId: actor.id,
      },
    });
    await this.writeItems(args.tx, args.activityId, revision.id, document);
    const update = await args.tx.activity.updateMany({
      where: {
        id: args.activityId,
        contributionPolicySelectionRevision: activity.contributionPolicySelectionRevision,
        currentContributionPolicySelectionRevisionId:
          activity.currentContributionPolicySelectionRevisionId,
      },
      data: {
        contributionPolicySelectionRevision: args.expectedSelectionRevision,
        currentContributionPolicySelectionRevisionId: revision.id,
      },
    });
    if (update.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
    }
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
      {
        changedLayerCount: changes.length,
        targetCount: validation.targetCount,
        pointers: validation.pointers,
        operation: 'publish_review_contribution_policy_selection',
      },
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
      contributionPolicySelectionRevision: number;
      currentContributionPolicySelectionRevisionId: string | null;
    },
  ): Promise<CurrentSelection> {
    if (activity.contributionPolicySelectionRevision === 0) {
      if (activity.currentContributionPolicySelectionRevisionId !== null) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
      return {
        document: emptyActivityContributionPolicySelectionDocument(),
        templateId: null,
        templateDefinitionHash: null,
        templateSelection: null,
      };
    }
    if (!activity.currentContributionPolicySelectionRevisionId) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    const revision = await tx.activityContributionPolicySelectionRevision.findFirst({
      where: {
        id: activity.currentContributionPolicySelectionRevisionId,
        activityId: activity.id,
        revision: activity.contributionPolicySelectionRevision,
      },
      select: {
        selectionJson: true,
        selectionHash: true,
        itemCount: true,
        templateId: true,
        templateDefinitionHash: true,
      },
    });
    if (!revision) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    try {
      const document = parseActivityContributionPolicySelectionDocument(revision.selectionJson);
      if (
        activityContributionPolicySelectionHash(document) !== revision.selectionHash ||
        Object.keys(document.items).length !== revision.itemCount
      ) {
        throw new TypeError('stored selection is not self-consistent');
      }
      const templateSelection = await this.loadTemplateSelection(
        tx,
        revision.templateId,
        revision.templateDefinitionHash,
      );
      return {
        document,
        templateId: revision.templateId,
        templateDefinitionHash: revision.templateDefinitionHash,
        templateSelection,
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }

  private async loadTemplateSelection(
    tx: Prisma.TransactionClient,
    templateId: string | null,
    templateDefinitionHash: string | null,
  ): Promise<ActivityContributionPolicyTemplateSelection | null> {
    if (templateId === null && templateDefinitionHash === null) return null;
    if (templateId === null || templateDefinitionHash === null) {
      throw new TypeError('incomplete selection template anchor');
    }
    const template = await tx.activityTemplate.findFirst({
      where: { id: templateId, definitionHash: templateDefinitionHash },
      select: { schemaVersion: true, definitionJson: true, definitionHash: true },
    });
    if (
      !template ||
      template.schemaVersion !== 5 ||
      template.definitionJson === null ||
      template.definitionHash !== templateDefinitionHash
    ) {
      throw new TypeError('selection template anchor is unavailable');
    }
    return activityTemplateContributionPolicyRuntimeSelection(
      parseActivityTemplateDefinitionV5(template.definitionJson).contributionPolicySelection,
    );
  }

  private async writeItems(
    tx: Prisma.TransactionClient,
    activityId: string,
    selectionRevisionId: string,
    document: ActivityContributionPolicySelectionDocument,
  ): Promise<void> {
    const items = Object.values(document.items).map((item) => ({
      selectionRevisionId,
      activityId,
      layerCode: item.scope.layerCode,
      sessionId: item.scope.sessionId,
      positionId: item.scope.positionId,
      mode: item.selection.mode,
      policyId: item.selection.pointer?.policyId ?? null,
      versionId: item.selection.pointer?.versionId ?? null,
      definitionHash: item.selection.pointer?.definitionHash ?? null,
      evaluatorVersion: item.selection.pointer?.evaluatorVersion ?? null,
    }));
    for (let index = 0; index < items.length; index += MAX_BATCH_ROWS) {
      await tx.activityContributionPolicySelectionItem.createMany({
        data: items.slice(index, index + MAX_BATCH_ROWS),
      });
    }
  }

  private async lockChangedTargets(
    tx: Prisma.TransactionClient,
    activityId: string,
    changes: readonly ActivityContributionPolicySelectionChange[],
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
      if (locked.length !== sessionIds.length) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
    }
    if (positionIds.length) {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ActivitySessionPosition" WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL AND "id" IN (${Prisma.join(positionIds)}) ORDER BY "id" FOR UPDATE`,
      );
      if (locked.length !== positionIds.length) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
    }
  }

  private async assertReferencesCurrentAndAvailable(
    tx: Prisma.TransactionClient,
    activity: { id: string; startAt: Date; endAt: Date },
    document: ActivityContributionPolicySelectionDocument,
    templateSelection: ActivityContributionPolicyTemplateSelection | null,
    changes: readonly ActivityContributionPolicySelectionChange[],
    reauthorize: () => Promise<void>,
  ): Promise<{
    readonly targetCount: number;
    readonly pointers: readonly ActivityContributionPolicyPointer[];
  }> {
    const positions = await tx.activitySessionPosition.findMany({
      where: { activityId: activity.id },
      select: {
        id: true,
        code: true,
        sessionId: true,
        deletedAt: true,
        startAt: true,
        endAt: true,
        session: {
          select: {
            code: true,
            deletedAt: true,
            startAt: true,
            endAt: true,
          },
        },
      },
      orderBy: [{ sessionId: 'asc' }, { id: 'asc' }],
    });
    const positionsById = new Map(positions.map((position) => [position.id, position]));
    for (const change of changes) {
      if (change.scope.layerCode !== 'position') continue;
      const position = positionsById.get(change.scope.positionId!);
      if (
        !position ||
        position.deletedAt !== null ||
        position.session.deletedAt !== null ||
        position.sessionId !== change.scope.sessionId
      ) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
    }

    let resolved;
    try {
      resolved = resolveActivityContributionPolicySelection(
        document,
        templateSelection,
        positions.map((position) => ({
          sessionId: position.sessionId,
          sessionCode: position.session.code,
          positionId: position.id,
          positionCode: position.code,
        })),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
      throw error;
    }
    const livePositionIds = new Set(
      positions
        .filter((position) => position.deletedAt === null && position.session.deletedAt === null)
        .map((position) => position.id),
    );
    const selected = resolved.filter(
      (entry) =>
        entry.pointer !== null &&
        (entry.scope.layerCode === 'activity' || livePositionIds.has(entry.scope.positionId!)),
    );
    const pointers = uniquePointers(selected.map((entry) => entry.pointer!));
    const policyIds = [...new Set(pointers.map((pointer) => pointer.policyId))].sort();
    const versionIds = [...new Set(pointers.map((pointer) => pointer.versionId))].sort();
    if (policyIds.length) {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ContributionPolicy" WHERE "id" IN (${Prisma.join(policyIds)}) ORDER BY "id" FOR SHARE`,
      );
      if (locked.length !== policyIds.length) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      await reauthorize();
    }
    if (versionIds.length) {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ContributionPolicyVersion" WHERE "id" IN (${Prisma.join(versionIds)}) ORDER BY "id" FOR SHARE`,
      );
      if (locked.length !== versionIds.length) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      await reauthorize();
    }
    const versions = versionIds.length
      ? await tx.contributionPolicyVersion.findMany({ where: { id: { in: versionIds } } })
      : [];
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    for (const entry of selected) {
      const pointer = entry.pointer!;
      const version = versionsById.get(pointer.versionId);
      if (
        !version ||
        version.policyId !== pointer.policyId ||
        version.definitionHash !== pointer.definitionHash ||
        version.evaluatorVersion !== pointer.evaluatorVersion ||
        version.statusCode !== 'active' ||
        version.schemaVersion !== 1 ||
        version.evaluatorVersion !== 1
      ) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
      try {
        if (contributionPolicyVersionDocument(version).definitionHash !== pointer.definitionHash) {
          throw new TypeError('stored policy version hash differs');
        }
      } catch (error) {
        if (error instanceof BizException || error instanceof TypeError) {
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
        }
        throw error;
      }
      const interval = (() => {
        if (entry.scope.layerCode === 'activity') {
          return { startAt: activity.startAt, endAt: activity.endAt };
        }
        const position = positionsById.get(entry.scope.positionId!);
        if (!position) return null;
        return {
          startAt: position.startAt ?? position.session.startAt,
          endAt: position.endAt ?? position.session.endAt,
        };
      })();
      if (!interval || !intervalIsCovered(pointer, version, interval.startAt, interval.endAt)) {
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE);
      }
    }
    return { targetCount: livePositionIds.size + 1, pointers };
  }
}

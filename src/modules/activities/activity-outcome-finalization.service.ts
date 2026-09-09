import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { instanceToPlain } from 'class-transformer';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentsService } from '../attachments/attachments.service';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';
import { validateOutcomeCandidateInTx } from './activity-outcome-candidate-validation';
import { lockMetricSelectionReference } from './activity-metric-selection-access';
import { metricDefinitionDocument } from './activity-metric-presenter';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityOutcomeFinalizationAuditRecorder } from './activity-outcome-finalization-audit-recorder';
import {
  outcomeCorrectionCancellationHash,
  outcomeCorrectionRequestHash,
  outcomeConfirmationRequestHash,
  parseOutcomeConfirmation,
  parseOutcomeCorrection,
  parseOutcomeCorrectionCancellation,
  parseOutcomeFinalizationReceipt,
  type OutcomeFinalizationResult,
} from './activity-outcome-finalization-command';
import {
  assertOutcomeFinalizationAnchors,
  nextFinalizedOutcomeRevision,
} from './activity-outcome-finalization-policy';

@Injectable()
export class ActivityOutcomeFinalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
    private readonly audit: ActivityOutcomeFinalizationAuditRecorder,
    private readonly attachments: AttachmentsService,
    private readonly source: ActivityMetricCandidateSourceQuery,
  ) {}

  async confirm(
    activityId: string,
    input: object,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<OutcomeFinalizationResult> {
    try {
      const command = parseOutcomeConfirmation(instanceToPlain(input));
      const requestHash = outcomeConfirmationRequestHash(activityId, command);
      return await this.prisma.$transaction(
        async (tx) => {
          let context = await this.access.authorize(
            tx,
            user,
            activityId,
            'activity.outcome.confirm',
          );
          const revalidate = async () => {
            context = await this.access.authorize(tx, user, activityId, 'activity.outcome.confirm');
          };
          const operationCode = 'confirm_outcome' as const;
          const lockKey = JSON.stringify([
            'activity-outcome-finalization',
            user.id,
            operationCode,
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await revalidate();
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
          await revalidate();
          const identity = {
            actorUserId: context.actor.id,
            operationCode,
            operationKey: command.operationKey,
          };
          const receipt = await tx.activityOutcomeFinalizationReceipt.findUnique({
            where: { actorUserId_operationCode_operationKey: identity },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
            try {
              if (receipt.activityId !== activityId)
                throw new TypeError('wrong confirmation receipt activity');
              return parseOutcomeFinalizationReceipt(
                receipt.resultJson,
                activityId,
                receipt.outcomeRevisionId,
                operationCode,
              );
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_OUTCOME_RECEIPT_INVALID);
              throw error;
            }
          }
          const latest = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
            include: {
              values: { take: 101, include: { finalizationSources: { take: 2 } } },
              priorRevision: true,
            },
          });
          const formal = await tx.activityOutcomeRevision.findMany({
            where: { activityId, statusCode: 'confirmed' },
            take: 2,
          });
          if (formal.length > 1)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          const confirmed = formal[0] ?? null;
          assertOutcomeFinalizationAnchors(
            context.activity.statusCode,
            command.expectedLatestRevision,
            command.expectedConfirmedRevision,
            latest,
            confirmed,
          );
          if (latest && latest.statusCode !== 'draft')
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          if (command.manualDraftId !== null && command.manualDraftId !== latest?.id)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          if (
            latest &&
            (latest.metricSetVersionId !== command.metricSetVersionId ||
              latest.metricSetDefinitionHash !== command.metricSetDefinitionHash ||
              latest.values.length > 100)
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          if (confirmed) {
            if (
              !latest ||
              !(await tx.activityOutcomeFinalizationReceipt.findFirst({
                where: {
                  activityId,
                  outcomeRevisionId: latest.id,
                  operationCode: 'prepare_outcome_correction',
                  baseConfirmedRevisionId: confirmed.id,
                },
              }))
            )
              throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          } else if (
            latest &&
            !(await tx.activityOutcomeCommandReceipt.findFirst({
              where: { activityId, outcomeRevisionId: latest.id },
            }))
          ) {
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          }
          if (
            context.activity.metricRequirementCode !== 'required' ||
            context.activity.selectedMetricSetVersionId !== command.metricSetVersionId ||
            context.activity.selectedMetricSetDefinitionHash !== command.metricSetDefinitionHash
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const set = await tx.activityMetricSetVersion.findFirst({
            where: { id: command.metricSetVersionId },
          });
          if (!set || set.definitionHash !== command.metricSetDefinitionHash)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          await lockMetricSelectionReference(
            tx,
            {
              metricRequirementCode: 'required',
              metricSetPointer: {
                id: set.id,
                code: set.code,
                version: set.version,
                schemaVersion: 1,
                definitionHash: set.definitionHash,
              },
            },
            revalidate,
          );
          const items = await tx.activityMetricSetItem.findMany({
            where: { setVersionId: set.id },
            include: { metricDefinition: true },
            take: 101,
          });
          if (
            items.length > 100 ||
            items.some(
              (item) =>
                item.required &&
                !command.values.some(
                  (value) => value.metricDefinitionId === item.metricDefinitionId,
                ),
            )
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
          const hasSystem = command.values.some((value) => value.sourceKind === 'system');
          let prepared:
            | { draftRevision: number; priorRevision: number; preparedAgainstRevision: number }
            | undefined;
          if (hasSystem && confirmed) {
            if (!latest?.priorRevision) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
            const priorRevision = latest.priorRevision.revision;
            for (const selected of command.values.filter(
              (value) => value.sourceKind === 'system',
            )) {
              const draftValue = latest.values.find(
                (value) =>
                  value.metricDefinitionId === selected.metricDefinitionId &&
                  value.sourceCode === 'system',
              );
              const source = draftValue?.finalizationSources[0];
              if (
                !draftValue ||
                draftValue.finalizationSources.length !== 1 ||
                !source ||
                source.candidateValueId !== selected.sourceValueId ||
                source.preparedAgainstRevision !== priorRevision
              )
                throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
            }
            prepared = {
              draftRevision: latest.revision,
              priorRevision,
              preparedAgainstRevision: priorRevision,
            };
          }
          const candidate =
            hasSystem && command.candidateId
              ? await validateOutcomeCandidateInTx(tx, this.source, command.candidateId, {
                  activityId,
                  metricRequirementCode: context.activity.metricRequirementCode,
                  metricSetVersionId: set.id,
                  metricSetDefinitionHash: set.definitionHash,
                  latestRevision: latest?.revision ?? 0,
                  prepared,
                })
              : null;
          const values = command.values.map((value) => {
            const definition = items.find(
              (item) => item.metricDefinitionId === value.metricDefinitionId,
            )?.metricDefinition;
            if (!definition || definition.kindCode === 'short_text')
              throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
            const manualValue =
              value.sourceKind === 'manual'
                ? latest?.values.find(
                    (row) =>
                      row.id === value.sourceValueId &&
                      row.metricDefinitionId === value.metricDefinitionId &&
                      row.sourceCode === 'manual',
                  )
                : null;
            const candidateValue =
              value.sourceKind === 'system'
                ? candidate?.candidate.values.find(
                    (row) =>
                      row.id === value.sourceValueId &&
                      row.definitionId === value.metricDefinitionId,
                  )
                : null;
            if (
              (value.sourceKind === 'manual' && !manualValue) ||
              (value.sourceKind === 'system' && !candidateValue)
            )
              throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
            const parsed = fingerprintActivityOutcomeValue(
              metricDefinitionDocument(definition),
              definition.definitionHash,
              manualValue?.valueJson ?? candidateValue?.valueJson,
            );
            if (parsed.valueHash !== (manualValue?.valueHash ?? candidateValue?.valueHash))
              throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
            return { ...value, ...parsed, manualValue, candidateValue };
          });
          const attachmentIds = [
            ...new Set(values.flatMap((value) => value.evidenceAttachmentIds)),
          ].sort();
          await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(tx, {
            ownerId: activityId,
            ownerTypes: ['activity'],
            referencedAttachmentIds: attachmentIds,
          });
          await revalidate();
          if (
            !(await this.attachments.findOwnedAttachmentsTrusted(tx, {
              ownerId: activityId,
              ownerTypes: ['activity'],
              attachmentIds,
            }))
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          for (const old of [confirmed, latest]) {
            if (!old) continue;
            const updated = await tx.activityOutcomeRevision.updateMany({
              where: { id: old.id, activityId, statusCode: old.statusCode },
              data: { statusCode: 'superseded' },
            });
            if (updated.count !== 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          }
          const outcome = await tx.activityOutcomeRevision.create({
            data: {
              activityId,
              ...nextFinalizedOutcomeRevision(latest),
              metricSetVersionId: set.id,
              metricSetDefinitionHash: set.definitionHash,
              statusCode: 'confirmed',
              createdByUserId: context.actor.id,
            },
          });
          for (const value of values) {
            const row = await tx.activityMetricValueRevision.create({
              data: {
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                metricDefinitionId: value.metricDefinitionId,
                valueJson: value.valueJson,
                valueHash: value.valueHash,
                sourceCode: value.sourceKind,
                sourceReference: value.candidateValue?.id ?? 'human_manual',
                calculatedByRuleVersion: value.candidateValue
                  ? `${value.candidateValue.binding.ruleCode}@${value.candidateValue.binding.evaluatorVersion}`
                  : 'manual-outcome-v1',
                confirmedByUserId: context.actor.id,
                confirmedAt: outcome.createdAt,
                createdAt: outcome.createdAt,
              },
            });
            await tx.activityMetricValueEvidence.createMany({
              data: value.evidenceAttachmentIds.map((attachmentId, sortOrder) => ({
                valueRevisionId: row.id,
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                attachmentId,
                sortOrder,
                createdAt: outcome.createdAt,
              })),
            });
            await tx.activityOutcomeValueSource.create({
              data: {
                valueRevisionId: row.id,
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                metricDefinitionId: value.metricDefinitionId,
                sourceKind: value.sourceKind,
                manualValueRevisionId: value.manualValue?.id ?? null,
                candidateValueId: value.candidateValue?.id ?? null,
                preparedAgainstRevision:
                  value.sourceKind === 'system'
                    ? (prepared?.preparedAgainstRevision ?? latest?.revision ?? 0)
                    : null,
                createdAt: outcome.createdAt,
              },
            });
          }
          const result: OutcomeFinalizationResult = {
            schemaVersion: 1,
            activityId,
            outcomeRevisionId: outcome.id,
            revision: outcome.revision,
            createdStatusCode: 'confirmed',
            operationCode,
            valueCount: values.length,
            evidenceCount: values.reduce(
              (count, value) => count + value.evidenceAttachmentIds.length,
              0,
            ),
            createdAt: outcome.createdAt.toISOString(),
          };
          await tx.activityOutcomeFinalizationReceipt.create({
            data: {
              ...identity,
              requestHash,
              activityId,
              outcomeRevisionId: outcome.id,
              baseConfirmedRevisionId: confirmed?.id ?? null,
              resultJson: { ...result },
              createdAt: outcome.createdAt,
            },
          });
          await this.audit.log(
            tx,
            context.actor,
            meta,
            result,
            confirmed?.id ?? null,
            values.map((value) => value.sourceKind),
          );
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
      throw error;
    }
  }

  async prepareCorrection(
    activityId: string,
    input: object,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<OutcomeFinalizationResult> {
    try {
      const command = parseOutcomeCorrection(instanceToPlain(input));
      const requestHash = outcomeCorrectionRequestHash(activityId, command);
      return await this.prisma.$transaction(
        async (tx) => {
          let context = await this.access.authorize(
            tx,
            user,
            activityId,
            'activity.outcome.correct',
          );
          const revalidate = async () => {
            context = await this.access.authorize(tx, user, activityId, 'activity.outcome.correct');
          };
          const operationCode = 'prepare_outcome_correction' as const;
          const lockKey = JSON.stringify([
            'activity-outcome-finalization',
            user.id,
            operationCode,
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await revalidate();
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
          await revalidate();
          const identity = {
            actorUserId: context.actor.id,
            operationCode,
            operationKey: command.operationKey,
          };
          const receipt = await tx.activityOutcomeFinalizationReceipt.findUnique({
            where: { actorUserId_operationCode_operationKey: identity },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
            try {
              if (receipt.activityId !== activityId)
                throw new TypeError('wrong preparation receipt activity');
              return parseOutcomeFinalizationReceipt(
                receipt.resultJson,
                activityId,
                receipt.outcomeRevisionId,
                operationCode,
              );
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_OUTCOME_RECEIPT_INVALID);
              throw error;
            }
          }
          const latest = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
          });
          const formal = await tx.activityOutcomeRevision.findMany({
            where: { activityId, statusCode: 'confirmed' },
            take: 2,
          });
          if (!latest || formal.length !== 1)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const confirmed = formal[0];
          assertOutcomeFinalizationAnchors(
            context.activity.statusCode,
            command.expectedLatestRevision,
            command.expectedConfirmedRevision,
            latest,
            confirmed,
          );
          if (latest.id !== confirmed.id) {
            const priorPreparation = await tx.activityOutcomeFinalizationReceipt.findFirst({
              where: {
                activityId,
                outcomeRevisionId: latest.id,
                operationCode,
                baseConfirmedRevisionId: confirmed.id,
              },
            });
            if (!priorPreparation) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
            if (
              latest.statusCode === 'superseded' &&
              !(await tx.activityOutcomeFinalizationReceipt.findFirst({
                where: {
                  activityId,
                  outcomeRevisionId: latest.id,
                  operationCode: 'cancel_outcome_correction',
                  baseConfirmedRevisionId: confirmed.id,
                },
              }))
            )
              throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
            if (latest.statusCode !== 'draft' && latest.statusCode !== 'superseded')
              throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          }
          if (
            context.activity.metricRequirementCode !== 'required' ||
            context.activity.selectedMetricSetVersionId !== command.metricSetVersionId ||
            context.activity.selectedMetricSetDefinitionHash !== command.metricSetDefinitionHash
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const set = await tx.activityMetricSetVersion.findFirst({
            where: { id: command.metricSetVersionId },
          });
          if (!set || set.definitionHash !== command.metricSetDefinitionHash)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          await lockMetricSelectionReference(
            tx,
            {
              metricRequirementCode: 'required',
              metricSetPointer: {
                id: set.id,
                code: set.code,
                version: set.version,
                schemaVersion: 1,
                definitionHash: set.definitionHash,
              },
            },
            revalidate,
          );
          const items = await tx.activityMetricSetItem.findMany({
            where: { setVersionId: set.id },
            include: { metricDefinition: true },
            take: 101,
          });
          if (items.length > 100) throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
          const hasSystem = command.values.some((value) => value.sourceKind === 'system');
          const candidate =
            hasSystem && command.candidateId
              ? await validateOutcomeCandidateInTx(tx, this.source, command.candidateId, {
                  activityId,
                  metricRequirementCode: context.activity.metricRequirementCode,
                  metricSetVersionId: set.id,
                  metricSetDefinitionHash: set.definitionHash,
                  latestRevision: latest.revision,
                })
              : null;
          const values = command.values.map((value) => {
            const definition = items.find(
              (item) => item.metricDefinitionId === value.metricDefinitionId,
            )?.metricDefinition;
            if (!definition || definition.kindCode === 'short_text')
              throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
            const candidateValue =
              value.sourceKind === 'system'
                ? candidate?.candidate.values.find(
                    (row) =>
                      row.id === value.sourceValueId &&
                      row.definitionId === value.metricDefinitionId,
                  )
                : null;
            if (value.sourceKind === 'system' && !candidateValue)
              throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
            const parsed = fingerprintActivityOutcomeValue(
              metricDefinitionDocument(definition),
              definition.definitionHash,
              value.sourceKind === 'manual' ? value.value : candidateValue?.valueJson,
            );
            return { ...value, ...parsed, candidateValue };
          });
          const attachmentIds = [
            ...new Set(values.flatMap((value) => value.evidenceAttachmentIds)),
          ].sort();
          await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(tx, {
            ownerId: activityId,
            ownerTypes: ['activity'],
            referencedAttachmentIds: attachmentIds,
          });
          await revalidate();
          if (
            !(await this.attachments.findOwnedAttachmentsTrusted(tx, {
              ownerId: activityId,
              ownerTypes: ['activity'],
              attachmentIds,
            }))
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          const transition = nextFinalizedOutcomeRevision(latest);
          const outcome = await tx.activityOutcomeRevision.create({
            data: {
              activityId,
              ...transition,
              metricSetVersionId: set.id,
              metricSetDefinitionHash: set.definitionHash,
              statusCode: 'draft',
              createdByUserId: context.actor.id,
            },
          });
          for (const value of values) {
            const row = await tx.activityMetricValueRevision.create({
              data: {
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                metricDefinitionId: value.metricDefinitionId,
                valueJson: value.valueJson,
                valueHash: value.valueHash,
                sourceCode: value.sourceKind,
                sourceReference: value.candidateValue?.id ?? 'human_manual',
                calculatedByRuleVersion: value.candidateValue
                  ? `${value.candidateValue.binding.ruleCode}@${value.candidateValue.binding.evaluatorVersion}`
                  : 'manual-outcome-v1',
                createdAt: outcome.createdAt,
              },
            });
            if (value.evidenceAttachmentIds.length)
              await tx.activityMetricValueEvidence.createMany({
                data: value.evidenceAttachmentIds.map((attachmentId, sortOrder) => ({
                  valueRevisionId: row.id,
                  outcomeRevisionId: outcome.id,
                  activityId,
                  setVersionId: set.id,
                  attachmentId,
                  sortOrder,
                  createdAt: outcome.createdAt,
                })),
              });
            await tx.activityOutcomeValueSource.create({
              data: {
                valueRevisionId: row.id,
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                metricDefinitionId: value.metricDefinitionId,
                sourceKind: value.sourceKind,
                candidateValueId: value.candidateValue?.id ?? null,
                preparedAgainstRevision: value.sourceKind === 'system' ? latest.revision : null,
                createdAt: outcome.createdAt,
              },
            });
          }
          if (latest.statusCode === 'draft') {
            const updated = await tx.activityOutcomeRevision.updateMany({
              where: { id: latest.id, activityId, statusCode: 'draft' },
              data: { statusCode: 'superseded' },
            });
            if (updated.count !== 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          }
          const result: OutcomeFinalizationResult = {
            schemaVersion: 1,
            activityId,
            outcomeRevisionId: outcome.id,
            revision: outcome.revision,
            createdStatusCode: 'draft',
            operationCode,
            valueCount: values.length,
            evidenceCount: values.reduce(
              (count, value) => count + value.evidenceAttachmentIds.length,
              0,
            ),
            createdAt: outcome.createdAt.toISOString(),
          };
          await tx.activityOutcomeFinalizationReceipt.create({
            data: {
              ...identity,
              requestHash,
              activityId,
              outcomeRevisionId: outcome.id,
              baseConfirmedRevisionId: confirmed.id,
              resultJson: { ...result },
              createdAt: outcome.createdAt,
            },
          });
          await this.audit.log(
            tx,
            context.actor,
            meta,
            result,
            confirmed.id,
            values.map((value) => value.sourceKind),
          );
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
      throw error;
    }
  }

  /** Retain the cancelled draft and its values; the formal base remains current. */
  async cancelCorrection(
    activityId: string,
    outcomeRevisionId: string,
    input: object,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<OutcomeFinalizationResult> {
    try {
      const command = parseOutcomeCorrectionCancellation(instanceToPlain(input));
      const requestHash = outcomeCorrectionCancellationHash(activityId, outcomeRevisionId, command);
      return await this.prisma.$transaction(
        async (tx) => {
          let context = await this.access.authorize(
            tx,
            user,
            activityId,
            'activity.outcome.correct',
          );
          const revalidate = async () => {
            context = await this.access.authorize(tx, user, activityId, 'activity.outcome.correct');
          };
          const operationCode = 'cancel_outcome_correction' as const;
          const lockKey = JSON.stringify([
            'activity-outcome-finalization',
            user.id,
            operationCode,
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await revalidate();
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
          await revalidate();
          const identity = {
            actorUserId: context.actor.id,
            operationCode,
            operationKey: command.operationKey,
          };
          const receipt = await tx.activityOutcomeFinalizationReceipt.findUnique({
            where: { actorUserId_operationCode_operationKey: identity },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
            try {
              if (
                receipt.activityId !== activityId ||
                receipt.outcomeRevisionId !== outcomeRevisionId
              )
                throw new TypeError('cancellation receipt target mismatch');
              return parseOutcomeFinalizationReceipt(
                receipt.resultJson,
                activityId,
                outcomeRevisionId,
                operationCode,
              );
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_OUTCOME_RECEIPT_INVALID);
              throw error;
            }
          }
          const latest = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
          });
          const formal = await tx.activityOutcomeRevision.findMany({
            where: { activityId, statusCode: 'confirmed' },
            take: 2,
          });
          if (formal.length !== 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const confirmed = formal[0];
          assertOutcomeFinalizationAnchors(
            context.activity.statusCode,
            command.expectedLatestRevision,
            command.expectedConfirmedRevision,
            latest,
            confirmed,
          );
          if (!latest || latest.id !== outcomeRevisionId || latest.statusCode !== 'draft')
            throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const preparation = await tx.activityOutcomeFinalizationReceipt.findFirst({
            where: {
              activityId,
              outcomeRevisionId,
              operationCode: 'prepare_outcome_correction',
              baseConfirmedRevisionId: confirmed.id,
            },
          });
          if (!preparation) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const values = await tx.activityMetricValueRevision.findMany({
            where: { activityId, outcomeRevisionId },
            select: { sourceCode: true },
            take: 101,
          });
          const evidenceCount = await tx.activityMetricValueEvidence.count({
            where: { activityId, outcomeRevisionId },
          });
          if (
            !values.length ||
            values.length > 100 ||
            evidenceCount > values.length * 20 ||
            values.some((value) => value.sourceCode !== 'manual' && value.sourceCode !== 'system')
          )
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          const [{ now }] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT CURRENT_TIMESTAMP(3)::timestamp AS now`;
          const updated = await tx.activityOutcomeRevision.updateMany({
            where: { id: outcomeRevisionId, activityId, statusCode: 'draft' },
            data: { statusCode: 'superseded' },
          });
          if (updated.count !== 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
          const result: OutcomeFinalizationResult = {
            schemaVersion: 1,
            activityId,
            outcomeRevisionId,
            revision: latest.revision,
            createdStatusCode: 'superseded',
            operationCode,
            valueCount: values.length,
            evidenceCount,
            createdAt: now.toISOString(),
          };
          await tx.activityOutcomeFinalizationReceipt.create({
            data: {
              ...identity,
              requestHash,
              activityId,
              outcomeRevisionId,
              baseConfirmedRevisionId: confirmed.id,
              resultJson: { ...result },
              createdAt: now,
            },
          });
          const sourceKinds: ('manual' | 'system')[] = [];
          if (values.some((value) => value.sourceCode === 'manual')) sourceKinds.push('manual');
          if (values.some((value) => value.sourceCode === 'system')) sourceKinds.push('system');
          await this.audit.log(tx, context.actor, meta, result, confirmed.id, sourceKinds);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
      throw error;
    }
  }
}

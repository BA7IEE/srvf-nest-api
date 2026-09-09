import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { instanceToPlain } from 'class-transformer';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityMetricCandidateAuditRecorder } from './activity-metric-candidate-audit-recorder';
import {
  metricCandidateRequestHash,
  parseMetricCandidateCommand,
  parseMetricCandidateReceipt,
  MetricCandidateCommandResult,
} from './activity-metric-candidate-command';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { metricDefinitionDocument } from './activity-metric-presenter';
import {
  evaluateActivityMetricRule,
  resolveActivityMetricRuleBinding,
} from './activity-metric-rule';
import { lockMetricSelectionReference } from './activity-metric-selection-access';

@Injectable()
export class ActivityMetricCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
    private readonly source: ActivityMetricCandidateSourceQuery,
    private readonly audit: ActivityMetricCandidateAuditRecorder,
  ) {}

  async calculate(activityId: string, input: object, user: CurrentUserPayload, meta: AuditMeta) {
    try {
      const command = parseMetricCandidateCommand(instanceToPlain(input));
      const requestHash = metricCandidateRequestHash(activityId, command);
      return await this.prisma.$transaction(
        async (tx) => {
          let context = await this.access.authorize(
            tx,
            user,
            activityId,
            'activity.outcome.calculate',
          );
          const revalidate = async () => {
            context = await this.access.authorize(
              tx,
              user,
              activityId,
              'activity.outcome.calculate',
            );
          };
          const lockKey = JSON.stringify([
            'activity-metric-candidate',
            user.id,
            'calculate_metric_candidate',
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await revalidate();
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
          await revalidate();
          const identity = {
            actorId: context.actor.id,
            operation: 'calculate_metric_candidate',
            operationKey: command.operationKey,
          };
          const receipt = await tx.activityMetricCandidateCommandReceipt.findUnique({
            where: { actorId_operation_operationKey: identity },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT);
            try {
              return parseMetricCandidateReceipt(
                receipt.resultJson,
                activityId,
                receipt.candidateId,
              );
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_RECEIPT_INVALID);
              throw error;
            }
          }
          const latest = await tx.activityMetricCandidate.findFirst({
            where: { activityId },
            orderBy: { candidateRevision: 'desc' },
          });
          const outcome = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
            select: { revision: true },
          });
          if (
            !['draft', 'published', 'completed', 'terminated'].includes(
              context.activity.statusCode,
            ) ||
            (latest?.candidateRevision ?? 0) !== command.expectedCandidateRevision ||
            (outcome?.revision ?? 0) !== command.expectedOutcomeRevision ||
            context.activity.metricRequirementCode !== 'required' ||
            context.activity.selectedMetricSetVersionId !== command.metricSetVersionId ||
            context.activity.selectedMetricSetDefinitionHash !== command.metricSetDefinitionHash
          )
            throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
          const set = await tx.activityMetricSetVersion.findFirst({
            where: { id: command.metricSetVersionId },
          });
          if (!set || set.definitionHash !== command.metricSetDefinitionHash)
            throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
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
          const bindings = await tx.activityMetricRuleBinding.findMany({
            where: { id: { in: command.bindingIds } },
            include: { definition: true },
            take: command.bindingIds.length + 1,
            orderBy: { id: 'asc' },
          });
          if (
            bindings.length !== command.bindingIds.length ||
            new Set(bindings.map((b) => b.metricDefinitionId)).size !== bindings.length
          )
            throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
          const items = await tx.activityMetricSetItem.findMany({
            where: { setVersionId: set.id },
            select: { metricDefinitionId: true },
            take: 101,
          });
          if (items.length > 100) throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_INVALID);
          const memberIds = new Set(items.map((item) => item.metricDefinitionId));
          for (const binding of bindings) {
            if (
              !memberIds.has(binding.metricDefinitionId) ||
              binding.definition.statusCode !== 'active'
            )
              throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
            const expected = resolveActivityMetricRuleBinding(
              binding.metricDefinitionId,
              metricDefinitionDocument(binding.definition),
              binding.definitionHash,
              binding.ruleCode,
              binding.evaluatorVersion,
            );
            if (
              expected.bindingHash !== binding.bindingHash ||
              expected.ruleDigest !== binding.ruleDigest ||
              expected.scale !== binding.scale ||
              expected.unitCode !== binding.unitCode
            )
              throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
          }
          const source = await this.source.readTrusted(tx, activityId);
          const values = bindings.map((binding) => ({
            binding,
            value: evaluateActivityMetricRule(
              binding.metricDefinitionId,
              metricDefinitionDocument(binding.definition),
              binding.definitionHash,
              binding.ruleCode,
              binding.evaluatorVersion,
              source.sources,
            ),
          }));
          const bindingsDigest = fingerprintMetricEnvelope(
            'activity-metric-candidate-bindings-v1',
            command.bindingIds.map((id) => ({
              id,
              bindingHash: bindings.find((binding) => binding.id === id)!.bindingHash,
            })),
          ).definitionHash;
          const candidate = await tx.activityMetricCandidate.create({
            data: {
              schemaVersion: 1,
              activityId,
              candidateRevision: command.expectedCandidateRevision + 1,
              priorCandidateId: latest?.id ?? null,
              metricSetVersionId: set.id,
              metricSetDefinitionHash: set.definitionHash,
              expectedOutcomeRevision: command.expectedOutcomeRevision,
              sourceMode: source.sourceMode,
              providerVersion: source.providerVersion,
              sourceDigest: source.sourceDigest,
              bindingsDigest,
              valueCount: values.length,
              sourceCount: source.sources.length,
              createdByUserId: context.actor.id,
            },
          });
          await tx.activityMetricCandidateValue.createMany({
            data: values.map(({ binding, value }) => ({
              candidateId: candidate.id,
              activityId,
              setVersionId: set.id,
              definitionId: binding.metricDefinitionId,
              definitionHash: binding.definitionHash,
              bindingId: binding.id,
              valueJson: value.valueJson,
              valueHash: value.valueHash,
            })),
          });
          if (source.sources.length)
            await tx.activityMetricCandidateSource.createMany({
              data: source.sources.map((row, ordinal) => ({
                ...row,
                candidateId: candidate.id,
                activityId,
                sourceFingerprint: source.sourceFingerprints[ordinal],
              })),
            });
          const result: MetricCandidateCommandResult = {
            schemaVersion: 1,
            candidateId: candidate.id,
            activityId,
            revision: candidate.candidateRevision,
            metricSetVersionId: set.id,
            metricSetDefinitionHash: set.definitionHash,
            createdStatusCode: 'candidate',
            sourceCode: 'system',
            valueCount: candidate.valueCount,
            sourceCount: candidate.sourceCount,
            createdAt: candidate.createdAt.toISOString(),
          };
          parseMetricCandidateReceipt(result, activityId, candidate.id);
          await tx.activityMetricCandidateCommandReceipt.create({
            data: {
              ...identity,
              requestHash,
              candidateId: candidate.id,
              activityId,
              resultJson: { ...result },
            },
          });
          await this.audit.log(tx, context.actor, meta, result, candidate.priorCandidateId);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target: unknown = error.meta?.target;
        if (
          Array.isArray(target) &&
          ((target.length === 2 &&
            target[0] === 'activityId' &&
            target[1] === 'candidateRevision') ||
            (target.length === 3 &&
              target[0] === 'actorId' &&
              target[1] === 'operation' &&
              target[2] === 'operationKey'))
        )
          throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT);
      }
      throw error;
    }
  }
}

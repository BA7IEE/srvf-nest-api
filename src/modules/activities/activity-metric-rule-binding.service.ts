import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { instanceToPlain } from 'class-transformer';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { metricDefinitionDocument } from './activity-metric-presenter';
import { resolveActivityMetricRuleBinding } from './activity-metric-rule';
import { ActivityMetricRuleBindingAuditRecorder } from './activity-metric-rule-binding-audit-recorder';
import {
  metricRuleBindingRequestHash,
  parseMetricRuleBindingCommand,
  parseMetricRuleBindingReceipt,
} from './activity-metric-rule-binding-command';

@Injectable()
export class ActivityMetricRuleBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: ActivityMetricRuleBindingAuditRecorder,
  ) {}

  private async authorize(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    permission: string,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    // Writes require an explicit GLOBAL grant; catalog reads retain the existing catalog rule.
    if (
      !(await this.rbac.can(actor, permission, undefined, tx)) ||
      (permission === 'activity-metric.manage.rule-binding' &&
        !(await this.rbac.getUserPermissionCodes(actor.id, undefined, tx)).has(permission))
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }

  async create(input: object, user: CurrentUserPayload, meta: AuditMeta) {
    try {
      const command = parseMetricRuleBindingCommand(instanceToPlain(input));
      const requestHash = metricRuleBindingRequestHash(command);
      return await this.prisma.$transaction(
        async (tx) => {
          const permission = 'activity-metric.manage.rule-binding';
          let actor = await this.authorize(tx, user, permission);
          const lock = JSON.stringify([
            'activity-metric-rule-binding',
            user.id,
            'create_metric_rule_binding',
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
          actor = await this.authorize(tx, user, permission);
          const identity = {
            actorId: actor.id,
            operation: 'create_metric_rule_binding',
            operationKey: command.operationKey,
          };
          const prior = await tx.activityMetricRuleBindingCommandReceipt.findUnique({
            where: { actorId_operation_operationKey: identity },
          });
          if (prior) {
            if (prior.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT);
            try {
              return parseMetricRuleBindingReceipt(prior.resultJson, prior.bindingId);
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_RECEIPT_INVALID);
              throw error;
            }
          }
          await tx.$queryRaw`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" = ${command.metricDefinitionId} FOR UPDATE`;
          actor = await this.authorize(tx, user, permission);
          const definition = await tx.activityMetricDefinition.findFirst({
            where: { id: command.metricDefinitionId },
          });
          if (
            !definition ||
            definition.statusCode !== 'active' ||
            definition.definitionHash !== command.definitionHash
          )
            throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
          const data = resolveActivityMetricRuleBinding(
            definition.id,
            metricDefinitionDocument(definition),
            definition.definitionHash,
            command.ruleCode,
            command.evaluatorVersion,
          );
          const existing = await tx.activityMetricRuleBinding.findUnique({
            where: { bindingHash: data.bindingHash },
          });
          const binding =
            existing ??
            (await tx.activityMetricRuleBinding.create({
              data: { ...data, createdByUserId: actor.id },
            }));
          const result = parseMetricRuleBindingReceipt(
            {
              schemaVersion: 1,
              bindingId: binding.id,
              bindingHash: binding.bindingHash,
              metricDefinitionId: binding.metricDefinitionId,
              definitionHash: binding.definitionHash,
              ruleCode: binding.ruleCode,
              evaluatorVersion: binding.evaluatorVersion,
              unitCode: binding.unitCode,
              scale: binding.scale,
              createdAt: binding.createdAt.toISOString(),
            },
            binding.id,
          );
          await tx.activityMetricRuleBindingCommandReceipt.create({
            data: { ...identity, requestHash, bindingId: binding.id, resultJson: { ...result } },
          });
          await this.audit.log(tx, actor, meta, result, existing !== null);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target: unknown = error.meta?.target;
        if (
          Array.isArray(target) &&
          ((target.length === 1 && target[0] === 'bindingHash') ||
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

  async list(user: CurrentUserPayload, page: number, pageSize: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, user, 'activity-metric.read.catalog');
      const rows = await tx.activityMetricRuleBinding.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const items = rows.map((row) =>
        parseMetricRuleBindingReceipt(
          {
            schemaVersion: 1,
            bindingId: row.id,
            bindingHash: row.bindingHash,
            metricDefinitionId: row.metricDefinitionId,
            definitionHash: row.definitionHash,
            ruleCode: row.ruleCode,
            evaluatorVersion: row.evaluatorVersion,
            unitCode: row.unitCode,
            scale: row.scale,
            createdAt: row.createdAt.toISOString(),
          },
          row.id,
        ),
      );
      return { items, total: await tx.activityMetricRuleBinding.count(), page, pageSize };
    });
  }
}

import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityMetricCommand, metricHash } from './activity-metric-command';
import { ActivityMetricAuditRecorder } from './activity-metric-audit-recorder';
import {
  fingerprintActivityMetricDefinition,
  parseActivityMetricDefinition,
} from './activity-metric-definition';
import { metricCommandResult, metricDefinitionDocument } from './activity-metric-presenter';
import { assertMetricTransition, type ActivityMetricAction } from './activity-metric-state-machine';

@Injectable()
export class ActivityMetricDefinitionService {
  constructor(
    private readonly commands: ActivityMetricCommand,
    private readonly audit: ActivityMetricAuditRecorder,
  ) {}

  execute(
    action: ActivityMetricAction,
    id: string | null,
    command: {
      operationKey: string;
      expectedDefinitionHash?: string;
      definition?: unknown;
    },
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    const permission = 'activity-metric.manage.definition';
    const operation = `${action}_definition` as const;
    let definition: ReturnType<typeof parseActivityMetricDefinition> | undefined;
    let expectedHash: string | undefined;
    try {
      if (action === 'create' || action === 'update')
        definition = parseActivityMetricDefinition(instanceToPlain(command.definition));
      if (action !== 'create') expectedHash = metricHash(command.expectedDefinitionHash);
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_INVALID);
      throw error;
    }
    const fingerprint = definition ? fingerprintActivityMetricDefinition(definition) : undefined;
    return this.commands.run({
      user,
      permission,
      operation,
      operationKey: command.operationKey,
      targetId: id,
      canonicalInput: JSON.stringify([expectedHash ?? null, fingerprint?.canonicalText ?? null]),
      execute: async (tx, actor) => {
        let before: { definitionHash: string; statusCode: string } | null = null;
        let row;
        if (action === 'create' && definition && fingerprint) {
          row = await tx.activityMetricDefinition.create({
            data: {
              code: definition.code,
              version: definition.version,
              name: definition.name,
              kindCode: definition.configuration.kindCode,
              unit: definition.configuration.unit,
              configurationJson: { ...definition.configuration },
              schemaVersion: 1,
              definitionHash: fingerprint.definitionHash,
              statusCode: 'draft',
            },
          });
        } else {
          if (!id || !expectedHash)
            throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_INVALID);
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" = ${id} FOR UPDATE`,
          );
          actor = await this.commands.assertAccess(tx, actor, permission);
          const current = await tx.activityMetricDefinition.findFirst({ where: { id } });
          if (!current) throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND);
          before = current;
          const statusCode = assertMetricTransition(
            current.statusCode,
            action === 'create' ? 'update' : action,
            current.definitionHash,
            expectedHash,
          );
          if (action === 'update' && definition && fingerprint) {
            if (definition.code !== current.code || definition.version !== current.version)
              throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_INVALID);
            row = await tx.activityMetricDefinition.update({
              where: { id },
              data: {
                name: definition.name,
                kindCode: definition.configuration.kindCode,
                unit: definition.configuration.unit,
                configurationJson: { ...definition.configuration },
                definitionHash: fingerprint.definitionHash,
              },
            });
          } else {
            // Validate the stored document at the parser boundary before freezing it.
            let valid = false;
            try {
              valid =
                fingerprintActivityMetricDefinition(metricDefinitionDocument(current))
                  .definitionHash === current.definitionHash;
            } catch (error) {
              if (!(error instanceof TypeError)) throw error;
            }
            if (!valid) throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_INVALID);
            row = await tx.activityMetricDefinition.update({
              where: { id },
              data: {
                statusCode,
                ...(action === 'activate'
                  ? { activatedAt: new Date() }
                  : { retiredAt: new Date() }),
              },
            });
          }
        }
        const result = metricCommandResult(row);
        await this.audit.log({ tx, actor, meta, operation, result, before });
        return result;
      },
    });
  }
}

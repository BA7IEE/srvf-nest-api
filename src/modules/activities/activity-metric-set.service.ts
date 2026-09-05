import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityMetricCommand, metricHash } from './activity-metric-command';
import { ActivityMetricAuditRecorder } from './activity-metric-audit-recorder';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import {
  assertActivityMetricSetActivation,
  fingerprintActivityMetricSetDefinition,
  parseActivityMetricSetDefinition,
} from './activity-metric-set-definition';
import {
  metricCommandResult,
  metricDefinitionDocument,
  metricSetDocument,
} from './activity-metric-presenter';
import { assertMetricTransition, type ActivityMetricAction } from './activity-metric-state-machine';

@Injectable()
export class ActivityMetricSetService {
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
    const permission = 'activity-metric.manage.set';
    const operation = `${action}_set` as const;
    let definition: ReturnType<typeof parseActivityMetricSetDefinition> | undefined;
    let expectedHash: string | undefined;
    try {
      if (action === 'create' || action === 'update')
        definition = parseActivityMetricSetDefinition(instanceToPlain(command.definition));
      if (action !== 'create') expectedHash = metricHash(command.expectedDefinitionHash);
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_METRIC_SET_INVALID);
      throw error;
    }
    const fingerprint = definition ? fingerprintActivityMetricSetDefinition(definition) : undefined;
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
          row = await tx.activityMetricSetVersion.create({
            data: {
              code: definition.code,
              version: definition.version,
              name: definition.name,
              schemaVersion: 1,
              definitionHash: fingerprint.definitionHash,
              statusCode: 'draft',
            },
          });
          await this.replaceItems(tx, row.id, definition);
        } else {
          if (!id || !expectedHash) throw new BizException(BizCode.ACTIVITY_METRIC_SET_INVALID);
          await tx.$queryRaw`SELECT "id" FROM "ActivityMetricSetVersion" WHERE "id" = ${id} FOR UPDATE`;
          actor = await this.commands.assertAccess(tx, actor, permission);
          const current = await tx.activityMetricSetVersion.findFirst({
            where: { id },
            include: { items: { include: { metricDefinition: true } } },
          });
          if (!current) throw new BizException(BizCode.ACTIVITY_METRIC_SET_NOT_FOUND);
          before = current;
          const statusCode = assertMetricTransition(
            current.statusCode,
            action === 'create' ? 'update' : action,
            current.definitionHash,
            expectedHash,
          );
          if (action === 'update' && definition && fingerprint) {
            if (definition.code !== current.code || definition.version !== current.version)
              throw new BizException(BizCode.ACTIVITY_METRIC_SET_INVALID);
            await this.replaceItems(tx, id, definition);
            row = await tx.activityMetricSetVersion.update({
              where: { id },
              data: { name: definition.name, definitionHash: fingerprint.definitionHash },
            });
          } else {
            if (action === 'activate') {
              if (current.items.length === 0)
                throw new BizException(BizCode.ACTIVITY_METRIC_SET_INVALID);
              const ids = current.items.map((item) => item.metricDefinitionId).sort();
              await tx.$queryRaw(
                Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`,
              );
              const definitions = await tx.activityMetricDefinition.findMany({
                where: { id: { in: ids } },
              });
              // Reread after reference locks: the earlier include could precede a concurrent edit.
              const locked = await tx.activityMetricSetVersion.findFirstOrThrow({
                where: { id },
                include: { items: { include: { metricDefinition: true } } },
              });
              try {
                assertActivityMetricSetActivation(
                  metricSetDocument(locked),
                  current.definitionHash,
                  definitions.map((value) => ({
                    ...value,
                    definition: metricDefinitionDocument(value),
                  })),
                );
              } catch (error) {
                if (error instanceof TypeError)
                  throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
                throw error;
              }
            }
            row = await tx.activityMetricSetVersion.update({
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

  private async replaceItems(
    tx: Prisma.TransactionClient,
    id: string,
    definition: ReturnType<typeof parseActivityMetricSetDefinition>,
  ) {
    const ids = definition.items.map((item) => item.metricDefinitionId).sort();
    if (ids.length > 0) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`,
      );
      const rows = await tx.activityMetricDefinition.findMany({ where: { id: { in: ids } } });
      for (const item of definition.items) {
        const row = rows.find((candidate) => candidate.id === item.metricDefinitionId);
        if (!row || row.definitionHash !== item.definitionHash)
          throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
        try {
          if (
            fingerprintActivityMetricDefinition(metricDefinitionDocument(row)).definitionHash !==
            row.definitionHash
          )
            throw new TypeError('invalid referenced hash');
        } catch (error) {
          if (error instanceof TypeError)
            throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
          throw error;
        }
      }
    }
    // Only draft child replacement; D1 trigger checks/locks the parent. No version deletion.
    await tx.$executeRaw`DELETE FROM "ActivityMetricSetItem" WHERE "setVersionId" = ${id}`;
    if (definition.items.length > 0)
      await tx.activityMetricSetItem.createMany({
        data: definition.items.map((item) => ({
          setVersionId: id,
          metricDefinitionId: item.metricDefinitionId,
          key: item.key,
          sortOrder: item.sortOrder,
          required: item.required,
        })),
      });
  }
}

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityMetricCommand, metricHash } from './activity-metric-command';
import { metricInteger, metricObject, metricText } from './activity-metric-definition';
import {
  metricStatus,
  type ActivityMetricAction,
  type ActivityMetricStatus,
} from './activity-metric-state-machine';

export type TemplateVersionOperation = `${ActivityMetricAction}_template_version`;
export interface TemplateVersionCommandResult {
  id: string;
  code: string;
  version: number;
  schemaVersion: 3 | 4;
  statusCode: ActivityMetricStatus;
  definitionHash: string;
}
export function parseTemplateVersionReceipt(
  value: unknown,
  targetId?: string,
  operation?: TemplateVersionOperation,
): TemplateVersionCommandResult {
  try {
    const v = metricObject(value, [
      'id',
      'code',
      'version',
      'schemaVersion',
      'statusCode',
      'definitionHash',
    ]);
    const id = metricText(v.id, 64);
    if (
      (v.schemaVersion !== 3 && v.schemaVersion !== 4) ||
      (targetId !== undefined && targetId !== id)
    )
      throw new TypeError('invalid template receipt');
    const statusCode = metricStatus(v.statusCode);
    if (
      operation &&
      statusCode !==
        (operation === 'activate_template_version'
          ? 'active'
          : operation === 'retire_template_version'
            ? 'retired'
            : 'draft')
    )
      throw new TypeError('wrong receipt status');
    return {
      id,
      code: metricText(v.code, 64),
      version: metricInteger(v.version, 1, 2147483647),
      schemaVersion: v.schemaVersion,
      statusCode,
      definitionHash: metricHash(v.definitionHash),
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof BizException)
      throw new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID);
    throw error;
  }
}

@Injectable()
export class ActivityTemplateVersionCommand {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: ActivityMetricCommand,
  ) {}
  assertAccess(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    permission = 'activity-template.manage.version',
  ) {
    return this.identity.assertAccess(tx, user, permission);
  }
  async run(args: {
    user: CurrentUserPayload;
    operation: TemplateVersionOperation;
    operationKey: string;
    targetId: string | null;
    canonicalInput: string;
    execute: (
      tx: Prisma.TransactionClient,
      actor: CurrentUserPayload,
    ) => Promise<TemplateVersionCommandResult>;
    /** V4 callers can require their additional catalogue qualification even on an idempotent replay. */
    revalidateReplay?: (
      tx: Prisma.TransactionClient,
      actor: CurrentUserPayload,
      result: TemplateVersionCommandResult,
    ) => Promise<void>;
  }) {
    let key: string;
    try {
      key = metricText(args.operationKey, 128);
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.BAD_REQUEST);
      throw error;
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify([args.operation, args.targetId, args.canonicalInput]))
      .digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        let actor = await this.assertAccess(tx, args.user);
        const lockKey = JSON.stringify(['activity-metric', actor.id, args.operation, key]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        actor = await this.assertAccess(tx, args.user);
        const identity = {
          actorUserId: actor.id,
          operationCode: args.operation,
          operationKey: key,
        };
        const prior = await tx.activityMetricCommandReceipt.findUnique({
          where: { actorUserId_operationCode_operationKey: identity },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new BizException(BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT);
          if (
            !prior.templateVersionId ||
            prior.activityId !== null ||
            prior.definitionId !== null ||
            prior.setVersionId !== null ||
            (args.targetId !== null && prior.templateVersionId !== args.targetId)
          )
            throw new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID);
          await tx.$queryRaw`SELECT "id" FROM "ActivityTemplate" WHERE "id" = ${prior.templateVersionId} FOR SHARE`;
          await this.assertAccess(tx, args.user);
          const target = await tx.activityTemplate.findFirst({
            where: {
              id: prior.templateVersionId,
              family: { scopeTypeCode: 'global', ownerOrganizationId: null, statusCode: 'active' },
            },
            select: { id: true },
          });
          if (!target) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
          const result = parseTemplateVersionReceipt(prior.resultJson, target.id, args.operation);
          await args.revalidateReplay?.(tx, actor, result);
          return result;
        }
        const result = parseTemplateVersionReceipt(
          await args.execute(tx, actor),
          args.targetId ?? undefined,
          args.operation,
        );
        await tx.activityMetricCommandReceipt.create({
          data: {
            ...identity,
            requestHash,
            templateVersionId: result.id,
            resultJson: { ...result },
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target: unknown = error.meta?.target;
        if (
          Array.isArray(target) &&
          ((target.length === 1 && target[0] === 'code') ||
            (target.length === 2 &&
              ['code', 'familyId'].includes(String(target[0])) &&
              target[1] === 'version'))
        )
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_ALREADY_EXISTS);
      }
      throw error;
    }
  }
}

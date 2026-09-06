import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { metricCode, metricInteger, metricObject, metricText } from './activity-metric-definition';
import {
  metricStatus,
  type ActivityMetricAction,
  type ActivityMetricStatus,
} from './activity-metric-state-machine';

export type MetricOperation = `${ActivityMetricAction}_${'definition' | 'set'}`;
export interface MetricCommandResult {
  id: string;
  code: string;
  version: number;
  schemaVersion: 1;
  statusCode: ActivityMetricStatus;
  definitionHash: string;
}

export function metricHash(value: unknown): string {
  const text = metricText(value, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError('invalid metric hash');
  return text;
}

export function parseMetricReceipt(value: unknown): MetricCommandResult {
  try {
    const row = metricObject(value, [
      'id',
      'code',
      'version',
      'schemaVersion',
      'statusCode',
      'definitionHash',
    ]);
    if (row.schemaVersion !== 1) throw new TypeError('invalid receipt schema');
    return {
      id: metricText(row.id, 64),
      code: metricCode(row.code),
      version: metricInteger(row.version, 1, 2147483647),
      schemaVersion: 1,
      statusCode: metricStatus(row.statusCode),
      definitionHash: metricHash(row.definitionHash),
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof BizException)
      throw new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID);
    throw error;
  }
}

export function metricRequestHash(
  operation: MetricOperation,
  targetId: string | null,
  canonicalInput: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([operation, targetId, canonicalInput]))
    .digest('hex');
}

@Injectable()
export class ActivityMetricCommand {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async assertAccess(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    permission: string,
  ): Promise<CurrentUserPayload> {
    const current = await loadActiveUserIdentityInTx(tx, user.id);
    if (!current) throw new BizException(BizCode.UNAUTHORIZED);
    if (!(await this.rbac.can(current, permission, undefined, tx)))
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return current;
  }

  async run(args: {
    user: CurrentUserPayload;
    permission: string;
    operation: MetricOperation;
    operationKey: string;
    targetId: string | null;
    canonicalInput: string;
    execute: (
      tx: Prisma.TransactionClient,
      actor: CurrentUserPayload,
    ) => Promise<MetricCommandResult>;
  }): Promise<MetricCommandResult> {
    let key: string;
    try {
      key = metricText(args.operationKey, 128);
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.BAD_REQUEST);
      throw error;
    }
    const hash = metricRequestHash(args.operation, args.targetId, args.canonicalInput);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertAccess(tx, args.user, args.permission);
        const lockKey = JSON.stringify(['activity-metric', args.user.id, args.operation, key]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        // A waiter must not replay a receipt using identity/permissions read before the wait.
        const actor = await this.assertAccess(tx, args.user, args.permission);
        const prior = await tx.activityMetricCommandReceipt.findUnique({
          where: {
            actorUserId_operationCode_operationKey: {
              actorUserId: actor.id,
              operationCode: args.operation,
              operationKey: key,
            },
          },
        });
        if (prior) {
          if (prior.requestHash !== hash)
            throw new BizException(BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT);
          const result = parseMetricReceipt(prior.resultJson);
          const target = args.operation.endsWith('_definition')
            ? prior.definitionId
            : prior.setVersionId;
          const status = args.operation.startsWith('activate_')
            ? 'active'
            : args.operation.startsWith('retire_')
              ? 'retired'
              : 'draft';
          if (
            result.id !== target ||
            result.statusCode !== status ||
            (args.targetId !== null && result.id !== args.targetId)
          )
            throw new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID);
          return result;
        }
        const result = parseMetricReceipt(await args.execute(tx, actor));
        await tx.activityMetricCommandReceipt.create({
          data: {
            actorUserId: actor.id,
            operationCode: args.operation,
            operationKey: key,
            requestHash: hash,
            resultJson: { ...result },
            ...(args.operation.endsWith('_definition')
              ? { definitionId: result.id }
              : { setVersionId: result.id }),
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target: unknown = error.meta?.target;
        if (
          Array.isArray(target) &&
          target.length === 2 &&
          target[0] === 'code' &&
          target[1] === 'version'
        )
          throw new BizException(BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS);
      }
      throw error;
    }
  }
}

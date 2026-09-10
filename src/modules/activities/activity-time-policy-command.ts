import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';

export type TimePolicyOperation =
  | 'create_policy'
  | 'create_version'
  | 'activate_version'
  | 'retire_version';
export type TimePolicyPermission =
  | 'activity-time-policy.read.catalog'
  | 'activity-time-policy.manage.version';
export interface TimePolicyCommandResult {
  schemaVersion: 1;
  operationCode: TimePolicyOperation;
  policyId: string;
  versionId: string | null;
  definitionHash: string | null;
  resultStatusCode: 'draft' | 'active' | 'retired' | null;
  createdAt: string;
}

export function timePolicyText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((c) => {
      const n = c.charCodeAt(0);
      return n < 32 || (n >= 127 && n <= 159);
    })
  )
    throw new TypeError('Invalid time policy text');
  return value;
}

export function timePolicyObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  canonicalizeActivityTemplateDefinition(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new TypeError('Invalid time policy object');
  return Object.fromEntries(Object.entries(value));
}

export function timePolicyHash(value: unknown): string {
  const hash = timePolicyText(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError('Invalid time policy hash');
  return hash;
}

export function parseTimePolicyReceipt(value: unknown): TimePolicyCommandResult {
  try {
    const r = timePolicyObject(value, [
      'schemaVersion',
      'operationCode',
      'policyId',
      'versionId',
      'definitionHash',
      'resultStatusCode',
      'createdAt',
    ]);
    const op = r.operationCode;
    if (
      r.schemaVersion !== 1 ||
      (op !== 'create_policy' &&
        op !== 'create_version' &&
        op !== 'activate_version' &&
        op !== 'retire_version')
    )
      throw new TypeError('Invalid operation');
    const expected =
      op === 'create_policy'
        ? null
        : op === 'create_version'
          ? 'draft'
          : op === 'activate_version'
            ? 'active'
            : 'retired';
    if (r.resultStatusCode !== expected) throw new TypeError('Invalid status');
    if (op === 'create_policy' && (r.versionId !== null || r.definitionHash !== null))
      throw new TypeError('Invalid policy receipt');
    const createdAt = timePolicyText(r.createdAt, 24);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
      !Number.isFinite(new Date(createdAt).getTime()) ||
      new Date(createdAt).toISOString() !== createdAt
    )
      throw new TypeError('Invalid receipt instant');
    return {
      schemaVersion: 1,
      operationCode: op,
      policyId: timePolicyText(r.policyId, 64),
      versionId: op === 'create_policy' ? null : timePolicyText(r.versionId, 64),
      definitionHash: op === 'create_policy' ? null : timePolicyHash(r.definitionHash),
      resultStatusCode: expected,
      createdAt,
    };
  } catch (error) {
    if (error instanceof TypeError)
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
    throw error;
  }
}

export function timePolicyRequestHash(
  operation: TimePolicyOperation,
  policyId: string | null,
  versionId: string | null,
  input: unknown,
): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: { operation, policyId, versionId, input },
  });
}

@Injectable()
export class ActivityTimePolicyCommand {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async assertAccess(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    permission: TimePolicyPermission,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (
      !(await this.rbac.can(actor, permission, undefined, tx)) ||
      !(await this.rbac.getUserPermissionCodes(actor.id, undefined, tx)).has(permission)
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }

  async run(args: {
    user: CurrentUserPayload;
    operation: TimePolicyOperation;
    operationKey: string;
    policyId: string | null;
    versionId: string | null;
    input: unknown;
    execute: (
      tx: Prisma.TransactionClient,
      actor: CurrentUserPayload,
    ) => Promise<TimePolicyCommandResult>;
  }): Promise<TimePolicyCommandResult> {
    let key: string;
    let requestHash: string;
    try {
      key = timePolicyText(args.operationKey, 128);
      requestHash = timePolicyRequestHash(
        args.operation,
        args.policyId,
        args.versionId,
        args.input,
      );
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_INVALID);
      throw error;
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const permission = 'activity-time-policy.manage.version';
          await this.assertAccess(tx, args.user, permission);
          const lock = JSON.stringify(['activity-time-policy', args.user.id, args.operation, key]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
          const actor = await this.assertAccess(tx, args.user, permission);
          const prior = await tx.timePolicyCommandReceipt.findUnique({
            where: {
              actorUserId_operationCode_operationKey: {
                actorUserId: actor.id,
                operationCode: args.operation,
                operationKey: key,
              },
            },
          });
          if (prior) {
            if (prior.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT);
            const result = parseTimePolicyReceipt(prior.resultJson);
            if (
              result.operationCode !== args.operation ||
              result.policyId !== prior.policyId ||
              result.versionId !== prior.versionId ||
              result.definitionHash !== prior.definitionHash ||
              (args.policyId !== null && result.policyId !== args.policyId) ||
              (args.versionId !== null && result.versionId !== args.versionId)
            )
              throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
            if (result.versionId !== null) {
              const anchor = await tx.timePolicyVersion.findFirst({
                where: {
                  id: result.versionId,
                  policyId: result.policyId,
                  definitionHash: result.definitionHash ?? '',
                },
                select: { id: true },
              });
              if (!anchor) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
            } else if (
              !(await tx.timePolicy.findFirst({
                where: { id: result.policyId },
                select: { id: true },
              }))
            )
              throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
            return result;
          }
          const result = parseTimePolicyReceipt(await args.execute(tx, actor));
          if (
            result.operationCode !== args.operation ||
            (args.policyId !== null && result.policyId !== args.policyId) ||
            (args.versionId !== null && result.versionId !== args.versionId)
          )
            throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
          await tx.timePolicyCommandReceipt.create({
            data: {
              actorUserId: actor.id,
              operationCode: args.operation,
              operationKey: key,
              requestHash,
              policyId: result.policyId,
              versionId: result.versionId,
              definitionHash: result.definitionHash,
              resultJson: { ...result },
              createdAt: new Date(result.createdAt),
            },
          });
          return result;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 2000,
          timeout: 5000,
        },
      );
    } catch (error) {
      if (
        args.operation === 'create_policy' &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.length === 1 &&
        error.meta.target[0] === 'code'
      )
        throw new BizException(BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS);
      throw error;
    }
  }
}

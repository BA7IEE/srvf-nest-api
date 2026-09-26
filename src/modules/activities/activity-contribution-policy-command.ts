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
import {
  fingerprintContributionPolicyVersion,
  type ContributionPolicyDefinition,
} from './activity-contribution-policy-definition';

export type ContributionPolicyOperation =
  | 'create_policy'
  | 'create_version'
  | 'activate_version'
  | 'retire_version';
export type ContributionPolicyPermission =
  | 'contribution-policy.read.catalog'
  | 'contribution-policy.manage.version';
export interface ContributionPolicyCommandResult {
  schemaVersion: 1;
  operationCode: ContributionPolicyOperation;
  policyId: string;
  versionId: string | null;
  definitionHash: string | null;
  evaluatorVersion: number | null;
  resultStatusCode: 'draft' | 'active' | 'retired' | null;
  createdAt: string;
}

export function contributionPolicyText(value: unknown, maximum: number): string {
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
    throw new TypeError('Invalid contribution policy text');
  return value;
}

export function contributionPolicyObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  canonicalizeActivityTemplateDefinition(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new TypeError('Invalid contribution policy object');
  return Object.fromEntries(Object.entries(value));
}

export function contributionPolicyHash(value: unknown): string {
  const hash = contributionPolicyText(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError('Invalid contribution policy hash');
  return hash;
}

export function parseContributionPolicyReceipt(value: unknown): ContributionPolicyCommandResult {
  try {
    const r = contributionPolicyObject(value, [
      'schemaVersion',
      'operationCode',
      'policyId',
      'versionId',
      'definitionHash',
      'evaluatorVersion',
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
    if (
      op === 'create_policy'
        ? r.versionId !== null || r.definitionHash !== null || r.evaluatorVersion !== null
        : r.evaluatorVersion !== 1
    )
      throw new TypeError('Invalid policy receipt');
    const createdAt = contributionPolicyText(r.createdAt, 24);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
      !Number.isFinite(new Date(createdAt).getTime()) ||
      new Date(createdAt).toISOString() !== createdAt
    )
      throw new TypeError('Invalid receipt instant');
    return {
      schemaVersion: 1,
      operationCode: op,
      policyId: contributionPolicyText(r.policyId, 64),
      versionId: op === 'create_policy' ? null : contributionPolicyText(r.versionId, 64),
      definitionHash: op === 'create_policy' ? null : contributionPolicyHash(r.definitionHash),
      evaluatorVersion: op === 'create_policy' ? null : 1,
      resultStatusCode: expected,
      createdAt,
    };
  } catch (error) {
    if (error instanceof TypeError)
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
    throw error;
  }
}

export function contributionPolicyRequestHash(
  operation: ContributionPolicyOperation,
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
export class ActivityContributionPolicyCommand {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /** E2 owner primitive: caller owns the transaction, locks, authorization and audit. */
  async createDraftCandidateInTx(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    input: {
      code: string;
      name: string;
      definition: ContributionPolicyDefinition;
      effectiveFrom: string;
    },
  ) {
    const code = contributionPolicyText(input.code, 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code))
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID);
    const name = contributionPolicyText(input.name, 120);
    const version = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition: input.definition,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: null,
    });
    if (await tx.contributionPolicy.findUnique({ where: { code }, select: { id: true } }))
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS);
    const policy = await tx.contributionPolicy.create({ data: { code, name } });
    const draft = await tx.contributionPolicyVersion.create({
      data: {
        policyId: policy.id,
        version: 1,
        schemaVersion: 1,
        evaluatorVersion: 1,
        definitionJson: { ...version.definition } as unknown as Prisma.InputJsonValue,
        definitionHash: version.definitionHash,
        effectiveFrom: new Date(version.effectiveFrom),
        effectiveUntil: null,
        statusCode: 'draft',
        createdByUserId: actor.id,
      },
    });
    return { policy, draft };
  }

  async assertAccess(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    permission: ContributionPolicyPermission,
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
    operation: ContributionPolicyOperation;
    operationKey: string;
    policyId: string | null;
    versionId: string | null;
    input: unknown;
    execute: (
      tx: Prisma.TransactionClient,
      actor: CurrentUserPayload,
    ) => Promise<ContributionPolicyCommandResult>;
  }): Promise<ContributionPolicyCommandResult> {
    let key: string;
    let requestHash: string;
    try {
      key = contributionPolicyText(args.operationKey, 128);
      requestHash = contributionPolicyRequestHash(
        args.operation,
        args.policyId,
        args.versionId,
        args.input,
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID);
      throw error;
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const permission = 'contribution-policy.manage.version';
          await this.assertAccess(tx, args.user, permission);
          const lock = JSON.stringify(['contribution-policy', args.user.id, args.operation, key]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
          const actor = await this.assertAccess(tx, args.user, permission);
          const prior = await tx.contributionPolicyCommandReceipt.findUnique({
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
              throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT);
            const result = parseContributionPolicyReceipt(prior.resultJson);
            if (
              result.operationCode !== args.operation ||
              result.policyId !== prior.policyId ||
              result.versionId !== prior.versionId ||
              result.definitionHash !== prior.definitionHash ||
              result.evaluatorVersion !== prior.evaluatorVersion ||
              (args.policyId !== null && result.policyId !== args.policyId) ||
              (args.versionId !== null && result.versionId !== args.versionId)
            )
              throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
            if (result.versionId !== null) {
              const anchor = await tx.contributionPolicyVersion.findFirst({
                where: {
                  id: result.versionId,
                  policyId: result.policyId,
                  definitionHash: result.definitionHash ?? '',
                  evaluatorVersion: result.evaluatorVersion ?? -1,
                },
                select: { id: true },
              });
              if (!anchor)
                throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
            } else if (
              !(await tx.contributionPolicy.findFirst({
                where: { id: result.policyId },
                select: { id: true },
              }))
            )
              throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
            return result;
          }
          const result = parseContributionPolicyReceipt(await args.execute(tx, actor));
          if (
            result.operationCode !== args.operation ||
            (args.policyId !== null && result.policyId !== args.policyId) ||
            (args.versionId !== null && result.versionId !== args.versionId)
          )
            throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
          await tx.contributionPolicyCommandReceipt.create({
            data: {
              actorUserId: actor.id,
              operationCode: args.operation,
              operationKey: key,
              requestHash,
              policyId: result.policyId,
              versionId: result.versionId,
              definitionHash: result.definitionHash,
              evaluatorVersion: result.evaluatorVersion,
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
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS);
      throw error;
    }
  }
}

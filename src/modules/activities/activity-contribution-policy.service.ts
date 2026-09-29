import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityContributionPolicyCommand,
  contributionPolicyHash,
  contributionPolicyObject,
  contributionPolicyText,
  type ContributionPolicyCommandResult,
} from './activity-contribution-policy-command';
import { ActivityContributionPolicyAuditRecorder } from './activity-contribution-policy-audit-recorder';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import { contributionPolicyVersionDocument } from './activity-contribution-policy-presenter';
import { canTransitionContributionPolicyVersion } from './activity-contribution-policy-state-machine';

@Injectable()
export class ActivityContributionPolicyService {
  constructor(
    private readonly commands: ActivityContributionPolicyCommand,
    private readonly audit: ActivityContributionPolicyAuditRecorder,
  ) {}

  private parse<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID);
      throw error;
    }
  }

  createPolicy(input: object, user: CurrentUserPayload, meta: AuditMeta) {
    const parsed = this.parse(() => {
      const plain = instanceToPlain(input, { exposeUnsetFields: false });
      const hasDescription =
        typeof plain === 'object' &&
        plain !== null &&
        Object.prototype.hasOwnProperty.call(plain, 'description');
      const r = contributionPolicyObject(
        plain,
        hasDescription
          ? ['operationKey', 'code', 'name', 'description']
          : ['operationKey', 'code', 'name'],
      );
      const code = contributionPolicyText(r.code, 64);
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code)) throw new TypeError('Invalid code');
      return {
        operationKey: contributionPolicyText(r.operationKey, 128),
        code,
        name: contributionPolicyText(r.name, 120),
        description: hasDescription ? contributionPolicyText(r.description, 500) : null,
      };
    });
    return this.commands.run({
      user,
      operation: 'create_policy',
      operationKey: parsed.operationKey,
      policyId: null,
      versionId: null,
      input: { code: parsed.code, name: parsed.name, description: parsed.description },
      execute: async (tx, actor) => {
        if (
          await tx.contributionPolicy.findUnique({
            where: { code: parsed.code },
            select: { id: true },
          })
        )
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS);
        const row = await tx.contributionPolicy.create({
          data: {
            code: parsed.code,
            name: parsed.name,
            description: parsed.description,
          },
        });
        const result: ContributionPolicyCommandResult = {
          schemaVersion: 1,
          operationCode: 'create_policy',
          policyId: row.id,
          versionId: null,
          definitionHash: null,
          evaluatorVersion: null,
          resultStatusCode: null,
          createdAt: row.createdAt.toISOString(),
        };
        await this.audit.log(tx, actor, meta, result, null);
        return result;
      },
    });
  }

  createVersion(policyId: string, input: object, user: CurrentUserPayload, meta: AuditMeta) {
    const parsed = this.parse(() => {
      const r = contributionPolicyObject(instanceToPlain(input, { exposeUnsetFields: false }), [
        'operationKey',
        'schemaVersion',
        'evaluatorVersion',
        'definition',
        'effectiveFrom',
        'effectiveUntil',
      ]);
      return {
        operationKey: contributionPolicyText(r.operationKey, 128),
        version: fingerprintContributionPolicyVersion({
          schemaVersion: r.schemaVersion,
          evaluatorVersion: r.evaluatorVersion,
          definition: r.definition,
          effectiveFrom: r.effectiveFrom,
          effectiveUntil: r.effectiveUntil,
        }),
      };
    });
    return this.commands.run({
      user,
      operation: 'create_version',
      operationKey: parsed.operationKey,
      policyId,
      versionId: null,
      input: parsed.version,
      execute: async (tx, actor) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ContributionPolicy" WHERE "id" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'contribution-policy.manage.version');
        if (
          !(await tx.contributionPolicy.findFirst({
            where: { id: policyId },
            select: { id: true },
          }))
        )
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
        const latest = await tx.contributionPolicyVersion.findFirst({
          where: { policyId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        if (latest && latest.version >= 2147483647)
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT);
        const v = parsed.version;
        const row = await tx.contributionPolicyVersion.create({
          data: {
            policyId,
            version: (latest?.version ?? 0) + 1,
            schemaVersion: 1,
            evaluatorVersion: 1,
            definitionJson: { ...v.definition } as unknown as Prisma.InputJsonValue,
            definitionHash: v.definitionHash,
            effectiveFrom: new Date(v.effectiveFrom),
            effectiveUntil: v.effectiveUntil === null ? null : new Date(v.effectiveUntil),
            statusCode: 'draft',
            createdByUserId: actor.id,
          },
        });
        const result: ContributionPolicyCommandResult = {
          schemaVersion: 1,
          operationCode: 'create_version',
          policyId,
          versionId: row.id,
          definitionHash: row.definitionHash,
          evaluatorVersion: row.evaluatorVersion,
          resultStatusCode: 'draft',
          createdAt: row.createdAt.toISOString(),
        };
        await this.audit.log(tx, actor, meta, result, null);
        return result;
      },
    });
  }

  transition(
    action: 'activate' | 'retire',
    policyId: string,
    versionId: string,
    input: object,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    const parsed = this.parse(() => {
      const r = contributionPolicyObject(instanceToPlain(input, { exposeUnsetFields: false }), [
        'operationKey',
        'expectedDefinitionHash',
        'expectedStatusCode',
      ]);
      const expectedStatusCode = action === 'activate' ? 'draft' : 'active';
      if (r.expectedStatusCode !== expectedStatusCode)
        throw new TypeError('Invalid expected status');
      return {
        operationKey: contributionPolicyText(r.operationKey, 128),
        expectedStatusCode,
        expectedDefinitionHash: contributionPolicyHash(r.expectedDefinitionHash),
      };
    });
    const operation = action === 'activate' ? 'activate_version' : 'retire_version';
    return this.commands.run({
      user,
      operation,
      operationKey: parsed.operationKey,
      policyId,
      versionId,
      input: {
        expectedStatusCode: parsed.expectedStatusCode,
        expectedDefinitionHash: parsed.expectedDefinitionHash,
      },
      execute: async (tx, actor) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ContributionPolicy" WHERE "id" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'contribution-policy.manage.version');
        if (
          !(await tx.contributionPolicy.findFirst({
            where: { id: policyId },
            select: { id: true },
          }))
        )
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ContributionPolicyVersion" WHERE "id" = ${versionId} AND "policyId" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'contribution-policy.manage.version');
        const before = await tx.contributionPolicyVersion.findFirst({
          where: { id: versionId, policyId },
        });
        if (!before) throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
        if (
          before.definitionHash !== parsed.expectedDefinitionHash ||
          before.statusCode !== parsed.expectedStatusCode
        )
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE);
        const statusCode = action === 'activate' ? 'active' : 'retired';
        if (!canTransitionContributionPolicyVersion(before.statusCode, statusCode))
          throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID);
        contributionPolicyVersionDocument(before);
        const now = new Date();
        await tx.contributionPolicyVersion.update({
          where: { id: versionId },
          data: {
            statusCode,
            ...(action === 'activate'
              ? { activatedAt: now, activatedByUserId: actor.id }
              : { retiredAt: now, retiredByUserId: actor.id }),
          },
        });
        const result: ContributionPolicyCommandResult = {
          schemaVersion: 1,
          operationCode: operation,
          policyId,
          versionId,
          definitionHash: before.definitionHash,
          evaluatorVersion: before.evaluatorVersion,
          resultStatusCode: statusCode,
          createdAt: now.toISOString(),
        };
        await this.audit.log(tx, actor, meta, result, before);
        return result;
      },
    });
  }
}

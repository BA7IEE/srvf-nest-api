import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityTimePolicyCommand,
  timePolicyHash,
  timePolicyObject,
  timePolicyText,
  type TimePolicyCommandResult,
} from './activity-time-policy-command';
import { ActivityTimePolicyAuditRecorder } from './activity-time-policy-audit-recorder';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';
import { canTransitionTimePolicyVersion } from './activity-time-policy-state-machine';

@Injectable()
export class ActivityTimePolicyService {
  constructor(
    private readonly commands: ActivityTimePolicyCommand,
    private readonly audit: ActivityTimePolicyAuditRecorder,
  ) {}

  private parse<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_INVALID);
      throw error;
    }
  }

  createPolicy(input: object, user: CurrentUserPayload, meta: AuditMeta) {
    const parsed = this.parse(() => {
      const r = timePolicyObject(instanceToPlain(input, { exposeUnsetFields: false }), [
        'operationKey',
        'code',
        'name',
      ]);
      const code = timePolicyText(r.code, 64);
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code)) throw new TypeError('Invalid code');
      return {
        operationKey: timePolicyText(r.operationKey, 128),
        code,
        name: timePolicyText(r.name, 120),
      };
    });
    return this.commands.run({
      user,
      operation: 'create_policy',
      operationKey: parsed.operationKey,
      policyId: null,
      versionId: null,
      input: { code: parsed.code, name: parsed.name },
      execute: async (tx, actor) => {
        if (await tx.timePolicy.findUnique({ where: { code: parsed.code }, select: { id: true } }))
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS);
        const row = await tx.timePolicy.create({ data: { code: parsed.code, name: parsed.name } });
        const result: TimePolicyCommandResult = {
          schemaVersion: 1,
          operationCode: 'create_policy',
          policyId: row.id,
          versionId: null,
          definitionHash: null,
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
      const r = timePolicyObject(instanceToPlain(input, { exposeUnsetFields: false }), [
        'operationKey',
        'schemaVersion',
        'evaluatorVersion',
        'definition',
        'effectiveFrom',
        'effectiveUntil',
      ]);
      return {
        operationKey: timePolicyText(r.operationKey, 128),
        version: fingerprintTimePolicyVersion({
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
          Prisma.sql`SELECT "id" FROM "TimePolicy" WHERE "id" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'activity-time-policy.manage.version');
        if (!(await tx.timePolicy.findFirst({ where: { id: policyId }, select: { id: true } })))
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
        const latest = await tx.timePolicyVersion.findFirst({
          where: { policyId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        if (latest && latest.version >= 2147483647)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT);
        const v = parsed.version;
        const row = await tx.timePolicyVersion.create({
          data: {
            policyId,
            version: (latest?.version ?? 0) + 1,
            schemaVersion: 1,
            evaluatorVersion: 1,
            definitionJson: { ...v.definition },
            definitionHash: v.definitionHash,
            effectiveFrom: new Date(v.effectiveFrom),
            effectiveUntil: v.effectiveUntil === null ? null : new Date(v.effectiveUntil),
            statusCode: 'draft',
          },
        });
        const result: TimePolicyCommandResult = {
          schemaVersion: 1,
          operationCode: 'create_version',
          policyId,
          versionId: row.id,
          definitionHash: row.definitionHash,
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
      const r = timePolicyObject(instanceToPlain(input, { exposeUnsetFields: false }), [
        'operationKey',
        'expectedDefinitionHash',
        'expectedStatusCode',
      ]);
      const expectedStatusCode = action === 'activate' ? 'draft' : 'active';
      if (r.expectedStatusCode !== expectedStatusCode)
        throw new TypeError('Invalid expected status');
      return {
        operationKey: timePolicyText(r.operationKey, 128),
        expectedStatusCode,
        expectedDefinitionHash: timePolicyHash(r.expectedDefinitionHash),
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
          Prisma.sql`SELECT "id" FROM "TimePolicy" WHERE "id" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'activity-time-policy.manage.version');
        if (!(await tx.timePolicy.findFirst({ where: { id: policyId }, select: { id: true } })))
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "TimePolicyVersion" WHERE "id" = ${versionId} AND "policyId" = ${policyId} FOR UPDATE`,
        );
        actor = await this.commands.assertAccess(tx, actor, 'activity-time-policy.manage.version');
        const before = await tx.timePolicyVersion.findFirst({ where: { id: versionId, policyId } });
        if (!before) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
        if (
          before.definitionHash !== parsed.expectedDefinitionHash ||
          before.statusCode !== parsed.expectedStatusCode
        )
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_STALE);
        const statusCode = action === 'activate' ? 'active' : 'retired';
        if (!canTransitionTimePolicyVersion(before.statusCode, statusCode))
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID);
        timePolicyVersionDocument(before);
        const now = new Date();
        await tx.timePolicyVersion.update({
          where: { id: versionId },
          data: {
            statusCode,
            ...(action === 'activate' ? { activatedAt: now } : { retiredAt: now }),
          },
        });
        const result: TimePolicyCommandResult = {
          schemaVersion: 1,
          operationCode: operation,
          policyId,
          versionId,
          definitionHash: before.definitionHash,
          resultStatusCode: statusCode,
          createdAt: now.toISOString(),
        };
        await this.audit.log(tx, actor, meta, result, before);
        return result;
      },
    });
  }
}

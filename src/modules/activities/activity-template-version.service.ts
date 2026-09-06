import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import type { ActivityTemplate, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAccessService } from './activity-access.service';
import { metricHash } from './activity-metric-command';
import { metricInteger, metricText } from './activity-metric-definition';
import {
  parseActivityMetricSelection,
  type ActivityMetricSelection,
} from './activity-metric-selection';
import { lockMetricSelectionReference } from './activity-metric-selection-access';
import { fingerprintActivityTemplateDefinition } from './activity-template-definition';
import {
  parseActivityTemplateDefinitionV3,
  type ActivityTemplateDefinitionV3,
} from './activity-template-definition-v3';
import {
  ActivityTemplateVersionCommand,
  parseTemplateVersionReceipt,
} from './activity-template-version-command';
import { ActivityTemplateVersionAuditRecorder } from './activity-template-version-audit-recorder';
import {
  globalTemplateFamilyWhere,
  parseStoredTemplateVersion,
} from './activity-template-version-presenter';
import { canonicalizeRegistrationFormDefinitionForB3 } from './registration-form-definition';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';
import { ActivityTemplateDefinitionV1Error } from './activity-template-definition-v1';

export interface CreateTemplateVersionCommand {
  operationKey: string;
  familyId?: string;
  code?: string;
  name?: string;
  categoryCode?: string;
  activityTypeCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  definition?: unknown;
  copyFromVersionId?: string;
  expectedSourceDefinitionHash?: string;
  metricSelection?: unknown;
}
function windowFromInput(from: string, to: string | null | undefined) {
  const effectiveFrom = new Date(from);
  const effectiveTo = to === undefined || to === null ? null : new Date(to);
  if (
    typeof from !== 'string' ||
    !Number.isFinite(effectiveFrom.getTime()) ||
    (effectiveTo !== null &&
      (!Number.isFinite(effectiveTo.getTime()) || effectiveTo <= effectiveFrom))
  )
    throw new TypeError('invalid template effective window');
  return { effectiveFrom, effectiveTo };
}
function assertV3Form(definition: ActivityTemplateDefinitionV3) {
  fingerprintActivityTemplateDefinition({ schemaVersion: 3, definition });
  if (definition.registrationForm)
    canonicalizeRegistrationFormDefinitionForB3(definition.registrationForm);
}

@Injectable()
export class ActivityTemplateVersionService {
  constructor(
    private readonly commands: ActivityTemplateVersionCommand,
    private readonly audit: ActivityTemplateVersionAuditRecorder,
    private readonly access: ActivityAccessService,
  ) {}

  create(command: CreateTemplateVersionCommand, user: CurrentUserPayload, meta: AuditMeta) {
    let familyId: string | null;
    let familyInput: { code: string; name: string; categoryCode: string } | null;
    let definition: ActivityTemplateDefinitionV3 | null;
    let copy: { id: string; hash: string; selection: ActivityMetricSelection } | null;
    let version: number;
    let activityTypeCode: string;
    let window: ReturnType<typeof windowFromInput>;
    try {
      familyId = command.familyId === undefined ? null : metricText(command.familyId, 64);
      if (
        familyId &&
        [command.code, command.name, command.categoryCode].some((v) => v !== undefined)
      )
        throw new TypeError('family metadata cannot change');
      familyInput = familyId
        ? null
        : {
            code: metricText(command.code, 64),
            name: metricText(command.name, 100),
            categoryCode: metricText(command.categoryCode, 64),
          };
      activityTypeCode = metricText(command.activityTypeCode, 64);
      version = metricInteger(command.version, 1, 2147483647);
      window = windowFromInput(command.effectiveFrom, command.effectiveTo);
      if (command.definition !== undefined) {
        if (
          [
            command.copyFromVersionId,
            command.expectedSourceDefinitionHash,
            command.metricSelection,
          ].some((v) => v !== undefined)
        )
          throw new TypeError('mutually exclusive template inputs');
        // Class fields create undefined own keys for omitted HTTP properties.
        // Preserve JSON omission semantics without relaxing the V1/V2 parser.
        definition = parseActivityTemplateDefinitionV3(
          instanceToPlain(command.definition, { exposeUnsetFields: false }),
        );
        assertV3Form(definition);
        copy = null;
      } else {
        definition = null;
        copy = {
          id: metricText(command.copyFromVersionId, 64),
          hash: metricHash(command.expectedSourceDefinitionHash),
          selection: parseActivityMetricSelection(instanceToPlain(command.metricSelection)),
        };
      }
    } catch (error) {
      if (
        error instanceof TypeError ||
        error instanceof BizException ||
        error instanceof ActivityTemplateDefinitionV1Error
      )
        throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
      throw error;
    }
    return this.commands.run({
      user,
      operation: 'create_template_version',
      operationKey: command.operationKey,
      targetId: null,
      canonicalInput: canonicalize({
        familyId,
        familyInput,
        version,
        activityTypeCode,
        effectiveFrom: window.effectiveFrom.toISOString(),
        effectiveTo: window.effectiveTo?.toISOString() ?? null,
        definition,
        copy,
      } as unknown as CanonicalValue),
      execute: async (tx, actor) => {
        let sourceFamilyId: string | null = null;
        let targetFamilyId: string | null = null;
        const revalidate = async () => {
          actor = await this.commands.assertAccess(tx, user);
          if (sourceFamilyId) await this.assertVisibleFamily(tx, sourceFamilyId);
          if (targetFamilyId && targetFamilyId !== sourceFamilyId)
            await this.assertVisibleFamily(tx, targetFamilyId);
        };
        if (copy) {
          await tx.$queryRaw`SELECT "id" FROM "ActivityTemplate" WHERE "id" = ${copy.id} FOR SHARE`;
          await revalidate();
          const source = await tx.activityTemplate.findFirst({
            where: { id: copy.id, family: globalTemplateFamilyWhere() },
          });
          if (!source) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
          sourceFamilyId = source.familyId;
          if (source.definitionHash !== copy.hash)
            throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_STALE);
          try {
            const sourceDefinition = parseStoredTemplateVersion(source);
            definition = parseActivityTemplateDefinitionV3({
              activity: sourceDefinition.activity,
              sessions: sourceDefinition.sessions,
              registrationForm:
                'registrationForm' in sourceDefinition ? sourceDefinition.registrationForm : null,
              metricSelection: copy.selection,
            });
            assertV3Form(definition);
          } catch (error) {
            if (
              error instanceof TypeError ||
              error instanceof BizException ||
              error instanceof ActivityTemplateDefinitionV1Error
            )
              throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
            throw error;
          }
        }
        if (!definition) throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
        let family = familyId
          ? await tx.activityTemplateFamily.findFirst({
              where: { id: familyId, ...globalTemplateFamilyWhere() },
            })
          : null;
        if (familyId && !family)
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
        targetFamilyId = family?.id ?? null;
        await this.validateClassification(
          tx,
          activityTypeCode,
          family?.categoryCode ?? familyInput!.categoryCode,
        );
        // No receipt or Family survives a reference, identity or audit failure.
        await lockMetricSelectionReference(tx, definition.metricSelection, revalidate);
        if (!family && familyInput)
          family = await tx.activityTemplateFamily.create({
            data: {
              ...familyInput,
              scopeTypeCode: 'global',
              ownerOrganizationId: null,
              statusCode: 'active',
            },
          });
        if (!family) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
        const fingerprint = fingerprintActivityTemplateDefinition({ schemaVersion: 3, definition });
        const row = await tx.activityTemplate.create({
          data: {
            code: family.code,
            name: family.name,
            familyId: family.id,
            version,
            activityTypeCode,
            statusCode: 'draft',
            schemaVersion: 3,
            definitionJson: definition as unknown as Prisma.InputJsonValue,
            definitionHash: fingerprint.definitionHash,
            ...window,
          },
        });
        const result = this.result(row);
        await this.audit.log(tx, actor, meta, 'create_template_version', result, null);
        return result;
      },
    });
  }

  change(
    action: 'update' | 'activate' | 'retire',
    id: string,
    command: { operationKey: string; expectedDefinitionHash: string; definition?: unknown },
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    let expectedHash: string;
    let definition: ActivityTemplateDefinitionV3 | null = null;
    try {
      expectedHash = metricHash(command.expectedDefinitionHash);
      if (action === 'update') {
        definition = parseActivityTemplateDefinitionV3(
          instanceToPlain(command.definition, { exposeUnsetFields: false }),
        );
        assertV3Form(definition);
      } else if (command.definition !== undefined)
        throw new TypeError('lifecycle command cannot change definition');
    } catch (error) {
      if (
        error instanceof TypeError ||
        error instanceof BizException ||
        error instanceof ActivityTemplateDefinitionV1Error
      )
        throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
      throw error;
    }
    const operation = `${action}_template_version` as const;
    return this.commands.run({
      user,
      operation,
      operationKey: command.operationKey,
      targetId: id,
      canonicalInput: canonicalize({ expectedHash, definition } as unknown as CanonicalValue),
      execute: async (tx, actor) => {
        await tx.$queryRaw`SELECT "id" FROM "ActivityTemplate" WHERE "id" = ${id} FOR UPDATE`;
        actor = await this.commands.assertAccess(tx, user);
        const before = await tx.activityTemplate.findFirst({
          where: { id, family: globalTemplateFamilyWhere() },
          include: { family: true },
        });
        if (!before) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
        if (before.schemaVersion !== 3)
          throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
        if (before.definitionHash !== expectedHash)
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_STALE);
        if (
          (action === 'retire' && before.statusCode !== 'active') ||
          (action !== 'retire' && before.statusCode !== 'draft')
        )
          throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
        let next = definition;
        if (action === 'activate') {
          try {
            parseStoredTemplateVersion(before);
            next = parseActivityTemplateDefinitionV3(before.definitionJson);
            assertV3Form(next);
            if (!before.effectiveFrom) throw new TypeError('missing template window');
            windowFromInput(before.effectiveFrom.toISOString(), before.effectiveTo?.toISOString());
          } catch (error) {
            if (
              error instanceof TypeError ||
              error instanceof BizException ||
              error instanceof ActivityTemplateDefinitionV1Error
            )
              throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
            throw error;
          }
        }
        if (next) {
          await this.validateClassification(
            tx,
            before.activityTypeCode,
            before.family!.categoryCode,
          );
          await lockMetricSelectionReference(tx, next.metricSelection, async () => {
            actor = await this.commands.assertAccess(tx, user);
            await this.assertVisibleFamily(tx, before.family!.id);
          });
        }
        const data: Prisma.ActivityTemplateUpdateInput =
          action === 'update' && next
            ? {
                definitionJson: next as unknown as Prisma.InputJsonValue,
                definitionHash: fingerprintActivityTemplateDefinition({
                  schemaVersion: 3,
                  definition: next,
                }).definitionHash,
              }
            : { statusCode: action === 'activate' ? 'active' : 'retired' };
        const row = await tx.activityTemplate.update({ where: { id }, data });
        const result = this.result(row);
        await this.audit.log(tx, actor, meta, operation, result, before);
        return result;
      },
    });
  }

  private async assertVisibleFamily(tx: Prisma.TransactionClient, familyId: string) {
    const family = await tx.activityTemplateFamily.findFirst({
      where: { id: familyId, ...globalTemplateFamilyWhere() },
      select: { id: true },
    });
    if (!family) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
  }

  private async validateClassification(
    tx: Prisma.TransactionClient,
    activityTypeCode: string,
    categoryCode: string,
  ) {
    await this.access.assertDictItemValid(
      'activity_type',
      activityTypeCode,
      BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
      tx,
    );
    await this.access.assertDictItemValid(
      'activity_category',
      categoryCode,
      BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
      tx,
    );
  }
  private result(row: ActivityTemplate) {
    return parseTemplateVersionReceipt({
      id: row.id,
      code: row.code,
      version: row.version,
      schemaVersion: row.schemaVersion,
      statusCode: row.statusCode,
      definitionHash: row.definitionHash,
    });
  }
}

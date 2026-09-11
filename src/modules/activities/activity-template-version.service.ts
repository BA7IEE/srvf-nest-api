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
  parseActivityTemplateDefinitionV4,
  type ActivityTemplateDefinitionV4,
} from './activity-template-definition-v4';
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
import { ActivityTimePolicySelectionService } from './activity-time-policy-selection.service';
import type { ActivityTimePolicyPointer } from './activity-time-policy-selection';
import { ActivityTimePolicyCommand } from './activity-time-policy-command';

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
  schemaVersion?: number;
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
type WritableTemplateDefinition = ActivityTemplateDefinitionV3 | ActivityTemplateDefinitionV4;

function assertTemplateForm(schemaVersion: 3 | 4, definition: WritableTemplateDefinition) {
  fingerprintActivityTemplateDefinition({ schemaVersion, definition });
  if (definition.registrationForm)
    canonicalizeRegistrationFormDefinitionForB3(definition.registrationForm);
}

function timePolicyPointers(
  definition: WritableTemplateDefinition,
): readonly ActivityTimePolicyPointer[] {
  if (!('timePolicySelection' in definition)) return [];
  return [
    definition.timePolicySelection.default,
    ...definition.timePolicySelection.sessionOverrides.map((item) => item.selection),
    ...definition.timePolicySelection.positionOverrides.map((item) => item.selection),
  ].flatMap((selection) => (selection.pointer ? [selection.pointer] : []));
}

@Injectable()
export class ActivityTemplateVersionService {
  constructor(
    private readonly commands: ActivityTemplateVersionCommand,
    private readonly audit: ActivityTemplateVersionAuditRecorder,
    private readonly access: ActivityAccessService,
    private readonly timePolicySelections: ActivityTimePolicySelectionService,
    private readonly timePolicyCommands: ActivityTimePolicyCommand,
  ) {}

  create(command: CreateTemplateVersionCommand, user: CurrentUserPayload, meta: AuditMeta) {
    let familyId: string | null;
    let familyInput: { code: string; name: string; categoryCode: string } | null;
    let definition: WritableTemplateDefinition | null;
    let copy: { id: string; hash: string; selection: ActivityMetricSelection } | null;
    let version: number;
    let schemaVersion: 3 | 4;
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
      if (command.schemaVersion !== undefined && command.schemaVersion !== 4)
        throw new TypeError('only explicit V4 is accepted; V3 remains omitted');
      schemaVersion = command.schemaVersion === 4 ? 4 : 3;
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
        definition =
          schemaVersion === 4
            ? parseActivityTemplateDefinitionV4(
                instanceToPlain(command.definition, { exposeUnsetFields: false }),
              )
            : parseActivityTemplateDefinitionV3(
                instanceToPlain(command.definition, { exposeUnsetFields: false }),
              );
        assertTemplateForm(schemaVersion, definition);
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
        schemaVersion,
        activityTypeCode,
        effectiveFrom: window.effectiveFrom.toISOString(),
        effectiveTo: window.effectiveTo?.toISOString() ?? null,
        definition,
        copy,
      } as unknown as CanonicalValue),
      revalidateReplay: async (tx, actor, result) => {
        if (result.schemaVersion === 4) {
          await this.timePolicyCommands.assertAccess(
            tx,
            actor,
            'activity-time-policy.read.catalog',
          );
        }
      },
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
            if (schemaVersion === 4) {
              if (!('timePolicySelection' in sourceDefinition))
                throw new TypeError('V4 copy requires a V4 source');
              definition = parseActivityTemplateDefinitionV4({
                activity: sourceDefinition.activity,
                sessions: sourceDefinition.sessions,
                registrationForm:
                  'registrationForm' in sourceDefinition ? sourceDefinition.registrationForm : null,
                metricSelection: copy.selection,
                timePolicySelection: sourceDefinition.timePolicySelection,
              });
            } else {
              definition = parseActivityTemplateDefinitionV3({
                activity: sourceDefinition.activity,
                sessions: sourceDefinition.sessions,
                registrationForm:
                  'registrationForm' in sourceDefinition ? sourceDefinition.registrationForm : null,
                metricSelection: copy.selection,
              });
            }
            assertTemplateForm(schemaVersion, definition);
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
        await this.timePolicySelections.assertPointersAvailableWithinTransaction(
          tx,
          timePolicyPointers(definition),
          async () => {
            await revalidate();
            if (timePolicyPointers(definition!).length > 0) {
              actor = await this.timePolicyCommands.assertAccess(
                tx,
                user,
                'activity-time-policy.read.catalog',
              );
            }
          },
        );
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
        const fingerprint = fingerprintActivityTemplateDefinition({ schemaVersion, definition });
        const row = await tx.activityTemplate.create({
          data: {
            code: family.code,
            name: family.name,
            familyId: family.id,
            version,
            activityTypeCode,
            statusCode: 'draft',
            schemaVersion,
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
    command: {
      operationKey: string;
      expectedDefinitionHash: string;
      schemaVersion?: number;
      definition?: unknown;
    },
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    let expectedHash: string;
    let rawDefinition: unknown = null;
    try {
      expectedHash = metricHash(command.expectedDefinitionHash);
      if (command.schemaVersion !== undefined && command.schemaVersion !== 4)
        throw new TypeError('only explicit V4 is accepted');
      if (action === 'update') {
        rawDefinition = instanceToPlain(command.definition, { exposeUnsetFields: false });
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
      // V3 receipts predate schemaVersion and must keep their exact canonical payload.  V4 needs
      // its explicit marker in the idempotency hash, otherwise a later omitted marker could replay
      // a V4 lifecycle command while bypassing the target-schema requirement below.
      canonicalInput: canonicalize(
        (command.schemaVersion === 4
          ? { expectedHash, rawDefinition, schemaVersion: 4 }
          : { expectedHash, rawDefinition }) as CanonicalValue,
      ),
      revalidateReplay: async (tx, actor, result) => {
        if (result.schemaVersion === 4) {
          await this.timePolicyCommands.assertAccess(
            tx,
            actor,
            'activity-time-policy.read.catalog',
          );
        }
      },
      execute: async (tx, actor) => {
        await tx.$queryRaw`SELECT "id" FROM "ActivityTemplate" WHERE "id" = ${id} FOR UPDATE`;
        actor = await this.commands.assertAccess(tx, user);
        const before = await tx.activityTemplate.findFirst({
          where: { id, family: globalTemplateFamilyWhere() },
          include: { family: true },
        });
        if (!before) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
        if (before.schemaVersion !== 3 && before.schemaVersion !== 4)
          throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
        if (
          (before.schemaVersion === 4 && command.schemaVersion !== 4) ||
          (command.schemaVersion !== undefined && command.schemaVersion !== before.schemaVersion)
        )
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
        if (before.definitionHash !== expectedHash)
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_STALE);
        if (
          (action === 'retire' && before.statusCode !== 'active') ||
          (action !== 'retire' && before.statusCode !== 'draft')
        )
          throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
        let next: WritableTemplateDefinition | null = null;
        if (action === 'update') {
          next =
            before.schemaVersion === 4
              ? parseActivityTemplateDefinitionV4(rawDefinition)
              : parseActivityTemplateDefinitionV3(rawDefinition);
          assertTemplateForm(before.schemaVersion, next);
        }
        if (action === 'activate') {
          try {
            parseStoredTemplateVersion(before);
            next =
              before.schemaVersion === 4
                ? parseActivityTemplateDefinitionV4(before.definitionJson)
                : parseActivityTemplateDefinitionV3(before.definitionJson);
            assertTemplateForm(before.schemaVersion, next);
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
          await this.timePolicySelections.assertPointersAvailableWithinTransaction(
            tx,
            timePolicyPointers(next),
            async () => {
              actor = await this.commands.assertAccess(tx, user);
              await this.assertVisibleFamily(tx, before.family!.id);
              if (timePolicyPointers(next).length > 0) {
                actor = await this.timePolicyCommands.assertAccess(
                  tx,
                  user,
                  'activity-time-policy.read.catalog',
                );
              }
            },
          );
        }
        const data: Prisma.ActivityTemplateUpdateInput =
          action === 'update' && next
            ? {
                definitionJson: next as unknown as Prisma.InputJsonValue,
                definitionHash: fingerprintActivityTemplateDefinition({
                  schemaVersion: before.schemaVersion,
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

import type { ActivityTemplate, ActivityTemplateFamily } from '@prisma/client';
import { matchesActivityTemplateDefinitionHash } from './activity-template-definition';
import {
  parseActivityTemplateDefinitionV1,
  type ActivityTemplateDefinitionV1,
} from './activity-template-definition-v1';
import {
  parseActivityTemplateDefinitionV2,
  type ActivityTemplateDefinitionV2,
} from './activity-template-definition-v2';
import {
  parseActivityTemplateDefinitionV3,
  type ActivityTemplateDefinitionV3,
} from './activity-template-definition-v3';
import {
  parseActivityTemplateDefinitionV4,
  type ActivityTemplateDefinitionV4,
} from './activity-template-definition-v4';

export type GlobalTemplateVersionRow = ActivityTemplate & { family: ActivityTemplateFamily | null };
export function globalTemplateFamilyWhere() {
  return { scopeTypeCode: 'global', ownerOrganizationId: null, statusCode: 'active' } as const;
}
export function parseStoredTemplateVersion(
  row: ActivityTemplate,
):
  | ActivityTemplateDefinitionV1
  | ActivityTemplateDefinitionV2
  | ActivityTemplateDefinitionV3
  | ActivityTemplateDefinitionV4 {
  if (
    !row.familyId ||
    !row.definitionHash ||
    !row.definitionJson ||
    !row.schemaVersion ||
    !matchesActivityTemplateDefinitionHash(
      { schemaVersion: row.schemaVersion, definition: row.definitionJson },
      row.definitionHash,
    )
  )
    throw new TypeError('invalid template definition hash');
  if (row.schemaVersion === 1) return parseActivityTemplateDefinitionV1(row.definitionJson);
  if (row.schemaVersion === 2) return parseActivityTemplateDefinitionV2(row.definitionJson);
  if (row.schemaVersion === 3) return parseActivityTemplateDefinitionV3(row.definitionJson);
  if (row.schemaVersion === 4) return parseActivityTemplateDefinitionV4(row.definitionJson);
  throw new TypeError('unsupported template schema');
}
export function presentTemplateVersionSummary(row: GlobalTemplateVersionRow) {
  if (
    !row.family ||
    row.family.scopeTypeCode !== 'global' ||
    row.family.ownerOrganizationId !== null ||
    row.family.statusCode !== 'active'
  )
    throw new TypeError('template family not visible');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    version: row.version,
    schemaVersion: row.schemaVersion,
    definitionHash: row.definitionHash,
    statusCode: row.statusCode,
    activityTypeCode: row.activityTypeCode,
    family: {
      id: row.family.id,
      code: row.family.code,
      name: row.family.name,
      categoryCode: row.family.categoryCode,
    },
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export function presentTemplateVersion(row: GlobalTemplateVersionRow) {
  return { ...presentTemplateVersionSummary(row), definition: parseStoredTemplateVersion(row) };
}

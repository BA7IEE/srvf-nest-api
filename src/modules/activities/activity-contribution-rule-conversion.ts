import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import {
  ContributionPolicyDefinition,
  ContributionPolicyResult,
  ContributionTimeCategoryCode,
  parseContributionPolicyDefinition,
} from './activity-contribution-policy-definition';

/** Values are explicit JSON projections, not Prisma rows or an approved type mapping. */
export interface LegacyContributionSourceRule {
  id: string;
  activityTypeCode: string;
  attendanceRoleCode: string;
  durationThreshold: string | null;
  pointsBelow: string;
  pointsAbove: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  deletedAt: string | null;
  updatedAt: string;
}

export interface LegacyContributionRoleMapping {
  sourceRoleCode: string;
  targetRoleCode: string;
  belowExplanationCode: string;
  aboveExplanationCode: string;
}

export interface LegacyContributionMapping {
  activityTypeCode: string;
  timeCategoryCode: ContributionTimeCategoryCode;
  defaultResult: ContributionPolicyResult;
  roleMappings: LegacyContributionRoleMapping[];
}

export interface LegacyContributionCandidate {
  definition: ContributionPolicyDefinition;
  canonicalDefinition: string;
  sourceFingerprint: string;
}

function invalid(): never {
  throw new TypeError('Invalid legacy contribution conversion input');
}

function exactFields(value: object, fields: readonly string[]): void {
  const present = Object.keys(value);
  if (present.length !== fields.length || present.some((field) => !fields.includes(field)))
    invalid();
}

function code(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value)) return invalid();
  return value;
}

function role(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || (point >= 127 && point <= 159);
    })
  )
    return invalid();
  return value;
}

/** Decimal(5,2) hours/points; integer cents avoid binary-float threshold drift. */
function hundredths(value: unknown): number {
  if (typeof value !== 'string') return invalid();
  const match = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,2}))?$/u.exec(value);
  if (match === null) return invalid();
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function points(value: unknown): string {
  const cents = hundredths(value);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return invalid();
  return value;
}

/**
 * Builds an uncommitted definition only. The caller must supply every business mapping;
 * no policy identity, effective date, version hash, receipt or database write is created.
 */
export function buildLegacyContributionCandidate(
  sourceRules: readonly LegacyContributionSourceRule[],
  mapping: LegacyContributionMapping,
): LegacyContributionCandidate {
  canonicalizeActivityTemplateDefinition({ sourceRules, mapping });
  if (!Array.isArray(sourceRules) || sourceRules.length < 1 || sourceRules.length > 64)
    return invalid();
  const rules: readonly LegacyContributionSourceRule[] = sourceRules;
  exactFields(mapping, ['activityTypeCode', 'timeCategoryCode', 'defaultResult', 'roleMappings']);
  code(mapping.activityTypeCode);
  if (!Array.isArray(mapping.roleMappings) || mapping.roleMappings.length !== rules.length) {
    return invalid();
  }

  const bySourceRole = new Map<string, LegacyContributionRoleMapping>();
  const targetRoles = new Set<string>();
  for (const item of mapping.roleMappings) {
    exactFields(item, [
      'sourceRoleCode',
      'targetRoleCode',
      'belowExplanationCode',
      'aboveExplanationCode',
    ]);
    const sourceRoleCode = role(item.sourceRoleCode);
    const targetRoleCode = role(item.targetRoleCode);
    code(item.belowExplanationCode);
    code(item.aboveExplanationCode);
    if (bySourceRole.has(sourceRoleCode) || targetRoles.has(targetRoleCode)) return invalid();
    bySourceRole.set(sourceRoleCode, item);
    targetRoles.add(targetRoleCode);
  }

  const sourceIds = new Set<string>();
  const sourceRoles = new Set<string>();
  const normalizedSources = rules.map((source) => {
    exactFields(source, [
      'id',
      'activityTypeCode',
      'attendanceRoleCode',
      'durationThreshold',
      'pointsBelow',
      'pointsAbove',
      'status',
      'deletedAt',
      'updatedAt',
    ]);
    const id = role(source.id);
    const attendanceRoleCode = role(source.attendanceRoleCode);
    if (
      sourceIds.has(id) ||
      sourceRoles.has(attendanceRoleCode) ||
      source.activityTypeCode !== mapping.activityTypeCode ||
      source.status !== 'ACTIVE' ||
      source.deletedAt !== null ||
      !bySourceRole.has(attendanceRoleCode)
    )
      return invalid();
    sourceIds.add(id);
    sourceRoles.add(attendanceRoleCode);
    const thresholdHundredths =
      source.durationThreshold === null ? null : hundredths(source.durationThreshold);
    const below = points(source.pointsBelow);
    const above = source.pointsAbove === null ? null : points(source.pointsAbove);
    return {
      id,
      activityTypeCode: mapping.activityTypeCode,
      attendanceRoleCode,
      durationThreshold: thresholdHundredths,
      pointsBelow: below,
      pointsAbove: above,
      status: 'ACTIVE',
      deletedAt: null,
      updatedAt: instant(source.updatedAt),
    };
  });
  normalizedSources.sort((a, b) => {
    if (a.attendanceRoleCode !== b.attendanceRoleCode) {
      return a.attendanceRoleCode < b.attendanceRoleCode ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const definition = parseContributionPolicyDefinition({
    defaultResult: mapping.defaultResult,
    roleRules: normalizedSources.map((source) => {
      const mapped = bySourceRole.get(source.attendanceRoleCode);
      if (mapped === undefined) return invalid();
      const belowBand = {
        maxSecondsInclusive:
          source.durationThreshold === null ? null : source.durationThreshold * 36,
        recognizedPoints: source.pointsBelow,
        explanationCode: mapped.belowExplanationCode,
      };
      const durationBands =
        source.durationThreshold === null
          ? [belowBand]
          : [
              belowBand,
              {
                maxSecondsInclusive: null,
                recognizedPoints: source.pointsAbove ?? source.pointsBelow,
                explanationCode: mapped.aboveExplanationCode,
              },
            ];
      return {
        attendanceRoleCode: mapped.targetRoleCode,
        categoryRules: [{ timeCategoryCode: mapping.timeCategoryCode, durationBands }],
      };
    }),
  });

  return {
    definition,
    canonicalDefinition: canonicalizeActivityTemplateDefinition(definition),
    sourceFingerprint: computeActivityTemplateDefinitionHash({
      schemaVersion: 1,
      definition: { rules: normalizedSources },
    }),
  };
}

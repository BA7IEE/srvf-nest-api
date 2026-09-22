import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';

export const CONTRIBUTION_TIME_CATEGORY_CODES = [
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;

export type ContributionTimeCategoryCode = (typeof CONTRIBUTION_TIME_CATEGORY_CODES)[number];

export interface ContributionPolicyResult {
  recognizedPoints: string;
  explanationCode: string;
}

export interface ContributionPolicyDurationBand extends ContributionPolicyResult {
  maxSecondsInclusive: number | null;
}

export interface ContributionPolicyCategoryRule {
  timeCategoryCode: ContributionTimeCategoryCode;
  durationBands: ContributionPolicyDurationBand[];
}

export interface ContributionPolicyRoleRule {
  attendanceRoleCode: string;
  categoryRules: ContributionPolicyCategoryRule[];
}

export interface ContributionPolicyDefinition {
  defaultResult: ContributionPolicyResult;
  roleRules: ContributionPolicyRoleRule[];
}

export interface ContributionPolicyEvaluationInput {
  attendanceRoleCode: string;
  timeCategoryCode: ContributionTimeCategoryCode;
  durationSeconds: number;
}

function invalid(): never {
  throw new TypeError('Invalid contribution policy metadata');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Called only after canonical validation has rejected accessors, cycles and non-JSON values. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return invalid();
  return value;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return invalid();
  if (
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return invalid();
  return value;
}

function stableCode(value: unknown): string {
  const code = text(value, 64);
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(code)) return invalid();
  return code;
}

function recognizedPoints(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/u.test(value)) {
    return invalid();
  }
  const [whole] = value.split('.');
  if (Number(whole) > 999) return invalid();
  return value;
}

function result(value: unknown): ContributionPolicyResult {
  const item = record(value, ['recognizedPoints', 'explanationCode']);
  return {
    recognizedPoints: recognizedPoints(item.recognizedPoints),
    explanationCode: stableCode(item.explanationCode),
  };
}

function category(value: unknown): ContributionTimeCategoryCode {
  if (
    value === 'volunteer_service' ||
    value === 'training' ||
    value === 'organization' ||
    value === 'non_creditable'
  )
    return value;
  return invalid();
}

function maximumSeconds(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

function parseDurationBands(value: unknown): ContributionPolicyDurationBand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return invalid();
  let previous = -1;
  return value.map((entry, index) => {
    const item = record(entry, ['maxSecondsInclusive', 'recognizedPoints', 'explanationCode']);
    const maximum = maximumSeconds(item.maxSecondsInclusive);
    const final = index === value.length - 1;
    if ((maximum === null) !== final || (maximum !== null && maximum <= previous)) return invalid();
    if (maximum !== null) previous = maximum;
    return {
      maxSecondsInclusive: maximum,
      recognizedPoints: recognizedPoints(item.recognizedPoints),
      explanationCode: stableCode(item.explanationCode),
    };
  });
}

export function parseContributionPolicyDefinition(value: unknown): ContributionPolicyDefinition {
  canonicalizeActivityTemplateDefinition(value);
  const root = record(value, ['defaultResult', 'roleRules']);
  if (!Array.isArray(root.roleRules) || root.roleRules.length > 64) return invalid();

  const roleRules = root.roleRules.map((entry: unknown) => {
    const role = record(entry, ['attendanceRoleCode', 'categoryRules']);
    if (!Array.isArray(role.categoryRules) || role.categoryRules.length > 4) return invalid();
    const categoryRules = role.categoryRules.map((categoryEntry: unknown) => {
      const categoryRule = record(categoryEntry, ['timeCategoryCode', 'durationBands']);
      return {
        timeCategoryCode: category(categoryRule.timeCategoryCode),
        durationBands: parseDurationBands(categoryRule.durationBands),
      };
    });
    if (new Set(categoryRules.map((item) => item.timeCategoryCode)).size !== categoryRules.length) {
      return invalid();
    }
    categoryRules.sort(
      (a, b) =>
        CONTRIBUTION_TIME_CATEGORY_CODES.indexOf(a.timeCategoryCode) -
        CONTRIBUTION_TIME_CATEGORY_CODES.indexOf(b.timeCategoryCode),
    );
    return { attendanceRoleCode: text(role.attendanceRoleCode, 64), categoryRules };
  });
  if (new Set(roleRules.map((item) => item.attendanceRoleCode)).size !== roleRules.length) {
    return invalid();
  }
  roleRules.sort((a, b) =>
    a.attendanceRoleCode < b.attendanceRoleCode
      ? -1
      : a.attendanceRoleCode > b.attendanceRoleCode
        ? 1
        : 0,
  );
  return { defaultResult: result(root.defaultResult), roleRules };
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalid();
  return value;
}

export function fingerprintContributionPolicyVersion(value: unknown) {
  canonicalizeActivityTemplateDefinition(value);
  const root = record(value, [
    'schemaVersion',
    'definition',
    'evaluatorVersion',
    'effectiveFrom',
    'effectiveUntil',
  ]);
  if (root.schemaVersion !== 1 || root.evaluatorVersion !== 1) return invalid();
  const definition = parseContributionPolicyDefinition(root.definition);
  const effectiveFrom = instant(root.effectiveFrom);
  const effectiveUntil = root.effectiveUntil === null ? null : instant(root.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return invalid();
  const envelope = { definition, evaluatorVersion: 1, effectiveFrom, effectiveUntil };
  const definitionHash = computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: envelope,
  });
  return { schemaVersion: 1, ...envelope, definitionHash };
}

export function evaluateContributionPolicy(
  definitionValue: unknown,
  inputValue: unknown,
): ContributionPolicyResult {
  const definition = parseContributionPolicyDefinition(definitionValue);
  canonicalizeActivityTemplateDefinition(inputValue);
  const input = record(inputValue, ['attendanceRoleCode', 'timeCategoryCode', 'durationSeconds']);
  const attendanceRoleCode = text(input.attendanceRoleCode, 64);
  const timeCategoryCode = category(input.timeCategoryCode);
  if (
    typeof input.durationSeconds !== 'number' ||
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 0
  )
    return invalid();
  const durationSeconds = input.durationSeconds;

  const role = definition.roleRules.find((item) => item.attendanceRoleCode === attendanceRoleCode);
  const categoryRule = role?.categoryRules.find(
    (item) => item.timeCategoryCode === timeCategoryCode,
  );
  const band = categoryRule?.durationBands.find(
    (item) => item.maxSecondsInclusive === null || durationSeconds <= item.maxSecondsInclusive,
  );
  const selected = band ?? definition.defaultResult;
  return {
    recognizedPoints: selected.recognizedPoints,
    explanationCode: selected.explanationCode,
  };
}

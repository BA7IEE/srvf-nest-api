import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';

export const QUALIFICATION_RULE_TYPES = [
  'grade',
  'gender',
  'organization',
  'certificate',
  'training',
  'age',
  'insurance',
] as const;
export type QualificationRuleType = (typeof QUALIFICATION_RULE_TYPES)[number];

export type QualificationRuleEnforcement = 'block' | 'warn';
export type QualificationRuleOperator =
  | 'in'
  | 'in_subtree'
  | 'has_any'
  | 'between'
  | 'covers_activity';

export interface QualificationRuleScope {
  sessionId: string | null;
  positionId: string | null;
}

export interface QualificationRuleInput {
  ruleTypeCode: QualificationRuleType;
  enforcementCode: QualificationRuleEnforcement;
  operator: QualificationRuleOperator;
  codes?: string[];
  organizationIds?: string[];
  standardIds?: string[];
  minYears?: number | null;
  maxYears?: number | null;
  warnScore?: number;
  message?: string | null;
  sortOrder: number;
}

export interface QualificationRuleSetInput {
  scope: QualificationRuleScope;
  rules: QualificationRuleInput[];
}

export interface QualificationRuleSetsInput {
  ruleSets: QualificationRuleSetInput[];
}

export interface CanonicalQualificationRule {
  ruleTypeCode: QualificationRuleType;
  enforcementCode: QualificationRuleEnforcement;
  operator: QualificationRuleOperator;
  codes?: string[];
  organizationIds?: string[];
  standardIds?: string[];
  minYears?: number | null;
  maxYears?: number | null;
  warnScore: number | null;
  message: string | null;
  sortOrder: number;
}

export interface CanonicalQualificationRuleSet {
  scope: QualificationRuleScope;
  rules: CanonicalQualificationRule[];
  definitionHash: string;
}

export interface CanonicalQualificationRuleSetsDefinition {
  ruleSets: CanonicalQualificationRuleSet[];
}

export interface CanonicalQualificationRuleSetsResult {
  definition: CanonicalQualificationRuleSetsDefinition;
  canonicalJson: string;
  targetHash: string;
}

type PersistedRule = {
  ruleTypeCode: string;
  enforcementCode: string;
  operator: string;
  valueJson: Prisma.JsonValue | null;
  warnScore: number | null;
  message: string | null;
  sortOrder: number;
};

type PersistedRuleSet = {
  sessionId: string | null;
  positionId: string | null;
  rules: PersistedRule[];
};

function fail(code: keyof typeof BizCode): never {
  throw new BizException(BizCode[code]);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function compareQualificationScope(
  left: QualificationRuleScope,
  right: QualificationRuleScope,
): number {
  const level = (scope: QualificationRuleScope): number =>
    scope.positionId !== null ? 2 : scope.sessionId !== null ? 1 : 0;
  const levelComparison = level(left) - level(right);
  if (levelComparison !== 0) return levelComparison;
  const sessionComparison = utf8Compare(left.sessionId ?? '', right.sessionId ?? '');
  if (sessionComparison !== 0) return sessionComparison;
  return utf8Compare(left.positionId ?? '', right.positionId ?? '');
}

function scopeKey(scope: QualificationRuleScope): string {
  return `${scope.sessionId ?? ''}\u0000${scope.positionId ?? ''}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableId(value: unknown, code: keyof typeof BizCode): string | null {
  if (value === null) return null;
  if (!nonEmptyString(value)) fail(code);
  return value;
}

function hasUnexpectedValue(
  input: QualificationRuleInput,
  allowed: readonly (keyof QualificationRuleInput)[],
): boolean {
  const typedKeys: Array<keyof QualificationRuleInput> = [
    'codes',
    'organizationIds',
    'standardIds',
    'minYears',
    'maxYears',
  ];
  return typedKeys.some((key) => input[key] !== undefined && !allowed.includes(key));
}

function canonicalStringArray(value: unknown, code: keyof typeof BizCode): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(code);
  const values = new Set<string>();
  for (const item of value) {
    if (!nonEmptyString(item)) fail(code);
    values.add(item);
  }
  const normalized = [...values];
  normalized.sort(utf8Compare);
  return normalized;
}

function canonicalAge(value: unknown, code: keyof typeof BizCode): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function canonicalRule(
  input: QualificationRuleInput,
  code: keyof typeof BizCode,
): CanonicalQualificationRule {
  if (!input || typeof input !== 'object') fail(code);
  if (!(QUALIFICATION_RULE_TYPES as readonly string[]).includes(input.ruleTypeCode)) fail(code);
  if (input.enforcementCode !== 'block' && input.enforcementCode !== 'warn') fail(code);
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0) fail(code);
  if (input.message !== undefined && input.message !== null && !nonEmptyString(input.message))
    fail(code);
  const message = input.message ?? null;
  let warnScore: number | null;
  if (input.enforcementCode === 'warn') {
    if (
      typeof input.warnScore !== 'number' ||
      !Number.isSafeInteger(input.warnScore) ||
      input.warnScore < 0 ||
      input.warnScore > 100
    ) {
      fail(code);
    }
    warnScore = input.warnScore;
  } else {
    if (input.warnScore !== undefined) fail(code);
    warnScore = null;
  }

  const common = {
    ruleTypeCode: input.ruleTypeCode,
    enforcementCode: input.enforcementCode,
    message,
    warnScore,
    sortOrder: input.sortOrder,
  } as const;

  if (input.ruleTypeCode === 'grade' || input.ruleTypeCode === 'gender') {
    if (input.operator !== 'in' || hasUnexpectedValue(input, ['codes'])) fail(code);
    return { ...common, operator: 'in', codes: canonicalStringArray(input.codes, code) };
  }
  if (input.ruleTypeCode === 'organization') {
    if (input.operator !== 'in_subtree' || hasUnexpectedValue(input, ['organizationIds']))
      fail(code);
    return {
      ...common,
      operator: 'in_subtree',
      organizationIds: canonicalStringArray(input.organizationIds, code),
    };
  }
  if (input.ruleTypeCode === 'certificate' || input.ruleTypeCode === 'training') {
    if (input.operator !== 'has_any' || hasUnexpectedValue(input, ['standardIds'])) fail(code);
    return {
      ...common,
      operator: 'has_any',
      standardIds: canonicalStringArray(input.standardIds, code),
    };
  }
  if (input.ruleTypeCode === 'age') {
    if (input.operator !== 'between' || hasUnexpectedValue(input, ['minYears', 'maxYears'])) {
      fail(code);
    }
    const minYears = canonicalAge(input.minYears, code);
    const maxYears = canonicalAge(input.maxYears, code);
    if (minYears === null && maxYears === null) fail(code);
    if (minYears !== null && maxYears !== null && minYears > maxYears) fail(code);
    return { ...common, operator: 'between', minYears, maxYears };
  }
  if (input.operator !== 'covers_activity' || hasUnexpectedValue(input, [])) fail(code);
  return { ...common, operator: 'covers_activity' };
}

function canonicalRuleSet(
  input: QualificationRuleSetInput,
  code: keyof typeof BizCode,
): CanonicalQualificationRuleSet {
  if (!input || typeof input !== 'object' || !input.scope || typeof input.scope !== 'object') {
    fail(code);
  }
  const scope = {
    sessionId: nullableId(input.scope.sessionId, code),
    positionId: nullableId(input.scope.positionId, code),
  };
  if (scope.positionId !== null && scope.sessionId === null) fail(code);
  if (!Array.isArray(input.rules) || input.rules.length === 0) fail(code);
  const sortOrders = new Set<number>();
  const rules = input.rules.map((rule) => {
    const canonical = canonicalRule(rule, code);
    if (sortOrders.has(canonical.sortOrder)) fail(code);
    sortOrders.add(canonical.sortOrder);
    return canonical;
  });
  rules.sort((left, right) => left.sortOrder - right.sortOrder);
  const definitionWithoutHash = { scope, rules };
  const definitionHash = createHash('sha256')
    .update(canonicalize(definitionWithoutHash as unknown as CanonicalValue), 'utf8')
    .digest('hex');
  return { ...definitionWithoutHash, definitionHash };
}

export function canonicalizeQualificationRuleSets(
  input: QualificationRuleSetsInput,
  errorCode: keyof typeof BizCode = 'BAD_REQUEST',
): CanonicalQualificationRuleSetsResult {
  if (!input || typeof input !== 'object' || !Array.isArray(input.ruleSets)) fail(errorCode);
  const seenScopes = new Set<string>();
  const ruleSets = input.ruleSets.map((ruleSet) => {
    const canonical = canonicalRuleSet(ruleSet, errorCode);
    const key = scopeKey(canonical.scope);
    if (seenScopes.has(key)) fail(errorCode);
    seenScopes.add(key);
    return canonical;
  });
  ruleSets.sort((left, right) => compareQualificationScope(left.scope, right.scope));
  const definition = { ruleSets };
  const canonicalJson = canonicalize(definition as unknown as CanonicalValue);
  return {
    definition,
    canonicalJson,
    targetHash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
  };
}

function isRecord(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storedArray(value: Prisma.JsonValue | null, key: string): string[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !(key in value)) return undefined;
  const result = value[key];
  return Array.isArray(result) ? (result as string[]) : undefined;
}

function storedRuleToInput(
  rule: PersistedRule,
  code: keyof typeof BizCode,
): QualificationRuleInput {
  if (rule.enforcementCode === 'block' && rule.warnScore !== null) fail(code);
  const common = {
    ruleTypeCode: rule.ruleTypeCode as QualificationRuleType,
    enforcementCode: rule.enforcementCode as QualificationRuleEnforcement,
    operator: rule.operator as QualificationRuleOperator,
    ...(rule.enforcementCode === 'warn' ? { warnScore: rule.warnScore ?? undefined } : {}),
    message: rule.message,
    sortOrder: rule.sortOrder,
  };
  if (rule.ruleTypeCode === 'grade' || rule.ruleTypeCode === 'gender') {
    return { ...common, codes: storedArray(rule.valueJson, 'codes') };
  }
  if (rule.ruleTypeCode === 'organization') {
    return { ...common, organizationIds: storedArray(rule.valueJson, 'organizationIds') };
  }
  if (rule.ruleTypeCode === 'certificate' || rule.ruleTypeCode === 'training') {
    return { ...common, standardIds: storedArray(rule.valueJson, 'standardIds') };
  }
  if (rule.ruleTypeCode === 'age') {
    if (!isRecord(rule.valueJson)) fail(code);
    const keys = Object.keys(rule.valueJson).sort();
    if (keys.length === 0 || keys.some((key) => key !== 'minYears' && key !== 'maxYears')) {
      fail(code);
    }
    return {
      ...common,
      minYears: rule.valueJson.minYears as number | null | undefined,
      maxYears: rule.valueJson.maxYears as number | null | undefined,
    };
  }
  if (rule.ruleTypeCode === 'insurance' && rule.valueJson === null) return common;
  fail(code);
}

/** Rebuild persisted state through the same typed canonicalizer; malformed historical state is 21041. */
export function qualificationRuleSetsFromStored(
  ruleSets: PersistedRuleSet[],
): CanonicalQualificationRuleSetsResult {
  return canonicalizeQualificationRuleSets(
    {
      ruleSets: ruleSets.map((ruleSet) => ({
        scope: { sessionId: ruleSet.sessionId, positionId: ruleSet.positionId },
        rules: ruleSet.rules.map((rule) =>
          storedRuleToInput(rule, 'ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID'),
        ),
      })),
    },
    'ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID',
  );
}

export function qualificationRuleStoredValue(
  rule: CanonicalQualificationRule,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if ('codes' in rule) return { codes: rule.codes };
  if ('organizationIds' in rule) {
    return { organizationIds: rule.organizationIds };
  }
  if ('standardIds' in rule) return { standardIds: rule.standardIds };
  if (rule.ruleTypeCode === 'age') {
    return {
      ...(rule.minYears === null ? {} : { minYears: rule.minYears }),
      ...(rule.maxYears === null ? {} : { maxYears: rule.maxYears }),
    };
  }
  return Prisma.DbNull;
}

export function qualificationRuleSetPublicDefinition(
  definition: CanonicalQualificationRuleSet,
): Omit<CanonicalQualificationRuleSet, 'definitionHash'> {
  return { scope: definition.scope, rules: definition.rules };
}

/** Removes canonical-only null/default fields before re-entering the strict typed input parser. */
export function qualificationRuleSetsInputFromCanonical(
  definition: CanonicalQualificationRuleSetsDefinition,
): QualificationRuleSetsInput {
  return {
    ruleSets: definition.ruleSets.map((ruleSet) => ({
      scope: ruleSet.scope,
      rules: ruleSet.rules.map((rule) => ({
        ruleTypeCode: rule.ruleTypeCode,
        enforcementCode: rule.enforcementCode,
        operator: rule.operator,
        ...('codes' in rule ? { codes: rule.codes } : {}),
        ...('organizationIds' in rule ? { organizationIds: rule.organizationIds } : {}),
        ...('standardIds' in rule ? { standardIds: rule.standardIds } : {}),
        ...('minYears' in rule ? { minYears: rule.minYears } : {}),
        ...('maxYears' in rule ? { maxYears: rule.maxYears } : {}),
        ...(rule.warnScore === null ? {} : { warnScore: rule.warnScore }),
        ...(rule.message === null ? {} : { message: rule.message }),
        sortOrder: rule.sortOrder,
      })),
    })),
  };
}

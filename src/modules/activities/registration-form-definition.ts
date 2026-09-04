import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';

/** The persisted closed set is also the only runtime wire set. */
export const REGISTRATION_FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'date',
  'single_choice',
  'multi_choice',
  'file',
  'confirmation',
] as const;
export type RegistrationFormFieldType = (typeof REGISTRATION_FORM_FIELD_TYPES)[number];

export const REGISTRATION_FORM_FIELD_VISIBILITIES = [
  'self_and_registration_staff',
  'self_and_owner',
  'self_only',
] as const;
export type RegistrationFormFieldVisibility = (typeof REGISTRATION_FORM_FIELD_VISIBILITIES)[number];

/**
 * B3 的治理词表只解释报名表 definition；数据库只守五列的 all-or-none 形状，避免
 * 同一份闭集在 schema / SQL / JSON 三处各自漂移。敏感字段保留在 grammar 中，但 B3
 * 尚未有读面掩码和清理 SOP，实际 writer 会在下方的 B3 gate 拒绝它。
 */
export const REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES = [
  'transport_logistics',
  'accommodation_logistics',
  'dietary_accommodation',
  'equipment_clothing',
  'activity_specific_note',
  'file_confirmation',
] as const;
export type RegistrationFormGovernancePurposeCode =
  (typeof REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES)[number];

export const REGISTRATION_FORM_DATA_CLASS_CODES = ['ordinary', 'sensitive'] as const;
export type RegistrationFormDataClassCode = (typeof REGISTRATION_FORM_DATA_CLASS_CODES)[number];

/** B3 只存在一套普通字段留存 / 掩码执行位；敏感 policy 留待 B3-S 逐题批准。 */
export const REGISTRATION_FORM_RETENTION_POLICY_CODES = ['activity_lifecycle'] as const;
export type RegistrationFormRetentionPolicyCode =
  (typeof REGISTRATION_FORM_RETENTION_POLICY_CODES)[number];

export const REGISTRATION_FORM_MASKING_POLICY_CODES = ['none'] as const;
export type RegistrationFormMaskingPolicyCode =
  (typeof REGISTRATION_FORM_MASKING_POLICY_CODES)[number];

export interface RegistrationFormChoiceInput {
  value: string;
  label: string;
}

/**
 * Governance 是 definition 级的第二种完整形状。undefined / null 表示 legacy Field；
 * 真正的对象必须包含五个键且 prefillSourceCode 只能是 null。
 */
export interface RegistrationFormFieldGovernanceInput {
  purposeCode: RegistrationFormGovernancePurposeCode;
  dataClassCode: RegistrationFormDataClassCode;
  retentionPolicyCode: RegistrationFormRetentionPolicyCode;
  maskingPolicyCode: RegistrationFormMaskingPolicyCode;
  prefillSourceCode: null;
}

/**
 * This intentionally contains no version/id/workflow metadata. It is the sole representation
 * eligible for a form schema hash and proposal snapshot.
 */
export interface RegistrationFormFieldInput {
  fieldCode: string;
  typeCode: RegistrationFormFieldType;
  label: string;
  helpText?: string | null;
  required: boolean;
  visibilityCode: RegistrationFormFieldVisibility;
  exportable: boolean;
  sortOrder: number;
  minValue?: number | string | null;
  maxValue?: number | string | null;
  minLength?: number | null;
  maxLength?: number | null;
  maxSelections?: number | null;
  options?: RegistrationFormChoiceInput[] | null;
  governance?: RegistrationFormFieldGovernanceInput | null;
}

export interface RegistrationFormDefinitionInput {
  fields: RegistrationFormFieldInput[];
}

export interface CanonicalRegistrationFormChoice {
  value: string;
  label: string;
}

export interface CanonicalRegistrationFormFieldGovernance {
  purposeCode: RegistrationFormGovernancePurposeCode;
  dataClassCode: RegistrationFormDataClassCode;
  retentionPolicyCode: RegistrationFormRetentionPolicyCode;
  maskingPolicyCode: RegistrationFormMaskingPolicyCode;
  prefillSourceCode: null;
}

export interface CanonicalRegistrationFormField {
  fieldCode: string;
  typeCode: RegistrationFormFieldType;
  label: string;
  helpText: string | null;
  required: boolean;
  visibilityCode: RegistrationFormFieldVisibility;
  exportable: boolean;
  sortOrder: number;
  minValue: string | null;
  maxValue: string | null;
  minLength: number | null;
  maxLength: number | null;
  maxSelections: number | null;
  options: CanonicalRegistrationFormChoice[] | null;
  /**
   * 故意只在 governed definition 出现。legacy 绝不补 `governance: null`，否则既有
   * canonical JSON / schemaHash 会漂移。
   */
  governance?: CanonicalRegistrationFormFieldGovernance;
}

export interface CanonicalRegistrationFormDefinition {
  fields: CanonicalRegistrationFormField[];
}

export interface CanonicalRegistrationFormResult {
  definition: CanonicalRegistrationFormDefinition;
  canonicalJson: string;
  schemaHash: string;
  mode: RegistrationFormDefinitionMode;
}

export type RegistrationFormDefinitionMode = 'legacy' | 'governed';

function invalid(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** DTO instance 与 JSON plain object 都可进入 canonicalizer；只拒绝未声明的 enumerable key。 */
function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function nullableInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  const normalized = nullableInteger(value);
  if (normalized !== null && normalized < 1) invalid();
  return normalized;
}

/** Decimal values are persisted as Decimal(18,6); a decimal string avoids float hash drift. */
function nullableDecimal(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') invalid();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) invalid();
  // Number() is used only for validation. String input stays textual, while numeric input uses
  // its normal JSON representation; both are then canonicalized by decimal trimming below.
  const source = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)) invalid();
  const negative = source.startsWith('-');
  const unsigned = negative ? source.slice(1) : source;
  const [rawInteger, rawFraction = ''] = unsigned.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  // RegistrationFormField is Decimal(18,6): accepting a value Prisma would round or reject
  // would make the canonical hash diverge from the frozen persisted definition.
  if (integer.length > 12 || fraction.length > 6) invalid();
  const normalized = `${negative && (integer !== '0' || fraction !== '') ? '-' : ''}${integer}${
    fraction === '' ? '' : `.${fraction}`
  }`;
  return normalized === '-0' ? '0' : normalized;
}

function compareNormalizedDecimals(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const magnitude = (first: string, second: string): number => {
    const [firstInteger, firstFraction = ''] = first.replace(/^-/, '').split('.');
    const [secondInteger, secondFraction = ''] = second.replace(/^-/, '').split('.');
    if (firstInteger.length !== secondInteger.length) {
      return firstInteger.length < secondInteger.length ? -1 : 1;
    }
    const integerComparison = firstInteger.localeCompare(secondInteger);
    if (integerComparison !== 0) return integerComparison;
    return firstFraction.padEnd(6, '0').localeCompare(secondFraction.padEnd(6, '0'));
  };
  const comparison = magnitude(left, right);
  return leftNegative ? -comparison : comparison;
}

function normalizeOptions(value: unknown): CanonicalRegistrationFormChoice[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) invalid();
  const values = new Set<string>();
  return value.map((option) => {
    const record = asRecord(option);
    assertOnlyKeys(record, ['value', 'label']);
    if (
      !hasOwn(record, 'value') ||
      !hasOwn(record, 'label') ||
      !isNonEmptyString(record.value) ||
      !isNonEmptyString(record.label)
    ) {
      invalid();
    }
    if (values.has(record.value)) invalid();
    values.add(record.value);
    return { value: record.value, label: record.label };
  });
}

function normalizeGovernance(value: unknown): CanonicalRegistrationFormFieldGovernance | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const keys = [
    'purposeCode',
    'dataClassCode',
    'retentionPolicyCode',
    'maskingPolicyCode',
    'prefillSourceCode',
  ] as const;
  assertOnlyKeys(record, keys);
  if (keys.some((key) => !hasOwn(record, key))) invalid();
  if (
    !(REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES as readonly string[]).includes(
      record.purposeCode as string,
    ) ||
    !(REGISTRATION_FORM_DATA_CLASS_CODES as readonly string[]).includes(
      record.dataClassCode as string,
    ) ||
    !(REGISTRATION_FORM_RETENTION_POLICY_CODES as readonly string[]).includes(
      record.retentionPolicyCode as string,
    ) ||
    !(REGISTRATION_FORM_MASKING_POLICY_CODES as readonly string[]).includes(
      record.maskingPolicyCode as string,
    ) ||
    record.prefillSourceCode !== null
  ) {
    invalid();
  }
  return {
    purposeCode: record.purposeCode as RegistrationFormGovernancePurposeCode,
    dataClassCode: record.dataClassCode as RegistrationFormDataClassCode,
    retentionPolicyCode: record.retentionPolicyCode as RegistrationFormRetentionPolicyCode,
    maskingPolicyCode: record.maskingPolicyCode as RegistrationFormMaskingPolicyCode,
    prefillSourceCode: null,
  };
}

function canonicalField(input: RegistrationFormFieldInput): CanonicalRegistrationFormField {
  if (!input || typeof input !== 'object') invalid();
  assertOnlyKeys(input, [
    'fieldCode',
    'typeCode',
    'label',
    'helpText',
    'required',
    'visibilityCode',
    'exportable',
    'sortOrder',
    'minValue',
    'maxValue',
    'minLength',
    'maxLength',
    'maxSelections',
    'options',
    'governance',
  ]);
  if (!isNonEmptyString(input.fieldCode) || !isNonEmptyString(input.label)) invalid();
  if (!(REGISTRATION_FORM_FIELD_TYPES as readonly string[]).includes(input.typeCode)) invalid();
  if (!(REGISTRATION_FORM_FIELD_VISIBILITIES as readonly string[]).includes(input.visibilityCode)) {
    invalid();
  }
  if (typeof input.required !== 'boolean' || typeof input.exportable !== 'boolean') invalid();
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0) invalid();
  if (
    input.helpText !== undefined &&
    input.helpText !== null &&
    typeof input.helpText !== 'string'
  ) {
    invalid();
  }

  const minValue = nullableDecimal(input.minValue);
  const maxValue = nullableDecimal(input.maxValue);
  const minLength = nullableInteger(input.minLength);
  const maxLength = nullableInteger(input.maxLength);
  const maxSelections = nullablePositiveInteger(input.maxSelections);
  const options = normalizeOptions(input.options);
  const governance = normalizeGovernance(input.governance);

  if (minValue !== null && maxValue !== null && compareNormalizedDecimals(minValue, maxValue) > 0) {
    invalid();
  }
  if (minLength !== null && maxLength !== null && minLength > maxLength) invalid();

  const isText = input.typeCode === 'short_text' || input.typeCode === 'long_text';
  if (isText) {
    if (minValue !== null || maxValue !== null || maxSelections !== null || options !== null)
      invalid();
  } else if (input.typeCode === 'number') {
    if (minLength !== null || maxLength !== null || maxSelections !== null || options !== null)
      invalid();
  } else if (input.typeCode === 'single_choice') {
    if (
      minValue !== null ||
      maxValue !== null ||
      minLength !== null ||
      maxLength !== null ||
      maxSelections !== null ||
      options === null
    ) {
      invalid();
    }
  } else if (input.typeCode === 'multi_choice') {
    if (
      minValue !== null ||
      maxValue !== null ||
      minLength !== null ||
      maxLength !== null ||
      options === null
    ) {
      invalid();
    }
    if (maxSelections !== null && maxSelections > options.length) invalid();
  } else if (
    minValue !== null ||
    maxValue !== null ||
    minLength !== null ||
    maxLength !== null ||
    maxSelections !== null ||
    options !== null
  ) {
    invalid();
  }

  const canonical: CanonicalRegistrationFormField = {
    fieldCode: input.fieldCode,
    typeCode: input.typeCode,
    label: input.label,
    helpText: input.helpText ?? null,
    required: input.required,
    visibilityCode: input.visibilityCode,
    exportable: input.exportable,
    sortOrder: input.sortOrder,
    minValue,
    maxValue,
    minLength,
    maxLength,
    maxSelections,
    // Choice order is meaningful and intentionally never sorted.
    options,
  };
  if (governance !== undefined) canonical.governance = governance;
  return canonical;
}

export function canonicalizeRegistrationFormDefinition(
  input: RegistrationFormDefinitionInput,
): CanonicalRegistrationFormResult {
  if (!input || !Array.isArray(input.fields) || input.fields.length === 0) invalid();
  assertOnlyKeys(input, ['fields']);
  const fieldCodes = new Set<string>();
  const fields = input.fields.map((field) => {
    const canonical = canonicalField(field);
    if (fieldCodes.has(canonical.fieldCode)) invalid();
    fieldCodes.add(canonical.fieldCode);
    return canonical;
  });
  fields.sort((left, right) =>
    left.sortOrder === right.sortOrder
      ? left.fieldCode.localeCompare(right.fieldCode)
      : left.sortOrder - right.sortOrder,
  );
  const modes = new Set<RegistrationFormDefinitionMode>(
    fields.map((field) => (field.governance === undefined ? 'legacy' : 'governed')),
  );
  if (modes.size !== 1) invalid();
  const mode = modes.has('governed') ? 'governed' : 'legacy';
  const definition: CanonicalRegistrationFormDefinition = { fields };
  const canonicalJson = canonicalize(definition as unknown as CanonicalValue);
  return {
    definition,
    canonicalJson,
    schemaHash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    mode,
  };
}

/**
 * B3 的基础执行位：敏感题目仍可被严格 parser 表达，但没有读面掩码、留存清理与逐题
 * SOP 前，所有实际 writer 都必须拒绝它。governed 表单也不能开启 exportable。
 */
export function canonicalizeRegistrationFormDefinitionForB3(
  input: RegistrationFormDefinitionInput,
): CanonicalRegistrationFormResult {
  const canonical = canonicalizeRegistrationFormDefinition(input);
  if (canonical.mode === 'legacy') return canonical;
  for (const field of canonical.definition.fields) {
    const governance = field.governance;
    if (
      governance === undefined ||
      governance.dataClassCode !== 'ordinary' ||
      governance.retentionPolicyCode !== 'activity_lifecycle' ||
      governance.maskingPolicyCode !== 'none' ||
      governance.prefillSourceCode !== null ||
      field.exportable
    ) {
      invalid();
    }
  }
  return canonical;
}

/** Public/app read surfaces never expose owner governance metadata. */
export function registrationFormPublicDefinition(
  input: RegistrationFormDefinitionInput,
): CanonicalRegistrationFormDefinition {
  const canonical = canonicalizeRegistrationFormDefinition(input).definition;
  return {
    fields: canonical.fields.map((field) => {
      const publicField = { ...field };
      delete publicField.governance;
      return publicField;
    }),
  };
}

/** Rebuild the same canonical definition from a persisted version without leaking row metadata. */
export function registrationFormDefinitionFromStoredFields(
  fields: Array<{
    fieldCode: string;
    typeCode: string;
    label: string;
    helpText: string | null;
    required: boolean;
    visibilityCode: string;
    exportable: boolean;
    sortOrder: number;
    minValue: Prisma.Decimal | null;
    maxValue: Prisma.Decimal | null;
    minLength: number | null;
    maxLength: number | null;
    maxSelections: number | null;
    optionsJson: Prisma.JsonValue | null;
    purposeCode?: string | null;
    dataClassCode?: string | null;
    retentionPolicyCode?: string | null;
    maskingPolicyCode?: string | null;
    prefillSourceCode?: string | null;
  }>,
): CanonicalRegistrationFormResult {
  return canonicalizeRegistrationFormDefinition({
    fields: fields.map((field) => ({
      fieldCode: field.fieldCode,
      typeCode: field.typeCode as RegistrationFormFieldType,
      label: field.label,
      helpText: field.helpText,
      required: field.required,
      visibilityCode: field.visibilityCode as RegistrationFormFieldVisibility,
      exportable: field.exportable,
      sortOrder: field.sortOrder,
      minValue: field.minValue?.toString() ?? null,
      maxValue: field.maxValue?.toString() ?? null,
      minLength: field.minLength,
      maxLength: field.maxLength,
      maxSelections: field.maxSelections,
      options: field.optionsJson as RegistrationFormChoiceInput[] | null,
      governance: storedGovernance(field),
    })),
  });
}

function storedGovernance(field: {
  purposeCode?: string | null;
  dataClassCode?: string | null;
  retentionPolicyCode?: string | null;
  maskingPolicyCode?: string | null;
  prefillSourceCode?: string | null;
}): RegistrationFormFieldGovernanceInput | null | undefined {
  const values = [
    field.purposeCode,
    field.dataClassCode,
    field.retentionPolicyCode,
    field.maskingPolicyCode,
    field.prefillSourceCode,
  ];
  // Unit fixtures from before B3 intentionally have no five-column keys. Real reads select all
  // five columns; a partially populated persisted row is passed through and rejected below.
  if (values.every((value) => value === undefined)) return undefined;
  if (values.every((value) => value === null)) return null;
  return {
    purposeCode: field.purposeCode as RegistrationFormGovernancePurposeCode,
    dataClassCode: field.dataClassCode as RegistrationFormDataClassCode,
    retentionPolicyCode: field.retentionPolicyCode as RegistrationFormRetentionPolicyCode,
    maskingPolicyCode: field.maskingPolicyCode as RegistrationFormMaskingPolicyCode,
    prefillSourceCode: field.prefillSourceCode as null,
  };
}

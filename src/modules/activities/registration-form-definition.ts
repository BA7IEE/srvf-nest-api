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

export interface RegistrationFormChoiceInput {
  value: string;
  label: string;
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
}

export interface RegistrationFormDefinitionInput {
  fields: RegistrationFormFieldInput[];
}

export interface CanonicalRegistrationFormChoice {
  value: string;
  label: string;
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
}

export interface CanonicalRegistrationFormDefinition {
  fields: CanonicalRegistrationFormField[];
}

export interface CanonicalRegistrationFormResult {
  definition: CanonicalRegistrationFormDefinition;
  canonicalJson: string;
  schemaHash: string;
}

function invalid(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    if (!option || typeof option !== 'object') invalid();
    const record = option as Record<string, unknown>;
    if (!isNonEmptyString(record.value) || !isNonEmptyString(record.label)) invalid();
    if (values.has(record.value)) invalid();
    values.add(record.value);
    return { value: record.value, label: record.label };
  });
}

function canonicalField(input: RegistrationFormFieldInput): CanonicalRegistrationFormField {
  if (!input || typeof input !== 'object') invalid();
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

  return {
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
}

export function canonicalizeRegistrationFormDefinition(
  input: RegistrationFormDefinitionInput,
): CanonicalRegistrationFormResult {
  if (!input || !Array.isArray(input.fields) || input.fields.length === 0) invalid();
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
  const definition: CanonicalRegistrationFormDefinition = { fields };
  const canonicalJson = canonicalize(definition as unknown as CanonicalValue);
  return {
    definition,
    canonicalJson,
    schemaHash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
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
    })),
  });
}

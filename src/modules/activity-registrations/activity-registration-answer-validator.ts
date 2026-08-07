import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type RegistrationAnswerField = {
  id: string;
  fieldCode: string;
  typeCode: string;
  required: boolean;
  minValue: Prisma.Decimal | null;
  maxValue: Prisma.Decimal | null;
  minLength: number | null;
  maxLength: number | null;
  maxSelections: number | null;
  optionsJson: Prisma.JsonValue | null;
};

export type RegistrationAnswerInput = {
  fieldCode: unknown;
  value?: unknown;
  uploadSessionId?: unknown;
};

export type ValidatedRegistrationAnswer = {
  fieldId: string;
  fieldCode: string;
  typeCode: string;
  valueText?: string;
  valueNumber?: Prisma.Decimal;
  valueDate?: Date;
  valueJson?: Prisma.InputJsonValue;
  uploadSessionId?: string;
};

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(): never {
  throw new BizException(BizCode.REGISTRATION_FORM_ANSWER_INVALID);
}

function hasOwn(input: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, property);
}

function stringLength(value: string): number {
  return Array.from(value).length;
}

function normalizeDecimal(value: unknown): Prisma.Decimal {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  const source = String(value);
  if (!DECIMAL_PATTERN.test(source)) invalid();
  const [integer, fraction = ''] = source.replace(/^-/, '').split('.');
  if (integer.length > 12 || fraction.length > 6) invalid();
  try {
    return new Prisma.Decimal(source);
  } catch {
    return invalid();
  }
}

function normalizeDate(value: unknown): Date {
  if (typeof value !== 'string') invalid();
  const match = DATE_PATTERN.exec(value);
  if (!match) invalid();
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    invalid();
  }
  return result;
}

function choices(optionsJson: Prisma.JsonValue | null): Set<string> {
  if (!Array.isArray(optionsJson) || optionsJson.length === 0) invalid();
  const result = new Set<string>();
  for (const option of optionsJson) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) invalid();
    const value = (option as Record<string, unknown>).value;
    if (typeof value !== 'string' || value.length === 0 || result.has(value)) invalid();
    result.add(value);
  }
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function assertExactlyOneValue(input: RegistrationAnswerInput, file: boolean): void {
  const hasValue = hasOwn(input, 'value') && input.value !== undefined;
  const hasUploadSession = hasOwn(input, 'uploadSessionId') && input.uploadSessionId !== undefined;
  if (file ? hasValue || !hasUploadSession : !hasValue || hasUploadSession) invalid();
}

function assertTextRange(value: string, field: RegistrationAnswerField): void {
  const length = stringLength(value);
  if (
    (field.minLength !== null && length < field.minLength) ||
    (field.maxLength !== null && length > field.maxLength)
  ) {
    invalid();
  }
}

function assertNumberRange(value: Prisma.Decimal, field: RegistrationAnswerField): void {
  if (
    (field.minValue !== null && value.lessThan(field.minValue)) ||
    (field.maxValue !== null && value.greaterThan(field.maxValue))
  ) {
    invalid();
  }
}

function validateOne(
  field: RegistrationAnswerField,
  answer: RegistrationAnswerInput,
): ValidatedRegistrationAnswer {
  const base = { fieldId: field.id, fieldCode: field.fieldCode, typeCode: field.typeCode };
  const file = field.typeCode === 'file';
  assertExactlyOneValue(answer, file);

  if (file) {
    if (
      typeof answer.uploadSessionId !== 'string' ||
      answer.uploadSessionId.length < 8 ||
      answer.uploadSessionId.length > 64
    ) {
      invalid();
    }
    return { ...base, uploadSessionId: answer.uploadSessionId };
  }

  switch (field.typeCode) {
    case 'short_text':
    case 'long_text': {
      if (typeof answer.value !== 'string') invalid();
      if (field.required && stringLength(answer.value) === 0) invalid();
      assertTextRange(answer.value, field);
      return { ...base, valueText: answer.value };
    }
    case 'number': {
      const valueNumber = normalizeDecimal(answer.value);
      assertNumberRange(valueNumber, field);
      return { ...base, valueNumber };
    }
    case 'date':
      return { ...base, valueDate: normalizeDate(answer.value) };
    case 'single_choice': {
      if (typeof answer.value !== 'string' || !choices(field.optionsJson).has(answer.value))
        invalid();
      return { ...base, valueJson: answer.value };
    }
    case 'multi_choice': {
      const selectedValues = answer.value;
      if (!isStringArray(selectedValues)) invalid();
      const allowed = choices(field.optionsJson);
      const selected = new Set<string>();
      for (const choice of selectedValues) {
        if (!allowed.has(choice) || selected.has(choice)) invalid();
        selected.add(choice);
      }
      if (field.required && selected.size === 0) invalid();
      if (field.maxSelections !== null && selected.size > field.maxSelections) invalid();
      return { ...base, valueJson: [...selected].sort() };
    }
    case 'confirmation':
      if (typeof answer.value !== 'boolean' || (field.required && answer.value !== true)) invalid();
      return { ...base, valueJson: answer.value };
    default:
      return invalid();
  }
}

/**
 * Validates the entire immutable answer set in one place.  It intentionally receives only the
 * frozen active Form fields and the narrow wire shape, so callers cannot accidentally accept an
 * answer by selecting another form/version or an arbitrary persistence column.
 */
export function validateRegistrationFormAnswers(
  fields: readonly RegistrationAnswerField[],
  input: unknown,
): ValidatedRegistrationAnswer[] {
  if (!Array.isArray(input)) invalid();
  const fieldByCode = new Map<string, RegistrationAnswerField>();
  for (const field of fields) {
    if (!field.fieldCode || fieldByCode.has(field.fieldCode)) invalid();
    fieldByCode.set(field.fieldCode, field);
  }

  const seen = new Set<string>();
  const result: ValidatedRegistrationAnswer[] = [];
  for (const rawAnswer of input) {
    if (!rawAnswer || typeof rawAnswer !== 'object' || Array.isArray(rawAnswer)) invalid();
    const answer = rawAnswer as RegistrationAnswerInput;
    if (typeof answer.fieldCode !== 'string' || !fieldByCode.has(answer.fieldCode)) invalid();
    if (seen.has(answer.fieldCode)) invalid();
    seen.add(answer.fieldCode);
    result.push(validateOne(fieldByCode.get(answer.fieldCode)!, answer));
  }

  for (const field of fields) {
    if (field.required && !seen.has(field.fieldCode)) invalid();
  }

  return result.sort((left, right) => left.fieldCode.localeCompare(right.fieldCode));
}

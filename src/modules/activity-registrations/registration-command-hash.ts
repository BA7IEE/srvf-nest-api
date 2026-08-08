import { createHash } from 'node:crypto';

import type { ValidatedRegistrationAnswer } from './activity-registration-answer-validator';

export type RegistrationCommandHashInput = {
  actorUserId: string;
  memberId: string;
  activityId: string;
  source: 'self';
  formVersion: number | null;
  answers: readonly {
    fieldCode: string;
    value?: unknown;
    uploadSessionId?: string;
  }[];
  preferences: readonly { sessionId: string; positionIds: readonly string[] }[];
};

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function canonicalUnknown(value: unknown, normalizeArrayOrder = false): CanonicalValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.map((item) => canonicalUnknown(item, normalizeArrayOrder));
    return normalizeArrayOrder
      ? values.sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)))
      : values;
  }
  if (value && typeof value === 'object') {
    const result: { [key: string]: CanonicalValue } = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = canonicalUnknown(child, normalizeArrayOrder);
    }
    return result;
  }
  // Invalid wire values still need a deterministic, non-throwing pre-transaction hash. The
  // answer validator remains the authority that rejects them before any business write.
  return `[invalid:${typeof value}]`;
}

function sha256(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function hashRegistrationCommand(input: RegistrationCommandHashInput): string {
  return sha256({
    actorUserId: input.actorUserId,
    memberId: input.memberId,
    activityId: input.activityId,
    source: input.source,
    formVersion: input.formVersion,
    answers: [...input.answers]
      .map((answer) => ({
        fieldCode: answer.fieldCode,
        // A valid answer array is multi_choice, whose selected option order is not semantic.
        // Session position order is intentionally handled separately and remains ordered.
        value: canonicalUnknown(answer.value, true),
        uploadSessionId: answer.uploadSessionId ?? null,
      }))
      .sort((left, right) => left.fieldCode.localeCompare(right.fieldCode)),
    preferences: [...input.preferences]
      .map((preference) => ({
        sessionId: preference.sessionId,
        // Position order is semantic: it becomes preferenceOrder 1..n.
        positionIds: [...preference.positionIds],
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
  });
}

export function hashRegistrationAnswers(
  answers: readonly ValidatedRegistrationAnswer[],
): string | null {
  if (answers.length === 0) return null;
  return sha256(
    answers.map((answer) => ({
      fieldCode: answer.fieldCode,
      typeCode: answer.typeCode,
      valueText: answer.valueText ?? null,
      valueNumber: answer.valueNumber?.toString() ?? null,
      valueDate: answer.valueDate?.toISOString().slice(0, 10) ?? null,
      valueJson: canonicalUnknown(answer.valueJson),
      uploadSessionId: answer.uploadSessionId ?? null,
    })),
  );
}

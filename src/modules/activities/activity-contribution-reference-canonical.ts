import { canonicalizeActivityTemplateDefinition } from './activity-template-definition';
import type { ContributionSourceReference } from './activity-contribution-settlement-policy';

const referenceKeys = [
  'allocationHash',
  'allocationRevisionId',
  'durationSeconds',
  'endsAt',
  'selectionItemId',
  'sliceId',
  'sourceSegmentId',
  'sourceSegmentRevision',
  'startsAt',
] as const;

function canonicalPrimitive(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** Canonical text for newly constructed flat references; generic validation is the fallback. */
export function canonicalizeLocalContributionReference(ref: ContributionSourceReference): string {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref))
    return canonicalizeActivityTemplateDefinition(ref);
  const prototype: unknown = Object.getPrototypeOf(ref);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(ref).length !== 0 ||
    Object.keys(ref).length !== 9 ||
    Object.getOwnPropertyNames(ref).length !== 9 ||
    Object.hasOwn(ref, 'correctionSource')
  )
    return canonicalizeActivityTemplateDefinition(ref);
  const parts = referenceKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(ref, key);
    return descriptor !== undefined && 'value' in descriptor
      ? canonicalPrimitive(descriptor.value)
      : undefined;
  });
  if (parts.some((part) => part === undefined)) return canonicalizeActivityTemplateDefinition(ref);
  return (
    '{"allocationHash":' +
    parts[0] +
    ',"allocationRevisionId":' +
    parts[1] +
    ',"durationSeconds":' +
    parts[2] +
    ',"endsAt":' +
    parts[3] +
    ',"selectionItemId":' +
    parts[4] +
    ',"sliceId":' +
    parts[5] +
    ',"sourceSegmentId":' +
    parts[6] +
    ',"sourceSegmentRevision":' +
    parts[7] +
    ',"startsAt":' +
    parts[8] +
    '}'
  );
}

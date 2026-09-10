import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';

export type TimePolicyCategory =
  | 'volunteer_service'
  | 'training'
  | 'organization'
  | 'non_creditable';
export type TimePolicyEvidenceSource = 'punch_event' | 'service_segment' | 'attachment';
export type TimePolicySpecialInterval =
  | { mode: 'exclude' }
  | { mode: 'manual' }
  | { mode: 'category'; category: TimePolicyCategory };
export type TimePolicyManualAdjustment =
  | { enabled: false }
  | { enabled: true; reasonRequired: true; evidenceRequired: boolean };
export interface TimePolicyDefinition {
  defaultCategory: TimePolicyCategory;
  roleMappings: { attendanceRoleCode: string; category: TimePolicyCategory }[];
  allowSplit: boolean;
  specialIntervals: {
    preparation: TimePolicySpecialInterval;
    duty: TimePolicySpecialInterval;
    travel: TimePolicySpecialInterval;
  };
  rounding: { mode: 'floor'; quantumSeconds: number };
  evidence: { requiredSources: TimePolicyEvidenceSource[]; requireManualRecognition: boolean };
  manualAdjustment: TimePolicyManualAdjustment;
}

function invalid(): never {
  throw new TypeError('Invalid time policy metadata');
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

function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return invalid();
  if (
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return invalid();
  return value;
}

function category(value: unknown): TimePolicyCategory {
  if (
    value === 'volunteer_service' ||
    value === 'training' ||
    value === 'organization' ||
    value === 'non_creditable'
  )
    return value;
  return invalid();
}

function special(value: unknown): TimePolicySpecialInterval {
  if (!isRecord(value)) return invalid();
  if (value.mode === 'category') {
    const item = record(value, ['mode', 'category']);
    return { mode: 'category', category: category(item.category) };
  }
  const item = record(value, ['mode']);
  if (item.mode === 'exclude' || item.mode === 'manual') return { mode: item.mode };
  return invalid();
}

function manual(value: unknown): TimePolicyManualAdjustment {
  if (!isRecord(value)) return invalid();
  if (value.enabled === false) {
    record(value, ['enabled']);
    return { enabled: false };
  }
  const item = record(value, ['enabled', 'reasonRequired', 'evidenceRequired']);
  if (item.enabled !== true || item.reasonRequired !== true) return invalid();
  return { enabled: true, reasonRequired: true, evidenceRequired: bool(item.evidenceRequired) };
}

export function parseTimePolicyDefinition(value: unknown): TimePolicyDefinition {
  const canonical = canonicalizeActivityTemplateDefinition(value);
  if (Buffer.byteLength(canonical, 'utf8') > 32768) return invalid();
  const root = record(value, [
    'defaultCategory',
    'roleMappings',
    'allowSplit',
    'specialIntervals',
    'rounding',
    'evidence',
    'manualAdjustment',
  ]);
  if (!Array.isArray(root.roleMappings) || root.roleMappings.length > 64) return invalid();
  const roleMappings = root.roleMappings.map((value: unknown) => {
    const item = record(value, ['attendanceRoleCode', 'category']);
    return {
      attendanceRoleCode: text(item.attendanceRoleCode, 64),
      category: category(item.category),
    };
  });
  if (new Set(roleMappings.map((item) => item.attendanceRoleCode)).size !== roleMappings.length)
    return invalid();
  roleMappings.sort((a, b) =>
    a.attendanceRoleCode < b.attendanceRoleCode
      ? -1
      : a.attendanceRoleCode > b.attendanceRoleCode
        ? 1
        : 0,
  );
  const intervals = record(root.specialIntervals, ['preparation', 'duty', 'travel']);
  const specialIntervals = {
    preparation: special(intervals.preparation),
    duty: special(intervals.duty),
    travel: special(intervals.travel),
  };
  const rounding = record(root.rounding, ['mode', 'quantumSeconds']);
  if (
    rounding.mode !== 'floor' ||
    typeof rounding.quantumSeconds !== 'number' ||
    !Number.isInteger(rounding.quantumSeconds) ||
    rounding.quantumSeconds < 1 ||
    rounding.quantumSeconds > 3600
  )
    return invalid();
  const evidence = record(root.evidence, ['requiredSources', 'requireManualRecognition']);
  if (!Array.isArray(evidence.requiredSources) || evidence.requiredSources.length > 3)
    return invalid();
  const sourceOrder: TimePolicyEvidenceSource[] = ['punch_event', 'service_segment', 'attachment'];
  const requiredSources = evidence.requiredSources.map(
    (value: unknown): TimePolicyEvidenceSource => {
      if (value === 'punch_event' || value === 'service_segment' || value === 'attachment')
        return value;
      return invalid();
    },
  );
  if (new Set(requiredSources).size !== requiredSources.length) return invalid();
  requiredSources.sort((a, b) => sourceOrder.indexOf(a) - sourceOrder.indexOf(b));
  const requireManualRecognition = bool(evidence.requireManualRecognition);
  const manualAdjustment = manual(root.manualAdjustment);
  if (
    !manualAdjustment.enabled &&
    (requireManualRecognition ||
      Object.values(specialIntervals).some((item) => item.mode === 'manual'))
  )
    return invalid();
  return {
    defaultCategory: category(root.defaultCategory),
    roleMappings,
    allowSplit: bool(root.allowSplit),
    specialIntervals,
    rounding: { mode: 'floor', quantumSeconds: rounding.quantumSeconds },
    evidence: { requiredSources, requireManualRecognition },
    manualAdjustment,
  };
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalid();
  return value;
}

export function fingerprintTimePolicyVersion(value: unknown) {
  canonicalizeActivityTemplateDefinition(value);
  const root = record(value, [
    'schemaVersion',
    'definition',
    'evaluatorVersion',
    'effectiveFrom',
    'effectiveUntil',
  ]);
  if (root.schemaVersion !== 1 || root.evaluatorVersion !== 1) return invalid();
  const definition = parseTimePolicyDefinition(root.definition);
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

export function parseTimePolicyVersionReference(value: unknown) {
  canonicalizeActivityTemplateDefinition(value);
  const root = record(value, ['policyId', 'versionId', 'definitionHash']);
  const definitionHash = text(root.definitionHash, 64);
  if (!/^[a-f0-9]{64}$/u.test(definitionHash)) return invalid();
  return { policyId: text(root.policyId, 64), versionId: text(root.versionId, 64), definitionHash };
}

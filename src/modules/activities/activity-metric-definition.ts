import { createHash } from 'node:crypto';

/** C1 D1: pure, bounded metadata only. No result storage, evaluator, API or template coupling. */
export type ActivityMetricConfiguration =
  | { kindCode: 'non_negative_integer'; unit: string; minimum: number; maximum: number }
  | {
      kindCode: 'non_negative_decimal';
      unit: string;
      scale: number;
      minimum: string;
      maximum: string;
    }
  | { kindCode: 'boolean'; unit: null }
  | { kindCode: 'short_text'; unit: null; maxLength: number }
  | { kindCode: 'single_choice'; unit: null; options: { code: string; label: string }[] };

export interface ActivityMetricDefinitionV1 {
  schemaVersion: 1;
  code: string;
  version: number;
  name: string;
  configuration: ActivityMetricConfiguration;
}

/** Reject accessors/non-JSON properties without invoking them. Shared only by C1's two parsers. */
export function metricObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('metric metadata must be an object');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('metric metadata must be a plain object');
  }
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError('metric metadata contains missing or unknown fields');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !('value' in property)) {
      throw new TypeError('metric metadata must contain enumerable data properties');
    }
    result[key] = property.value as unknown;
  }
  return result;
}

export function metricText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError('metric text must be nonempty, trimmed and bounded');
  }
  return value;
}

export function metricCode(value: unknown): string {
  const code = metricText(value, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new TypeError('invalid metric code');
  return code;
}

export function metricInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError('metric integer is out of bounds');
  }
  return value;
}

export function metricArray(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError('metric list must be a bounded plain array');
  }
  if (Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError('invalid metric list properties');
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !property.enumerable || !('value' in property))
      throw new TypeError('invalid metric list item');
    result.push(property.value as unknown);
  }
  return result;
}

function decimal(value: unknown, scale: number): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value)) {
    throw new TypeError('metric decimal must be a canonical non-negative string');
  }
  const [integer, fraction = ''] = value.split('.');
  if (integer.length > 18 - scale || fraction.length > scale)
    throw new TypeError('metric decimal exceeds precision');
  return value;
}

function scaled(value: string, scale: number): bigint {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer + fraction.padEnd(scale, '0'));
}

function parseConfiguration(value: unknown): ActivityMetricConfiguration {
  // Inspect the discriminant via descriptor before reading any caller-owned properties.
  if (typeof value !== 'object' || value === null)
    throw new TypeError('missing metric configuration');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kindCode');
  const kind: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  switch (kind) {
    case 'non_negative_integer': {
      const v = metricObject(value, ['kindCode', 'unit', 'minimum', 'maximum']);
      const minimum = metricInteger(v.minimum, 0, Number.MAX_SAFE_INTEGER);
      return {
        kindCode: kind,
        unit: metricText(v.unit, 32),
        minimum,
        maximum: metricInteger(v.maximum, minimum, Number.MAX_SAFE_INTEGER),
      };
    }
    case 'non_negative_decimal': {
      const v = metricObject(value, ['kindCode', 'unit', 'scale', 'minimum', 'maximum']);
      const scale = metricInteger(v.scale, 0, 6);
      const minimum = decimal(v.minimum, scale);
      const maximum = decimal(v.maximum, scale);
      if (scaled(minimum, scale) > scaled(maximum, scale))
        throw new TypeError('inverted metric bounds');
      return { kindCode: kind, unit: metricText(v.unit, 32), scale, minimum, maximum };
    }
    case 'boolean': {
      const v = metricObject(value, ['kindCode', 'unit']);
      if (v.unit !== null) throw new TypeError('boolean metric unit must be null');
      return { kindCode: kind, unit: null };
    }
    case 'short_text': {
      const v = metricObject(value, ['kindCode', 'unit', 'maxLength']);
      if (v.unit !== null) throw new TypeError('text metric unit must be null');
      return { kindCode: kind, unit: null, maxLength: metricInteger(v.maxLength, 1, 500) };
    }
    case 'single_choice': {
      const v = metricObject(value, ['kindCode', 'unit', 'options']);
      if (v.unit !== null) throw new TypeError('choice metric unit must be null');
      const options = metricArray(v.options, 50).map((option) => {
        const o = metricObject(option, ['code', 'label']);
        return { code: metricCode(o.code), label: metricText(o.label, 100) };
      });
      if (options.length === 0 || new Set(options.map((o) => o.code)).size !== options.length) {
        throw new TypeError('metric options must be nonempty and unique');
      }
      return { kindCode: kind, unit: null, options };
    }
    default:
      throw new TypeError('unknown metric kind');
  }
}

export function parseActivityMetricDefinition(value: unknown): ActivityMetricDefinitionV1 {
  const v = metricObject(value, ['schemaVersion', 'code', 'version', 'name', 'configuration']);
  if (v.schemaVersion !== 1) throw new TypeError('unsupported metric schema version');
  return {
    schemaVersion: 1,
    code: metricCode(v.code),
    version: metricInteger(v.version, 1, 2147483647),
    name: metricText(v.name, 100),
    configuration: parseConfiguration(v.configuration),
  };
}

/** Inputs here are freshly parsed JSON, never arbitrary caller-owned objects. */
function canonicalParsed(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalParsed).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property))
          throw new TypeError('invalid parsed metric metadata');
        return JSON.stringify(key) + ':' + canonicalParsed(property.value as unknown);
      })
      .join(',') +
    '}'
  );
}

export function fingerprintParsedMetricMetadata(value: ActivityMetricDefinitionV1): {
  canonicalText: string;
  definitionHash: string;
} {
  return fingerprintMetricEnvelope(
    'activity-metric-definition',
    parseActivityMetricDefinition(value),
  );
}

/** Internal C1 hash primitive; consumers must parse their own closed envelope first. */
export function fingerprintMetricEnvelope(
  domain: string,
  parsed: unknown,
): { canonicalText: string; definitionHash: string } {
  const canonicalText = canonicalParsed({ domain, definition: parsed });
  return {
    canonicalText,
    definitionHash: createHash('sha256').update(canonicalText, 'utf8').digest('hex'),
  };
}

export function fingerprintActivityMetricDefinition(value: unknown): {
  canonicalText: string;
  definitionHash: string;
} {
  return fingerprintParsedMetricMetadata(parseActivityMetricDefinition(value));
}

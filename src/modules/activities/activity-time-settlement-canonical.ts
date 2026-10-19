import { createHash } from 'node:crypto';
import { canonicalMetricEnvelope } from './activity-metric-definition';

const valueDomain = 'activity-time-settlement-local-value-v1';

/** Preserve C1's recursive treatment of caller objects, including descriptor errors. */
function canonicalCallerValue(value: unknown): string {
  const canonical = canonicalMetricEnvelope(valueDomain, value);
  return canonical.slice(
    '{"definition":'.length,
    -(',"domain":' + JSON.stringify(valueDomain) + '}').length,
  );
}

type Layout = {
  inputKeys: string[];
  fields: { key: string; prefix: string }[];
};

/** Only records freshly constructed by the time-settlement producer enter this encoder. */
function localRecordEncoder() {
  // Per invocation only; callers may add fields, so every layout is checked before reuse.
  const layouts = new Map<number, Layout>();
  const encode = (record: Record<string, unknown>, sources = false): string => {
    const inputKeys = Object.keys(record);
    const previous = layouts.get(inputKeys.length);
    let layout = previous?.inputKeys.every((key, index) => key === inputKeys[index])
      ? previous
      : undefined;
    if (!layout) {
      layout = {
        inputKeys,
        fields: [...inputKeys].sort().map((key) => ({ key, prefix: JSON.stringify(key) + ':' })),
      };
      // Retain one layout per size; a different shape takes the exact sorted path.
      if (!previous) layouts.set(inputKeys.length, layout);
    }
    return (
      '{' +
      layout.fields
        .map(({ key, prefix }) => {
          const value = record[key];
          const canonical =
            sources && key === 'sources' && Array.isArray(value)
              ? '[' + value.map((source: Record<string, unknown>) => encode(source)).join(',') + ']'
              : value !== null && typeof value === 'object'
                ? canonicalCallerValue(value)
                : JSON.stringify(value);
          return prefix + canonical;
        })
        .join(',') +
      '}'
    );
  };
  return encode;
}

export function fingerprintLocalTimeSourceManifest(definition: Record<string, unknown>): {
  definitionHash: string;
} {
  const encode = localRecordEncoder();
  const hash = createHash('sha256').update('{"definition":{', 'utf8');
  const keys = Object.keys(definition).sort();
  for (const [index, key] of keys.entries()) {
    hash.update((index === 0 ? '' : ',') + JSON.stringify(key) + ':', 'utf8');
    const value = definition[key];
    if (key === 'segments' && Array.isArray(value)) {
      hash.update('[', 'utf8');
      value.forEach((segment: Record<string, unknown>, ordinal) => {
        hash.update((ordinal === 0 ? '' : ',') + encode(segment), 'utf8');
      });
      hash.update(']', 'utf8');
    } else {
      hash.update(canonicalCallerValue(value), 'utf8');
    }
  }
  return {
    definitionHash: hash
      .update('},"domain":"activity-time-settlement-sources-v1"}', 'utf8')
      .digest('hex'),
  };
}

export function fingerprintLocalTimeBucketManifest(buckets: readonly Record<string, unknown>[]): {
  definitionHash: string;
} {
  const encode = localRecordEncoder();
  const hash = createHash('sha256').update('{"definition":[', 'utf8');
  buckets.forEach((bucket, index) => {
    hash.update((index === 0 ? '' : ',') + encode(bucket, true), 'utf8');
  });
  return {
    definitionHash: hash
      .update('],"domain":"activity-time-settlement-buckets-v1"}', 'utf8')
      .digest('hex'),
  };
}

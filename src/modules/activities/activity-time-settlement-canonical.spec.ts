import { createHash, type HashOptions } from 'node:crypto';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  fingerprintLocalTimeBucketManifest,
  fingerprintLocalTimeSourceManifest,
} from './activity-time-settlement-canonical';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, createHash: jest.fn(actual.createHash) };
});

const actualCrypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');

function capture(work: () => { definitionHash: string }) {
  const streams: string[][] = [];
  jest.mocked(createHash).mockImplementation((algorithm: string, options?: HashOptions) => {
    const hash = actualCrypto.createHash(algorithm, options);
    const chunks: string[] = [];
    streams.push(chunks);
    const update = hash.update.bind(hash);
    jest.spyOn(hash, 'update').mockImplementation((data, encoding) => {
      if (typeof data !== 'string') throw new Error('Canonical hash requires string chunks');
      expect(encoding).toBe('utf8');
      chunks.push(data);
      return update(data, encoding);
    });
    return hash;
  });
  try {
    const result = work();
    return {
      hash: result.definitionHash,
      canonical: streams[0].join(''),
      hashCount: streams.length,
    };
  } finally {
    jest.mocked(createHash).mockImplementation(actualCrypto.createHash);
  }
}

describe('local time manifest complete canonical equivalence', () => {
  const texts = ['', 'quote" slash\\', 'a\nb\tc', '雪🙂', 'é é', '\u2028\u2029', '\u0001', '  '];
  it('preserves the complete source envelope across layouts, scalar boundaries and nested JSON', () => {
    for (let n = 0; n < 60; n++) {
      const text = texts[n % texts.length];
      const segments = Array.from({ length: 12 }, (_, index) => ({
        id: text + index,
        checkInAt: '2026-09-01T01:00:00.000Z',
        checkOutAt: index % 2 ? null : '2026-09-01T02:00:00.000Z',
        revision: [-2147483648, -0, 0, 1, 2147483647, Number.MAX_SAFE_INTEGER][n % 6],
        allocationRevisionId: index % 2 ? text : null,
        allocationHash: text,
        exceptionFlagsJson: n % 2 ? { z: [null, false, text], a: { unknown: 'nested' } } : null,
        ...(index % 3 ? { unknown: text } : { other: text }),
      }));
      const definition = {
        activityId: text,
        workflowRevision: n,
        population: [{ memberId: text, participationIdentityId: text, pending: false }],
        segments,
        extra: { nested: [null, false, text, 1.25] },
      };
      const original = fingerprintMetricEnvelope('activity-time-settlement-sources-v1', definition);
      const candidate = capture(() => fingerprintLocalTimeSourceManifest(definition));
      expect(candidate.canonical).toBe(original.canonicalText);
      expect(candidate.hash).toBe(original.definitionHash);
      expect(candidate.hashCount).toBe(1);
    }
  });

  it('preserves complete bucket/source bags, array order, nulls and manual reasons', () => {
    for (let n = 0; n < 60; n++) {
      const text = texts[n % texts.length];
      const buckets = Array.from({ length: n % 8 }, (_, index) => ({
        participationIdentityId: text + index,
        categoryCode: 'volunteer_service',
        recognizedSeconds: n,
        rawRecognizedMilliseconds: String(n * 1000),
        rawCalculatedMilliseconds: index % 2 ? null : String(n * 1000),
        adjustmentReason: index % 2 ? [{ allocationRevisionId: text, manualReason: text }] : null,
        sources: Array.from({ length: n % 5 }, (_, ordinal) => ({
          allocationRevisionId: text + ordinal,
          sourceSegmentRevision: ordinal,
          sourceSegmentId: text,
          rawCalculatedMilliseconds: ordinal % 2 ? null : String(n * 1000),
          rawRecognizedMilliseconds: String(n * 1000),
        })),
      }));
      const original = fingerprintMetricEnvelope('activity-time-settlement-buckets-v1', buckets);
      const candidate = capture(() => fingerprintLocalTimeBucketManifest(buckets));
      expect(candidate.canonical).toBe(original.canonicalText);
      expect(candidate.hash).toBe(original.definitionHash);
      expect(candidate.hashCount).toBe(1);
    }
  });

  it('retains original caller-object descriptor rejection without invoking accessors', () => {
    let reads = 0;
    const population = Object.defineProperty({}, 'memberId', {
      enumerable: true,
      get: () => {
        reads++;
        return 'member';
      },
    });
    expect(() =>
      fingerprintLocalTimeSourceManifest({ population: [population], segments: [] }),
    ).toThrow('invalid parsed metric metadata');
    expect(reads).toBe(0);
  });
});

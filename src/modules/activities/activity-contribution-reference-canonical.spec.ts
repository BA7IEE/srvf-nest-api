import { canonicalizeLocalContributionReference } from './activity-contribution-reference-canonical';
import { canonicalizeActivityTemplateDefinition } from './activity-template-definition';
import type { ContributionSourceReference } from './activity-contribution-settlement-policy';

function reference(): Record<string, unknown> {
  return {
    allocationHash: 'a'.repeat(64),
    allocationRevisionId: 'allocation","é😀',
    durationSeconds: 0,
    endsAt: '2026-10-01T16:00:00.000Z',
    selectionItemId: '选择"\\\t尾',
    sliceId: 'slice\n尾',
    sourceSegmentId: '段 é é',
    sourceSegmentRevision: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-10-01T16:00:00.000Z',
  };
}
function format(value: unknown) {
  return canonicalizeLocalContributionReference(value as ContributionSourceReference);
}
function failure(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error: unknown) {
    return error instanceof Error
      ? { type: error.constructor.name, message: error.message }
      : error;
  }
}
describe('local reference canonical text agrees with the unchanged generic oracle', () => {
  it('preserves complete bytes for scalars, key order and nested/extra-field fallbacks', () => {
    const ordinary = reference();
    const nullPrototype = Object.assign(Object.create(null) as object, ordinary);
    const cases = [
      ordinary,
      Object.fromEntries(Object.entries(ordinary).reverse()),
      nullPrototype,
      { ...ordinary, durationSeconds: -0 },
      { ...ordinary, sourceSegmentRevision: 1 },
      Object.fromEntries(Object.keys(ordinary).map((key) => [key, null])),
      Object.fromEntries(Object.keys(ordinary).map((key) => [key, true])),
      Object.fromEntries(Object.keys(ordinary).map((key) => [key, ''])),
      {
        ...ordinary,
        correctionSource: {
          proofId: 'proof',
          pendingAllocationId: null,
          sourceHash: 'b'.repeat(64),
          sliceOrdinal: 0,
        },
      },
      { ...ordinary, unknown: ['nested', { x: 1 }] },
      { ...ordinary, durationSeconds: [0, 1] },
      { ...ordinary, sourceSegmentId: { id: 'nested' } },
    ];
    for (const value of cases)
      expect(format(value)).toBe(canonicalizeActivityTemplateDefinition(value));
  });
  it('preserves validation errors for unsupported values and object metadata', () => {
    const symbol = reference();
    Reflect.set(symbol, Symbol('private'), 'value');
    const hidden = reference();
    Object.defineProperty(hidden, 'hidden', { value: 1 });
    const accessor = reference();
    Object.defineProperty(accessor, 'sliceId', {
      enumerable: true,
      get() {
        throw new Error('must not invoke');
      },
    });
    const cyclic = reference();
    cyclic.sourceSegmentId = cyclic;
    const cases = [
      null,
      [],
      new Date(0),
      Object.assign(Object.create({ inherited: 1 }) as object, reference()),
      symbol,
      hidden,
      accessor,
      cyclic,
      { ...reference(), durationSeconds: 0.5 },
      { ...reference(), durationSeconds: Number.NaN },
      { ...reference(), durationSeconds: Number.POSITIVE_INFINITY },
      { ...reference(), sourceSegmentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...reference(), sliceId: undefined },
      { ...reference(), sourceSegmentId: () => 'value' },
    ];
    for (const value of cases) {
      const original = failure(() => canonicalizeActivityTemplateDefinition(value));
      expect(original).not.toBeNull();
      expect(failure(() => format(value))).toEqual(original);
    }
  });
});

import {
  buildNativeCapacityCorrectionShape,
  nativeCapacityCorrectionDeltas,
  selectNativeCapacityChanges,
} from '../../../test/helpers/native-capacity-change-shape';

const source = Object.freeze(
  Array.from({ length: 10000 }, (_, index) =>
    Object.freeze({
      id: `source-${String(index).padStart(5, '0')}`,
      participationIdentityId: `identity-${String(Math.floor(index / 5)).padStart(4, '0')}`,
      segmentKey: `segment-${index % 5}`,
    }),
  ),
);

describe('native capacity distinguishes complete sources from changed facts', () => {
  it('fixes N=10000 to delta=1, 1000, 10000 without changing production limits', () => {
    expect(nativeCapacityCorrectionDeltas(source.length)).toEqual({
      single: 1,
      tenPercent: 1000,
      all: 10000,
    });
  });

  it.each([1, 1000, 10000])('selects exactly %i complete segment keys', (delta) => {
    const { selected, metrics } = selectNativeCapacityChanges(source, delta);
    expect(metrics).toEqual({
      sourceRows: 10000,
      sourceIdentities: 2000,
      changedSegmentRows: delta,
      changedIdentities: delta === 10000 ? 2000 : delta,
      unchangedSegmentRows: 10000 - delta,
    });
    expect(new Set(selected.map((row) => row.id)).size).toBe(delta);
    expect(selected.every((row) => source.includes(row))).toBe(true);
    expect(selected.map((row) => row.id)).toEqual(
      selectNativeCapacityChanges([...source].reverse(), delta).selected.map((row) => row.id),
    );
    expect(source[0].id).toBe('source-00000');
    expect(source[9999].id).toBe('source-09999');
  });

  it('retains all original fact objects for the existing all-changed acceptance', () => {
    expect(new Set(selectNativeCapacityChanges(source, 10000).selected)).toEqual(new Set(source));
  });

  it.each([0, -1, 0.5, 10001, NaN, Infinity])('rejects invalid delta %s', (delta) => {
    expect(() => selectNativeCapacityChanges(source, delta)).toThrow('delta');
  });

  it('rejects duplicate physical rows rather than overstating N', () => {
    expect(() => selectNativeCapacityChanges([source[0], source[0]], 1)).toThrow('physical row');
  });

  it('rejects multiple revisions of the same logical segment', () => {
    expect(() =>
      selectNativeCapacityChanges([source[0], { ...source[0], id: 'different-revision' }], 1),
    ).toThrow('two revisions');
  });

  it('keeps distinct keys containing delimiters distinct', () => {
    const rows = [
      { id: 'one', participationIdentityId: 'a:b', segmentKey: 'c' },
      { id: 'two', participationIdentityId: 'a', segmentKey: 'b:c' },
    ];
    expect(selectNativeCapacityChanges(rows, 2).metrics.changedSegmentRows).toBe(2);
  });

  it('rejects an empty source and incomplete keys', () => {
    expect(() => selectNativeCapacityChanges([], 1)).toThrow('empty');
    expect(() => selectNativeCapacityChanges([{ ...source[0], segmentKey: '' }], 1)).toThrow(
      'nonempty',
    );
  });

  it.each([0, -10, 9, 10001, 10.5, NaN, Infinity])(
    'rejects a rounded ten-percent matrix: %s',
    (n) => {
      expect(() => nativeCapacityCorrectionDeltas(n)).toThrow('divisible by ten');
    },
  );
});

describe('fixed native V3 correction input and independent bucket expectations', () => {
  const closedSource = source.map((row, index) => ({
    ...row,
    checkInAt: new Date(Date.UTC(2099, 0, 1) + (index % 5) * 23000),
    checkOutAt: new Date(Date.UTC(2099, 0, 1) + (index % 5) * 23000 + 20000),
  }));

  it.each([
    { delta: 1 as const, total: 199996, changedPeople: 1 },
    { delta: 1000 as const, total: 196000, changedPeople: 1000 },
    { delta: 10000 as const, total: 190000, changedPeople: 2000 },
  ])(
    'keeps complete sources and applies exactly delta=$delta',
    ({ delta, total, changedPeople }) => {
      const shape = buildNativeCapacityCorrectionShape(closedSource, delta);
      expect(shape.metrics.changedSegmentRows).toBe(delta);
      expect(shape.metrics.changedIdentities).toBe(changedPeople);
      expect(shape.expectedRecognizedSeconds).toBe(total);
      expect(shape.expected).toEqual({
        sources: 10000,
        pending: delta,
        bindings: 10000,
        slices: 50000,
        segmentRevisions: 10000 + delta,
        allocationRevisions: 20000 + delta,
        physicalSlices: 100000 + 5 * delta,
      });
      const first = shape.recognizedSecondsByIdentity.get('identity-0000');
      expect(first).toEqual(
        delta === 10000
          ? { volunteer_service: 38, training: 19, organization: 19, non_creditable: 19 }
          : { volunteer_service: 39, training: 19, organization: 19, non_creditable: 19 },
      );
      if (delta !== 10000) {
        expect(shape.recognizedSecondsByIdentity.get('identity-1999')).toEqual({
          volunteer_service: 40,
          training: 20,
          organization: 20,
          non_creditable: 20,
        });
      }
    },
  );

  it('refuses a different fixture instead of applying the fixed arithmetic silently', () => {
    expect(() => buildNativeCapacityCorrectionShape(closedSource.slice(1), 1)).toThrow('N=10000');
    expect(() =>
      buildNativeCapacityCorrectionShape(
        closedSource.map((row, i) =>
          i === 0 ? { ...row, checkOutAt: new Date(row.checkOutAt.getTime() - 1) } : row,
        ),
        1,
      ),
    ).toThrow();
    expect(() =>
      buildNativeCapacityCorrectionShape(
        closedSource.map((row, i) =>
          i === 1
            ? {
                ...row,
                checkInAt: closedSource[0].checkInAt,
                checkOutAt: closedSource[0].checkOutAt,
              }
            : row,
        ),
        1,
      ),
    ).toThrow('overlap');
  });
});

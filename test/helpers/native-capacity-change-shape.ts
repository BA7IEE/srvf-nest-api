import { strict as assert } from 'node:assert';

interface CapacitySourceKey {
  readonly id: string;
  readonly participationIdentityId: string;
  readonly segmentKey: string;
}

/** N is the complete source set; delta is the number of replaced facts.
 * A large participant count alone is not evidence of a large correction.
 * This helper selects fixture inputs only. It neither executes nor accepts a test.
 */
export function selectNativeCapacityChanges<T extends CapacitySourceKey>(
  source: readonly T[],
  delta: number,
) {
  assert(source.length > 0, 'capacity source must not be empty');
  assert(
    Number.isSafeInteger(delta) && delta >= 1 && delta <= source.length,
    'delta must be an integer in [1, N]',
  );
  const ids = new Set<string>();
  const keys = new Set<string>();
  const identities = new Set<string>();
  for (const row of source) {
    assert(
      typeof row.id === 'string' &&
        row.id.length > 0 &&
        typeof row.participationIdentityId === 'string' &&
        row.participationIdentityId.length > 0 &&
        typeof row.segmentKey === 'string' &&
        row.segmentKey.length > 0,
      'capacity source requires nonempty physical and logical keys',
    );
    const key = JSON.stringify([row.participationIdentityId, row.segmentKey]);
    assert(!ids.has(row.id), 'capacity source contains a duplicate physical row');
    assert(!keys.has(key), 'capacity source contains two revisions of one current segment');
    ids.add(row.id);
    keys.add(key);
    identities.add(row.participationIdentityId);
  }
  // Locale-independent ordering makes the chosen facts independent of DB row order.
  const ordered = [...source].sort((a, b) => {
    const left = JSON.stringify([a.participationIdentityId, a.segmentKey, a.id]);
    const right = JSON.stringify([b.participationIdentityId, b.segmentKey, b.id]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const selected = Array.from(
    { length: delta },
    (_, index) => ordered[Math.floor((index * ordered.length) / delta)],
  );
  return {
    selected,
    metrics: {
      sourceRows: source.length,
      sourceIdentities: identities.size,
      changedSegmentRows: selected.length,
      changedIdentities: new Set(selected.map((row) => row.participationIdentityId)).size,
      unchangedSegmentRows: source.length - selected.length,
    },
  };
}

export function nativeCapacityCorrectionDeltas(totalSources: number) {
  assert(
    Number.isSafeInteger(totalSources) && totalSources >= 10 && totalSources % 10 === 0,
    'fixed correction matrix requires a positive source count divisible by ten',
  );
  return { single: 1, tenPercent: totalSources / 10, all: totalSources } as const;
}

interface ClosedCapacitySource extends CapacitySourceKey {
  readonly checkInAt: Date;
  readonly checkOutAt: Date | null;
}

/** Fixed native fixture only: five disjoint twenty-second segments per identity,
 * five equally sized slices (service, training, organization, non-credit, service),
 * and floor-to-one-second rounding after each complete identity/category bucket.
 * This constructs approved inputs; it is not a replacement for the frozen oracle.
 */
export function buildNativeCapacityCorrectionShape<T extends ClosedCapacitySource>(
  source: readonly T[],
  delta: 1 | 1000 | 10000,
) {
  assert.equal(source.length, 10000, 'fixed full source requires N=10000');
  assert([1, 1000, 10000].includes(delta), 'unsupported fixed correction shape');
  const shape = selectNativeCapacityChanges(source, delta);
  const selectedIds = new Set(shape.selected.map((row) => row.id));
  const byIdentity = new Map<string, T[]>();
  for (const row of source) {
    assert(row.checkInAt instanceof Date && row.checkOutAt instanceof Date);
    assert.equal(row.checkOutAt.getTime() - row.checkInAt.getTime(), 20000);
    const group = byIdentity.get(row.participationIdentityId) ?? [];
    group.push(row);
    byIdentity.set(row.participationIdentityId, group);
  }
  assert.equal(byIdentity.size, 2000, 'fixed full source requires 2000 identities');
  const recognizedSecondsByIdentity = new Map<string, Record<string, number>>();
  for (const [identityId, rows] of byIdentity) {
    assert.equal(rows.length, 5, 'fixed source requires five segments per identity');
    const ordered = [...rows].sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
    for (let i = 1; i < ordered.length; i++) {
      assert(
        ordered[i - 1].checkOutAt!.getTime() <= ordered[i].checkInAt.getTime(),
        'fixed source segments must not overlap',
      );
    }
    const changed = rows.filter((row) => selectedIds.has(row.id)).length;
    const milliseconds = 100000 - changed * 1000;
    recognizedSecondsByIdentity.set(identityId, {
      volunteer_service: Math.floor((milliseconds * 2) / 5000),
      training: Math.floor(milliseconds / 5000),
      organization: Math.floor(milliseconds / 5000),
      non_creditable: Math.floor(milliseconds / 5000),
    });
  }
  return {
    ...shape,
    recognizedSecondsByIdentity,
    expectedRecognizedSeconds: [...recognizedSecondsByIdentity.values()].reduce(
      (total, categories) =>
        total + Object.values(categories).reduce((sum, value) => sum + value, 0),
      0,
    ),
    expected: {
      sources: 10000,
      pending: delta,
      bindings: 10000,
      slices: 50000,
      segmentRevisions: 10000 + delta,
      allocationRevisions: 20000 + delta,
      physicalSlices: 100000 + 5 * delta,
    },
  };
}

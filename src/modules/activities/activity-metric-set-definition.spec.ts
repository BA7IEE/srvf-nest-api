import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import {
  assertActivityMetricSetActivation,
  fingerprintActivityMetricSetDefinition,
  parseActivityMetricSetDefinition,
} from './activity-metric-set-definition';

const definition = {
  schemaVersion: 1,
  code: 'served',
  version: 1,
  name: '服务人数',
  configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 1000 },
};
const definitionHash = fingerprintActivityMetricDefinition(definition).definitionHash;
const item = {
  key: 'served',
  sortOrder: 0,
  required: true,
  metricDefinitionId: 'definition_1',
  definitionHash,
};
const set = { schemaVersion: 1, code: 'support', version: 1, name: '保障成果', items: [item] };
const row = { id: item.metricDefinitionId, statusCode: 'active', definitionHash, definition };

describe('C1 metric set V1', () => {
  it('verifies the entire definition/hash reference closure before activation', () => {
    expect(
      assertActivityMetricSetActivation(
        set,
        fingerprintActivityMetricSetDefinition(set).definitionHash,
        [row],
      ),
    ).toEqual(set);
  });
  it('canonicalizes items by explicit order rather than input array position', () => {
    const second = { ...item, key: 'second', sortOrder: 1, metricDefinitionId: 'definition_2' };
    expect(fingerprintActivityMetricSetDefinition({ ...set, items: [second, item] })).toEqual(
      fingerprintActivityMetricSetDefinition({ ...set, items: [item, second] }),
    );
  });
  it.each([
    { required: false },
    { key: 'other' },
    { sortOrder: 1 },
    { metricDefinitionId: 'definition_2' },
    { definitionHash: 'b'.repeat(64) },
  ])('hash binds item semantics %j', (change) => {
    expect(
      fingerprintActivityMetricSetDefinition({ ...set, items: [{ ...item, ...change }] })
        .definitionHash,
    ).not.toBe(fingerprintActivityMetricSetDefinition(set).definitionHash);
  });
  it.each([
    { ...set, schemaVersion: 2 },
    { ...set, version: 0 },
    { ...set, name: ' ' },
    { ...set, items: [{ ...item, required: 'true' }] },
    { ...set, items: [{ ...item, definitionHash: 'A'.repeat(64) }] },
    { ...set, items: [{ ...item, sortOrder: 100 }] },
    { ...set, items: [{ ...item, prompt: 'private' }] },
    { ...set, items: [item, { ...item, key: 'second', sortOrder: 1 }] },
    { ...set, items: [item, { ...item, metricDefinitionId: 'other_id', sortOrder: 1 }] },
    { ...set, items: [item, { ...item, metricDefinitionId: 'other_id', key: 'second' }] },
    {
      ...set,
      items: Array.from({ length: 101 }, (_, n) => ({
        ...item,
        key: 'k' + n,
        metricDefinitionId: 'id_' + n,
        sortOrder: n,
      })),
    },
  ])('rejects malformed or ambiguous set %j', (value) => {
    expect(() => parseActivityMetricSetDefinition(value)).toThrow(TypeError);
  });
  it('permits exactly 100 explicitly ordered distinct items', () => {
    const value = {
      ...set,
      items: Array.from({ length: 100 }, (_, n) => ({
        ...item,
        key: 'k' + n,
        metricDefinitionId: 'id_' + n,
        sortOrder: n,
      })),
    };
    expect(parseActivityMetricSetDefinition(value).items).toHaveLength(100);
  });
  it('can fingerprint empty drafts but never activates them', () => {
    const empty = { ...set, items: [] };
    const hash = fingerprintActivityMetricSetDefinition(empty).definitionHash;
    expect(() => assertActivityMetricSetActivation(empty, hash, [])).toThrow(TypeError);
  });
  it.each(
    [
      [],
      [row, row],
      [{ ...row, id: 'wrong_id' }],
      [{ ...row, statusCode: 'draft' }],
      [{ ...row, statusCode: 'retired' }],
      [{ ...row, definitionHash: 'a'.repeat(64) }],
      [{ ...row, definition: { ...definition, name: 'tampered' } }],
    ].map((rows) => ({ rows })),
  )('rejects stale/missing/duplicate references %j', ({ rows }) => {
    expect(() =>
      assertActivityMetricSetActivation(
        set,
        fingerprintActivityMetricSetDefinition(set).definitionHash,
        rows,
      ),
    ).toThrow(TypeError);
  });
  it('rejects a forged set hash', () => {
    expect(() => assertActivityMetricSetActivation(set, 'f'.repeat(64), [row])).toThrow(TypeError);
  });
});

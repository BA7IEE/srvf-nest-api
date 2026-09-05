import {
  fingerprintActivityMetricDefinition,
  parseActivityMetricDefinition,
} from './activity-metric-definition';

const integer = { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 1000 };
const definition = (configuration: unknown = integer) => ({
  schemaVersion: 1,
  code: 'served_people',
  version: 1,
  name: '服务人数',
  configuration,
});

describe('C1 metric definition V1', () => {
  it.each([
    integer,
    {
      kindCode: 'non_negative_decimal',
      unit: '千克',
      scale: 6,
      minimum: '0',
      maximum: '999999999999.999999',
    },
    { kindCode: 'boolean', unit: null },
    { kindCode: 'short_text', unit: null, maxLength: 500 },
    { kindCode: 'single_choice', unit: null, options: [{ code: 'done', label: '完成' }] },
  ])('roundtrips the supported configuration %j', (configuration) => {
    const value = definition(configuration);
    expect(parseActivityMetricDefinition(value)).toEqual(value);
    expect(fingerprintActivityMetricDefinition(value).definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sorts object keys, returns a fresh graph, and domain-separates the envelope', () => {
    const a = definition();
    const b = {
      configuration: { maximum: 1000, minimum: 0, unit: '人', kindCode: 'non_negative_integer' },
      name: a.name,
      version: 1,
      code: a.code,
      schemaVersion: 1,
    };
    const result = fingerprintActivityMetricDefinition(a);
    expect(fingerprintActivityMetricDefinition(b)).toEqual(result);
    expect(result.canonicalText).toContain('"domain":"activity-metric-definition"');
    expect(parseActivityMetricDefinition(a).configuration).not.toBe(a.configuration);
  });

  it.each([
    { ...definition(), version: 2 },
    { ...definition(), name: '救助人数' },
    { ...definition(), code: 'rescued_people' },
    definition({ ...integer, unit: '次' }),
    definition({ ...integer, maximum: 999 }),
  ])('changes the hash for semantic change %j', (value) => {
    expect(fingerprintActivityMetricDefinition(value).definitionHash).not.toBe(
      fingerprintActivityMetricDefinition(definition()).definitionHash,
    );
  });

  it.each([
    { ...definition(), schemaVersion: 2 },
    { ...definition(), version: 0 },
    { ...definition(), version: 2147483648 },
    { ...definition(), code: 'Bad-Code' },
    { ...definition(), code: 'a'.repeat(65) },
    { ...definition(), name: ' ' },
    { ...definition(), name: 'n'.repeat(101) },
    { ...definition(), script: 'return 1' },
    { ...definition(), configuration: undefined },
  ])('rejects invalid top-level metadata %j', (value) => {
    expect(() => parseActivityMetricDefinition(value)).toThrow(TypeError);
  });

  it.each([
    { ...integer, minimum: -1 },
    { ...integer, maximum: 0.1 },
    { ...integer, minimum: 5, maximum: 4 },
    { ...integer, maximum: Number.MAX_SAFE_INTEGER + 1 },
    { ...integer, maximum: NaN },
    { ...integer, unit: null },
    { ...integer, unit: 'u'.repeat(33) },
    { ...integer, options: [] },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 7, minimum: '0', maximum: '1' },
    {
      kindCode: 'non_negative_decimal',
      unit: '吨',
      scale: 6,
      minimum: '0',
      maximum: '1000000000000',
    },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 1, minimum: '0', maximum: '1.01' },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 2, minimum: '2', maximum: '1' },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 2, minimum: '0', maximum: '01' },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 2, minimum: '0', maximum: '1.00' },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 2, minimum: '0', maximum: 1.1 },
    { kindCode: 'non_negative_decimal', unit: '吨', scale: 2, minimum: '0', maximum: '1e2' },
    { kindCode: 'boolean', unit: '人' },
    { kindCode: 'boolean', unit: null, maximum: 1 },
    { kindCode: 'short_text', unit: null, maxLength: 501 },
    { kindCode: 'short_text', unit: null, maxLength: 0 },
    { kindCode: 'single_choice', unit: null, options: [] },
    {
      kindCode: 'single_choice',
      unit: null,
      options: [
        { code: 'x', label: 'X' },
        { code: 'x', label: 'Y' },
      ],
    },
    {
      kindCode: 'single_choice',
      unit: null,
      options: Array.from({ length: 51 }, (_, n) => ({ code: 'c' + n, label: 'X' })),
    },
    { kindCode: 'single_choice', unit: null, options: [{ code: 'x', label: 'x'.repeat(101) }] },
    { kindCode: 'json', unit: null },
  ])('rejects invalid typed configuration %j', (configuration) => {
    expect(() => parseActivityMetricDefinition(definition(configuration))).toThrow(TypeError);
  });

  it('rejects an accessor without executing caller code', () => {
    const getter = jest.fn(() => integer);
    const value = Object.defineProperty(definition(), 'configuration', {
      get: getter,
      enumerable: true,
    });
    expect(() => parseActivityMetricDefinition(value)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    new Date(),
    Object.assign(definition(), { [Symbol('secret')]: 1 }),
    Object.create(definition()),
  ])('rejects non-JSON object %j', (value: unknown) => {
    expect(() => parseActivityMetricDefinition(value)).toThrow(TypeError);
  });

  it('rejects sparse option arrays and option getters', () => {
    const options = new Array<unknown>(1);
    expect(() =>
      parseActivityMetricDefinition(definition({ kindCode: 'single_choice', unit: null, options })),
    ).toThrow(TypeError);
    const getter = jest.fn();
    Object.defineProperty(options, '0', { get: getter, enumerable: true });
    expect(() =>
      parseActivityMetricDefinition(definition({ kindCode: 'single_choice', unit: null, options })),
    ).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

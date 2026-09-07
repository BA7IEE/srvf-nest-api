import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';

function fixture(configuration: unknown) {
  const definition = { schemaVersion: 1, code: 'served', version: 1, name: '成果', configuration };
  const { definitionHash } = fingerprintActivityMetricDefinition(definition);
  return (value: unknown) => fingerprintActivityOutcomeValue(definition, definitionHash, value);
}

describe('C2 outcome value validation', () => {
  it('accepts integer boundaries and rejects coercion, unsafe and noncanonical numbers', () => {
    const parse = fixture({
      kindCode: 'non_negative_integer',
      unit: '人',
      minimum: 0,
      maximum: 10,
    });
    expect(parse(0).valueJson).toBe(0);
    expect(parse(10).valueJson).toBe(10);
    for (const value of [-0, -1, 11, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])
      expect(() => parse(value)).toThrow(TypeError);
  });

  it('compares decimals exactly and rejects noncanonical or overprecision inputs', () => {
    const parse = fixture({
      kindCode: 'non_negative_decimal',
      unit: '千克',
      scale: 2,
      minimum: '0.1',
      maximum: '9999999999999999.99',
    });
    expect(parse('0.1').valueJson).toBe('0.1');
    expect(parse('9999999999999999.99').valueJson).toBe('9999999999999999.99');
    for (const value of ['0.09', '0.101', '01', '1.0', '1e2', '-0', '10000000000000000', 0.1])
      expect(() => parse(value)).toThrow(TypeError);
  });

  it('validates boolean, bounded text and configured choices without coercion', () => {
    const boolean = fixture({ kindCode: 'boolean', unit: null });
    expect(boolean(false).valueJson).toBe(false);
    expect(() => boolean('false')).toThrow(TypeError);
    const text = fixture({ kindCode: 'short_text', unit: null, maxLength: 3 });
    expect(text('abc').valueJson).toBe('abc');
    for (const value of ['', ' a', 'abcd', {}]) expect(() => text(value)).toThrow(TypeError);
    const choice = fixture({
      kindCode: 'single_choice',
      unit: null,
      options: [{ code: 'done', label: '完成' }],
    });
    expect(choice('done').valueJson).toBe('done');
    expect(() => choice('完成')).toThrow(TypeError);
  });

  it('preserves exact decimal boundaries at zero and maximum supported scale', () => {
    const whole = fixture({
      kindCode: 'non_negative_decimal',
      unit: '个',
      scale: 0,
      minimum: '0',
      maximum: '999999999999999999',
    });
    expect(whole('0').valueJson).toBe('0');
    expect(whole('999999999999999999').valueJson).toBe('999999999999999999');
    for (const value of ['0.1', '1000000000000000000', '0.0', '', ' 1', '1\n'])
      expect(() => whole(value)).toThrow(TypeError);
    const fractional = fixture({
      kindCode: 'non_negative_decimal',
      unit: '千克',
      scale: 6,
      minimum: '0.000001',
      maximum: '999999999999.999999',
    });
    expect(fractional('0.000001').valueJson).toBe('0.000001');
    expect(fractional('999999999999.999999').valueJson).toBe('999999999999.999999');
    for (const value of ['0', '0.0000001', '1000000000000', '0.0000010'])
      expect(() => fractional(value)).toThrow(TypeError);
  });

  it('binds deterministic value hashes to the validated definition and rejects drift', () => {
    const definition = {
      schemaVersion: 1,
      code: 'served',
      version: 1,
      name: '成果',
      configuration: { kindCode: 'boolean', unit: null },
    };
    const hash = fingerprintActivityMetricDefinition(definition).definitionHash;
    const first = fingerprintActivityOutcomeValue(definition, hash, true);
    expect(fingerprintActivityOutcomeValue(definition, hash, true)).toEqual(first);
    expect(fingerprintActivityOutcomeValue(definition, hash, false).valueHash).not.toBe(
      first.valueHash,
    );
    expect(() =>
      fingerprintActivityOutcomeValue({ ...definition, version: 2 }, hash, true),
    ).toThrow(TypeError);
    expect(() =>
      fingerprintActivityOutcomeValue({ ...definition, extra: true }, hash, true),
    ).toThrow(TypeError);
    expect(() => fingerprintActivityOutcomeValue(definition, 'bad', true)).toThrow(TypeError);
  });
});

import { parseInsuranceEnforcementEnabled } from './app.config';

describe('INSURANCE_ENFORCEMENT_ENABLED', () => {
  it.each(['development', 'test', 'smoke'] as const)('%s missing/empty defaults false', (env) => {
    expect(parseInsuranceEnforcementEnabled(undefined, env)).toBe(false);
    expect(parseInsuranceEnforcementEnabled('', env)).toBe(false);
  });

  it('production requires an explicit value', () => {
    expect(() => parseInsuranceEnforcementEnabled(undefined, 'production')).toThrow(
      'INSURANCE_ENFORCEMENT_ENABLED 不能为空',
    );
    expect(() => parseInsuranceEnforcementEnabled('', 'production')).toThrow(
      'INSURANCE_ENFORCEMENT_ENABLED 不能为空',
    );
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('accepts strict literal %s', (raw, expected) => {
    expect(parseInsuranceEnforcementEnabled(raw, 'production')).toBe(expected);
  });

  it.each(['TRUE', 'False', '1', 'yes', ' true ', 'false '])(
    'rejects invalid literal %j in every environment',
    (raw) => {
      expect(() => parseInsuranceEnforcementEnabled(raw, 'test')).toThrow(
        'INSURANCE_ENFORCEMENT_ENABLED 无效',
      );
    },
  );
});

import {
  parseActivityResponsibilityWorkflowEnabled,
  parseInsuranceEnforcementEnabled,
  parseTrustedProxyCidrs,
} from './app.config';

describe('APP_TRUSTED_PROXY_CIDRS', () => {
  it.each(['development', 'test'] as const)('%s missing/empty/blank defaults to none', (env) => {
    expect(parseTrustedProxyCidrs(undefined, env)).toEqual([]);
    expect(parseTrustedProxyCidrs('', env)).toEqual([]);
    expect(parseTrustedProxyCidrs('   ', env)).toEqual([]);
  });

  it.each(['production', 'smoke'] as const)('%s missing/empty/blank fails fast', (env) => {
    expect(() => parseTrustedProxyCidrs(undefined, env)).toThrow(
      'APP_TRUSTED_PROXY_CIDRS 不能为空',
    );
    expect(() => parseTrustedProxyCidrs('', env)).toThrow('APP_TRUSTED_PROXY_CIDRS 不能为空');
    expect(() => parseTrustedProxyCidrs('   ', env)).toThrow('APP_TRUSTED_PROXY_CIDRS 不能为空');
  });

  it('accepts exact lowercase none as an explicit empty trust set', () => {
    expect(parseTrustedProxyCidrs('none', 'production')).toEqual([]);
  });

  it('accepts explicit IPv4 and IPv6 CIDRs without normalizing their text', () => {
    const raw =
      '10.42.0.12/32,192.0.2.128/25,2001:db8:8000::/33,2001:DB8:1::1/128,::ffff:192.0.2.0/120';
    expect(parseTrustedProxyCidrs(raw, 'production')).toEqual(raw.split(','));
  });

  it.each([
    '192.0.2.1/24',
    '192.0.2.129/25',
    '2001:db8::1/64',
    '2001:db8:0:1::/48',
    '2001:db8:4000::/33',
    '::ffff:192.0.2.1/120',
    '::ffff:c000:201/120',
  ])('rejects non-canonical network CIDR with non-zero host bits: %s', (raw) => {
    expect(() => parseTrustedProxyCidrs(raw, 'test')).toThrow(
      '含非零 host bits，必须填写 canonical network CIDR',
    );
  });

  it.each([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '::ffff:10.0.0.0/104',
    '::ffff:172.16.0.0/108',
    '::ffff:c0a8:0/112',
  ])('rejects an entire RFC1918 aggregation root, including mapped spelling: %s', (raw) => {
    expect(() => parseTrustedProxyCidrs(raw, 'test')).toThrow('禁止信任整个 RFC1918 聚合根');
  });

  it.each(['::ffff:0.0.0.0/96', '::ffff:0:0/96'])(
    'rejects an IPv4-mapped network equivalent to IPv4 /0: %s',
    (raw) => {
      expect(() => parseTrustedProxyCidrs(raw, 'test')).toThrow('禁止任意 /0');
    },
  );

  it.each([
    'NONE',
    'true',
    'false',
    '1',
    '2',
    '*',
    'proxy.internal',
    '192.0.2.1',
    'none,192.0.2.1/32',
    '192.0.2.1/32,none',
    '192.0.2.1/32,',
    ',192.0.2.1/32',
    '192.0.2.1/32,,198.51.100.1/32',
    ' 192.0.2.1/32',
    '192.0.2.1/32 ',
    '192.0.2.1 /32',
    '192.0.2.1/ 32',
    '192.0.2.1/024',
    '192.0.2.1/+24',
    '192.0.2.1/-1',
    '192.0.2.1/33',
    '2001:db8::1/129',
    '192.0.2.1/24/1',
    '2001:db8::1%eth0/128',
    '0.0.0.0/0',
    '::/0',
  ])('rejects non-CIDR, ambiguous, wildcard, empty-item, or illegal-prefix value %j', (raw) => {
    expect(() => parseTrustedProxyCidrs(raw, 'test')).toThrow('APP_TRUSTED_PROXY_CIDRS 无效');
  });

  it.each([
    '127.0.0.1/32',
    '126.0.0.0/7',
    '169.254.10.1/32',
    '169.0.0.0/8',
    '::1/128',
    'fe80::1/128',
    'fe00::/7',
    'fc00::1/128',
    'fd12:3456::/48',
    'f800::/5',
    '::ffff:127.0.0.1/128',
    '::ffff:127.0.0.0/104',
    '::ffff:169.254.1.1/128',
    '::ffff:169.254.0.0/112',
    '::ffff:126.0.0.0/103',
  ])('rejects CIDR that is inside or intersects a forbidden local range: %s', (raw) => {
    expect(() => parseTrustedProxyCidrs(raw, 'test')).toThrow(
      '不得包含 loopback/link-local/unique-local',
    );
  });
});

describe('ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED', () => {
  it.each(['development', 'test'] as const)('%s missing defaults false', (env) => {
    expect(parseActivityResponsibilityWorkflowEnabled(undefined, env)).toBe(false);
    expect(parseActivityResponsibilityWorkflowEnabled('', env)).toBe(false);
  });

  it.each(['production', 'smoke'] as const)('%s requires an explicit value', (env) => {
    expect(() => parseActivityResponsibilityWorkflowEnabled(undefined, env)).toThrow(
      'ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED 不能为空',
    );
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('accepts strict literal %s', (raw, expected) => {
    expect(parseActivityResponsibilityWorkflowEnabled(raw, 'production')).toBe(expected);
  });

  it.each(['TRUE', 'False', '1', 'yes', ' true '])('rejects invalid literal %j', (raw) => {
    expect(() => parseActivityResponsibilityWorkflowEnabled(raw, 'test')).toThrow(
      '必须严格为 true 或 false',
    );
  });
});

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

import { validateR5CiInput } from '../../test/setup/r5-ci-instance-scope';
import { R5_CI_DATABASE, R5_CI_ROLES } from '../../test/helpers/r5-ci-source-binding';

// Source/transport-input model only. No database, SCRAM or qualification claim.
const sample = () => ({
  identity: {
    database: R5_CI_DATABASE,
    databaseOid: 101,
    cluster: '20261101001',
    roles: Object.fromEntries(Object.values(R5_CI_ROLES).map((name, index) => [name, 201 + index])),
  },
  installationSha256: '1'.repeat(64),
  authenticationSha256: '2'.repeat(64),
  ownerUrl: `postgresql://postgres@localhost/${R5_CI_DATABASE}?host=%2Frun%2Fr5-pg-socket&connection_limit=1`,
  trustedUrl: `postgresql://${R5_CI_ROLES.trusted}:synthetic-test-only@127.0.0.1/${R5_CI_DATABASE}?connection_limit=1&options=-c%20role%3D${R5_CI_ROLES.caller}`,
  untrustedUrl: `postgresql://${R5_CI_ROLES.untrusted}:synthetic-test-only@127.0.0.1/${R5_CI_DATABASE}?connection_limit=1&options=-c%20role%3D${R5_CI_ROLES.caller}`,
});

describe('R5 authenticated CI input remains fresh, source-bound and memory-only', () => {
  it('derives expected catalogs from frozen source using only fresh identity substitutions', () => {
    const input = sample();
    const accepted = validateR5CiInput(input);
    expect(accepted.installed.database).toEqual({ name: R5_CI_DATABASE, oid: 101 });
    expect(accepted.installed.source.clusterSystemIdentifier).toBe(input.identity.cluster);
    expect(accepted.installed.source.expectedCatalogSha256).toBe(accepted.sourceSha256);
    expect(JSON.stringify(accepted.installed)).not.toContain('synthetic-test-only');
    expect(JSON.stringify(accepted.installed)).not.toContain('postgresql://');
  });
  it.each([
    {
      name: 'historical cluster',
      mutate: (input: ReturnType<typeof sample>) => {
        input.identity.cluster = '7695840193603043362';
      },
    },
    {
      name: 'different database',
      mutate: (input: ReturnType<typeof sample>) => {
        input.identity.database = 'app_test';
      },
    },
    {
      name: 'owner TCP fallback',
      mutate: (input: ReturnType<typeof sample>) => {
        input.ownerUrl = input.ownerUrl.replace('host=%2Frun%2Fr5-pg-socket&', '');
      },
    },
    {
      name: 'other socket',
      mutate: (input: ReturnType<typeof sample>) => {
        input.ownerUrl = input.ownerUrl.replace('r5-pg-socket', 'other');
      },
    },
    {
      name: 'P ordinary identity',
      mutate: (input: ReturnType<typeof sample>) => {
        input.untrustedUrl = input.trustedUrl;
      },
    },
    {
      name: 'nonloopback P',
      mutate: (input: ReturnType<typeof sample>) => {
        input.trustedUrl = input.trustedUrl.replace('127.0.0.1', '192.0.2.1');
      },
    },
    {
      name: 'two P connections',
      mutate: (input: ReturnType<typeof sample>) => {
        input.trustedUrl = input.trustedUrl.replace('connection_limit=1', 'connection_limit=2');
      },
    },
    {
      name: 'different port',
      mutate: (input: ReturnType<typeof sample>) => {
        input.untrustedUrl = input.untrustedUrl.replace('127.0.0.1/', '127.0.0.1:5433/');
      },
    },
    {
      name: 'missing receipt',
      mutate: (input: ReturnType<typeof sample>) => {
        input.authenticationSha256 = '';
      },
    },
  ])('rejects $name without echoing input', ({ mutate }) => {
    const input = sample();
    mutate(input);
    expect(() => validateR5CiInput(input)).toThrow('R5_CI_INPUT_REJECTED');
  });
});

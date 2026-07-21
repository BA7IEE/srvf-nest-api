import {
  parseStorageSettingsBootstrapArgs,
  StorageSettingsBootstrapError,
} from './storage-settings-bootstrap';

describe('parseStorageSettingsBootstrapArgs', () => {
  it('parses required values and dry-run', () => {
    expect(
      parseStorageSettingsBootstrapArgs([
        '--config-file=/run/secrets/storage-bootstrap.json',
        '--confirm-database=srvf_prod',
        '--dry-run',
      ]),
    ).toEqual({
      configFile: '/run/secrets/storage-bootstrap.json',
      confirmDatabase: 'srvf_prod',
      dryRun: true,
    });
  });

  it.each([
    ['--config-file=/tmp/config.json'],
    ['--confirm-database=srvf_prod'],
    ['--config-file=/tmp/config.json', '--confirm-database=srvf_prod', '--overwrite'],
    ['--config-file=/tmp/a.json', '--config-file=/tmp/b.json', '--confirm-database=srvf_prod'],
  ])('rejects missing, unknown or duplicate arguments: %j', (...tokens) => {
    expect(() => parseStorageSettingsBootstrapArgs(tokens)).toThrow(StorageSettingsBootstrapError);
  });
});

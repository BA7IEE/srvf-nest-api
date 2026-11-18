import {
  assertOwnedAdvisoryLockBackends,
  type AdvisoryLockBackend,
} from '../../test/helpers/organization-lock-ownership';

const owner = 'org_topology_0123456789abcdef0123456789abcdef';
const backend: AdvisoryLockBackend = {
  pid: 123,
  applicationName: owner,
  backendStart: '2026-01-01 00:00:00+00',
};

describe('organization advisory-lock cleanup ownership', () => {
  it('accepts only backends with the current test identity and start time', () => {
    expect(() => assertOwnedAdvisoryLockBackends([backend], owner)).not.toThrow();
    expect(() => assertOwnedAdvisoryLockBackends([], owner)).not.toThrow();
  });

  it.each([
    { ...backend, pid: 124, applicationName: null },
    { ...backend, pid: 124, applicationName: '' },
    { ...backend, pid: 124, applicationName: 'another-test' },
    { ...backend, pid: 124, backendStart: null },
    { ...backend, pid: 124, backendStart: '' },
    { ...backend, pid: null },
    { ...backend, pid: 0 },
  ])('rejects an unknown or incomplete backend identity', (unknown) => {
    expect(() => assertOwnedAdvisoryLockBackends([backend, unknown], owner)).toThrow(
      'backend ownership is unknown',
    );
  });

  it('rejects malformed owners and duplicate PIDs', () => {
    expect(() => assertOwnedAdvisoryLockBackends([backend], 'org_topology_123')).toThrow(
      'backend ownership is unknown',
    );
    expect(() => assertOwnedAdvisoryLockBackends([backend, backend], owner)).toThrow(
      'backend ownership is unknown',
    );
  });
});

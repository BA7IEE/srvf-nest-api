export interface AdvisoryLockBackend {
  pid: number | null;
  applicationName: string | null;
  backendStart: string | null;
}

export function assertOwnedAdvisoryLockBackends(
  backends: AdvisoryLockBackend[],
  owner: string,
): asserts backends is Array<{
  pid: number;
  applicationName: string;
  backendStart: string;
}> {
  const seen = new Set<number>();
  if (
    !/^org_topology_[a-f0-9]{32}$/u.test(owner) ||
    backends.some((backend) => {
      if (
        backend.pid === null ||
        !Number.isSafeInteger(backend.pid) ||
        backend.pid <= 0 ||
        seen.has(backend.pid) ||
        backend.applicationName !== owner ||
        !backend.backendStart
      ) {
        return true;
      }
      seen.add(backend.pid);
      return false;
    })
  ) {
    throw new Error('advisory-lock cleanup refused: backend ownership is unknown');
  }
}

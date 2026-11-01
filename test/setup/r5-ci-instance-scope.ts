import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import suites from '../r5-authenticated-ci-suites.json';
import {
  R5_CI_DATABASE,
  R5_CI_ROLES,
  r5CiInstalledRecord,
  r5CiSourceBinding,
  type R5CiInstanceIdentity,
} from '../helpers/r5-ci-source-binding';

const HISTORICAL_CLUSTER = '7695840193603043362';
export const R5_CI_AUTHENTICATED_FILES = Object.freeze(suites.map(({ file }) => file));
// Public test values only. Connection URLs and JWT material remain in their
// separate stdin/config-token paths and never enter this environment map.
export const R5_CI_NONSECRET_APP_ENV = Object.freeze({
  APP_ENV: 'test',
  APP_PORT: '3001',
  APP_CORS_ORIGIN: 'http://localhost:5173',
  ENABLE_SWAGGER: 'true',
  LOGIN_THROTTLE_LIMIT: '50',
});

export interface R5CiInput {
  readonly identity: R5CiInstanceIdentity;
  readonly installationSha256: string;
  readonly authenticationSha256: string;
  readonly ownerUrl: string;
  readonly trustedUrl: string;
  readonly untrustedUrl: string;
}
interface Scope extends R5CiInput {
  readonly sourceSha256: string;
  readonly installed: ReturnType<typeof r5CiInstalledRecord>;
}
let scope: Scope | undefined;

export function r5CiAuthenticated(): boolean {
  const value = process.env.SRVF_R5_CI_AUTHENTICATED;
  if (value === undefined) return false;
  if (value !== '1') throw new Error('R5_CI_EXPLICIT_ROUTE_REQUIRED');
  return true;
}

/** Operator stdin is only an input. The production qualifier still verifies
 * these source-bound identities on the actual P connection before app.init. */
export function validateR5CiInput(value: unknown): Scope {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const input = value as R5CiInput;
    if (
      Object.keys(input).sort().join(',') !==
        'authenticationSha256,identity,installationSha256,ownerUrl,trustedUrl,untrustedUrl' ||
      input.identity.cluster === HISTORICAL_CLUSTER
    )
      throw new Error();
    const binding = r5CiSourceBinding(input.identity);
    const urls = [input.ownerUrl, input.trustedUrl, input.untrustedUrl].map((raw) => {
      if (typeof raw !== 'string' || raw.length > 8192) throw new Error();
      const url = new URL(raw);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        decodeURIComponent(url.pathname.slice(1)) !== R5_CI_DATABASE ||
        url.searchParams.getAll('connection_limit').join(',') !== '1' ||
        url.hash ||
        [...url.searchParams.keys()].some(
          (key) => !['connection_limit', 'options', 'host', 'schema'].includes(key),
        ) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
        (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
      )
        throw new Error();
      return url;
    });
    const [owner, trusted, untrusted] = urls;
    if (
      decodeURIComponent(owner.username) !== 'postgres' ||
      owner.password ||
      !['localhost', '127.0.0.1'].includes(owner.hostname) ||
      owner.searchParams.get('host') !== '/run/r5-pg-socket' ||
      owner.searchParams.has('options')
    )
      throw new Error();
    for (const [url, role] of [
      [trusted, R5_CI_ROLES.trusted],
      [untrusted, R5_CI_ROLES.untrusted],
    ] as const) {
      if (
        url.hostname !== '127.0.0.1' ||
        decodeURIComponent(url.username) !== role ||
        !url.password ||
        url.searchParams.has('host') ||
        url.searchParams.get('options') !== `-c role=${R5_CI_ROLES.caller}` ||
        (url.port || '5432') !== (owner.port || '5432')
      )
        throw new Error();
    }
    return Object.freeze({
      ...input,
      sourceSha256: binding.catalogSha256,
      installed: r5CiInstalledRecord(input.identity, binding, input),
    });
  } catch {
    // No supplied URL, password, JSON, path or nested error is serialized.
    throw new Error('R5_CI_INPUT_REJECTED');
  }
}

export function registerR5CiStdin(): void {
  if (!r5CiAuthenticated() || scope) throw new Error('R5_CI_SCOPE_REGISTRATION_REJECTED');
  if (!fstatSync(0).isFIFO()) throw new Error('R5_CI_STDIN_PIPE_REQUIRED');
  const bytes = Buffer.alloc(32769);
  let size = 0;
  try {
    while (size < bytes.length) {
      const count = readSync(0, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size < 2 || size > 32768) throw new Error();
    const input: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    scope = validateR5CiInput(input);
  } catch {
    throw new Error('R5_CI_STDIN_REJECTED');
  } finally {
    bytes.fill(0);
  }
}

export function r5CiScope(): Scope {
  if (!r5CiAuthenticated() || !scope) throw new Error('R5_CI_SCOPE_NOT_REGISTERED');
  return scope;
}

export function r5CiTestDatabaseUrl(): string | undefined {
  return r5CiAuthenticated() ? r5CiScope().ownerUrl : process.env.DATABASE_URL;
}

export function r5CiDatabaseName(): string | undefined {
  return r5CiAuthenticated() ? r5CiScope().identity.database : undefined;
}

export function assertR5CiOwnerUrl(url: string | undefined): void {
  if (url !== r5CiScope().ownerUrl) throw new Error('R5_CI_OWNER_URL_SCOPE_REJECTED');
}

/** Used immediately before fixture cleanup, including repeated reset calls.
 * A URL or matching database name never substitutes for live cluster/OID. */
export async function assertR5CiOwnerConnection(client: {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}): Promise<void> {
  const expected = r5CiScope();
  const rows = await client.$queryRawUnsafe<
    Array<{ database: string; oid: string; cluster: string; socket: boolean; owner: boolean }>
  >(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
      inet_server_addr() IS NULL AS socket,
      session_user='postgres' AND current_user='postgres' AS owner`);
  if (
    rows.length !== 1 ||
    rows[0].database !== expected.identity.database ||
    rows[0].oid !== String(expected.identity.databaseOid) ||
    rows[0].cluster !== expected.identity.cluster ||
    rows[0].cluster === HISTORICAL_CLUSTER ||
    !rows[0].socket ||
    !rows[0].owner
  )
    throw new Error('R5_CI_LIVE_OWNER_SCOPE_REJECTED');
  // Recheck source files; no live catalog is adopted as a new expected value.
  const binding = r5CiSourceBinding(expected.identity);
  if (binding.catalogSha256 !== expected.sourceSha256)
    throw new Error('R5_CI_SOURCE_CHANGED_DURING_RUN');
}

export function r5CiInstalledRecordBytes(): { bytes: string; sha256: string } {
  const bytes = JSON.stringify(r5CiScope().installed);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

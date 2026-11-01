import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, readSync, readlinkSync } from 'node:fs';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/database/prisma.service';
import {
  humanCorrectionCatalogSha256,
  type HumanCorrectionInstalledConnection,
} from '../../src/modules/activities/human-correction-trusted-connection';
import type { R5OwnedBackend } from './r5-setmat-backend-boundary';

/** Successful installation evidence, NOT current LOGIN/session capability. */
export const R5_ASYNC_INSTALLED_IDENTITIES = Object.freeze({
  libraryId: 'libfile_4f374dd111d48191a07794711c8fe248',
  sha256: '2f199937113f2dfdd1a3cdf6e92c4779ef575e7e2fce0f4ae65821c21b85b6b6',
  database: 'app_test_r5_setmat_20261029_q1',
  databaseOid: 1998913,
  cluster: '7695840193603043362',
  P: { name: 'r5_human_queue_login_20261030_q1', oid: 2035122 },
  U: { name: 'r5_untrusted_caller_login_20261030_q1', oid: 2035123 },
  C: { name: 'r5_boundary_caller_h7c6', oid: 1789091 },
  stateAtCloseout: 'NOLOGIN_PASSWORD_NULL',
  historicalBackendStart: null,
});
export interface R5AsyncRuntimeManifest {
  installationReceiptSha256: string;
  installationState: 'INSTALLED_INACTIVE';
  runtimeRequirement: 'FRESH_STAGE_LOGIN_AND_LIVE_QUALIFICATION';
  installedConnectionPath: string;
  installedConnectionSha256: string;
  /** Only an inherited anonymous pipe, never a path/env/CLI credential. */
  credentialsFd: 3;
}
export function assertR5AsyncInstalledConnection(r: HumanCorrectionInstalledConnection) {
  const i = R5_ASYNC_INSTALLED_IDENTITIES;
  assert.equal(r.database.name, i.database);
  assert.equal(r.database.oid, i.databaseOid);
  for (const [actual, expected] of [
    [r.sessionRole, i.P],
    [r.callerRole, i.C],
    [r.untrustedRole, i.U],
  ]) {
    assert.equal(actual.name, expected.name);
    assert.equal(actual.oid, expected.oid);
  }
  assert.equal(r.source.clusterSystemIdentifier, i.cluster);
  assert.equal(r.installationReceipt.sha256, i.sha256);
  assert.equal(r.authenticationReceipt.sha256, i.sha256);
}
export function assertR5AsyncRuntimeSource(
  r: HumanCorrectionInstalledConnection,
  base: unknown,
  supplemental: unknown,
) {
  assert.deepEqual(
    r.source.baseCatalog,
    base,
    'runtime binding cannot replace source-pinned base expected',
  );
  assert.deepEqual(
    r.source.supplementalCatalog,
    supplemental,
    'runtime binding cannot replace source-pinned supplemental expected',
  );
  assert.equal(r.source.expectedCatalogSha256, humanCorrectionCatalogSha256(base, supplemental));
}
export function r5AsyncPrincipalUrl(raw: string, kind: 'P' | 'U') {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid private runtime connection');
  }
  assert(['postgres:', 'postgresql:'].includes(u.protocol));
  assert(
    decodeURIComponent(u.username) === R5_ASYNC_INSTALLED_IDENTITIES[kind].name,
    'wrong private runtime principal',
  );
  assert(u.password.length > 0, 'runtime password must come from this stage memory supervisor');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), R5_ASYNC_INSTALLED_IDENTITIES.database);
  assert(!u.searchParams.has('options') && u.searchParams.get('pgbouncer') !== 'true');
  assert(!u.searchParams.has('schema') || u.searchParams.get('schema') === 'public');
  u.searchParams.set('connection_limit', '1');
  u.searchParams.set('options', '-c role=' + R5_ASYNC_INSTALLED_IDENTITIES.C.name);
  return u.toString();
}
export function parseR5AsyncMemoryCredentials(bytes: Buffer, phaseId: string) {
  assert(bytes.length > 0 && bytes.length <= 16_384, 'invalid runtime credential frame size');
  let x: { schema?: unknown; phaseId?: unknown; pUrl?: unknown; uUrl?: unknown };
  try {
    x = JSON.parse(bytes.toString('utf8')) as typeof x;
  } catch {
    throw new Error('invalid runtime credential frame');
  }
  assert(x && typeof x === 'object');
  assert.deepEqual(Object.keys(x).sort(), ['phaseId', 'pUrl', 'schema', 'uUrl'].sort());
  assert(x.schema === 'srvf-r5-async-memory-credentials/v1', 'invalid runtime credential schema');
  assert(x.phaseId === phaseId, 'memory credentials belong to a different stage');
  assert(typeof x.pUrl === 'string' && typeof x.uUrl === 'string');
  return {
    pUrl: r5AsyncPrincipalUrl(x.pUrl, 'P'),
    uUrl: r5AsyncPrincipalUrl(x.uUrl, 'U'),
    redactions: [x.pUrl, x.uUrl],
  };
}
export function readR5AsyncMemoryCredentials(fd: number, phaseId: string) {
  assert.equal(fd, 3);
  assert(
    fstatSync(fd).isFIFO() && /^pipe:\[[0-9]+\]$/.test(readlinkSync(`/proc/self/fd/${fd}`)),
    'runtime credentials must arrive through the supervised anonymous pipe',
  );
  let bytes: Buffer | undefined;
  try {
    bytes = Buffer.alloc(16_385);
    let size = 0;
    for (;;) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (n === 0) break;
      size += n;
      assert(size <= 16_384, 'oversized runtime credential frame');
    }
    bytes = bytes.subarray(0, size);
    return parseR5AsyncMemoryCredentials(bytes, phaseId);
  } finally {
    bytes?.fill(0);
    closeSync(fd);
  }
}
/** C cannot necessarily see even this session's backend_start. Temporarily use
 * the independently authenticated session identity inside a read-only tx and
 * persist the actual birth. NULL is never substituted or inferred from a PID. */
export async function captureR5AsyncSessionBirth(
  client: PrismaClient,
  kind: 'P' | 'U',
  persist: (value: unknown) => unknown,
  observer?: Pick<PrismaClient, '$queryRaw'>,
): Promise<R5OwnedBackend> {
  assert(kind !== 'U' || observer, 'U requires live independent target-cluster correlation');
  return client.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL ROLE NONE`;
      const rows = await tx.$queryRaw<
        (R5OwnedBackend & {
          session: string;
          current: string;
          sessionOid: string;
          backendType: string;
          login: boolean;
        })[]
      >`SELECT session_user::text AS "session",current_user::text AS "current",
      (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=session_user) AS "sessionOid",
      (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=session_user) AS login,
      pid,datid::int AS "databaseOid",backend_start::text AS "backendStart",backend_type AS "backendType"
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()`;
      persist({ kind: 'ASYNC_SESSION_BIRTH_ACTUAL', principal: kind, rows });
      assert.equal(rows.length, 1);
      const r = rows[0],
        expected = R5_ASYNC_INSTALLED_IDENTITIES[kind];
      assert.equal(r.session, expected.name);
      assert.equal(r.current, expected.name);
      assert.equal(r.sessionOid, String(expected.oid));
      assert.equal(r.login, true, 'NOLOGIN installation state is not runtime qualification');
      assert.equal(r.databaseOid, 1998913);
      assert.equal(r.backendType, 'client backend');
      assert(
        typeof r.backendStart === 'string' && r.backendStart.length > 0,
        'actual backend_start is UNKNOWN; no PID-only ownership exemption',
      );
      if (kind === 'U') {
        assert(observer);
        const nonce = 'r5-u-birth-' + randomUUID();
        await tx.$queryRaw`SELECT pg_catalog.set_config('application_name',${nonce},true)`;
        const matched = await observer.$queryRaw<
          {
            cluster: string;
            databaseOid: string;
            pid: number;
            backendStart: string;
            session: string;
          }[]
        >`
          SELECT (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
            d.oid::text AS "databaseOid",a.pid,a.backend_start::text AS "backendStart",a.usename::text AS session
          FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_database d ON d.oid=a.datid
          WHERE d.datname=${R5_ASYNC_INSTALLED_IDENTITIES.database} AND a.pid=${r.pid}
            AND a.backend_start::text=${r.backendStart} AND a.application_name=${nonce} AND a.usename=${expected.name}`;
        persist({ kind: 'ASYNC_U_LIVE_CLUSTER_CORRELATION', matched, principal: 'U' });
        assert.deepEqual(
          matched,
          [
            {
              cluster: R5_ASYNC_INSTALLED_IDENTITIES.cluster,
              databaseOid: '1998913',
              pid: r.pid,
              backendStart: r.backendStart,
              session: expected.name,
            },
          ],
          'U session is not independently bound to the target cluster; no OID-only inference',
        );
      }
      return { pid: r.pid, databaseOid: r.databaseOid, backendStart: r.backendStart };
    },
    { timeout: 7_000, maxWait: 2_000 },
  );
}

/** Same production bootstrap functions as createTestApp; protected setup and
 * AppModule are not edited. One P client is shared with the actual worker graph. */
export async function createR5AsyncTrustedHttpApp(
  client: PrismaService,
  installed: HumanCorrectionInstalledConnection,
  candidate: { bulkCommit: boolean; bulkPrepare: boolean } = {
    bulkCommit: false,
    bulkPrepare: false,
  },
) {
  const { HUMAN_CORRECTION_BACKGROUND_BUDGET } =
    await import('../../src/modules/activities/human-correction-background-budget');
  const [
    { Test },
    { AppModule },
    { PrismaService },
    { HUMAN_CORRECTION_INSTALLED_CONNECTION },
    { ConfigService },
    { applyGlobalSetup },
    { applySwagger },
  ] = await Promise.all([
    import('@nestjs/testing'),
    import('../../src/app.module'),
    import('../../src/database/prisma.service'),
    import('../../src/modules/activities/human-correction-trusted-connection'),
    import('@nestjs/config'),
    import('../../src/bootstrap/apply-global-setup'),
    import('../../src/bootstrap/apply-swagger'),
  ]);
  const m = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HUMAN_CORRECTION_BACKGROUND_BUDGET)
    .useValue(Object.freeze(candidate))
    .overrideProvider(PrismaService)
    .useValue(client)
    .overrideProvider(HUMAN_CORRECTION_INSTALLED_CONNECTION)
    .useValue(installed)
    .compile();
  const app = m.createNestApplication();
  app.useLogger(false);
  const cfg = app.get(ConfigService).get<import('../../src/config/app.config').AppConfig>('app');
  assert(cfg, 'app config unavailable');
  applyGlobalSetup(app, cfg);
  applySwagger(app, cfg);
  await app.init();
  await app.listen(0);
  return app;
}

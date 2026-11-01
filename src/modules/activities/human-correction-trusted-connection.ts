import { createHash } from 'node:crypto';
import type { FactoryProvider } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  HUMAN_CORRECTION_TRUSTED_CONNECTION,
  type HumanCorrectionTrustedConnection,
} from './human-correction-item-authority';
import { HumanCorrectionAuthorityUnavailableError } from './human-correction-intent';
import {
  HUMAN_CORRECTION_BASE_CATALOG_SQL,
  HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL,
  HUMAN_CORRECTION_BASE_TABLES,
  HUMAN_CORRECTION_SUPPLEMENTAL_TABLES,
} from './human-correction-trusted-catalog';

/** Trusted bootstrap input, never HTTP/Job data. The installer supplies only a
 * successful, independently source-reviewed receipt; hashes are integrity pins,
 * not authentication. No credentials or arbitrary SQL/callbacks belong here. */
export const HUMAN_CORRECTION_INSTALLED_CONNECTION = Symbol(
  'HUMAN_CORRECTION_INSTALLED_CONNECTION',
);
type Role = { readonly name: string; readonly oid: number };
type Catalog = {
  readonly database: string;
  readonly databaseOid: number;
  readonly tables: readonly { readonly name: string }[];
  readonly functions: readonly {
    readonly signature: string;
    readonly bodyHash: string;
    readonly definer: boolean;
    readonly config: readonly string[] | null;
    readonly language: string;
    readonly kind: string;
    readonly returnType: string;
    readonly set: boolean;
  }[];
  readonly enumTypes: readonly unknown[];
  readonly namespace: unknown;
};
export interface HumanCorrectionInstalledConnection {
  readonly schema: 'srvf-r5-human-correction-installed-connection/v1';
  readonly status: 'INSTALLED_AND_SOURCE_VERIFIED';
  readonly approvalReference: string;
  readonly sourceQualificationReference: string;
  readonly installationReceipt: { readonly reference: string; readonly sha256: string };
  readonly authenticationReceipt: { readonly reference: string; readonly sha256: string };
  readonly credentialBindingReference: string;
  readonly database: Role;
  readonly sessionRole: Role;
  readonly callerRole: Role;
  readonly untrustedRole: Role;
  readonly source: {
    readonly clusterSystemIdentifier: string;
    readonly expectedCatalogSha256: string;
    readonly installedPreflightBodySha256: string;
    readonly baseCatalog: Catalog;
    readonly supplementalCatalog: Catalog;
  };
}
type Tx = Prisma.TransactionClient;
type Profile = {
  sessionUser: string;
  currentUser: string;
  databaseName: string;
  databaseOid: string;
  sessionOid: string;
  callerOid: string;
  untrustedOid: string;
  trustedQualified: boolean;
  untrustedQualified: boolean;
  canReadClusterAsSession: boolean;
  preflightBodySha256: string;
  searchPath: string;
};
export class HumanCorrectionQualificationError extends HumanCorrectionAuthorityUnavailableError {
  constructor(readonly stage: string) {
    super();
  }
}
const fail = (stage: string): never => {
  throw new HumanCorrectionQualificationError(stage);
};
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value: unknown): string => hash(canonical(value));
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  // Prisma JSON and injected JSON may cross a VM realm (e.g. Nest's test
  // runner); canonical bytes must not depend on that realm's Object prototype.
  if (
    value &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Object]'
  )
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(',')}}`;
  return fail('NON_CANONICAL_BINDING');
}
export function humanCorrectionCatalogSha256(base: unknown, supplemental: unknown) {
  return digest({ base, supplemental });
}
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validOid = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 4_294_967_295;
const validReference = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value === value.trim();

function frozenInstallation(input: HumanCorrectionInstalledConnection) {
  // Detach the reviewed record: later mutation of an injected object cannot
  // change expected roles, catalog or receipt while a worker is running.
  let r: HumanCorrectionInstalledConnection;
  try {
    r = JSON.parse(canonical(input)) as HumanCorrectionInstalledConnection;
    if (
      r.schema !== 'srvf-r5-human-correction-installed-connection/v1' ||
      r.status !== 'INSTALLED_AND_SOURCE_VERIFIED' ||
      !validReference(r.approvalReference) ||
      !validReference(r.sourceQualificationReference) ||
      !validReference(r.credentialBindingReference) ||
      !validReference(r.installationReceipt.reference) ||
      !validHash(r.installationReceipt.sha256) ||
      !validReference(r.authenticationReceipt.reference) ||
      !validHash(r.authenticationReceipt.sha256) ||
      r.database.name !== 'app_test_r5_setmat_20261029_q1' ||
      r.sessionRole.name !== 'r5_human_queue_login_20261030_q1' ||
      r.callerRole.name !== 'r5_boundary_caller_h7c6' ||
      r.untrustedRole.name !== 'r5_untrusted_caller_login_20261030_q1' ||
      [r.database, r.sessionRole, r.callerRole, r.untrustedRole].some(
        (role) => !validOid(role.oid),
      ) ||
      new Set([r.sessionRole.oid, r.callerRole.oid, r.untrustedRole.oid]).size !== 3 ||
      !/^[1-9][0-9]*$/.test(r.source.clusterSystemIdentifier) ||
      !validHash(r.source.expectedCatalogSha256) ||
      !validHash(r.source.installedPreflightBodySha256)
    )
      return fail('INSTALLATION_RECORD');
    for (const [catalog, tables] of [
      [r.source.baseCatalog, HUMAN_CORRECTION_BASE_TABLES],
      [r.source.supplementalCatalog, HUMAN_CORRECTION_SUPPLEMENTAL_TABLES],
    ] as const) {
      if (
        catalog.database !== r.database.name ||
        catalog.databaseOid !== r.database.oid ||
        !Array.isArray(catalog.tables) ||
        !Array.isArray(catalog.functions) ||
        !Array.isArray(catalog.enumTypes) ||
        !catalog.namespace ||
        canonical(catalog.tables.map((x: Catalog['tables'][number]) => x.name).sort()) !==
          canonical([...tables].sort()) ||
        new Set(catalog.functions.map((f: Catalog['functions'][number]) => f.signature)).size !==
          catalog.functions.length ||
        catalog.functions.filter(
          (f: Catalog['functions'][number]) =>
            f.signature === 'public.r5_correction_boundary_preflight()' &&
            f.bodyHash === 'INSTALLER_SOURCE_PIN' &&
            f.definer === false &&
            canonical(f.config) === canonical(['search_path=pg_catalog']) &&
            f.language === 'plpgsql' &&
            f.kind === 'f' &&
            f.returnType === 'void' &&
            f.set === false,
        ).length !== 1
      )
        return fail('SOURCE_CATALOG_RECORD');
    }
    if (
      canonical(r.source.baseCatalog.functions) !==
        canonical(r.source.supplementalCatalog.functions) ||
      canonical(r.source.baseCatalog.namespace) !==
        canonical(r.source.supplementalCatalog.namespace) ||
      humanCorrectionCatalogSha256(r.source.baseCatalog, r.source.supplementalCatalog) !==
        r.source.expectedCatalogSha256
    )
      return fail('SOURCE_CATALOG_DIGEST');
  } catch {
    return fail('INSTALLATION_RECORD');
  }
  return r;
}

/** Builds no client, opens no connection and never changes pool settings. P's
 * reviewed credentials/startup role C must already belong to this exact client. */
export function createHumanCorrectionTrustedConnection(
  client: PrismaService,
  installed: HumanCorrectionInstalledConnection | null | undefined,
): HumanCorrectionTrustedConnection | null {
  if (installed == null) return null;
  const r = frozenInstallation(installed);
  const profile = async (tx: Tx, current: string) => {
    const rows = await tx.$queryRaw<Profile[]>`/* human-correction-trust:profile */
      SELECT session_user::text AS "sessionUser",current_user::text AS "currentUser",
        current_database() AS "databaseName",d.oid::text AS "databaseOid",
        p.oid::text AS "sessionOid",c.oid::text AS "callerOid",u.oid::text AS "untrustedOid",
        (p.rolcanlogin AND NOT c.rolcanlogin AND NOT c.rolinherit AND p.oid<>c.oid
          AND NOT(p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolbypassrls OR p.rolreplication)
          AND NOT(c.rolsuper OR c.rolcreatedb OR c.rolcreaterole OR c.rolbypassrls OR c.rolreplication)
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=p.oid)=1
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=p.oid AND roleid=c.oid
            AND set_option AND inherit_option AND NOT admin_option)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=c.oid)
          AND NOT pg_catalog.pg_has_role(c.oid,p.oid,'SET')
        ) AS "trustedQualified",
        (u.rolcanlogin AND NOT u.rolinherit
          AND NOT(u.rolsuper OR u.rolcreatedb OR u.rolcreaterole OR u.rolbypassrls OR u.rolreplication)
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=u.oid)=1
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=u.oid AND roleid=c.oid
            AND set_option AND NOT inherit_option AND NOT admin_option)
          AND NOT pg_catalog.pg_has_role(u.oid,p.oid,'SET')
          AND NOT pg_catalog.has_any_column_privilege(u.oid,'public."ActivityBatchJobItem"','SELECT,INSERT,UPDATE,REFERENCES')
          AND NOT pg_catalog.has_table_privilege(u.oid,'public."ActivityBatchJobItem"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        ) AS "untrustedQualified",
        pg_catalog.has_function_privilege(p.oid,'pg_catalog.pg_control_system()','EXECUTE') AS "canReadClusterAsSession",
        (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')
          FROM pg_catalog.pg_proc WHERE oid='public.r5_correction_boundary_preflight()'::regprocedure) AS "preflightBodySha256",
        pg_catalog.current_setting('search_path') AS "searchPath"
      FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles c CROSS JOIN pg_catalog.pg_roles u
        CROSS JOIN pg_catalog.pg_database d
      WHERE p.rolname=session_user AND c.rolname=${r.callerRole.name}
        AND u.rolname=${r.untrustedRole.name} AND d.datname=current_database()`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.sessionUser !== r.sessionRole.name ||
      row.currentUser !== current ||
      row.databaseName !== r.database.name ||
      row.databaseOid !== String(r.database.oid) ||
      row.sessionOid !== String(r.sessionRole.oid) ||
      row.callerOid !== String(r.callerRole.oid) ||
      row.untrustedOid !== String(r.untrustedRole.oid) ||
      row.trustedQualified !== true ||
      row.untrustedQualified !== true ||
      row.preflightBodySha256 !== r.source.installedPreflightBodySha256 ||
      typeof row.searchPath !== 'string'
    )
      return fail('LIVE_IDENTITY_OR_PREFLIGHT');
    return row;
  };
  return Object.freeze({
    client,
    approvalReference: r.approvalReference,
    sourceQualificationReference: r.sourceQualificationReference,
    database: Object.freeze(r.database),
    sessionRole: Object.freeze(r.sessionRole),
    callerRole: Object.freeze(r.callerRole),
    source: Object.freeze({
      clusterSystemIdentifier: r.source.clusterSystemIdentifier,
      expectedCatalogSha256: r.source.expectedCatalogSha256,
      installedPreflightBodySha256: r.source.installedPreflightBodySha256,
    }),
    async qualifyInTx(tx: Tx) {
      try {
        const before = await profile(tx, r.callerRole.name);
        // This permission is NOT assumed or granted by the provider. If P has
        // no approved existing read, activation stays closed; no expected value
        // or privileged observer is substituted for the live cluster read.
        if (before.canReadClusterAsSession !== true) return fail('CLUSTER_READ_UNAVAILABLE');
        await tx.$executeRaw`SET LOCAL ROLE NONE`;
        let cluster: string;
        try {
          await profile(tx, r.sessionRole.name);
          const rows = await tx.$queryRaw<
            { systemIdentifier: string }[]
          >`/* human-correction-trust:cluster */
            SELECT system_identifier::text AS "systemIdentifier" FROM pg_catalog.pg_control_system()`;
          if (
            rows.length !== 1 ||
            !rows[0] ||
            rows[0].systemIdentifier !== r.source.clusterSystemIdentifier
          )
            return fail('LIVE_CLUSTER');
          cluster = rows[0].systemIdentifier;
        } finally {
          await tx.$queryRaw`SELECT pg_catalog.set_config('role',${r.callerRole.name},true)`;
        }
        await profile(tx, r.callerRole.name);
        await tx.$queryRaw`SELECT pg_catalog.set_config('search_path','pg_catalog',true)`;
        try {
          const baseRows = await tx.$queryRaw<Record<string, unknown>[]>(
            Prisma.raw(HUMAN_CORRECTION_BASE_CATALOG_SQL),
          );
          const supplementalRows = await tx.$queryRaw<Record<string, unknown>[]>(
            Prisma.raw(HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL),
          );
          if (
            baseRows.length !== 1 ||
            supplementalRows.length !== 1 ||
            Object.keys(baseRows[0] ?? {}).length !== 1 ||
            Object.keys(supplementalRows[0] ?? {}).length !== 1
          )
            return fail('LIVE_CATALOG_SHAPE');
          const base = Object.values(baseRows[0])[0],
            supplemental = Object.values(supplementalRows[0])[0];
          const actualHash = humanCorrectionCatalogSha256(base, supplemental);
          if (
            canonical(base) !== canonical(r.source.baseCatalog) ||
            canonical(supplemental) !== canonical(r.source.supplementalCatalog) ||
            actualHash !== r.source.expectedCatalogSha256
          )
            return fail('LIVE_CATALOG');
          // Body and all metadata were matched BEFORE executing this installed
          // INVOKER guard. Its original checks remain under C on the same tx.
          await tx.$queryRaw`/* human-correction-trust:preflight */ SELECT public.r5_correction_boundary_preflight()::text AS validated`;
          const after = await profile(tx, r.callerRole.name);
          return {
            databaseName: after.databaseName,
            databaseOid: after.databaseOid,
            clusterSystemIdentifier: cluster,
            expectedCatalogSha256: actualHash,
            installedPreflightBodySha256: after.preflightBodySha256,
          };
        } finally {
          await tx.$queryRaw`SELECT pg_catalog.set_config('search_path',${before.searchPath},true)`;
        }
      } catch (error) {
        if (error instanceof HumanCorrectionQualificationError) throw error;
        // No SQL, URL, credentials or arbitrary upstream exception in outward errors.
        throw new HumanCorrectionQualificationError('LIVE_QUALIFICATION_FAILED');
      }
    },
  });
}

export const humanCorrectionTrustedConnectionProvider: FactoryProvider<HumanCorrectionTrustedConnection | null> =
  {
    provide: HUMAN_CORRECTION_TRUSTED_CONNECTION,
    inject: [PrismaService, HUMAN_CORRECTION_INSTALLED_CONNECTION],
    useFactory: createHumanCorrectionTrustedConnection,
  };
export const humanCorrectionTrustedConnectionProviders = [
  { provide: HUMAN_CORRECTION_INSTALLED_CONNECTION, useValue: null },
  humanCorrectionTrustedConnectionProvider,
];

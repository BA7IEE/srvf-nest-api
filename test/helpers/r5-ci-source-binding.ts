import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HumanCorrectionInstalledConnection } from '../../src/modules/activities/human-correction-trusted-connection';
import { HUMAN_CORRECTION_BASE_CATALOG_SQL } from '../../src/modules/activities/human-correction-trusted-catalog';
import {
  currentMigrationInventory,
  MILESTONE_MIGRATION,
  readFrozenMigrationCatalog as sourceCatalog,
} from './migration-inventory';

export const R5_CI_DATABASE = 'app_test_r5_setmat_20261029_q1';
export const R5_CI_ROLES = Object.freeze({
  owner: 'r5_boundary_owner_h7c6',
  caller: 'r5_boundary_caller_h7c6',
  writer: 'r5_mat_writer_20261029_q1',
  trusted: 'r5_human_queue_login_20261030_q1',
  untrusted: 'r5_untrusted_caller_login_20261030_q1',
});
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Catalog = HumanCorrectionInstalledConnection['source']['baseCatalog'];
export const r5CiMigrationSources = (checkout = process.cwd()) =>
  currentMigrationInventory(checkout).migrations;

/** Exact additive source overlay. The original 155-migration catalog remains
 * byte-pinned. Expected guard definitions come only from the separately pinned
 * migration, never a target database or a relaxed catalog comparison. */
function milestoneFunctions(checkout: string) {
  const sql = readFileSync(
    resolve(checkout, 'prisma/migrations', MILESTONE_MIGRATION.name, 'migration.sql'),
    'utf8',
  );
  if (sha(sql) !== MILESTONE_MIGRATION.sha256) throw new Error('R5_CI_MIGRATION_SOURCE_CHANGED');
  return [
    'team_join_milestone_immutable',
    'team_join_milestone_insert_guard',
    'team_join_notice_protocol_immutable',
  ].map((name) => {
    const definition = new RegExp(
      `CREATE FUNCTION public\\.${name}\\(\\) RETURNS trigger\\n` +
        'LANGUAGE plpgsql SET search_path = pg_catalog AS \\$\\$([\\s\\S]*?)\\$\\$;',
      'g',
    );
    const matches = [...sql.matchAll(definition)];
    if (matches.length !== 1) throw new Error('R5_CI_MILESTONE_FUNCTION_SOURCE_SHAPE');
    return {
      signature: `public.${name}()`,
      owner: R5_CI_ROLES.owner,
      language: 'plpgsql',
      kind: 'f',
      definer: false,
      config: ['search_path=pg_catalog'],
      acl: `{${R5_CI_ROLES.owner}=X/${R5_CI_ROLES.owner}}`,
      volatility: 'v',
      strict: false,
      leakproof: false,
      parallel: 'u',
      set: false,
      returnType: 'trigger',
      argNames: null,
      argModes: null,
      allArgTypes: null,
      defaults: '',
      bodyHash: sha(matches[0][1]),
      sqlBody: null,
    };
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Object]'
  )
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(',')}}`;
  throw new Error('R5_CI_NON_CANONICAL_SOURCE');
}

export interface R5CiInstanceIdentity {
  readonly database: string;
  readonly databaseOid: number;
  readonly cluster: string;
  readonly roles: Readonly<Record<string, number>>;
}

/** Only independently captured instance identities are variable. No target
 * catalog, body or ACL can be supplied as an expected definition. */
export function r5CiSourceBinding(identity: R5CiInstanceIdentity, checkout = process.cwd()) {
  const source = sourceCatalog();
  if (
    identity.database !== R5_CI_DATABASE ||
    !/^[1-9][0-9]*$/.test(identity.cluster) ||
    !Number.isSafeInteger(identity.databaseOid) ||
    identity.databaseOid < 1 ||
    Object.values(R5_CI_ROLES).some(
      (name) => !Number.isSafeInteger(identity.roles[name]) || identity.roles[name] < 1,
    ) ||
    new Set(Object.values(identity.roles)).size !== 5
  )
    throw new Error('R5_CI_INSTANCE_IDENTITY_REJECTED');
  try {
    r5CiMigrationSources(checkout);
  } catch {
    throw new Error('R5_CI_MIGRATION_SOURCE_CHANGED');
  }
  const additions = milestoneFunctions(checkout);
  const link = (input: unknown): Catalog => {
    const catalog = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    if (catalog.database !== 'CI_INSTANCE_DATABASE_NAME' || catalog.databaseOid !== 0)
      throw new Error('R5_CI_SOURCE_IDENTITY_PLACEHOLDER_CHANGED');
    catalog.database = identity.database;
    catalog.databaseOid = identity.databaseOid;
    const functions = catalog.functions as Record<string, unknown>[];
    const insertion = functions.findIndex(
      (row) => row.signature === 'public.tp_identity_guard_fn()',
    );
    if (
      insertion < 0 ||
      functions.some((row) => additions.some((addition) => addition.signature === row.signature))
    )
      throw new Error('R5_CI_MILESTONE_CATALOG_SOURCE_SHAPE');
    // Preserve every frozen field and its PostgreSQL order; the three new
    // team_join_* signatures sort immediately before the existing tp_* group.
    catalog.functions = [
      ...functions.slice(0, insertion),
      ...additions,
      ...functions.slice(insertion),
    ];
    const text = JSON.stringify(catalog).replaceAll(
      '{CI_CALLER_ROLE_OID}',
      `{${identity.roles[R5_CI_ROLES.caller]}}`,
    );
    return JSON.parse(text) as Catalog;
  };
  const base = link(source.catalogs.base),
    supplemental = link(source.catalogs.supplemental);
  const migration = readFileSync(
    resolve(
      checkout,
      'prisma/migrations/20261031223000_r5_correction_set_materialization/migration.sql',
    ),
    'utf8',
  );
  const matches = migration.match(
    /CREATE OR REPLACE FUNCTION public\.r5_correction_boundary_preflight\(\) RETURNS void\n[\s\S]*?\nEND;\$\$;/g,
  );
  if (matches?.length !== 1) throw new Error('R5_CI_PREFLIGHT_SOURCE_SHAPE');
  let ddl = matches[0];
  const literal = 'expected_catalog CONSTANT jsonb := NULL; -- R5_COMPILED_CATALOG_LITERAL';
  if (ddl.split(literal).length !== 2) throw new Error('R5_CI_NULL_SOURCE_PIN_REQUIRED');
  ddl = ddl.replace(
    literal,
    () =>
      `expected_catalog CONSTANT jsonb := '${JSON.stringify(base).replaceAll("'", "''")}'::jsonb; -- R5_COMPILED_CATALOG_LITERAL`,
  );
  const start = ddl.indexOf('  WITH relations AS (');
  const end = ddl.indexOf(' INTO observed_catalog;', start);
  if (start < 0 || end < start) throw new Error('R5_CI_COLLECTOR_SOURCE_SHAPE');
  const collector = HUMAN_CORRECTION_BASE_CATALOG_SQL.trim();
  if (!collector.endsWith(';')) throw new Error('R5_CI_COLLECTOR_TERMINATOR');
  ddl =
    ddl.slice(0, start) +
    collector.slice(0, -1) +
    ' INTO observed_catalog;' +
    ddl.slice(end + ' INTO observed_catalog;'.length);
  const body = ddl.match(/ AS \$\$([\s\S]*)\$\$;$/)?.[1];
  if (!body) throw new Error('R5_CI_BOUND_BODY_SHAPE');
  const catalogSha256 = sha(canonical({ base, supplemental }));
  return Object.freeze({ base, supplemental, ddl, bodySha256: sha(body), catalogSha256 });
}

export function r5CiInstalledRecord(
  identity: R5CiInstanceIdentity,
  binding: ReturnType<typeof r5CiSourceBinding>,
  receipts: { readonly installationSha256: string; readonly authenticationSha256: string },
): HumanCorrectionInstalledConnection {
  if (
    ![receipts.installationSha256, receipts.authenticationSha256].every((v) =>
      /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error('R5_CI_SUCCESS_RECEIPTS_REQUIRED');
  return {
    schema: 'srvf-r5-human-correction-installed-connection/v1',
    status: 'INSTALLED_AND_SOURCE_VERIFIED',
    approvalReference: 'disposable-ci-authentication-only',
    sourceQualificationReference: 'checksum-pinned-migrations-and-source-catalog',
    installationReceipt: {
      reference: 'this-disposable-instance/source-comparison',
      sha256: receipts.installationSha256,
    },
    authenticationReceipt: {
      reference: 'this-disposable-instance/real-scram-p-u',
      sha256: receipts.authenticationSha256,
    },
    credentialBindingReference: 'memory-only-this-disposable-instance',
    database: { name: identity.database, oid: identity.databaseOid },
    sessionRole: { name: R5_CI_ROLES.trusted, oid: identity.roles[R5_CI_ROLES.trusted] },
    callerRole: { name: R5_CI_ROLES.caller, oid: identity.roles[R5_CI_ROLES.caller] },
    untrustedRole: { name: R5_CI_ROLES.untrusted, oid: identity.roles[R5_CI_ROLES.untrusted] },
    source: {
      clusterSystemIdentifier: identity.cluster,
      expectedCatalogSha256: binding.catalogSha256,
      installedPreflightBodySha256: binding.bodySha256,
      baseCatalog: binding.base,
      supplementalCatalog: binding.supplemental,
    },
  };
}

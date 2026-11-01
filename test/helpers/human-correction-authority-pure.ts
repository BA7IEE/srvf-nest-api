import type { Prisma } from '@prisma/client';
import {
  HUMAN_CORRECTION_BASE_TABLES,
  HUMAN_CORRECTION_SUPPLEMENTAL_TABLES,
  HUMAN_CORRECTION_BASE_CATALOG_SQL,
  HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL,
} from '../../src/modules/activities/human-correction-trusted-catalog';
import {
  humanCorrectionCatalogSha256,
  type HumanCorrectionInstalledConnection,
} from '../../src/modules/activities/human-correction-trusted-connection';
import type { PrismaService } from '../../src/database/prisma.service';
import {
  humanCorrectionItemHash,
  HUMAN_CORRECTION_ITEM_KEY,
  type HumanCorrectionJobPayload,
} from '../../src/modules/activities/human-correction-intent';
import {
  HumanCorrectionItemAuthority,
  type HumanCorrectionTrustedConnection,
} from '../../src/modules/activities/human-correction-item-authority';

/** Pure SQL identity model, never credentials/authorization or a PG proof. */
export function pureHumanAuthority(client: object) {
  const state = {
    currentRole: 'pure_caller',
    sessionRole: 'pure_authority',
    qualified: true,
    restoreFails: false,
    lockTimeoutMs: 0,
    identities: [] as string[],
    writes: [] as string[],
  };
  const source = {
    clusterSystemIdentifier: '999',
    expectedCatalogSha256: '1'.repeat(64),
    installedPreflightBodySha256: '2'.repeat(64),
  };
  const qualification = jest.fn(async (_tx: unknown) => {
    void _tx;
    return {
      ...source,
      databaseName: 'pure_clone',
      databaseOid: '100',
    };
  });
  const binding: HumanCorrectionTrustedConnection = {
    client: client as PrismaService,
    approvalReference: 'PURE_MODEL_NOT_DB_APPROVAL',
    sourceQualificationReference: 'PURE_MODEL_NOT_CATALOG',
    database: { name: 'pure_clone', oid: 100 },
    sessionRole: { name: 'pure_authority', oid: 101 },
    callerRole: { name: 'pure_caller', oid: 102 },
    source,
    qualifyInTx: qualification,
  };
  const authority = new HumanCorrectionItemAuthority(binding);
  const sql = (input: unknown) => {
    if (Array.isArray(input)) return input.join('?');
    if (input && typeof input === 'object' && 'sql' in input && typeof input.sql === 'string')
      return input.sql;
    throw new Error('unexpected SQL model input');
  };
  function query(input: unknown): { handled: false } | { handled: true; value: unknown } {
    const text = sql(input);
    if (text.includes('human-correction-authority:profile')) {
      state.identities.push(state.currentRole);
      return {
        handled: true,
        value: [
          {
            sessionUser: state.sessionRole,
            currentUser: state.currentRole,
            databaseName: 'pure_clone',
            databaseOid: '100',
            sessionOid: '101',
            callerOid: '102',
            qualified: state.qualified,
          },
        ],
      };
    }
    if (text.includes("set_config('role'")) {
      if (state.restoreFails) throw new Error('PURE_RESTORE_FAILURE');
      state.currentRole = binding.callerRole.name;
      return { handled: true, value: [{ set_config: binding.callerRole.name }] };
    }
    return { handled: false };
  }
  function execute(input: unknown) {
    if (sql(input).includes("SET LOCAL lock_timeout = '4s'")) {
      state.lockTimeoutMs = 4000;
      return true;
    }
    if (!sql(input).includes('SET LOCAL ROLE NONE')) return false;
    state.currentRole = state.sessionRole;
    return true;
  }
  function requireP() {
    if (state.currentRole !== binding.sessionRole.name) throw new Error('PURE_ITEM_ROLE_DENIED');
    state.writes.push(state.currentRole);
  }
  return { state, binding, qualification, authority, sql, query, execute, requireP };
}

/** Applies every actual Item CAS predicate. This models rows, not PG locks or rollback. */
export function pureHumanItemStore(
  profile: ReturnType<typeof pureHumanAuthority>,
  payload: HumanCorrectionJobPayload,
) {
  const row: Record<string, unknown> = {
    id: 'intent',
    jobId: 'job',
    itemKey: HUMAN_CORRECTION_ITEM_KEY,
    statusCode: 'processing',
    attempts: 1,
    resourceType: 'CorrectionApplication',
    resourceId: payload.applicationId,
    payloadHash: humanCorrectionItemHash('job', payload),
    lastErrorCode: null,
    safeMessage: null,
    resultReference: null,
  };
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const items = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      profile.requireP();
      Object.assign(row, data);
      return Promise.resolve({ ...row });
    }),
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      profile.requireP();
      return Promise.resolve(matches(where) ? [{ ...row }] : []);
    }),
    updateMany: jest.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        profile.requireP();
        if (!matches(where)) return Promise.resolve({ count: 0 });
        for (const [key, value] of Object.entries(data)) {
          if (
            value &&
            typeof value === 'object' &&
            'increment' in value &&
            typeof value.increment === 'number'
          ) {
            const before = row[key];
            if (typeof before !== 'number') throw new Error('bad numeric CAS');
            row[key] = before + value.increment;
          } else row[key] = value;
        }
        return Promise.resolve({ count: 1 });
      },
    ),
  };
  function lockQuery(input: unknown, values: readonly unknown[]) {
    if (!profile.sql(input).includes('FROM "ActivityBatchJobItem"'))
      return { handled: false as const };
    profile.requireP();
    return {
      handled: true as const,
      value: row.jobId === values[0] && row.itemKey === values[1] ? [{ ...row }] : [],
    };
  }
  return { row, items, lockQuery };
}

/** Protocol transport only. Actual core qualification and actual Nest lifecycle
 * execute below; these mocks do not prove PG/credentials/authentication. */
export function pureHumanRuntimeTransportFixture() {
  const database = { name: 'app_test_r5_setmat_20261029_q1', oid: 100 };
  const functions = [
    {
      signature: 'public.r5_correction_boundary_preflight()',
      bodyHash: 'INSTALLER_SOURCE_PIN',
      definer: false,
      config: ['search_path=pg_catalog'],
      language: 'plpgsql',
      kind: 'f',
      returnType: 'void',
      set: false,
    },
  ];
  const catalog = (tables: readonly string[]) => ({
    database: database.name,
    databaseOid: database.oid,
    namespace: { owner: 'PURE', acl: null },
    tables: tables.map((name) => ({ name })),
    functions: structuredClone(functions),
    enumTypes: [],
  });
  const base = catalog(HUMAN_CORRECTION_BASE_TABLES);
  const supplemental = catalog(HUMAN_CORRECTION_SUPPLEMENTAL_TABLES);
  const record: HumanCorrectionInstalledConnection = {
    schema: 'srvf-r5-human-correction-installed-connection/v1',
    status: 'INSTALLED_AND_SOURCE_VERIFIED',
    approvalReference: 'PURE_NOT_APPROVAL',
    sourceQualificationReference: 'PURE_NOT_SOURCE_REVIEW',
    installationReceipt: { reference: 'PURE_NOT_INSTALLATION', sha256: '1'.repeat(64) },
    authenticationReceipt: { reference: 'PURE_NOT_AUTHENTICATION', sha256: '2'.repeat(64) },
    credentialBindingReference: 'PURE_NO_CREDENTIAL',
    database,
    sessionRole: { name: 'r5_human_queue_login_20261030_q1', oid: 101 },
    callerRole: { name: 'r5_boundary_caller_h7c6', oid: 102 },
    untrustedRole: { name: 'r5_untrusted_caller_login_20261030_q1', oid: 103 },
    source: {
      clusterSystemIdentifier: '999',
      expectedCatalogSha256: humanCorrectionCatalogSha256(base, supplemental),
      installedPreflightBodySha256: '3'.repeat(64),
      baseCatalog: base,
      supplementalCatalog: supplemental,
    },
  };
  const state = {
    role: record.callerRole.name,
    path: '"$user", public',
    qualified: true,
    unsafe: false,
    trace: [] as string[],
    gate: null as Promise<void> | null,
    entered: null as (() => void) | null,
  };
  const sqlText = (input: unknown) =>
    Array.isArray(input) ? input.join('?') : (input as Prisma.Sql).sql;
  const query = jest.fn(async (input: unknown, ...values: unknown[]) => {
    const sql = sqlText(input);
    if (sql.includes('human-correction-trust:profile')) {
      state.trace.push('profile');
      if (state.unsafe) throw new Error('UNSAFE_UPSTREAM_DETAIL');
      if (state.gate) {
        const gate = state.gate;
        state.gate = null;
        state.entered?.();
        await gate;
      }
      return [
        {
          sessionUser: record.sessionRole.name,
          currentUser: state.role,
          databaseName: database.name,
          databaseOid: '100',
          sessionOid: '101',
          callerOid: '102',
          untrustedOid: '103',
          trustedQualified: state.qualified,
          untrustedQualified: true,
          canReadClusterAsSession: true,
          preflightBodySha256: record.source.installedPreflightBodySha256,
          searchPath: state.path,
        },
      ];
    }
    if (sql.includes('human-correction-trust:cluster')) return [{ systemIdentifier: '999' }];
    if (sql === HUMAN_CORRECTION_BASE_CATALOG_SQL) return [{ jsonb_build_object: base }];
    if (sql === HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL)
      return [{ jsonb_build_object: supplemental }];
    if (sql.includes('human-correction-trust:preflight')) {
      state.trace.push('preflight');
      return [{ validated: '' }];
    }
    if (sql.includes("set_config('role',")) {
      state.role = String(values[0]);
      return [{ set_config: state.role }];
    }
    if (sql.includes("set_config('search_path','pg_catalog'")) {
      state.path = 'pg_catalog';
      return [{ set_config: state.path }];
    }
    if (sql.includes("set_config('search_path',")) {
      state.path = String(values[0]);
      return [{ set_config: state.path }];
    }
    throw new Error('unexpected protocol query');
  });
  const execute = jest.fn((input: unknown) => {
    const sql = sqlText(input);
    if (sql === 'SET TRANSACTION READ ONLY') {
      state.trace.push('readonly');
      return Promise.resolve(0);
    }
    if (sql === 'SET LOCAL ROLE NONE') {
      state.role = record.sessionRole.name;
      return Promise.resolve(0);
    }
    throw new Error('unexpected protocol execution');
  });
  const tx = { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient;
  const transaction = jest.fn(
    async (body: ((t: Prisma.TransactionClient) => Promise<unknown>) | Promise<unknown>[]) =>
      typeof body === 'function' ? body(tx) : Promise.all(body),
  );
  const client = {
    $transaction: transaction,
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  } as unknown as PrismaService;
  return { record, state, client, tx, transaction };
}

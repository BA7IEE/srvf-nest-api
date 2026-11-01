import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  HUMAN_CORRECTION_BASE_CATALOG_SQL,
  HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL,
  HUMAN_CORRECTION_BASE_TABLES,
  HUMAN_CORRECTION_SUPPLEMENTAL_TABLES,
  HUMAN_CORRECTION_BASE_COLLECTOR_SHA256,
  HUMAN_CORRECTION_SUPPLEMENTAL_COLLECTOR_SHA256,
} from './human-correction-trusted-catalog';
import {
  HUMAN_CORRECTION_INSTALLED_CONNECTION,
  createHumanCorrectionTrustedConnection,
  humanCorrectionCatalogSha256,
  humanCorrectionTrustedConnectionProviders,
  type HumanCorrectionInstalledConnection,
  HumanCorrectionQualificationError,
} from './human-correction-trusted-connection';
import {
  HUMAN_CORRECTION_TRUSTED_CONNECTION,
  type HumanCorrectionTrustedConnection,
} from './human-correction-item-authority';

/** Only a protocol model. No credential/installation/DB approval or PG proof. */
function fixture() {
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
    {
      signature: 'public.e4_assert_complete(text,boolean)',
      bodyHash: '4'.repeat(64),
      definer: false,
      config: null,
      language: 'plpgsql',
      kind: 'f',
      returnType: 'void',
      set: false,
    },
  ];
  const catalog = (tables: readonly string[]) => ({
    database: database.name,
    databaseOid: database.oid,
    namespace: { owner: 'PURE_OWNER', acl: null },
    tables: tables.map((name) => ({ name, definition: 'PURE_NOT_DDL' })),
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
    credentialBindingReference: 'PURE_NO_SECRET',
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
  const initialPath = '"$user", public, pg_temp';
  const state = {
    role: record.callerRole.name,
    searchPath: initialPath,
    canReadCluster: true,
    cluster: '999',
    base: structuredClone(base),
    supplemental: structuredClone(supplemental),
    profileChange: {} as Record<string, unknown>,
    fail: '',
    trace: [] as string[],
  };
  const sqlText = (input: unknown) =>
    Array.isArray(input) ? input.join('?') : (input as Prisma.Sql).sql;
  const query = jest.fn((input: unknown, ...values: unknown[]) => {
    const sql = sqlText(input);
    const execute = (label: string, value: unknown) => {
      state.trace.push(label);
      if (state.fail === label) throw new Error('PURE_UPSTREAM_ERROR_WITH_UNSAFE_DETAIL');
      return Promise.resolve(value);
    };
    if (sql.includes('human-correction-trust:profile'))
      return execute(`profile:${state.role}`, [
        {
          sessionUser: record.sessionRole.name,
          currentUser: state.role,
          databaseName: database.name,
          databaseOid: String(database.oid),
          sessionOid: '101',
          callerOid: '102',
          untrustedOid: '103',
          trustedQualified: true,
          untrustedQualified: true,
          canReadClusterAsSession: state.canReadCluster,
          preflightBodySha256: record.source.installedPreflightBodySha256,
          searchPath: state.searchPath,
          ...state.profileChange,
        },
      ]);
    if (sql.includes('human-correction-trust:cluster'))
      return execute('cluster', [{ systemIdentifier: state.cluster }]);
    if (sql === HUMAN_CORRECTION_BASE_CATALOG_SQL)
      return execute('base', [{ jsonb_build_object: state.base }]);
    if (sql === HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL)
      return execute('supplemental', [{ jsonb_build_object: state.supplemental }]);
    if (sql.includes('human-correction-trust:preflight')) {
      expect(state.role).toBe(record.callerRole.name);
      expect(state.searchPath).toBe('pg_catalog');
      return execute('preflight', [{ validated: '' }]);
    }
    if (sql.includes("set_config('role'")) {
      if (state.fail === 'restoreRole') throw new Error('PURE_RESTORE_ROLE');
      state.role = String(values[0]);
      return execute('restoreRole', [{ set_config: state.role }]);
    }
    if (sql.includes("set_config('search_path','pg_catalog'")) {
      state.searchPath = 'pg_catalog';
      return execute('setPath', [{ set_config: state.searchPath }]);
    }
    if (sql.includes("set_config('search_path',")) {
      if (state.fail === 'restorePath') throw new Error('PURE_RESTORE_PATH');
      state.searchPath = String(values[0]);
      return execute('restorePath', [{ set_config: state.searchPath }]);
    }
    throw new Error('Unexpected pure SQL');
  });
  const execute = jest.fn((input: unknown) => {
    if (sqlText(input) !== 'SET LOCAL ROLE NONE') throw new Error('Unexpected pure write');
    state.role = record.sessionRole.name;
    state.trace.push('enterP');
    return Promise.resolve(0);
  });
  const tx = { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient;
  const transaction = jest.fn(),
    connect = jest.fn();
  const client = { $transaction: transaction, $connect: connect } as unknown as PrismaService;
  const connection = () => createHumanCorrectionTrustedConnection(client, record)!;
  return {
    record,
    state,
    query,
    execute,
    tx,
    client,
    connection,
    initialPath,
    base,
    supplemental,
    transaction,
    connect,
  };
}

describe('installed Human connection provider (pure; NOT authentication/PG evidence)', () => {
  it('keeps the actual Nest provider closed without a successful bootstrap binding', async () => {
    const f = fixture();
    const module = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: f.client },
        ...humanCorrectionTrustedConnectionProviders,
      ],
    }).compile();
    expect(module.get(HUMAN_CORRECTION_TRUSTED_CONNECTION)).toBeNull();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    await module.close();
  });
  it('the real provider accepts the reviewed token and retains the existing client reference', async () => {
    const f = fixture();
    const module = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: f.client },
        ...humanCorrectionTrustedConnectionProviders,
      ],
    })
      .overrideProvider(HUMAN_CORRECTION_INSTALLED_CONNECTION)
      .useValue(f.record)
      .compile();
    const c = module.get<HumanCorrectionTrustedConnection>(HUMAN_CORRECTION_TRUSTED_CONNECTION);
    expect(c.client).toBe(f.client);
    await expect(c.qualifyInTx(f.tx)).resolves.toEqual({
      databaseName: f.record.database.name,
      databaseOid: '100',
      clusterSystemIdentifier: '999',
      expectedCatalogSha256: f.record.source.expectedCatalogSha256,
      installedPreflightBodySha256: f.record.source.installedPreflightBodySha256,
    });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.state.trace).toEqual([
      `profile:${f.record.callerRole.name}`,
      'enterP',
      `profile:${f.record.sessionRole.name}`,
      'cluster',
      'restoreRole',
      `profile:${f.record.callerRole.name}`,
      'setPath',
      'base',
      'supplemental',
      'preflight',
      `profile:${f.record.callerRole.name}`,
      'restorePath',
    ]);
    expect(f.state.role).toBe(f.record.callerRole.name);
    expect(f.state.searchPath).toBe(f.initialPath);
    await module.close();
  });
  it.each([
    ['DRAFT', (r: HumanCorrectionInstalledConnection) => Reflect.set(r, 'status', 'DRAFT')],
    [
      'wrong database',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r.database, 'name', 'app_test_other'),
    ],
    [
      'administrator',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r.sessionRole, 'name', 'postgres'),
    ],
    [
      'string OID',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r.sessionRole, 'oid', '101'),
    ],
    [
      'out of range OID',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r.callerRole, 'oid', 4_294_967_296),
    ],
    [
      'duplicate OID',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r.untrustedRole, 'oid', 101),
    ],
    [
      'missing install receipt',
      (r: HumanCorrectionInstalledConnection) => Reflect.deleteProperty(r, 'installationReceipt'),
    ],
    [
      'missing auth receipt',
      (r: HumanCorrectionInstalledConnection) => Reflect.deleteProperty(r, 'authenticationReceipt'),
    ],
    [
      'missing binding',
      (r: HumanCorrectionInstalledConnection) => Reflect.set(r, 'credentialBindingReference', ''),
    ],
    [
      'stale digest',
      (r: HumanCorrectionInstalledConnection) =>
        Reflect.set(r.source, 'expectedCatalogSha256', '0'.repeat(64)),
    ],
    [
      'missing protected table',
      (r: HumanCorrectionInstalledConnection) =>
        Reflect.set(r.source.supplementalCatalog, 'tables', []),
    ],
  ] as const)('rejects %s synchronously before any query/client operation', (_label, change) => {
    const f = fixture();
    change(f.record);
    expect(f.connection).toThrow(HumanCorrectionQualificationError);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    { sessionUser: 'postgres' },
    { currentUser: 'postgres' },
    { databaseName: 'app_test_other' },
    { databaseOid: '101' },
    { databaseOid: 100 },
    { sessionOid: '102' },
    { callerOid: '101' },
    { untrustedOid: '104' },
    { trustedQualified: false },
    { untrustedQualified: false },
    { preflightBodySha256: '0'.repeat(64) },
  ])('rejects actual identity/preflight mismatch %# without entering P', async (change) => {
    const f = fixture();
    Object.assign(f.state.profileChange, change);
    await expect(f.connection().qualifyInTx(f.tx)).rejects.toMatchObject({
      stage: 'LIVE_IDENTITY_OR_PREFLIGHT',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.state.trace).not.toContain('preflight');
  });
  it.each([
    { definer: true },
    { config: ['search_path=public'] },
    { language: 'sql' },
    { kind: 'p' },
    { returnType: 'text' },
    { set: true },
  ])(
    'rejects an altered preflight contract even with a coherently rehashed expected catalog %#',
    (change) => {
      const f = fixture();
      Object.assign(f.record.source.baseCatalog.functions[0], change);
      Object.assign(f.record.source.supplementalCatalog.functions[0], change);
      Reflect.set(
        f.record.source,
        'expectedCatalogSha256',
        humanCorrectionCatalogSha256(
          f.record.source.baseCatalog,
          f.record.source.supplementalCatalog,
        ),
      );
      expect(f.connection).toThrow(HumanCorrectionQualificationError);
      expect(f.query).not.toHaveBeenCalled();
    },
  );
  it('refuses a missing cluster-read privilege without pretending the expected identifier is actual', async () => {
    const f = fixture();
    f.state.canReadCluster = false;
    await expect(f.connection().qualifyInTx(f.tx)).rejects.toMatchObject({
      stage: 'CLUSTER_READ_UNAVAILABLE',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.state.trace).not.toContain('cluster');
  });
  it('rejects a different actual cluster and restores C without collecting/executing application functions', async () => {
    const f = fixture();
    f.state.cluster = '1000';
    await expect(f.connection().qualifyInTx(f.tx)).rejects.toMatchObject({ stage: 'LIVE_CLUSTER' });
    expect(f.state.role).toBe(f.record.callerRole.name);
    expect(f.state.trace).not.toContain('base');
  });
  it.each(['cluster', 'base', 'supplemental', 'preflight', 'restoreRole', 'restorePath'])(
    'never reports success after %s failure or exposes an upstream exception',
    async (label) => {
      const f = fixture();
      f.state.fail = label;
      await expect(f.connection().qualifyInTx(f.tx)).rejects.toMatchObject({
        stage: 'LIVE_QUALIFICATION_FAILED',
        message: 'HumanCorrectionAuthorityUnavailable',
      });
    },
  );
  it.each(['base', 'supplemental'] as const)(
    'checks every %s field, not only names/OIDs or a supplied digest',
    async (which) => {
      const f = fixture();
      Reflect.set(f.state[which].tables[0], 'extraUncheckedDependency', 'drift');
      await expect(f.connection().qualifyInTx(f.tx)).rejects.toMatchObject({
        stage: 'LIVE_CATALOG',
      });
      expect(f.state.trace).not.toContain('preflight');
      expect(f.state.searchPath).toBe(f.initialPath);
    },
  );
  it('freezes the installed expectation instead of adopting a later observed catalog/input mutation', async () => {
    const f = fixture(),
      c = f.connection();
    Reflect.set(f.record.source, 'clusterSystemIdentifier', '1000');
    Reflect.set(f.record.source.baseCatalog.tables[0], 'name', 'FORGED');
    await expect(c.qualifyInTx(f.tx)).resolves.toMatchObject({ clusterSystemIdentifier: '999' });
    expect(c.source.clusterSystemIdentifier).toBe('999');
    expect(Object.isFrozen(c)).toBe(true);
  });
  it('qualifies again in every supplied tx; a prior success cannot mask later metadata drift', async () => {
    const f = fixture(),
      c = f.connection();
    await c.qualifyInTx(f.tx);
    f.state.base.functions[1].bodyHash = '0'.repeat(64);
    await expect(c.qualifyInTx(f.tx)).rejects.toMatchObject({ stage: 'LIVE_CATALOG' });
    expect(f.state.trace.filter((x) => x === 'cluster')).toHaveLength(2);
    expect(f.state.trace.filter((x) => x === 'preflight')).toHaveLength(1);
  });
  it.each([
    [
      'test/helpers/r5-setmat-catalog-query.sql',
      HUMAN_CORRECTION_BASE_CATALOG_SQL,
      HUMAN_CORRECTION_BASE_COLLECTOR_SHA256,
    ],
    [
      'test/helpers/r5-setmat-async-job-catalog.sql',
      HUMAN_CORRECTION_SUPPLEMENTAL_CATALOG_SQL,
      HUMAN_CORRECTION_SUPPLEMENTAL_COLLECTOR_SHA256,
    ],
  ])('retains the exact frozen collector bytes and digest: %s', (path, sql, digest) => {
    const original = readFileSync(resolve(process.cwd(), path), 'utf8');
    expect(sql).toBe(original);
    expect(createHash('sha256').update(sql, 'utf8').digest('hex')).toBe(digest);
  });
});

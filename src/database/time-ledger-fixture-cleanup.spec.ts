/* eslint-disable no-restricted-syntax -- Test-only environment injection exercises the existing fixture database guards; no application configuration is changed. */
import type { Prisma } from '@prisma/client';
import { fstatSync, readSync } from 'node:fs';
import {
  timeLedgerFixtureTriggerSql,
  withTimeLedgerFixtureCleanup,
} from '../../test/setup/time-ledger-fixture-cleanup';
import { deriveTestDbName } from '../../test/setup/worktree-db';
import { registerR5CiStdin } from '../../test/setup/r5-ci-instance-scope';
import { R5_CI_DATABASE, R5_CI_ROLES } from '../../test/helpers/r5-ci-source-binding';

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof import('node:fs')>('node:fs'),
  fstatSync: jest.fn(),
  readSync: jest.fn(),
}));

const table = 'CorrectionWritePhase';
const trigger = 'r5_phase_no_truncate';

// Transport model only: real fixture guards and orchestration, without a database.
function transactionDouble(enabled: string | null = 'O') {
  const client = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ db: deriveTestDbName(), srv: null }]),
    $queryRaw: jest.fn((_sql: TemplateStringsArray, ...values: unknown[]) => {
      if (values[0] === trigger && values[1] === table) return Promise.resolve([{ enabled }]);
      if (values[0] === table && values[1] === trigger) return Promise.resolve([{ enabled }]);
      return Promise.resolve([]);
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  return { client, tx: client as unknown as Prisma.TransactionClient };
}

describe('phase trigger in controlled test fixture cleanup (no database)', () => {
  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      DATABASE_URL: `postgresql://fixture@localhost/${deriveTestDbName()}`,
    });
    delete process.env.SRVF_R5_CI_AUTHENTICATED;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { enabled: 'O', clause: 'ENABLE' },
    { enabled: 'A', clause: 'ENABLE ALWAYS' },
    { enabled: 'R', clause: 'ENABLE REPLICA' },
    { enabled: 'D', clause: 'DISABLE' },
  ])(
    'restores the original $enabled phase trigger state on the same transaction',
    async ({ enabled, clause }) => {
      const { client, tx } = transactionDouble(enabled);
      const cleanup = jest.fn((inner: Prisma.TransactionClient) => {
        expect(inner).toBe(tx);
        expect(client.$queryRawUnsafe).toHaveBeenCalledWith(
          'SELECT current_database() AS db, host(inet_server_addr()) AS srv',
        );
        expect(client.$executeRawUnsafe.mock.calls).toEqual([
          [`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`],
        ]);
        return Promise.resolve('cleaned');
      });
      await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).resolves.toBe('cleaned');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(client.$executeRawUnsafe.mock.calls).toEqual([
        [`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`],
        [`ALTER TABLE "${table}" ${clause} TRIGGER "${trigger}"`],
      ]);
      expect(client.$queryRaw.mock.calls.at(-1)?.slice(1)).toEqual([table, trigger]);
    },
  );

  it('allows older migration prefixes where the phase table does not exist', async () => {
    const { client, tx } = transactionDouble();
    client.$queryRaw.mockResolvedValue([]);
    const cleanup = jest.fn().mockResolvedValue('older-prefix');
    await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).resolves.toBe('older-prefix');
    expect(cleanup).toHaveBeenCalledWith(tx);
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: null, error: 'Expected fixture trigger is missing' },
    { enabled: 'unknown', error: 'Unknown fixture trigger state' },
  ])('refuses an existing phase table with trigger state $enabled', async ({ enabled, error }) => {
    const { client, tx } = transactionDouble(enabled);
    const cleanup = jest.fn();
    await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).rejects.toThrow(error);
    expect(cleanup).not.toHaveBeenCalled();
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('propagates cleanup failure to the owning transaction for rollback', async () => {
    const { client, tx } = transactionDouble();
    const failure = new Error('deliberate fixture failure');
    await expect(withTimeLedgerFixtureCleanup(tx, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(client.$executeRawUnsafe.mock.calls).toEqual([
      [`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`],
    ]);
  });

  it('rejects a phase trigger whose original state was not restored', async () => {
    const { client, tx } = transactionDouble();
    client.$queryRaw.mockImplementation((_sql, ...values) => {
      if (values[0] === trigger && values[1] === table) return Promise.resolve([{ enabled: 'O' }]);
      if (values[0] === table && values[1] === trigger) return Promise.resolve([{ enabled: 'D' }]);
      return Promise.resolve([]);
    });
    await expect(
      withTimeLedgerFixtureCleanup(tx, () => Promise.resolve(undefined)),
    ).rejects.toThrow('Fixture trigger restoration failed');
  });

  it.each([
    { name: 'missing URL', url: undefined },
    { name: 'business database', url: 'postgresql://fixture@localhost/business' },
    { name: 'public host', url: `postgresql://fixture@example.com/${deriveTestDbName()}` },
  ])('rejects $name before any transaction operation', async ({ url }) => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    const { client, tx } = transactionDouble();
    const cleanup = jest.fn();
    await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).rejects.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(() => timeLedgerFixtureTriggerSql()).toThrow();
  });

  it.each([
    { name: 'unknown connection', facts: [] },
    { name: 'business connection', facts: [{ db: 'business', srv: null }] },
    { name: 'public server', facts: [{ db: deriveTestDbName(), srv: '203.0.113.1' }] },
  ])('rejects $name before changing a trigger', async ({ facts }) => {
    const { client, tx } = transactionDouble();
    client.$queryRawUnsafe.mockResolvedValue(facts);
    const cleanup = jest.fn();
    await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).rejects.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('includes only the phase truncate guard in both generated SQL allowlists', () => {
    const { before, after } = timeLedgerFixtureTriggerSql();
    expect(before).toContain(`('${table}','${trigger}')`);
    expect(after).toContain(`(item->>'table'='${table}' AND item->>'trigger'='${trigger}')`);
    for (const sql of [before, after]) {
      expect(sql).toContain(`IF current_database() <> '${deriveTestDbName()}'`);
      expect(sql).not.toContain('r5_phase_row_guard');
      expect(sql).not.toContain('r5_materialize');
    }
    expect(before).toContain("set_config('srvf.d6_fixture_trigger_states',states::text,true)");
    expect(after).toContain("WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS'");
    expect(after).toContain('Fixture trigger restoration failed');
    expect(() => timeLedgerFixtureTriggerSql('business')).toThrow();
  });

  it('uses registered stdin intent and rejects mismatched live identity without a DATABASE_URL', async () => {
    process.env.SRVF_R5_CI_AUTHENTICATED = '1';
    delete process.env.DATABASE_URL;
    const identity = {
      database: R5_CI_DATABASE,
      databaseOid: 101,
      cluster: '20261101001',
      roles: Object.fromEntries(
        Object.values(R5_CI_ROLES).map((name, index) => [name, 201 + index]),
      ),
    };
    const input = {
      identity,
      installationSha256: '1'.repeat(64),
      authenticationSha256: '2'.repeat(64),
      ownerUrl: `postgresql://postgres@localhost/${R5_CI_DATABASE}?host=%2Frun%2Fr5-pg-socket&connection_limit=1`,
      trustedUrl: `postgresql://${R5_CI_ROLES.trusted}:synthetic-test-only@127.0.0.1/${R5_CI_DATABASE}?connection_limit=1&options=-c%20role%3D${R5_CI_ROLES.caller}`,
      untrustedUrl: `postgresql://${R5_CI_ROLES.untrusted}:synthetic-test-only@127.0.0.1/${R5_CI_DATABASE}?connection_limit=1&options=-c%20role%3D${R5_CI_ROLES.caller}`,
    };
    (fstatSync as jest.Mock).mockReturnValue({ isFIFO: () => true });
    jest
      .mocked(readSync)
      .mockImplementationOnce((_fd, buffer) => {
        const bytes = Buffer.from(JSON.stringify(input));
        bytes.copy(buffer as Buffer);
        return bytes.length;
      })
      .mockReturnValueOnce(0);
    registerR5CiStdin();
    const facts = {
      database: identity.database,
      oid: String(identity.databaseOid),
      cluster: identity.cluster,
      socket: true,
      owner: true,
    };
    for (const wrong of [
      { ...facts, database: 'business' },
      { ...facts, oid: '102' },
      { ...facts, cluster: '7695840193603043362' },
      { ...facts, socket: false },
      { ...facts, owner: false },
    ]) {
      const { client, tx } = transactionDouble();
      client.$queryRawUnsafe.mockResolvedValue([wrong]);
      const cleanup = jest.fn();
      await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).rejects.toThrow(
        'R5_CI_LIVE_OWNER_SCOPE_REJECTED',
      );
      expect(cleanup).not.toHaveBeenCalled();
      expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
    }
    const { client, tx } = transactionDouble();
    client.$queryRawUnsafe.mockResolvedValue([facts]);
    const cleanup = jest.fn().mockResolvedValue('stdin-cleaned');
    await expect(withTimeLedgerFixtureCleanup(tx, cleanup)).resolves.toBe('stdin-cleaned');
    expect(cleanup).toHaveBeenCalledWith(tx);
    expect(client.$executeRawUnsafe.mock.calls).toEqual([
      [`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`],
      [`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`],
    ]);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});

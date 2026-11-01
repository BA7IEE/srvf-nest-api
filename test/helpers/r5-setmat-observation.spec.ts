import { Prisma, type PrismaClient } from '@prisma/client';
import {
  installR5CallerTransactions,
  r5ServerError,
  r5ServerOutcome,
  R5_SETMAT_CALLER,
  R5_SETMAT_DATABASE,
} from './r5-setmat-observation';

describe('R5 safety transaction adapter pure checks (NO DATABASE)', () => {
  it.each([
    [['committed'], 'COMMITTED'],
    [['aborted'], 'ROLLED_BACK'],
    [['in progress'], 'UNKNOWN'],
    [[null], 'UNKNOWN'],
    [[], 'UNKNOWN'],
    [['committed', 'aborted'], 'UNKNOWN'],
  ])('classifies actual server statuses %j as %s', (input, outcome) => {
    expect(r5ServerOutcome(input as (string | null)[])).toBe(outcome);
  });
  it('maps only an actual raw SQLSTATE and its exact transport-prefixed guard text', () => {
    const message = 'write requires this transaction and actor open phase';
    const error = new Prisma.PrismaClientKnownRequestError('raw failure', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '23514', message: 'ERROR: ' + message },
    });
    expect(r5ServerError(error)).toEqual({ sqlState: '23514', message });
    expect(r5ServerError({ code: 'P2010', meta: error.meta })).toBeUndefined();
    expect(
      r5ServerError(
        new Prisma.PrismaClientKnownRequestError('constraint', {
          code: 'P2004',
          clientVersion: 'test',
          meta: error.meta,
        }),
      ),
    ).toBeUndefined();
  });

  function fake(status: string | null, postCommitError?: Error) {
    const calls: string[] = [];
    const engine = {
      transaction: jest.fn(async (phase: string) => {
        calls.push(phase);
      }),
    };
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray) => {
        expect(sql.join('')).toContain('SET LOCAL ROLE "r5_boundary_caller_h7c6"');
        return 0;
      }),
      $queryRaw: jest.fn(async () => [
        {
          database: R5_SETMAT_DATABASE,
          databaseOid: 42,
          role: R5_SETMAT_CALLER,
          pid: 11,
          xid: '901',
          sessionUser: 'synthetic-login',
          roleOid: '1789091',
          isSuperuser: 'off',
        },
      ]),
    };
    const client = {
      _engine: engine,
      $transaction: async function (body: (t: unknown) => Promise<unknown>, _options: unknown) {
        expect(_options).toBeDefined();
        expect(this).toBe(client);
        await engine.transaction('start');
        let committed = false;
        try {
          const value = await body(tx);
          await engine.transaction('commit');
          committed = true;
          if (postCommitError) throw postCommitError;
          return value;
        } catch (error) {
          if (!committed) await engine.transaction('rollback');
          throw error;
        }
      },
    };
    const observer = {
      $queryRaw: jest.fn(async () => [
        { database: R5_SETMAT_DATABASE, databaseOid: 42, observerPid: 12, status },
      ]),
    };
    return { client, observer, calls, tx };
  }

  it('retains server COMMITTED when the client rejects with P2028 after engine commit', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('transaction closed', {
      code: 'P2028',
      clientVersion: 'test',
    });
    const { client, observer, calls } = fake('committed', error);
    const original: unknown = Reflect.get(client, '$transaction');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const receipts: unknown[] = [];
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'client rejection',
      () =>
        client.$transaction(async () => 7, { timeout: 15_000, isolationLevel: 'ReadCommitted' }),
      (r) => {
        receipts.push(r);
        return 'pure-fixture-receipt';
      },
    );
    expect(result.client).toEqual({ status: 'rejected', reason: error });
    expect(result.databaseOutcome).toBe('COMMITTED');
    expect(result.observationComplete).toBe(true);
    expect(calls).toEqual(['start', 'commit']);
    expect(receipts[0]).toMatchObject({
      transactions: [
        {
          callback: 'FULFILLED',
          transactionPromise: 'REJECTED',
          options: { timeout: 15_000, isolationLevel: 'ReadCommitted' },
        },
      ],
      server: [{ status: 'committed' }],
    });
    adapter.restore();
    expect(Reflect.get(client, '$transaction')).toBe(original);
  });

  it('requires a fresh-session aborted status for ROLLED_BACK', async () => {
    const { client, observer } = fake('aborted');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const error = new Error('synthetic callback failure');
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'callback failure',
      () =>
        client.$transaction(async () => {
          throw error;
        }, {}),
      () => 'pure-fixture-receipt',
    );
    expect(result.databaseOutcome).toBe('ROLLED_BACK');
    expect(result.client).toEqual({ status: 'rejected', reason: error });
    adapter.restore();
  });

  it('does not call a fulfilled callback or Promise a database commit', async () => {
    const { client, observer } = fake('in progress');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'pending server',
      () => client.$transaction(async () => 7, {}),
      () => 'pure-fixture-receipt',
    );
    expect(result.client.status).toBe('fulfilled');
    expect(result.databaseOutcome).toBe('UNKNOWN');
    adapter.restore();
  });

  it('marks unavailable server observation UNKNOWN', async () => {
    const { client, observer } = fake('committed');
    observer.$queryRaw.mockRejectedValueOnce(new Error('synthetic read failure'));
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'missing server proof',
      () => client.$transaction(async () => 7, {}),
      () => 'pure-fixture-receipt',
    );
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    adapter.restore();
  });

  it('reports NO_TRANSACTION without inventing an aborted XID for pre-service rejection', async () => {
    const { client, observer } = fake('committed');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'DTO rejection',
      async () => ({ status: 400 }),
      () => 'pure-fixture-receipt',
    );
    expect(result.databaseOutcome).toBe('NO_TRANSACTION');
    expect(observer.$queryRaw).not.toHaveBeenCalled();
    adapter.restore();
  });

  it('keeps real login transactions outside correction scope and routes only explicit correction work', async () => {
    const { client, observer } = fake('committed');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const originalCalls: boolean[] = [];
    await client.$transaction(async (tx) => {
      originalCalls.push((tx as { $executeRaw: jest.Mock }).$executeRaw.mock.calls.length > 0);
    }, {});
    await adapter.withinCaller(() =>
      client.$transaction(async (tx) => {
        originalCalls.push((tx as { $executeRaw: jest.Mock }).$executeRaw.mock.calls.length > 0);
      }, {}),
    );
    expect(originalCalls).toEqual([false, true]);
    expect(observer.$queryRaw).not.toHaveBeenCalled();
    adapter.restore();
  });
  it('records the actual unexpected privileged context and blocks the original callback', async () => {
    const { client, observer, tx } = fake('aborted');
    tx.$queryRaw.mockResolvedValueOnce([
      {
        database: R5_SETMAT_DATABASE,
        databaseOid: 42,
        role: 'postgres',
        pid: 11,
        xid: '901',
        sessionUser: 'synthetic-login',
        roleOid: '10',
        isSuperuser: 'on',
      },
    ]);
    const body = jest.fn(async () => 1);
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const receipts: unknown[] = [];
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'wrong actual role',
      () => client.$transaction(body, {}),
      (receipt) => {
        receipts.push(receipt);
        return 'pure-context-receipt';
      },
    );
    expect(body).not.toHaveBeenCalled();
    expect(result.client.status).toBe('rejected');
    expect(receipts[0]).toMatchObject({
      transactions: [
        {
          identity: { role: 'postgres', sessionUser: 'synthetic-login', roleOid: '10' },
          callback: 'REJECTED',
        },
      ],
    });
    adapter.restore();
  });

  it('preserves UNKNOWN when identity capture fails even if the engine rolls back', async () => {
    const { client, observer, tx, calls } = fake('aborted');
    const error = new Error('synthetic identity query failed');
    tx.$queryRaw.mockRejectedValueOnce(error);
    const body = jest.fn(async () => 1);
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const receipts: unknown[] = [];
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'missing identity',
      () => client.$transaction(body, {}),
      (receipt) => {
        receipts.push(receipt);
        return 'pure-no-xid-receipt';
      },
    );
    expect(body).not.toHaveBeenCalled();
    expect(calls).toEqual(['start', 'rollback']);
    expect(result.client).toEqual({ status: 'rejected', reason: error });
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    expect(observer.$queryRaw).not.toHaveBeenCalled();
    expect(receipts[0]).toMatchObject({ transactions: [{ callback: 'REJECTED' }], server: [] });
    adapter.restore();
  });

  it('refuses a final verdict from an observer on the original backend', async () => {
    const { client, observer } = fake('committed');
    observer.$queryRaw.mockResolvedValueOnce([
      { database: R5_SETMAT_DATABASE, databaseOid: 42, observerPid: 11, status: 'committed' },
    ]);
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'same backend is not independent',
      () => client.$transaction(async () => 1, {}),
      () => 'pure-same-backend-receipt',
    );
    expect(result.client.status).toBe('fulfilled');
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    adapter.restore();
  });

  it('rejects a final status from the same OID in a different database', async () => {
    const { client, observer } = fake('committed');
    observer.$queryRaw.mockResolvedValueOnce([
      { database: 'different_database', databaseOid: 42, observerPid: 12, status: 'committed' },
    ]);
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'wrong observer database',
      () => client.$transaction(async () => 1, {}),
      () => 'pure-wrong-database-receipt',
    );
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    adapter.restore();
  });

  it('keeps an unawaited original Promise distinct from the completed entry', async () => {
    const { client, observer } = fake('in progress');
    const adapter = installR5CallerTransactions(client as unknown as PrismaClient, 42);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let originalPromise: Promise<unknown> | undefined;
    const receipts: unknown[] = [];
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'entry returns before transaction',
      async () => {
        originalPromise = client.$transaction(async () => {
          entered();
          await barrier;
          return 1;
        }, {});
        await callbackEntered;
        return 'entry finished';
      },
      (receipt) => {
        receipts.push(receipt);
        return 'pure-pending-promise-receipt';
      },
    );
    expect(result.client).toEqual({ status: 'fulfilled', value: 'entry finished' });
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    expect(receipts[0]).toMatchObject({
      transactions: [{ callback: 'PENDING', transactionPromise: 'PENDING' }],
    });
    expect(() => adapter.restore()).toThrow('pending real transactions prevent adapter teardown');
    release();
    await originalPromise;
    adapter.restore();
  });

  it('stops before original business callback when a caller prerequisite changes', async () => {
    const { client, observer, tx, calls } = fake('aborted');
    const error = new Error('zero-assignment prerequisite changed');
    const prerequisite = jest.fn(async (actualTx: unknown) => {
      expect(actualTx).toBe(tx);
      throw error;
    });
    const body = jest.fn(async () => 1);
    const adapter = installR5CallerTransactions(
      client as unknown as PrismaClient,
      42,
      prerequisite,
    );
    const result = await adapter.observe(
      observer as unknown as PrismaClient,
      'changed prerequisite',
      () => client.$transaction(body, {}),
      () => 'pure-prerequisite-receipt',
    );
    expect(prerequisite).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
    expect(calls).toEqual(['start', 'rollback']);
    expect(result.client).toEqual({ status: 'rejected', reason: error });
    expect(result.databaseOutcome).toBe('ROLLED_BACK');
    adapter.restore();
  });
});

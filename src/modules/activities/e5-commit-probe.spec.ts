import { observeE5Commit, safeCommitError } from '../../../test/helpers/e5-commit-probe';
import { PrismaService } from '../../database/prisma.service';

describe('E5 commit transaction observation', () => {
  it('restores actual Prisma root and interactive delegate proxy function identities without DB access', async () => {
    const prisma = new PrismaService();
    const originalTransaction = Reflect.get(prisma, '$transaction') as unknown;
    const root = observeE5Commit({ commitBatch: () => Promise.resolve(undefined) }, prisma);
    root.restore();
    expect(Reflect.get(prisma, '$transaction')).toBe(originalTransaction);
    expect(root.restorationFailures).toBe(0);

    const make = Reflect.get(prisma, '_createItxClient') as unknown;
    if (typeof make !== 'function') throw new Error('Prisma offline itx seam missing');
    const tx = Reflect.apply(make, prisma, [{ id: 'offline-probe', kind: 'itx' }]) as typeof prisma;
    const query = Reflect.get(tx, '$queryRaw') as unknown;
    const update = Reflect.get(tx.ledgerPostingBatch, 'update') as unknown;
    const result = {};
    const driver = {
      $transaction: async (body: (value: typeof tx) => Promise<unknown>) => body(tx),
    };
    const posting = {
      commitBatch: async () =>
        driver.$transaction((actual) => {
          expect(actual).toBe(tx);
          expect(Reflect.get(actual, '$queryRaw')).not.toBe(query);
          expect(Reflect.get(actual.ledgerPostingBatch, 'update')).not.toBe(update);
          return Promise.resolve(result);
        }),
    };
    const probe = observeE5Commit(posting, driver);
    try {
      expect(await posting.commitBatch()).toBe(result);
    } finally {
      probe.restore();
    }
    expect(Reflect.get(tx, '$queryRaw')).toBe(query);
    // Prisma's unmodified delegate creates a new function on every read. The probe's
    // restoration check compares with the exact function captured by installation.
    expect(typeof tx.ledgerPostingBatch.update).toBe('function');
    expect(probe.restorationFailures).toBe(0);
  });

  it('emits immediately, retains a failed sink in memory, and never replaces the original error', async () => {
    const cause = new Error('original');
    const posting = {
      commitBatch: () => Promise.reject(cause),
    };
    const output = jest.fn(() => {
      throw new Error('sink');
    });
    const probe = observeE5Commit(posting, {}, output);
    try {
      await expect(posting.commitBatch()).rejects.toBe(cause);
      expect(output).toHaveBeenCalled();
      expect(probe.failure).toBe(cause);
      const restored: unknown[] = [];
      probe.flush((event) => restored.push(event));
      expect(restored).toEqual(probe.events);
    } finally {
      probe.restore();
    }
  });

  it('rolls back previously installed wrappers when a later installation is refused', () => {
    const original = () => Promise.resolve(undefined);
    const posting = { commitBatchWithin: original };
    Object.defineProperty(posting, 'lockRun', { value: original, configurable: false });
    expect(() => observeE5Commit(posting, {})).toThrow();
    expect(posting.commitBatchWithin).toBe(original);
  });
  const expired = () =>
    Object.assign(new Error('invocation contains SQL and secret-fixture-value'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2028',
      clientVersion: '6.19.0',
      meta: {
        error:
          'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 7000 ms, however 7123 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.',
      },
    });

  it('retains the safe original transaction reason and fields while excluding arbitrary text', () => {
    const detail = safeCommitError(expired());
    expect(detail).toMatchObject({
      prismaCode: 'P2028',
      errorClass: 'PrismaClientKnownRequestError',
      transactionTimeoutMs: 7000,
      transactionElapsedMs: 7123,
      safeMessage: null,
      messageNotRetained: true,
      metaErrorNotRetained: false,
    });
    expect(detail.meta.error).toContain('A query cannot be executed on an expired transaction');
    expect(JSON.stringify(detail)).not.toContain('secret-fixture-value');
  });

  it('does not echo arbitrary meta or error getters', () => {
    const cause = Object.defineProperty(
      { meta: { code: '55P03', error: 'secret-fixture-value' } },
      'message',
      {
        get() {
          throw new Error('getter');
        },
      },
    );
    expect(safeCommitError(cause)).toMatchObject({
      safeMessage: null,
      meta: { code: '55P03', error: null },
      metaErrorNotRetained: true,
    });
    expect(JSON.stringify(safeCommitError(cause))).not.toContain('secret-fixture-value');
  });

  it.each([false, true])(
    'preserves tx, options, receiver, args and outcome when failure=%s',
    async (fails) => {
      const result = { committed: true };
      const cause = expired();
      const options = { timeout: 7000, isolationLevel: 'ReadCommitted' };
      const tx = {
        $queryRaw: jest
          .fn<Promise<{ locked: boolean }[]>, [unknown]>()
          .mockResolvedValue([{ locked: true }]),
        ledgerPostingBatch: {
          update: jest.fn<Promise<typeof result>, []>().mockImplementation(() => {
            if (fails) throw cause;
            return Promise.resolve(result);
          }),
        },
      };
      const prisma = {
        $transaction: jest.fn(
          async (body: (actual: typeof tx) => Promise<unknown>, received: unknown) => {
            expect(received).toBe(options);
            return body(tx);
          },
        ),
      };
      type Posting = {
        commitBatch(this: Posting, input: unknown): Promise<unknown>;
        commitBatchWithin(this: Posting, actual: typeof tx): Promise<unknown>;
      };
      const posting: Posting = {
        async commitBatch(input: unknown) {
          expect(this).toBe(posting);
          expect(input).toBe(result);
          return prisma.$transaction((actual) => this.commitBatchWithin(actual), options);
        },
        async commitBatchWithin(actual: typeof tx) {
          expect(this).toBe(posting);
          expect(actual).toBe(tx);
          await actual.$queryRaw(['SELECT pg_advisory_xact_lock(?)']);
          return actual.ledgerPostingBatch.update();
        },
      };
      const original = Reflect.get(posting, 'commitBatch') as unknown;
      const originalQuery = tx.$queryRaw;
      const probe = observeE5Commit(posting, prisma);
      try {
        if (fails) await expect(posting.commitBatch(result)).rejects.toBe(cause);
        else expect(await posting.commitBatch(result)).toBe(result);
        expect(tx.$queryRaw).toBe(originalQuery);
        expect(probe.hasFailure).toBe(fails);
        if (fails) expect(probe.failure).toBe(cause);
        expect(probe.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage: 'transaction.options', transactionOptions: options }),
            expect.objectContaining({
              stage: 'transaction.callback',
              outcome: fails ? 'THROW' : 'RETURN',
            }),
            expect.objectContaining({
              stage: 'tx.ledgerPostingBatch.update',
              outcome: fails ? 'THROW' : 'RETURN',
              durationMs: expect.any(Number) as unknown,
            }),
            expect.objectContaining({
              stage: 'transaction.resolve',
              outcome: fails ? 'THROW' : 'RETURN',
            }),
          ]),
        );
        expect(() =>
          probe.flush(() => {
            throw new Error('sink');
          }),
        ).not.toThrow();
        if (fails) expect(probe.failure).toBe(cause);
      } finally {
        probe.restore();
      }
      expect(Reflect.get(posting, 'commitBatch')).toBe(original);
    },
  );

  it('forwards transactions outside commit without changing the callback or array', async () => {
    const prisma = { $transaction: jest.fn().mockResolvedValue('outside') };
    const originalTransaction = prisma.$transaction;
    const posting = { commitBatch: () => Promise.resolve('unused') };
    const callback = () => Promise.resolve('same');
    const list: unknown[] = [];
    const probe = observeE5Commit(posting, prisma);
    try {
      await prisma.$transaction(callback);
      await prisma.$transaction(list);
      expect(originalTransaction.mock.calls).toEqual([[callback], [list]]);
      expect(probe.events).toEqual([]);
    } finally {
      probe.restore();
    }
  });
});

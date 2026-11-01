import { PrismaClient } from '@prisma/client';
import { installR5TailProfile, isR5CommitSeal } from './r5-setmat-tail-profile';
const make = () => {
  const timeCorrection = {
    createCommitReceipt: jest.fn(async (...args: unknown[]) => {
      void args;
      return { receipt: true };
    }),
    hasReadyV3CommitReceiptAnchor: jest.fn(async () => true),
    assertComplete: jest.fn(async () => {}),
  };
  const contributions = {
    readNativePostingBoundaryCandidateInTx: jest.fn(async () => ({
      privatePayload: 'never recorded',
    })),
    assertVersionInTx: jest.fn(async () => {}),
    assertNativePostingBoundaryInTx: jest.fn(async () => {}),
  };
  return {
    timeCorrection,
    ledgerPosting: { timeCorrection, contributions, commitBatchWithin: jest.fn(async () => {}) },
    humanAccess: { authorizeCommit: jest.fn(async () => {}) },
    audit: { logCommit: jest.fn(async () => {}) },
  };
};
function sealArgs(app = 'app', phase = 'commit') {
  let saved: unknown[] = [];
  const tag = (...args: unknown[]) => {
    saved = args;
  };
  void tag`
    SELECT * FROM public.r5_correction_seal_phase(${app}::text, ${phase}::text)
  `;
  return saved;
}
describe('tail profile transparent method boundaries (no DB)', () => {
  it('matches only the frozen native seal SQL and exact application/phase', () => {
    expect(isR5CommitSeal(sealArgs(), 'app')).toBe(true);
    expect(isR5CommitSeal(sealArgs('other'), 'app')).toBe(false);
    expect(isR5CommitSeal(sealArgs('app', 'prepare'), 'app')).toBe(false);
    const a = sealArgs(),
      t = [...(a[0] as string[])];
    Object.defineProperty(t, 'raw', { value: ['changed'] });
    a[0] = t;
    expect(isR5CommitSeal(a, 'app')).toBe(false);
  });
  it('preserves receiver, exact arguments/value and restores original methods', async () => {
    const c = make(),
      original = c.timeCorrection.createCommitReceipt,
      args = [{}, 'app', undefined],
      saved: unknown[] = [];
    const profile = installR5TailProfile(c, 'app', 'batch', (e) => {
      saved.push(e);
      return 'memory';
    });
    const result = await Reflect.apply(
      c.timeCorrection.createCommitReceipt,
      c.timeCorrection,
      args,
    );
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.contexts[0]).toBe(c.timeCorrection);
    expect(original.mock.calls[0]).toEqual(args);
    expect(result).toEqual({ receipt: true });
    expect(saved).toHaveLength(2);
    expect(() => profile.assertCompletedTail()).toThrow();
    profile.restore();
    expect(c.timeCorrection.createCommitReceipt).toBe(original);
  });
  it('assimilates lazy Prisma-style thenable once, not once for each observer', async () => {
    const c = make(),
      value = { id: 'receipt' },
      then = jest.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(value)));
    Reflect.set(
      c.timeCorrection,
      'createCommitReceipt',
      jest.fn(() => ({ then })),
    );
    const profile = installR5TailProfile(c, 'app', 'batch', () => 'memory');
    expect(await c.timeCorrection.createCommitReceipt()).toBe(value);
    expect(then).toHaveBeenCalledTimes(1);
    profile.restore();
  });
  it('preserves the native error object even when durable profiling fails', async () => {
    const c = make(),
      failure = new Error('native');
    c.audit.logCommit.mockRejectedValue(failure);
    const profile = installR5TailProfile(c, 'app', 'batch', () => {
      throw new Error('journal');
    });
    await expect(c.audit.logCommit()).rejects.toBe(failure);
    expect(() => profile.assertHealthy()).toThrow();
    expect(profile.snapshot().journalComplete).toBe(false);
    profile.restore();
  });
  it('passes unknown raw SQL through once and records actual branch flags without returned data', async () => {
    const c = make(),
      raw = jest.fn(async (...args: unknown[]) => {
        void args;
        return [];
      }),
      update = jest.fn(async (...args: unknown[]) => {
        void args;
        return {};
      }),
      tx = { $queryRaw: raw, ledgerPostingBatch: { update } };
    const profile = installR5TailProfile(c, 'app', 'batch', () => 'memory');
    profile.attachTransaction(tx);
    const args = ['unknown SQL', { id: 'opaque' }];
    await Reflect.apply(tx.$queryRaw, tx, args);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]).toEqual(args);
    expect(raw.mock.contexts[0]).toBe(tx);
    expect(profile.snapshot().events).toHaveLength(0);
    await tx.ledgerPostingBatch.update({
      where: { id: 'wrong' },
      data: { statusCode: 'committed' },
    });
    expect(profile.snapshot().events).toHaveLength(0);
    await c.ledgerPosting.timeCorrection.hasReadyV3CommitReceiptAnchor();
    await c.ledgerPosting.contributions.readNativePostingBoundaryCandidateInTx();
    expect(
      profile
        .snapshot()
        .events.filter((e) => e.event === 'FULFILLED')
        .map((e) => e.branchFlag),
    ).toEqual([true, true]);
    expect(JSON.stringify(profile.snapshot())).not.toContain('privatePayload');
    profile.restore();
    expect(tx.$queryRaw).toBe(raw);
    expect(tx.ledgerPostingBatch.update).toBe(update);
  });
  it('restores real Prisma6.19.3 transaction/model proxy methods without connecting', () => {
    const c = make(),
      client = new PrismaClient();
    const factory: unknown = Reflect.get(client, '_createItxClient');
    if (typeof factory !== 'function') throw new Error('missing pinned proxy');
    const tx = Reflect.apply(factory, client, [{ id: 'offline-only', payload: {} }]) as object;
    const query = Reflect.get(tx, '$queryRaw'),
      batch = Reflect.get(tx, 'ledgerPostingBatch') as object,
      update = Reflect.get(batch, 'update');
    const profile = installR5TailProfile(c, 'app', 'batch', () => 'memory');
    profile.attachTransaction(tx);
    expect(Reflect.get(tx, '$queryRaw')).not.toBe(query);
    expect(Reflect.get(batch, 'update')).not.toBe(update);
    const wrappedUpdate = Reflect.get(batch, 'update');
    profile.restore();
    expect(Reflect.get(tx, '$queryRaw')).toBe(query);
    // Prisma6 dynamically creates a new update function on every read before
    // an own override. The helper separately asserts its captured original.
    expect(typeof Reflect.get(batch, 'update')).toBe('function');
    expect(Reflect.get(batch, 'update')).not.toBe(wrappedUpdate);
    const restored = Reflect.get(batch, 'update') as (...args: unknown[]) => object;
    const lazy = Reflect.apply(restored, batch, [
      { where: { id: 'offline-only' }, data: { statusCode: 'committed' } },
    ]);
    expect(Reflect.get(lazy, Symbol.toStringTag)).toBe('PrismaPromise');
  });
  it('restores partially installed ordinary methods if a later dependency is missing', () => {
    const c = make(),
      receipt = c.timeCorrection.createCommitReceipt;
    Reflect.deleteProperty(c, 'humanAccess');
    expect(() => installR5TailProfile(c, 'app', 'batch', () => 'memory')).toThrow();
    expect(c.timeCorrection.createCommitReceipt).toBe(receipt);
  });
});

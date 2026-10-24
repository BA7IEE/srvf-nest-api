import { Prisma } from '@prisma/client';
import {
  E4_LEDGER_COMMIT_TX_TIMEOUT_MS,
  HUMAN_CORRECTION_COMMIT_TX_TIMEOUT_MS,
  MEMBER_LOCK_WAIT_BUDGET_MS,
  MEMBER_TX_TIMEOUT_MS,
  runMemberLinearizedTransaction,
} from './member-advisory-lock.util';

describe('named member transaction resource profiles', () => {
  it.each([
    ['standard', 7_000],
    ['d7-human-correction-commit', 15_000],
    ['e4-native-ledger-commit', 60_000],
  ] as const)(
    '%s keeps RC, the original lock limit and its own deadline',
    async (profile, timeout) => {
      const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(0) };
      const body = jest.fn().mockResolvedValue('real body result');
      const prisma = {
        $transaction: jest.fn(
          async (callback: (value: Prisma.TransactionClient) => Promise<string>) =>
            callback(tx as unknown as Prisma.TransactionClient),
        ),
      };
      await expect(
        runMemberLinearizedTransaction(
          prisma as unknown as Parameters<typeof runMemberLinearizedTransaction>[0],
          body,
          profile,
        ),
      ).resolves.toBe('real body result');
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout,
      });
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL lock_timeout = 4000');
      expect(body).toHaveBeenCalledTimes(1);
      expect(MEMBER_LOCK_WAIT_BUDGET_MS).toBe(4_000);
      expect(MEMBER_TX_TIMEOUT_MS).toBe(7_000);
      expect(HUMAN_CORRECTION_COMMIT_TX_TIMEOUT_MS).toBe(15_000);
      expect(E4_LEDGER_COMMIT_TX_TIMEOUT_MS).toBe(60_000);
    },
  );

  it('omitting a profile preserves the standard deadline and original failure', async () => {
    const failure = new Error('body failed');
    const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(0) };
    const prisma = {
      $transaction: jest.fn(async (callback: (value: Prisma.TransactionClient) => Promise<never>) =>
        callback(tx as unknown as Prisma.TransactionClient),
      ),
    };
    await expect(
      runMemberLinearizedTransaction(
        prisma as unknown as Parameters<typeof runMemberLinearizedTransaction>[0],
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 7_000,
    });
  });
});

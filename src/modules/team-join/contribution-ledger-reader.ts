import type { Prisma } from '@prisma/client';

/** Composed by AppModule; team-join never imports the participation implementation. */
export const CONTRIBUTION_LEDGER_READER = Symbol('CONTRIBUTION_LEDGER_READER');

type ContributionLedgerClient = Pick<Prisma.TransactionClient, 'participationLedgerEntry'>;

/** Caller authorization, member locks and transaction remain with the caller. */
export interface ContributionLedgerReader {
  sumCommittedCreditedPointsForMemberInTx(
    client: ContributionLedgerClient,
    memberId: string,
    ledgerDateExclusive: Date | null,
  ): Promise<Prisma.Decimal>;
  sumCommittedCreditedPointsForMembersInTx(
    client: ContributionLedgerClient,
    memberIds: readonly string[],
    ledgerDateExclusive: Date | null,
  ): Promise<Map<string, Prisma.Decimal>>;
}

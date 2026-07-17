import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

export const ORGANIZATION_TOPOLOGY_LOCK_NAMESPACE = 'srvf:organizations:topology:v1';

function stableSignedAdvisoryLockKey(namespace: string): bigint {
  const digest = createHash('sha256').update(namespace, 'utf8').digest();
  return digest.readBigInt64BE(0);
}

// Golden vector is locked by organization-topology-transaction.spec.ts:
// sha256("srvf:organizations:topology:v1")[0..8] = 609bf47aa45c47c3
// interpreted as PostgreSQL signed bigint = 6961426456611932099.
export const ORGANIZATION_TOPOLOGY_LOCK_KEY = stableSignedAdvisoryLockKey(
  ORGANIZATION_TOPOLOGY_LOCK_NAMESPACE,
);

/**
 * Serialize every Organization / OrganizationClosure topology mutation.
 *
 * The caller owns the interactive transaction and must call this before its first topology SQL.
 * Transaction-scoped locking is intentional: PostgreSQL releases it on both commit and rollback.
 */
export async function lockOrganizationTopology(tx: PrismaTx): Promise<void> {
  await tx.$queryRaw<Array<{ locked: string }>>(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        CAST(${ORGANIZATION_TOPOLOGY_LOCK_KEY} AS bigint)
      )::text AS locked
    `,
  );
}

export async function runOrganizationTopologyTransaction<T>(
  prisma: PrismaService,
  operation: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockOrganizationTopology(tx);
    return operation(tx);
  });
}

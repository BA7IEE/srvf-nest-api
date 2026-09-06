import { OrganizationStatus, Prisma } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

type PrismaTx = Prisma.TransactionClient;

export type ActivityOrganizationEligibility = 'eligible' | 'missing' | 'inactive' | 'root';

/**
 * Organization-owned eligibility reason, read once from the caller's transaction.
 * Missing (including soft deletion) precedes inactive, which precedes root rejection.
 * No raw organization projection, new transaction, lock or cross-request cache escapes here.
 */
export async function getActivityOrganizationEligibility(
  tx: PrismaTx,
  organizationId: string,
): Promise<ActivityOrganizationEligibility> {
  const organization = await tx.organization.findFirst({
    where: notDeletedWhere({ id: organizationId }),
    select: { parentId: true, status: true },
  });
  if (!organization) return 'missing';
  if (organization.status !== OrganizationStatus.ACTIVE) return 'inactive';
  if (organization.parentId === null) return 'root';
  return 'eligible';
}

/**
 * Identity-org owner primitive for a caller that needs only the current Activity organization
 * eligibility fact.  It deliberately returns a boolean rather than an Organization projection,
 * so participation callers cannot grow a second organization-read surface.
 */
export async function isActivityOrganizationResolvable(
  tx: PrismaTx,
  organizationId: string,
): Promise<boolean> {
  return (await getActivityOrganizationEligibility(tx, organizationId)) === 'eligible';
}

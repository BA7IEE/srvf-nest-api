import { OrganizationStatus, Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

/**
 * Identity-org owner primitive for a caller that needs only the current Activity organization
 * eligibility fact.  It deliberately returns a boolean rather than an Organization projection,
 * so participation callers cannot grow a second organization-read surface.
 */
export async function isActivityOrganizationResolvable(
  tx: PrismaTx,
  organizationId: string,
): Promise<boolean> {
  const organization = await tx.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    select: { parentId: true, status: true },
  });
  return (
    organization !== null &&
    organization.status === OrganizationStatus.ACTIVE &&
    organization.parentId !== null
  );
}

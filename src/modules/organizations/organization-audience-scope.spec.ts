import { MemberStatus, OrganizationStatus, type Prisma } from '@prisma/client';

import { resolveActiveMemberIdsWithinExactOrganizationScope } from './organization-audience-scope';

describe('organization audience scope owner primitives', () => {
  const at = new Date('2026-09-05T03:04:05.000Z');

  it('filters candidates by active member, current membership and active exact-scope organization', async () => {
    const member = {
      findMany: jest.fn().mockResolvedValue([{ id: 'member-b' }, { id: 'member-a' }]),
    };
    const tx = { member } as unknown as Prisma.TransactionClient;

    const result = await resolveActiveMemberIdsWithinExactOrganizationScope(
      tx,
      ['member-b', 'member-a'],
      ['org-b', 'org-a'],
      at,
    );

    expect(result).toEqual(new Set(['member-b', 'member-a']));
    expect(member.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['member-b', 'member-a'] },
        status: MemberStatus.ACTIVE,
        memberOrganizationMemberships: {
          some: {
            deletedAt: null,
            status: 'ACTIVE',
            startedAt: { lte: at },
            endedAt: null,
            organizationId: { in: ['org-b', 'org-a'] },
            organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
          },
        },
        deletedAt: null,
      },
      select: { id: true },
    });
  });

  it.each([
    { candidates: [], organizations: ['org-a'] },
    { candidates: ['member-a'], organizations: [] },
  ])('returns an empty set without querying when either bound is empty', async (input) => {
    const member = { findMany: jest.fn() };
    const tx = { member } as unknown as Prisma.TransactionClient;

    await expect(
      resolveActiveMemberIdsWithinExactOrganizationScope(
        tx,
        input.candidates,
        input.organizations,
        at,
      ),
    ).resolves.toEqual(new Set());
    expect(member.findMany).not.toHaveBeenCalled();
  });
});

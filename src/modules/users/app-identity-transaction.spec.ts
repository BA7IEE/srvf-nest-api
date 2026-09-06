import { MemberStatus, Role, UserStatus, type Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { AppIdentityResolver } from './app-identity.resolver';

describe('C1 D2b App identity uses caller transaction', () => {
  const user = {
    id: 'user',
    username: 'user',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  it('does not use default client; re-reads Member on every invocation', async () => {
    const fallback = {
      member: {
        findUnique: jest.fn(() => {
          throw new Error('wrong client');
        }),
      },
    };
    const tx = {
      member: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'member', status: MemberStatus.ACTIVE, deletedAt: null }),
      },
    };
    const resolver = new AppIdentityResolver(fallback as unknown as PrismaService);
    const client = tx as unknown as Prisma.TransactionClient;
    await expect(resolver.resolve(user, client)).resolves.toMatchObject({ canUseApp: true });
    tx.member.findUnique.mockResolvedValue({
      id: 'member',
      status: MemberStatus.INACTIVE,
      deletedAt: null,
    });
    await expect(resolver.resolve(user, client)).resolves.toMatchObject({
      canUseApp: false,
      reason: 'MEMBER_INACTIVE',
    });
    expect(tx.member.findUnique).toHaveBeenCalledTimes(2);
    expect(fallback.member.findUnique).not.toHaveBeenCalled();
  });
  it('unlinked SUPER_ADMIN has no App exception', async () => {
    const resolver = new AppIdentityResolver({} as PrismaService);
    await expect(
      resolver.resolve({ ...user, memberId: null }, {} as Prisma.TransactionClient),
    ).resolves.toEqual({ canUseApp: false, reason: 'MEMBER_NOT_LINKED', member: null });
  });
});

import type { PrismaService } from '../../database/prisma.service';
import {
  MemberQualificationFactsService,
  type MemberQualificationFacts,
} from './member-qualification-facts.service';

function makeService(rows: unknown[][]): MemberQualificationFactsService {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
  };
  return new MemberQualificationFactsService(prisma as unknown as PrismaService);
}

describe('MemberQualificationFactsService', () => {
  it('collects only the live profile and active organization subtree facts', async () => {
    const service = makeService([
      [{ gradeCode: 'L2' }],
      [{ genderCode: 'female', birthDate: new Date('2000-02-29T00:00:00.000Z') }],
      [{ organizationId: 'team-b' }, { organizationId: 'team-a' }, { organizationId: 'team-b' }],
      [
        { ancestorId: 'root' },
        { ancestorId: 'team-a' },
        { ancestorId: 'root' },
        { ancestorId: 'team-b' },
      ],
    ]);

    await expect(service.readForQualification('member-1')).resolves.toEqual({
      memberId: 'member-1',
      gradeCode: 'L2',
      profile: { genderCode: 'female', birthDate: new Date('2000-02-29T00:00:00.000Z') },
      activeOrganizationIds: ['team-a', 'team-b'],
      activeOrganizationAncestorIds: ['root', 'team-a', 'team-b'],
    });
  });

  it('treats a missing live profile as absent rather than inventing a default', async () => {
    const service = makeService([[{ gradeCode: 'L1' }], [], []]);

    await expect(service.readForQualification('member-2')).resolves.toEqual({
      memberId: 'member-2',
      gradeCode: 'L1',
      profile: null,
      activeOrganizationIds: [],
      activeOrganizationAncestorIds: [],
    });
  });

  it('accepts an active membership on the required organization or any of its ancestors', () => {
    const service = makeService([]);
    const facts: MemberQualificationFacts = {
      memberId: 'member-3',
      gradeCode: null,
      profile: null,
      activeOrganizationIds: ['team-a'],
      activeOrganizationAncestorIds: ['root', 'division-a'],
    };

    expect(service.hasActiveMembershipInRequiredSubtree(facts, ['team-a'])).toBe(true);
    expect(service.hasActiveMembershipInRequiredSubtree(facts, ['division-a'])).toBe(true);
    expect(service.hasActiveMembershipInRequiredSubtree(facts, ['other-root'])).toBe(false);
  });
});

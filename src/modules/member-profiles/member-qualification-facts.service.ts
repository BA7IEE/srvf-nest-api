import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

export interface MemberQualificationFacts {
  memberId: string;
  gradeCode: string | null;
  profile: { genderCode: string; birthDate: Date } | null;
  activeOrganizationIds: string[];
  activeOrganizationAncestorIds: string[];
}

type LockedMemberRow = {
  gradeCode: string | null;
};

type LockedProfileRow = {
  genderCode: string;
  birthDate: Date;
};

type LockedMembershipRow = {
  organizationId: string;
};

type LockedOrganizationClosureRow = {
  ancestorId: string;
};

/**
 * Qualification's deliberately narrow member-side read port.
 *
 * It owns current grade/profile/active-membership facts and takes share locks while
 * an enclosing registration transaction is deciding eligibility.  The evaluator
 * only consumes this projection; it never reimplements member/profile/closure SQL.
 */
@Injectable()
export class MemberQualificationFactsService {
  constructor(private readonly prisma: PrismaService) {}

  async readForQualification(memberId: string, tx?: PrismaTx): Promise<MemberQualificationFacts> {
    const client = tx ?? this.prisma;
    const now = new Date();
    const [members, profiles, memberships] = await Promise.all([
      client.$queryRaw<LockedMemberRow[]>(Prisma.sql`
        SELECT "gradeCode"
        FROM "Member"
        WHERE "id" = ${memberId} AND "deletedAt" IS NULL
        FOR SHARE
      `),
      client.$queryRaw<LockedProfileRow[]>(Prisma.sql`
        SELECT "genderCode", "birthDate"
        FROM "MemberProfile"
        WHERE "memberId" = ${memberId} AND "deletedAt" IS NULL
        FOR SHARE
      `),
      client.$queryRaw<LockedMembershipRow[]>(Prisma.sql`
        SELECT "organizationId"
        FROM "member_organization_memberships"
        WHERE "memberId" = ${memberId}
          AND "status" = 'ACTIVE'
          AND "deletedAt" IS NULL
          AND "startedAt" <= ${now}
          AND "endedAt" IS NULL
        ORDER BY "organizationId" ASC
        FOR SHARE
      `),
    ]);
    const activeOrganizationIds = [...new Set(memberships.map((row) => row.organizationId))].sort();
    const ancestors =
      activeOrganizationIds.length === 0
        ? []
        : await client.$queryRaw<LockedOrganizationClosureRow[]>(Prisma.sql`
            SELECT "ancestorId"
            FROM "organization_closure"
            WHERE "descendantId" IN (${Prisma.join(activeOrganizationIds)})
            ORDER BY "ancestorId" ASC
            FOR SHARE
          `);

    return {
      memberId,
      gradeCode: members[0]?.gradeCode ?? null,
      profile: profiles[0]
        ? { genderCode: profiles[0].genderCode, birthDate: profiles[0].birthDate }
        : null,
      activeOrganizationIds,
      activeOrganizationAncestorIds: [...new Set(ancestors.map((row) => row.ancestorId))].sort(),
    };
  }

  hasActiveMembershipInRequiredSubtree(
    facts: MemberQualificationFacts,
    requiredOrganizationIds: readonly string[],
  ): boolean {
    const required = new Set(requiredOrganizationIds);
    return (
      facts.activeOrganizationIds.some((organizationId) => required.has(organizationId)) ||
      facts.activeOrganizationAncestorIds.some((organizationId) => required.has(organizationId))
    );
  }
}

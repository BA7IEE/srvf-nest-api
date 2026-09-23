import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityContributionPolicyCommand } from './activity-contribution-policy-command';
import {
  presentContributionPolicy,
  presentContributionPolicyVersion,
  presentContributionPolicyVersionSummary,
} from './activity-contribution-policy-presenter';
import type {
  SystemListContributionPoliciesQueryDto,
  SystemListContributionPolicyVersionsQueryDto,
} from './dto/system/contribution-policy.dto';

const READ_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 2000,
  timeout: 5000,
} as const;

const SUMMARY_SELECT = {
  id: true,
  policyId: true,
  version: true,
  schemaVersion: true,
  evaluatorVersion: true,
  definitionHash: true,
  effectiveFrom: true,
  effectiveUntil: true,
  statusCode: true,
  activatedAt: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContributionPolicyVersionSelect;

@Injectable()
export class ActivityContributionPolicyCatalogueQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityContributionPolicyCommand,
  ) {}
  list(query: SystemListContributionPoliciesQueryDto, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'contribution-policy.read.catalog');
      const { page, pageSize } = query;
      const where = { code: query.code };
      const rows = await tx.contributionPolicy.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const total = await tx.contributionPolicy.count({ where });
      return { items: rows.map(presentContributionPolicy), total, page, pageSize };
    }, READ_TRANSACTION);
  }
  get(id: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'contribution-policy.read.catalog');
      const row = await tx.contributionPolicy.findFirst({ where: { id } });
      if (!row) throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
      return presentContributionPolicy(row);
    }, READ_TRANSACTION);
  }
  listVersions(
    id: string,
    query: SystemListContributionPolicyVersionsQueryDto,
    user: CurrentUserPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'contribution-policy.read.catalog');
      const { page, pageSize } = query;
      // One bounded statement distinguishes an absent policy from an empty version page.
      const counts = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT (SELECT count(*) FROM "ContributionPolicyVersion" v WHERE v."policyId" = p."id"
          ${query.statusCode === undefined ? Prisma.empty : Prisma.sql`AND v."statusCode" = ${query.statusCode}`}) AS total
        FROM "ContributionPolicy" p WHERE p."id" = ${id}`);
      if (counts.length === 0)
        throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
      const rows = await tx.contributionPolicyVersion.findMany({
        where: { policyId: id, statusCode: query.statusCode },
        select: SUMMARY_SELECT,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      });
      return {
        items: rows.map(presentContributionPolicyVersionSummary),
        total: Number(counts[0].total),
        page,
        pageSize,
      };
    }, READ_TRANSACTION);
  }
  getVersion(id: string, versionId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'contribution-policy.read.catalog');
      const row = await tx.contributionPolicyVersion.findFirst({
        where: { id: versionId, policyId: id },
      });
      if (!row) throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND);
      return presentContributionPolicyVersion(row);
    }, READ_TRANSACTION);
  }
}

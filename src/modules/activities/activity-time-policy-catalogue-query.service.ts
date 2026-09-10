import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimePolicyCommand } from './activity-time-policy-command';
import {
  presentTimePolicy,
  presentTimePolicyVersion,
  presentTimePolicyVersionSummary,
} from './activity-time-policy-presenter';
import type {
  AdminListTimePoliciesQueryDto,
  AdminListTimePolicyVersionsQueryDto,
} from './dto/admin/activity-time-policy.dto';

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
} satisfies Prisma.TimePolicyVersionSelect;

@Injectable()
export class ActivityTimePolicyCatalogueQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityTimePolicyCommand,
  ) {}
  list(query: AdminListTimePoliciesQueryDto, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-time-policy.read.catalog');
      const { page, pageSize } = query;
      const where = { code: query.code };
      const rows = await tx.timePolicy.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const total = await tx.timePolicy.count({ where });
      return { items: rows.map(presentTimePolicy), total, page, pageSize };
    });
  }
  get(id: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-time-policy.read.catalog');
      const row = await tx.timePolicy.findFirst({ where: { id } });
      if (!row) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
      return presentTimePolicy(row);
    });
  }
  listVersions(id: string, query: AdminListTimePolicyVersionsQueryDto, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-time-policy.read.catalog');
      const { page, pageSize } = query;
      // One bounded statement distinguishes an absent policy from an empty version page.
      const counts = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT (SELECT count(*) FROM "TimePolicyVersion" v WHERE v."policyId" = p."id"
          ${query.statusCode === undefined ? Prisma.empty : Prisma.sql`AND v."statusCode" = ${query.statusCode}`}) AS total
        FROM "TimePolicy" p WHERE p."id" = ${id}`);
      if (counts.length === 0) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
      const rows = await tx.timePolicyVersion.findMany({
        where: { policyId: id, statusCode: query.statusCode },
        select: SUMMARY_SELECT,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      });
      return {
        items: rows.map(presentTimePolicyVersionSummary),
        total: Number(counts[0].total),
        page,
        pageSize,
      };
    });
  }
  getVersion(id: string, versionId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-time-policy.read.catalog');
      const row = await tx.timePolicyVersion.findFirst({ where: { id: versionId, policyId: id } });
      if (!row) throw new BizException(BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND);
      return presentTimePolicyVersion(row);
    });
  }
}

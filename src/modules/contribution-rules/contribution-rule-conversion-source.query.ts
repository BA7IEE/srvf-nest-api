import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface ContributionRuleConversionSource {
  id: string;
  activityTypeCode: string;
  attendanceRoleCode: string;
  durationThreshold: string | null;
  pointsBelow: string;
  pointsAbove: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  deletedAt: null;
  updatedAt: string;
}

@Injectable()
export class ContributionRuleConversionSourceQuery {
  async readActiveSources(
    tx: Prisma.TransactionClient,
    activityTypeCode: string,
  ): Promise<ContributionRuleConversionSource[]> {
    const rows = await tx.contributionRule.findMany({
      where: { activityTypeCode, status: 'ACTIVE', deletedAt: null },
      orderBy: [{ attendanceRoleCode: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        activityTypeCode: true,
        attendanceRoleCode: true,
        durationThreshold: true,
        pointsBelow: true,
        pointsAbove: true,
        status: true,
        deletedAt: true,
        updatedAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      activityTypeCode: row.activityTypeCode,
      attendanceRoleCode: row.attendanceRoleCode,
      durationThreshold: row.durationThreshold?.toString() ?? null,
      pointsBelow: row.pointsBelow.toString(),
      pointsAbove: row.pointsAbove?.toString() ?? null,
      status: row.status,
      deletedAt: null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

import { Injectable } from '@nestjs/common';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { ACTIVITY_REGISTRATION_STATUS } from './activity-registration-state-machine';

export interface WaitlistPositionInput {
  id: string;
  activityId: string;
  statusCode: string;
  registeredAt: Date;
}

// 候补排位只读 QueryService。列表按页面内 activityId 一次批量取完整候补队列，禁止逐 item
// 查询；详情用一个 count 计算当前行之前的 live 候补数。排序口径固定 registeredAt ASC,id ASC。
@Injectable()
export class ActivityRegistrationWaitlistQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getPosition(row: WaitlistPositionInput): Promise<number | null> {
    if (row.statusCode !== ACTIVITY_REGISTRATION_STATUS.WAITLISTED) return null;
    const ahead = await this.prisma.activityRegistration.count({
      where: notDeletedWhere({
        activityId: row.activityId,
        statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
        OR: [
          { registeredAt: { lt: row.registeredAt } },
          { registeredAt: row.registeredAt, id: { lt: row.id } },
        ],
      }),
    });
    return ahead + 1;
  }

  async getPositions(rows: WaitlistPositionInput[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>(rows.map((row) => [row.id, null]));
    const activityIds = [
      ...new Set(
        rows
          .filter((row) => row.statusCode === ACTIVITY_REGISTRATION_STATUS.WAITLISTED)
          .map((row) => row.activityId),
      ),
    ];
    if (activityIds.length === 0) return result;

    const queue = await this.prisma.activityRegistration.findMany({
      where: notDeletedWhere({
        activityId: { in: activityIds },
        statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
      }),
      select: { id: true, activityId: true },
      orderBy: [{ activityId: 'asc' }, { registeredAt: 'asc' }, { id: 'asc' }],
    });

    const nextByActivity = new Map<string, number>();
    for (const item of queue) {
      const position = (nextByActivity.get(item.activityId) ?? 0) + 1;
      nextByActivity.set(item.activityId, position);
      if (result.has(item.id)) result.set(item.id, position);
    }
    return result;
  }
}

import { Injectable } from '@nestjs/common';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { ACTIVITY_REGISTRATION_STATUS } from './activity-registration-state-machine';

export interface WaitlistPositionInput {
  id: string;
  activityId: string;
  activityPositionId?: string | null;
  statusCode: string;
  registeredAt: Date;
}

function activityPositionQueueKey(activityId: string, activityPositionId: string | null): string {
  return `${activityId}\u0000${activityPositionId ?? ''}`;
}

// 候补排位只读 QueryService。列表按页面内 activityId 一次批量取完整候补集，再按
// (activityId,activityPositionId) 分队列编号，禁止逐 item 查询；详情 count 同样限定该组合键。
// 排序口径固定 registeredAt ASC,id ASC；activityPositionId=null 是无岗位活动旧队列。
@Injectable()
export class ActivityRegistrationWaitlistQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getPosition(row: WaitlistPositionInput): Promise<number | null> {
    if (row.statusCode !== ACTIVITY_REGISTRATION_STATUS.WAITLISTED) return null;
    const activityPositionId =
      row.activityPositionId === undefined
        ? ((
            await this.prisma.activityRegistration.findUnique({
              where: { id: row.id },
              select: { activityPositionId: true },
            })
          )?.activityPositionId ?? null)
        : row.activityPositionId;
    const ahead = await this.prisma.activityRegistration.count({
      where: notDeletedWhere({
        activityId: row.activityId,
        activityPositionId,
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
      select: { id: true, activityId: true, activityPositionId: true },
      orderBy: [
        { activityId: 'asc' },
        { activityPositionId: 'asc' },
        { registeredAt: 'asc' },
        { id: 'asc' },
      ],
    });

    const nextByActivityPosition = new Map<string, number>();
    for (const item of queue) {
      const activityPositionKey = activityPositionQueueKey(
        item.activityId,
        item.activityPositionId,
      );
      const waitlistPosition = (nextByActivityPosition.get(activityPositionKey) ?? 0) + 1;
      nextByActivityPosition.set(activityPositionKey, waitlistPosition);
      if (result.has(item.id)) result.set(item.id, waitlistPosition);
    }
    return result;
  }
}

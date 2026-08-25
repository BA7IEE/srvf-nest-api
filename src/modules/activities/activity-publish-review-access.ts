import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

/**
 * 发布审核事务原语:Activity 行锁、提案快照构建、可发布性不变量与受众标签解析。
 *
 * 刻意做成**纯 tx 函数**(沿 auth-session-lock / wecom-identity-revoke 范式),不做 @Injectable:
 * 全部以调用方的 `tx` 为入参、自身不持 PrismaService,因此不产生隐式锁序、
 * 也不把事务所有权从 application service 下放。
 *
 * ⚠️ 锁序恒为 Activity → review(见 activities/CLAUDE.md);本文件只提供 Activity 侧的锁原语,
 * review 行锁留在主服务,避免调用方误以为两把锁可以任意顺序取。
 */
export type PrismaTx = Prisma.TransactionClient;

export const DICT_TYPE_MEMBER_AUDIENCE_TAG = 'member_audience_tag';

export async function lockActivity(activityId: string, tx: PrismaTx): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Activity"
    WHERE id = ${activityId} AND "deletedAt" IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
}

export async function buildProposalSnapshot(
  activityId: string,
  tx: PrismaTx,
): Promise<Prisma.InputJsonValue> {
  const row = await tx.activity.findUniqueOrThrow({
    where: { id: activityId },
    select: {
      title: true,
      activityTypeCode: true,
      organizationId: true,
      startAt: true,
      endAt: true,
      location: true,
      description: true,
      capacity: true,
      genderRequirementCode: true,
      registrationDeadline: true,
      registrationNotes: true,
      isPublicRegistration: true,
      requiresInsurance: true,
      registrationSchema: true,
      coverImageUrl: true,
      galleryImageUrls: true,
      content: true,
      locationLongitude: true,
      locationLatitude: true,
      activityPositions: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          attendanceRoleCode: true,
          capacity: true,
          startAt: true,
          endAt: true,
          genderRequirementCode: true,
          description: true,
          sortOrder: true,
        },
      },
    },
  });
  ensureProposalInvariants(row);
  const { activityPositions, ...activity } = row;
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      activity,
      positions: activityPositions.map(({ id, ...position }) => ({
        activityPositionId: id,
        clientRef: null,
        ...position,
      })),
    }),
  ) as Prisma.InputJsonValue;
}

export function ensureProposalInvariants(activity: {
  startAt: Date;
  endAt: Date;
  capacity: number | null;
  registrationDeadline: Date | null;
  activityPositions: Array<{
    startAt: Date | null;
    endAt: Date | null;
    capacity: number | null;
  }>;
}): void {
  if (activity.startAt.getTime() >= activity.endAt.getTime()) {
    throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
  }
  if (
    activity.registrationDeadline &&
    activity.registrationDeadline.getTime() > activity.endAt.getTime()
  ) {
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
  }
  for (const position of activity.activityPositions) {
    if ((position.startAt === null) !== (position.endAt === null)) {
      throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
    }
    if (
      position.startAt &&
      position.endAt &&
      (position.startAt.getTime() >= position.endAt.getTime() ||
        position.startAt.getTime() < activity.startAt.getTime() ||
        position.endAt.getTime() > activity.endAt.getTime())
    ) {
      throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
    }
  }
  if (activity.capacity !== null && activity.activityPositions.length > 0) {
    if (activity.activityPositions.some((position) => position.capacity === null)) {
      throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
    }
    const total = activity.activityPositions.reduce(
      (sum, position) => sum + (position.capacity ?? 0),
      0,
    );
    if (total > activity.capacity) {
      throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
    }
  }
}

export function ensureInitialPublishable(activity: {
  statusCode: string;
  startAt: Date;
  endAt: Date;
  registrationDeadline: Date | null;
}): void {
  if (activity.statusCode !== 'draft') {
    throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
  }
  if (activity.startAt.getTime() >= activity.endAt.getTime()) {
    throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
  }
  if (
    activity.registrationDeadline &&
    activity.registrationDeadline.getTime() > activity.endAt.getTime()
  ) {
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
  }
  const now = Date.now();
  if (activity.endAt.getTime() <= now) {
    throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
  }
  if (activity.registrationDeadline && activity.registrationDeadline.getTime() < now) {
    throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
  }
}

export async function resolveActiveAudienceTagIds(
  tx: PrismaTx,
  audienceTagCodes: string[],
): Promise<string[]> {
  if (audienceTagCodes.length === 0) return [];
  const type = await tx.dictType.findFirst({
    where: {
      code: DICT_TYPE_MEMBER_AUDIENCE_TAG,
      status: DictTypeStatus.ACTIVE,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!type) throw new BizException(BizCode.BAD_REQUEST);
  const tags = await tx.dictItem.findMany({
    where: {
      typeId: type.id,
      code: { in: audienceTagCodes },
      status: DictItemStatus.ACTIVE,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (tags.length !== audienceTagCodes.length) throw new BizException(BizCode.BAD_REQUEST);
  return tags.map((tag) => tag.id);
}

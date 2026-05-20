import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AppAvailableActivityListItemDto } from './dto/app/app-available-activity-list-item.dto';

// Phase 2 P2-4a App /api/app/v1/activities/available 列表 service。
// 沿 docs/app-api-p2-4-activities-review.md §8.2 决议 D-P2-4-4 = 方案 B:
// **新建** AppActivitiesService(不复用 ActivitiesService.list / findOne);
// 私有 mapper toListItemDto(不新建独立 AppActivityPresenter class;沿 Phase 0.7 §13.3 P0/P1 过渡)。
//
// 铁律(沿评审稿 §6.5 + §8.3 + §13 风险表):
// - where 固定 `notDeletedWhere({ statusCode: 'published' })`;**不**接收任何 role / status 入参短路
// - select 严格 appActivityListItemSelect(11 字段;沿评审稿 §4.1 锁定);从 SQL 源头切断字段泄漏
// - canUseApp 校验由 Controller 完成(沿评审稿 §6.1);Service 入参 memberId 已通过准入
// - 不 import ActivitiesService / ActivityRegistrationsService / Prisma.activityRegistration.*
//   (沿评审稿 §16.3 + §13.13 风险点)

// 列表精简 select(沿评审稿 §8.3 + §4.1 v0.1 锁定 11 项)。
// **不** select:description / organizationId / genderRequirementCode / isPublicRegistration /
// registrationNotes / registrationSchema / galleryImageUrls / content /
// locationLongitude / locationLatitude / updatedAt / 任何 audit 字段。
const appActivityListItemSelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  statusCode: true,
  startAt: true,
  endAt: true,
  location: true,
  capacity: true,
  registrationDeadline: true,
  coverImageUrl: true,
  createdAt: true,
} as const satisfies Prisma.ActivitySelect;

type AppActivityListRow = Prisma.ActivityGetPayload<{ select: typeof appActivityListItemSelect }>;

@Injectable()
export class AppActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  // 入参 memberId 在 v0.1 实际**未参与 where 过滤**(沿评审稿 §6.5 + §8.3):published
  // 活动池对全员相同。保留 memberId 入参为后续 P2-5+ 若引入"已报名活动从列表排除"留扩展槽,
  // 同时保留调用链显式语义(列表是 App self perspective)。
  async listAvailableForMember(
    _memberId: string,
    query: PaginationQueryDto,
  ): Promise<PageResultDto<AppAvailableActivityListItemDto>> {
    const { page, pageSize } = query;
    const where = notDeletedWhere({ statusCode: 'published' });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: appActivityListItemSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // 私有 mapper(沿评审稿 §8.3.3;第一版不抽独立 Presenter class)。
  private toListItemDto(row: AppActivityListRow): AppAvailableActivityListItemDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      statusCode: row.statusCode,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      capacity: row.capacity,
      registrationDeadline: row.registrationDeadline,
      coverImageUrl: row.coverImageUrl,
      createdAt: row.createdAt,
    };
  }
}

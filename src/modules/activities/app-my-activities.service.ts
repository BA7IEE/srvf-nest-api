import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { AppMyActivityListItemDto } from './dto/app/app-my-activity-list-item.dto';
import { ListAppMyActivitiesQueryDto } from './dto/app/list-app-my-activities-query.dto';

// Phase 2 P2-5a App /api/app/v1/my/activities 汇总 service。
// 沿 docs/app-api-p2-5-registrations-review.md §11 + §16.B.1 默认锁定方案 A(两阶段查询)。
//
// 语义(沿 §11.1):
//   "我已建立 registration 关系的活动汇总"。每个活动一行,含本人在该活动的**最新有效**
//   registration 摘要(派生取值优先级 active > reject > cancelled,沿 §11.2)。
//   活动 statusCode 可包含全 4 态(draft / published / cancelled / completed);
//   本人在活动 published 时报过名,活动后续被 cancelled / completed,该 registration
//   仍是有效"我的活动"关系。
//
// 方案 A 两阶段查询(沿 §11.3):
//   Stage 1:按 (memberId, deletedAt=null, [optional statusCode filter]) groupBy activityId
//           + 关联 Activity.deletedAt=null 过滤(避免孤儿 registration 进汇总);
//           total = distinct activityId 数;current page distinct activityId 集合按
//           _max(createdAt) DESC 排序 + 分页。
//   Stage 2:对当前页 activityIds 同时拿 Activity 详情 + 全部本人有效 registration;
//           内存内按 §11.2 优先级算法挑选最新有效 registration。
//
// 铁律(沿评审稿 §6.5 + §8.3 + §11.6 + §14.7):
//   - where 永远含 `memberId = currentUser.memberId`(由调用方 controller / 薄壳传入);
//     **禁止** role 短路;**禁止** scope=all
//   - 列表 select 严格 11 字段(`appMyActivityListItemActivitySelect`),与 P2-4 不同字段
//   - **不**查 attendance / certificates / 出勤摘要 / 证书摘要(沿 §15.1 + §14.14)
//   - **不**做 N+1:Stage 2 单次 IN 查 activities + 单次 IN 查 registrations
@Injectable()
export class AppMyActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  // 11 字段 + activity.id(用作 IN 查询 + Map key)= select 12 字段(activityId 通过
  // Activity.id 在 mapper 里改名为 activityId);严格沿评审稿 §8.2.3 锁定。
  // **不** select description / capacity / registrationDeadline / registrationNotes /
  // registrationSchema / galleryImageUrls / content / locationLongitude /
  // locationLatitude / organizationId / genderRequirementCode / isPublicRegistration /
  // publishedBy* / cancelledBy* / 任何 audit / updatedAt。
  private static readonly activitySelect = {
    id: true,
    title: true,
    activityTypeCode: true,
    statusCode: true,
    startAt: true,
    endAt: true,
    location: true,
    coverImageUrl: true,
  } as const satisfies Prisma.ActivitySelect;

  // 仅 mapper / 优先级算法需要的字段;**不** select activity (避免 N+1 join);
  // 父 activity 走 Stage 2 单次 IN 查询。
  private static readonly registrationSelect = {
    id: true,
    activityId: true,
    statusCode: true,
    registeredAt: true,
    createdAt: true,
  } as const satisfies Prisma.ActivityRegistrationSelect;

  async listForMember(
    memberId: string,
    query: ListAppMyActivitiesQueryDto,
  ): Promise<PageResultDto<AppMyActivityListItemDto>> {
    const { page, pageSize, registrationStatusCode } = query;

    // Stage 1:groupBy activityId,本人有效 registration + Activity 未软删 + 可选 status filter
    const filterWhere: Prisma.ActivityRegistrationWhereInput = {
      memberId,
      deletedAt: null,
      activity: { deletedAt: null },
      ...(registrationStatusCode !== undefined ? { statusCode: registrationStatusCode } : {}),
    };

    // 1a:total distinct activityIds(沿 PageResultDto.total 语义)
    const totalGroups = await this.prisma.activityRegistration.groupBy({
      by: ['activityId'],
      where: filterWhere,
    });
    const total = totalGroups.length;

    // 1b:当前页 distinct activityIds,按本人最新 registration createdAt DESC 排序
    const pagedGroups = await this.prisma.activityRegistration.groupBy({
      by: ['activityId'],
      where: filterWhere,
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const activityIds = pagedGroups.map((g) => g.activityId);

    if (activityIds.length === 0) {
      return { items: [], total, page, pageSize };
    }

    // Stage 2:并发拉 activities + 本人全部有效 registrations(当前页 activityIds 范围)
    const [activities, registrations] = await Promise.all([
      this.prisma.activity.findMany({
        where: { id: { in: activityIds }, deletedAt: null },
        select: AppMyActivitiesService.activitySelect,
      }),
      this.prisma.activityRegistration.findMany({
        where: {
          memberId,
          activityId: { in: activityIds },
          deletedAt: null,
          ...(registrationStatusCode !== undefined ? { statusCode: registrationStatusCode } : {}),
        },
        select: AppMyActivitiesService.registrationSelect,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // 内存内按 §11.2 优先级挑选 latest-valid registration per activityId:
    //   active(pending / pass) > reject > cancelled;同优先级取 createdAt DESC 最新
    //   (registrations 已 orderBy createdAt DESC,首个高优先级即胜)
    const picked = new Map<string, (typeof registrations)[number]>();
    for (const reg of registrations) {
      const existing = picked.get(reg.activityId);
      if (existing === undefined) {
        picked.set(reg.activityId, reg);
        continue;
      }
      if (
        AppMyActivitiesService.priorityOf(reg.statusCode) >
        AppMyActivitiesService.priorityOf(existing.statusCode)
      ) {
        picked.set(reg.activityId, reg);
      }
      // 同优先级或更低 → 保留 existing(已是 createdAt DESC 先到者)
    }

    const activityById = new Map(activities.map((a) => [a.id, a]));

    // 顺序保留 Stage 1 给出的 activityIds(已按 _max(createdAt) DESC 排序)。
    const items: AppMyActivityListItemDto[] = [];
    for (const activityId of activityIds) {
      const reg = picked.get(activityId);
      const act = activityById.get(activityId);
      // 兜底:activity 软删 / registration 全软删 / 数据竞态 → 静默跳过该 row;
      // total/items 可能略不一致,但语义上"该活动已不在我可见关系内",刻意收窄。
      if (reg === undefined || act === undefined) continue;
      items.push(AppMyActivitiesService.toAppListItemDto(reg, act));
    }

    return { items, total, page, pageSize };
  }

  // §11.2 取值优先级数字化:active > reject > cancelled
  private static priorityOf(statusCode: string): number {
    if (statusCode === 'pending' || statusCode === 'pass') return 3;
    if (statusCode === 'reject') return 2;
    if (statusCode === 'cancelled') return 1;
    return 0;
  }

  // 私有 mapper(沿 P2-4 §8.3.3 / 评审稿 §6.4 P0/P1 过渡;不抽独立 Presenter class)。
  private static toAppListItemDto(
    reg: Prisma.ActivityRegistrationGetPayload<{
      select: typeof AppMyActivitiesService.registrationSelect;
    }>,
    act: Prisma.ActivityGetPayload<{ select: typeof AppMyActivitiesService.activitySelect }>,
  ): AppMyActivityListItemDto {
    return {
      activityId: act.id,
      title: act.title,
      activityTypeCode: act.activityTypeCode,
      statusCode: act.statusCode,
      startAt: act.startAt,
      endAt: act.endAt,
      location: act.location,
      coverImageUrl: act.coverImageUrl,
      myRegistrationId: reg.id,
      myRegistrationStatusCode: reg.statusCode,
      myRegisteredAt: reg.registeredAt,
    };
  }
}

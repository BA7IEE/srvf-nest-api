import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AppMyActivitiesService } from '../activities/app-my-activities.service';
import { ListAppMyActivitiesQueryDto } from '../activities/dto/app/list-app-my-activities-query.dto';
import { AppMyActivityListItemDto } from '../activities/dto/app/app-my-activity-list-item.dto';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { ListMyRegistrationsQueryDto } from './activity-registrations.dto';
import { AppMyRegistrationListItemDto } from './dto/app/app-my-registration-list-item.dto';
import { AppMyRegistrationDto } from './dto/app/app-my-registration.dto';
import { ListAppMyRegistrationsQueryDto } from './dto/app/list-app-my-registrations-query.dto';

// Phase 2 P2-5a App /api/app/v1/my/* registrations 薄壳 service。
// 沿 docs/app-api-p2-5-registrations-review.md §6.4 + §16.A.7 默认锁定:
//   controller → 薄壳 service → 既有 ActivityRegistrationsService(thin-wrap)
//
// 职责(沿 §6.1 + §6.4):
//   1. 所有 endpoint 前置 AppIdentityResolver.resolve + assertCanUseApp(canUseApp=false
//      统一 FORBIDDEN=40300;沿 §7.1 + §7.3)
//   2. thin-wrap 既有 ActivityRegistrationsService.listMy / findMy(读 2 endpoint)
//   3. 委派 AppMyActivitiesService.listForMember(/my/activities)
//   4. 私有 App mapper:
//        - Admin DTO 字段集 → App DTO 字段集(沿 §8.2.1 / §8.2.2 严格白名单)
//        - 列表项二次 join Activity 拿派生字段(activityTitle / activityStartAt /
//          activityEndAt / activityCoverImageUrl;沿 §8.2.1)
//
// 铁律:
//   - **不**改 ActivityRegistrationsService 签名(沿评审稿 §6.2)
//   - **不**新增 BizCode(D-P2-5-10)
//   - admin-as-member 走 linked-member self perspective(沿 D-5.2 + §7.5);
//     **禁止** role 短路 / scope=all
//   - MEMBER_NOT_FOUND=15001 由 controller 层 AppIdentityResolver 拦截,不可触达 App
//     path(沿评审稿 §14.2 风险 + §9.1 BizCode 矩阵)
//   - 列表项**不返** memberId(§16.B.2 默认锁定)
@Injectable()
export class AppMyRegistrationsService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly registrationsService: ActivityRegistrationsService,
    private readonly appMyActivities: AppMyActivitiesService,
    private readonly prisma: PrismaService,
  ) {}

  // ============ GET /api/app/v1/my/registrations(P2-5a)============

  async listMyForApp(
    query: ListAppMyRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyRegistrationListItemDto>> {
    await this.assertCanUseAppOrThrow(currentUser);

    // thin-wrap 既有 ActivityRegistrationsService.listMy:同字段集 query DTO,沿 v2 行为
    const adminQuery: ListMyRegistrationsQueryDto = {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.statusCode !== undefined ? { statusCode: query.statusCode } : {}),
    };
    const result = await this.registrationsService.listMy(adminQuery, currentUser);

    if (result.items.length === 0) {
      return { items: [], total: result.total, page: result.page, pageSize: result.pageSize };
    }

    // 二次 join Activity 拿派生字段(沿 §8.2.1 activityTitle / activityStartAt / ...);
    // 单次 IN 查询,**不** N+1。Activity.deletedAt 不过滤:onDelete=Restrict FK 保证
    // activity row 存在;soft-delete 状态下字段仍可读,**不**暴露 deletedAt。
    const activityIds = [...new Set(result.items.map((r) => r.activityId))];
    const activities = await this.prisma.activity.findMany({
      where: { id: { in: activityIds } },
      select: AppMyRegistrationsService.listActivitySelect,
    });
    const activityById = new Map(activities.map((a) => [a.id, a]));

    const items = result.items.map((reg) =>
      AppMyRegistrationsService.toAppListItemDto(reg, activityById.get(reg.activityId)),
    );

    return { items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  // ============ GET /api/app/v1/my/registrations/:id(P2-5a)============

  async findMyForApp(id: string, currentUser: CurrentUserPayload): Promise<AppMyRegistrationDto> {
    await this.assertCanUseAppOrThrow(currentUser);
    // thin-wrap 既有 findMy(owner 校验 + 404 防侧信道沿现状)
    const reg = await this.registrationsService.findMy(id, currentUser);
    return AppMyRegistrationsService.toAppDetailDto(reg);
  }

  // ============ GET /api/app/v1/my/activities(P2-5a)============

  async listMyActivitiesForApp(
    query: ListAppMyActivitiesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyActivityListItemDto>> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return this.appMyActivities.listForMember(access.member.id, query);
  }

  // ============ 内部 helpers ============

  // 沿 §7.1 / §7.3 准入硬约束:canUseApp=false → FORBIDDEN(member 未关联 / INACTIVE /
  // 软删 / Admin 无 member 全部统一 403);**不**沿 P2-3 admin-without-member 例外
  // (沿 §7.4 / D-P2-3-1 严格仅限 /me/password)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<void> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  // 列表项二次 join 用的 Activity 精简 select(沿 §8.2.1 派生字段集)。
  // **不** select:description / capacity / registrationDeadline / registrationNotes /
  // organizationId / 任何 audit / publishedBy* / cancelledBy* / deletedAt。
  private static readonly listActivitySelect = {
    id: true,
    title: true,
    startAt: true,
    endAt: true,
    coverImageUrl: true,
  } as const satisfies Prisma.ActivitySelect;

  // 私有 mapper(沿 §6.4 + P2-4 §8.3.3 P0/P1 过渡;不抽独立 Presenter class)。
  // **删除** admin DTO 字段:memberId / memberNo / memberDisplayName(沿 §8.2.1 / §16.B.2)。
  // **追加** 派生字段:activityTitle / activityStartAt / activityEndAt / activityCoverImageUrl。
  private static toAppListItemDto(
    reg: {
      id: string;
      activityId: string;
      statusCode: string;
      registeredAt: Date;
      reviewedAt: Date | null;
      cancelledAt: Date | null;
      createdAt: Date;
    },
    act:
      | Prisma.ActivityGetPayload<{
          select: typeof AppMyRegistrationsService.listActivitySelect;
        }>
      | undefined,
  ): AppMyRegistrationListItemDto {
    return {
      id: reg.id,
      activityId: reg.activityId,
      activityTitle: act?.title ?? '',
      activityStartAt: act?.startAt ?? reg.createdAt,
      activityEndAt: act?.endAt ?? reg.createdAt,
      activityCoverImageUrl: act?.coverImageUrl ?? null,
      statusCode: reg.statusCode,
      registeredAt: reg.registeredAt,
      reviewedAt: reg.reviewedAt,
      cancelledAt: reg.cancelledAt,
      createdAt: reg.createdAt,
    };
  }

  // 详情 mapper(沿 §8.2.2 严格 11 字段;**删除** memberId / reviewedBy /
  // cancelledByUserId,沿 §16.B.2 + §8.2.2 字段表)。
  private static toAppDetailDto(reg: {
    id: string;
    activityId: string;
    statusCode: string;
    registeredAt: Date;
    reviewedAt: Date | null;
    reviewNote: string | null;
    extras: Record<string, unknown> | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): AppMyRegistrationDto {
    return {
      id: reg.id,
      activityId: reg.activityId,
      statusCode: reg.statusCode,
      registeredAt: reg.registeredAt,
      reviewedAt: reg.reviewedAt,
      reviewNote: reg.reviewNote,
      extras: reg.extras,
      cancelledAt: reg.cancelledAt,
      cancelReason: reg.cancelReason,
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AppMyActivitiesService } from '../activities/app-my-activities.service';
import { ListAppMyActivitiesQueryDto } from '../activities/dto/app/list-app-my-activities-query.dto';
import { AppMyActivityListItemDto } from '../activities/dto/app/app-my-activity-list-item.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { ActivityRegistrationWaitlistQueryService } from './activity-registration-waitlist-query.service';
import { ListMyRegistrationsQueryDto } from './activity-registrations.dto';
import { AppMyRegistrationListItemDto } from './dto/app/app-my-registration-list-item.dto';
import { AppMyRegistrationDto } from './dto/app/app-my-registration.dto';
import { CancelAppMyRegistrationDto } from './dto/app/cancel-app-my-registration.dto';
import { CreateAppMyRegistrationDto } from './dto/app/create-app-my-registration.dto';
import { ListAppMyRegistrationsQueryDto } from './dto/app/list-app-my-registrations-query.dto';
import {
  ActivityImageSigningService,
  type ActivitySignedCover,
} from '../activities/activity-image-signing.service';

// Phase 2 P2-5a App /api/app/v1/my/* registrations 薄壳 service。
// 沿历史评审稿 docs/archive/reviews/app-api-p2-5-registrations-review.md
// §6.4 + §16.A.7 默认锁定:
//   controller → 薄壳 service → 既有 ActivityRegistrationsService(thin-wrap)
//
// 职责(沿同评审稿 §6.1 + §6.4):
//   1. 所有 endpoint 前置 AppIdentityResolver.resolve + assertCanUseApp(canUseApp=false
//      统一 FORBIDDEN=40300;沿同评审稿 §7.1 + §7.3)
//   2. thin-wrap 既有 ActivityRegistrationsService.listMy / findMy(读 2 endpoint)
//   3. 委派 AppMyActivitiesService.listForMember(/my/activities)
//   4. 私有 App mapper:
//        - Admin DTO 字段集 → App DTO 字段集(沿同评审稿 §8.2.1 / §8.2.2 严格白名单)
//        - 列表项二次 join Activity 拿派生字段(activityTitle / activityStartAt /
//          activityEndAt / activityCoverImageUrl;沿同评审稿 §8.2.1)
//
// 铁律:
//   - **不**改 ActivityRegistrationsService 签名(沿评审稿 §6.2)
//   - **不**新增 BizCode(D-P2-5-10)
//   - admin-as-member 走 linked-member self perspective(沿 D-5.2 + 同评审稿 §7.5);
//     **禁止** role 短路 / scope=all
//   - MEMBER_NOT_FOUND=15001 由 controller 层 AppIdentityResolver 拦截,不可触达 App
//     path(沿评审稿 §14.2 风险 + §9.1 BizCode 矩阵)
//   - 列表项**不返** memberId(同评审稿 §16.B.2 默认锁定)
@Injectable()
export class AppMyRegistrationsService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly registrationsService: ActivityRegistrationsService,
    private readonly appMyActivities: AppMyActivitiesService,
    private readonly prisma: PrismaService,
    private readonly waitlistQuery: ActivityRegistrationWaitlistQueryService,
    // P2-14 刀 A:活动封面现签。
    private readonly images: ActivityImageSigningService,
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

    // 二次 join Activity 拿派生字段
    // (沿同评审稿 §8.2.1 activityTitle / activityStartAt / ...);
    // 单次 IN 查询,**不** N+1。Activity.deletedAt 不过滤:onDelete=Restrict FK 保证
    // activity row 存在;soft-delete 状态下字段仍可读,**不**暴露 deletedAt。
    const activityIds = [...new Set(result.items.map((r) => r.activityId))];
    const activities = await this.prisma.activity.findMany({
      where: { id: { in: activityIds } },
      select: AppMyRegistrationsService.listActivitySelect,
    });
    const activityById = new Map(activities.map((a) => [a.id, a]));

    // P2-14 刀 A:mapper 是 static(拿不到 this.images),故签名在调用方解析后当入参传入
    // (与 activity-presenter / AppMyActivitiesService 同一处置)。
    const items = await Promise.all(
      result.items.map(async (reg) => {
        const act = activityById.get(reg.activityId);
        const cover =
          act === undefined ? { coverImageUrl: null } : await this.images.signCover(act);
        return AppMyRegistrationsService.toAppListItemDto(reg, act, cover);
      }),
    );

    return { items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  // ============ GET /api/app/v1/my/registrations/:id(P2-5a)============

  async findMyForApp(id: string, currentUser: CurrentUserPayload): Promise<AppMyRegistrationDto> {
    await this.assertCanUseAppOrThrow(currentUser);
    // thin-wrap 既有 findMy(owner 校验 + 404 防侧信道沿现状)
    const reg = await this.registrationsService.findMy(id, currentUser);
    const waitlistPosition = await this.waitlistQuery.getPosition(reg);
    return AppMyRegistrationsService.toAppDetailDto(reg, waitlistPosition);
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

  // ============ POST /api/app/v1/my/registrations(P2-5b)============
  //
  // 沿同一历史评审稿 §6.4 + §9.3 + §16.B.6 默认锁定方案 B:
  //   1. 准入:`assertCanUseAppOrThrow`(沿同评审稿 §7.1 + §7.3;canUseApp=false → 403)
  //   2. **薄壳内 inline** `assertActivityPublishedOrThrow`
  //      (沿 D-P2-5-8 + 同评审稿 §9.3):
  //      只有 published 活动可报名,其它(draft / cancelled / completed / 软删 / 不存在)
  //      **统一抛** ACTIVITY_NOT_FOUND=20001 / 404 防侧信道(沿 P2-4 D-P2-4-3 范式)
  //   3. thin-wrap 既有 `ActivityRegistrationsService.createMy`(沿同评审稿 §6.2 不改签名):
  //      事务内 resolveUserMemberIdOrThrow + assertActivityRegistrable(剩余只触发 20120)
  //      + 容量判定 + assertNoActiveRegistration + create + audit。
  //      ⚠️ 并发审计 S5 收口(2026-07-31):这里原写「assertCapacityNotExceeded」,
  //      是候补上线前的旧口径。**满员不再报错**,而是落 `waitlisted` 等递补
  //      (见 activity-registrations/CLAUDE.md「不恢复 create 满员报错」)。
  //   4. 出参经私有 mapper 转 AppMyRegistrationDto
  //      (沿同评审稿 §8.2.2 字段集 11 项不返 memberId)
  //
  // 铁律:
  //   - **不**改 ActivityRegistrationsService 公共 API
  //     (沿同评审稿 §6.2 + §16.B.6 方案 B)
  //   - **不**新增 BizCode(沿 D-P2-5-10)
  //   - **不**新增 audit event(沿同评审稿 §12.1 复用 registration.create + viaPath='self')
  //   - admin-as-member 走 linked-member self perspective(沿 D-5.2 + 同评审稿 §7.5);
  //     既有 createMy 内 resolveUserMemberIdOrThrow 用 currentUser.id 锁本人,
  //     **禁止** role 短路 / 接收 body memberId(DTO 严格白名单已挡)
  async createMyForApp(
    currentUser: CurrentUserPayload,
    dto: CreateAppMyRegistrationDto,
    auditMeta: AuditMeta,
  ): Promise<AppMyRegistrationDto> {
    await this.assertCanUseAppOrThrow(currentUser);
    await this.assertActivityPublishedOrThrow(dto.activityId);

    // thin-wrap 既有 createMy(沿同评审稿 §6.2 不改签名);extras 可选透传
    const reg = await this.registrationsService.createMy(
      dto.activityId,
      {
        ...(dto.activityPositionId !== undefined
          ? { activityPositionId: dto.activityPositionId }
          : {}),
        ...(dto.extras !== undefined ? { extras: dto.extras } : {}),
      },
      currentUser,
      auditMeta,
    );
    const waitlistPosition = await this.waitlistQuery.getPosition(reg);
    return AppMyRegistrationsService.toAppDetailDto(reg, waitlistPosition);
  }

  // ============ PATCH /api/app/v1/my/registrations/:id/cancel(P2-5b)============
  //
  // 沿评审稿 §10.2 状态机 + §7.7 owner 校验 + §12.1 audit:
  //   1. 准入:`assertCanUseAppOrThrow`(沿同评审稿 §7.1)
  //   2. thin-wrap 既有 `ActivityRegistrationsService.cancelMy`(沿同评审稿 §6.2):
  //      事务内:resolveUserMemberIdOrThrow + 反查 registration(本人 + 未软删) →
  //      404 防侧信道(他人 / 不存在 / 软删统一 ACTIVITY_REGISTRATION_NOT_FOUND=21001)→
  //      状态机校验 pending|pass|waitlisted → cancelled,其它态 → ACTIVITY_REGISTRATION_STATUS_INVALID=21030
  //      (并发审计 S5 收口 2026-07-31:原写「仅 pending|pass」,漏了候补上线后加进来的
  //       waitlisted;合法矩阵的唯一真源始终是 `activity-registration-state-machine.ts`)
  //      + update + audit registration.review (action='cancel', cancelledByPath='self')
  //   3. 出参经私有 mapper 转 AppMyRegistrationDto
  //
  // 取消他人 / 不存在 / 软删 statusCode==reject / cancelled 全部由既有 cancelMy 兜底,
  // 与 P2-5a `findMy` 防侧信道范式对齐(沿同评审稿 §7.7)。
  async cancelMyForApp(
    currentUser: CurrentUserPayload,
    id: string,
    dto: CancelAppMyRegistrationDto,
    auditMeta: AuditMeta,
  ): Promise<AppMyRegistrationDto> {
    await this.assertCanUseAppOrThrow(currentUser);

    const reg = await this.registrationsService.cancelMy(
      id,
      { ...(dto.cancelReason !== undefined ? { cancelReason: dto.cancelReason } : {}) },
      currentUser,
      auditMeta,
    );
    return AppMyRegistrationsService.toAppDetailDto(reg, null);
  }

  // ============ 内部 helpers ============

  // 沿同评审稿 §7.1 / §7.3 准入硬约束:
  // canUseApp=false → FORBIDDEN(member 未关联 / INACTIVE /
  // 软删 / Admin 无 member 全部统一 403);**不**沿 P2-3 admin-without-member 例外
  // (沿同评审稿 §7.4 / D-P2-3-1 严格仅限 /me/password)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<void> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  // 沿 D-P2-5-8 + 同评审稿 §9.3 + §16.B.6 默认方案 B:
  // 报名前置 published 校验薄壳内 inline。
  // 非 published(draft / cancelled / completed / 软删 / 不存在)统一抛 ACTIVITY_NOT_FOUND=20001
  // 防侧信道(沿 P2-4 D-P2-4-3 范式);**不**改 ActivityRegistrationsService 公共 API。
  // 与 admin path 行为故意不同:admin POST cancelled 活动仍抛 ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN=20121,
  // App path 该 21121 因前置 ACTIVITY_NOT_FOUND 拦截**永不触达**(沿评审稿 §9.3 结果矩阵)。
  private async assertActivityPublishedOrThrow(activityId: string): Promise<void> {
    const act = await this.prisma.activity.findFirst({
      where: notDeletedWhere({ id: activityId, statusCode: 'published' }),
      select: { id: true },
    });
    if (!act) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
  }

  // 列表项二次 join 用的 Activity 精简 select(沿同评审稿 §8.2.1 派生字段集)。
  // **不** select:description / capacity / registrationDeadline / registrationNotes /
  // organizationId / 任何 audit / publishedBy* / cancelledBy* / deletedAt。
  private static readonly listActivitySelect = {
    id: true,
    title: true,
    startAt: true,
    endAt: true,
    // ⚠️ P2-14 刀 A:coverImageUrl 是裸 URL 遗留列(已零写入路径,刀 B 删);
    // 对外的 activityCoverImageUrl 由 coverImageKey 现签而来。
    coverImageKey: true,
  } as const satisfies Prisma.ActivitySelect;

  // 私有 mapper(沿同评审稿 §6.4 + P2-4 §8.3.3 P0/P1 过渡;
  // 不抽独立 Presenter class)。
  // **删除** admin DTO 字段:memberId / memberNo / memberDisplayName
  // (沿同评审稿 §8.2.1 / §16.B.2)。
  // **追加** 派生字段:activityTitle / activityStartAt / activityEndAt / activityCoverImageUrl。
  private static toAppListItemDto(
    reg: {
      id: string;
      activityId: string;
      statusCode: string;
      waitlistPosition: number | null;
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
    cover: ActivitySignedCover,
  ): AppMyRegistrationListItemDto {
    return {
      id: reg.id,
      activityId: reg.activityId,
      activityTitle: act?.title ?? '',
      activityStartAt: act?.startAt ?? reg.createdAt,
      activityEndAt: act?.endAt ?? reg.createdAt,
      activityCoverImageUrl: cover.coverImageUrl,
      statusCode: reg.statusCode,
      waitlistPosition: reg.waitlistPosition,
      registeredAt: reg.registeredAt,
      reviewedAt: reg.reviewedAt,
      cancelledAt: reg.cancelledAt,
      createdAt: reg.createdAt,
    };
  }

  // 详情 mapper(沿同评审稿 §8.2.2 基线字段集 additive 增加 waitlistPosition；
  // 仍**删除** memberId / reviewedBy / cancelledByUserId，
  // 沿同评审稿 §16.B.2 + §8.2.2 字段表)。
  private static toAppDetailDto(
    reg: {
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
    },
    waitlistPosition: number | null,
  ): AppMyRegistrationDto {
    return {
      id: reg.id,
      activityId: reg.activityId,
      statusCode: reg.statusCode,
      waitlistPosition,
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

import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { ActivityResponseDto, CreateActivityDto, UpdateActivityDto } from './activities.dto';
import { toResponseDto } from './activity-presenter';
import { ActivityImageSigningService } from './activity-image-signing.service';

export const DICT_TYPE_ACTIVITY_TYPE = 'activity_type';
export const DICT_TYPE_GENDER_REQUIREMENT = 'gender_requirement';

export const ACTIVITY_STATUS_DRAFT = 'draft';
export const ACTIVITY_STATUS_PUBLISHED = 'published';
export const ACTIVITY_STATUS_COMPLETED = 'completed';
export const ACTIVITY_STATUS_CANCELLED = 'cancelled';
export const ACTIVITY_STATUS_TERMINATED = 'terminated';

export const TERMINAL_ACTIVITY_STATUS_CODES = new Set([
  ACTIVITY_STATUS_COMPLETED,
  ACTIVITY_STATUS_CANCELLED,
  ACTIVITY_STATUS_TERMINATED,
]);
// ⚠️ P2-14 刀 A:`coverImageUrl` / `galleryImageUrls` 从本集合移出,**不是收窄权限** ——
// 它们已不再是 UpdateActivityDto 的字段(裸 URL 写入口已拆除),改由专用的
// set-cover / set-gallery 端点承接。那两个端点**刻意不加状态闸**,以逐字保留
// 「终态活动仍可改封面」这条既有行为(见 activity-cover.service.ts 文件头)。
export const TERMINAL_ACTIVITY_UPDATE_FIELDS = new Set<keyof UpdateActivityDto>([
  'description',
  'content',
  'registrationNotes',
]);

// 第 3 批第二刀：published 根活动只允许不改变执行、名额、组织、模板或状态语义的展示字段。
// title 是报名者的关键识别信息，直改必须走 change-review；这必须是显式正向闭集，任何新字段
// 默认进入 change-review，而不是随 DTO 增长悄然放行。
// ⚠️ 同上:封面 / 图集移出本闭集是因为它们已不在 UpdateActivityDto 上,
// 而**不是**「已发布活动不能再改封面」。改封面走 set-cover 端点,行为不变。
export const PUBLISHED_ACTIVITY_DISPLAY_FIELDS = [
  'description',
  'registrationNotes',
  'content',
] as const satisfies ReadonlyArray<keyof UpdateActivityDto>;
export const PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET = new Set<keyof UpdateActivityDto>(
  PUBLISHED_ACTIVITY_DISPLAY_FIELDS,
);

// USER 角色可见的状态白名单(Q-A7)。
export const USER_VISIBLE_STATUS_CODES = [
  ACTIVITY_STATUS_PUBLISHED,
  ACTIVITY_STATUS_COMPLETED,
] as const;

// 完整字段 select(永不含 deletedAt 软删内部状态)。
export const activitySafeSelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  allocationModeCode: true,
  organizationId: true,
  initiatorMemberId: true,
  workflowRevision: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  genderRequirementCode: true,
  registrationDeadline: true,
  registrationNotes: true,
  statusCode: true,
  publishedBy: true,
  publishedAt: true,
  cancelledBy: true,
  cancelledAt: true,
  cancelReason: true,
  terminatedAt: true,
  terminatedByUserId: true,
  terminationReason: true,
  cancelOperationKey: true,
  cancelRequestHash: true,
  terminateOperationKey: true,
  terminateRequestHash: true,
  isPublicRegistration: true,
  requiresInsurance: true,
  registrationModeCode: true,
  visibilityCode: true,
  defaultCheckInRadiusMeters: true,
  defaultLocationRequired: true,
  archiveWaitingDays: true,
  registrationSchema: true,
  // ⚠️ P2-14 刀 A:coverImageUrl / galleryImageUrls 是**裸 URL 遗留列**,已零写入路径。
  // 仍 select 出来只为让刀 B 删列前的读侧对照可做,**presenter 不再读它们** ——
  // 对外的 coverImageUrl / galleryImageUrls 一律由下面四个附件制列现签而来。
  coverImageUrl: true,
  galleryImageUrls: true,
  coverImageKey: true,
  coverAttachmentId: true,
  galleryImageKeys: true,
  galleryAttachmentIds: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
  createdAt: true,
  updatedAt: true,
  activityPositions: {
    where: { deletedAt: null },
    select: { capacity: true },
  },
} as const satisfies Prisma.ActivitySelect;

// 列表精简(评审稿 §5.1):不返 content / galleryImageUrls / registrationSchema /
// audit 字段(publishedBy/At / cancelledBy/At/Reason)/ registrationNotes。
export const activityListItemSelect = {
  id: true,
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
  statusCode: true,
  isPublicRegistration: true,
  requiresInsurance: true,
  // 同上:列表的 coverImageUrl 也改由 coverImageKey 现签(列表不带图集)。
  coverImageUrl: true,
  coverImageKey: true,
  locationLongitude: true,
  locationLatitude: true,
  createdAt: true,
  updatedAt: true,
  activityPositions: {
    where: { deletedAt: null },
    select: { capacity: true },
  },
} as const satisfies Prisma.ActivitySelect;

export type ActivityFullRow = Prisma.ActivityGetPayload<{ select: typeof activitySafeSelect }>;
export type ActivityListRow = Prisma.ActivityGetPayload<{ select: typeof activityListItemSelect }>;
export type PrismaTx = Prisma.TransactionClient;

// 统一通知 S4(评审稿 §6.4):活动取消通知收件人 = 仍在册报名者 —— pending(待审)+ pass(已通过)+ waitlisted(候补);
// reject / cancelled 已出局不打扰。状态字面量镜像 activity-registration-state-machine 的
// ACTIVITY_REGISTRATION_STATUS(此处刻意用字面量,避免 activities → activity-registrations 跨模块耦合)。
export const ACTIVE_REGISTRATION_STATUS_CODES = ['pending', 'pass', 'waitlisted'] as const;

/*
 * 活动路径的**共享准入与校验层**(Phase 6-B 第三域第三刀,§3.2)。
 *
 * 两类共用前置:①判权与聚合根装载(assertCanOrThrow / findActivityOrThrow /
 * lockAndFind* / lockActivityForLifecycle);②建单与改单共用的域校验
 * (字典项、组织非根、起止时间、报名截止、v1.1 草稿配置、岗位与场次时间窗内含)。
 * 它们被 read / write / status 三段共用,不先降为共享底座,被抽出的族就得 import 回主 service。
 *
 * ⚠️ 做成 @Injectable 而非纯函数是刻意的:这些方法要吃 authz / rbac / prisma。
 * 若改成纯函数、把判权**结果**当入参传,漏传一个实参 = 一条判权凭空消失,
 * 而全仓单测可以零红(6-B 第三域实测)。注入式则判权调用仍在各族自己的方法体内。
 *
 * ⚠️ 文件名刻意**不叫** policy:规则 (j) 禁止 *.policy.ts import prisma.service,
 * 而本层要查字典项 / 组织 / 岗位窗 —— 它本来就不是纯 Policy。
 */
@Injectable()
export class ActivityAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    // P2-14 刀 A:封面 / 图集对外是**现签 URL**,presenter 是纯函数不能取数,故在此解析后传入。
    private readonly images: ActivityImageSigningService,
  ) {}

  // Slow-4 T3(2026-06-11,评审稿 §3.5 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - create 无 ref(no-ref = GLOBAL-only,行为锁天然成立;scoped create 留后续批)
  //   - update/delete/publish/cancel 传 {type:'activity', id}(点动作,scoped 持有者树内可用)
  // NOT_FOUND 回退沿 PR9 范式(attendances.service.ts assertFinalReviewAuthzOrThrow):resource_not_found
  // 时退回 rbac.can 全局码判定——持码者 return(交回调用方后续 findActivityOrThrow 抛既有 ACTIVITY_NOT_FOUND,
  // 「先判权后查资源」行为锁不变),无码者 30100 防枚举。5 个写方法第一条语句调用;list / findOne 无码化
  // (仅登录)不变,Q-A7 USER 过滤逻辑原样保留。
  async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx?: PrismaTx,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // 校验 organization 存在 + 非根节点(R8 / D17)。
  async assertOrganizationValidAndNonRoot(organizationId: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const org = await client.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, parentId: true },
    });
    if (!org) {
      throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    }
    if (org.parentId === null) {
      throw new BizException(BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN);
    }
  }

  // 起止时间校验:startAt < endAt;两端均必填(Create 必填,Update 任一变化时复校)。
  assertStartEndValid(startAt: Date, endAt: Date): void {
    if (startAt.getTime() >= endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    }
  }

  assertRegistrationDeadlineValid(deadline: Date | null, endAt: Date): void {
    if (deadline !== null && deadline.getTime() > endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
  }

  assertV11DraftConfiguration(dto: CreateActivityDto | UpdateActivityDto): void {
    if (
      dto.archiveWaitingDays !== undefined &&
      (!Number.isInteger(dto.archiveWaitingDays) ||
        dto.archiveWaitingDays < 0 ||
        dto.archiveWaitingDays > 365)
    ) {
      throw new BizException(BizCode.ACTIVITY_DRAFT_CONFIGURATION_INVALID);
    }
    if (
      dto.defaultCheckInRadiusMeters !== undefined &&
      dto.defaultCheckInRadiusMeters !== null &&
      !Number.isInteger(dto.defaultCheckInRadiusMeters)
    ) {
      throw new BizException(BizCode.ACTIVITY_DRAFT_CONFIGURATION_INVALID);
    }
  }

  async assertLivePositionWindowsWithinActivity(
    activityId: string,
    activityStartAt: Date,
    activityEndAt: Date,
    tx: PrismaTx,
  ): Promise<void> {
    const positions = await tx.activityPosition.findMany({
      where: { activityId, deletedAt: null },
      select: { startAt: true, endAt: true },
    });
    const hasInvalidWindow = positions.some(({ startAt, endAt }) => {
      if ((startAt === null) !== (endAt === null)) return true;
      return (
        startAt !== null &&
        endAt !== null &&
        (startAt.getTime() < activityStartAt.getTime() || endAt.getTime() > activityEndAt.getTime())
      );
    });
    if (hasInvalidWindow) {
      throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
    }
  }

  async assertLiveSessionWindowsWithinActivity(
    activityId: string,
    activityStartAt: Date,
    activityEndAt: Date,
    tx: PrismaTx,
  ): Promise<void> {
    const sessions = await tx.activitySession.findMany({
      where: { activityId, deletedAt: null },
      select: { startAt: true, endAt: true },
    });
    const hasInvalidWindow = sessions.some(
      ({ startAt, endAt }) =>
        startAt.getTime() >= endAt.getTime() ||
        startAt.getTime() < activityStartAt.getTime() ||
        endAt.getTime() > activityEndAt.getTime(),
    );
    if (hasInvalidWindow) {
      throw new BizException(BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID);
    }
  }

  async findActivityOrThrow(id: string, tx?: PrismaTx): Promise<ActivityFullRow> {
    const client = tx ?? this.prisma;
    const found = await client.activity.findFirst({
      where: notDeletedWhere({ id }),
      select: activitySafeSelect,
    });
    if (!found) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return found;
  }

  async lockAndFindActivityOrThrow(id: string, tx: PrismaTx): Promise<ActivityFullRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${id} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return this.findActivityOrThrow(id, tx);
  }

  /**
   * 只给同 aggregate 内的生命周期编排复用：锁顺序、软删过滤与完整旧取消快照必须
   * 与 Admin cancel 走同一条路径。它不做判权；调用方必须先在同一 tx 内完成自己的
   * 发起人／负责人锚校验。
   */
  async lockActivityForLifecycle(id: string, tx: PrismaTx): Promise<ActivityFullRow> {
    return this.lockAndFindActivityOrThrow(id, tx);
  }

  /**
   * App 草稿侧的归属锚只有发起人字段。责任行在发布时才由既有发布链建立，
   * 因此这里不能回退到 responsibilityAssignments，也不能把越权活动暴露成 403。
   */
  async lockAndFindManagedActivityOrThrow(
    id: string,
    currentUser: CurrentUserPayload,
    tx: PrismaTx,
  ): Promise<ActivityFullRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${id} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const found = await tx.activity.findFirst({
      where: notDeletedWhere({
        id,
        ...(currentUser.role === Role.SUPER_ADMIN
          ? {}
          : { initiatorMemberId: currentUser.memberId ?? '__missing_member__' }),
      }),
      select: activitySafeSelect,
    });
    if (!found) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return found;
  }

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<ActivityResponseDto> {
    const row = await this.findActivityOrThrow(id);

    // Q-A7:USER 看 draft / cancelled → 404(避免存在性泄漏)。
    if (
      currentUser.role === Role.USER &&
      !USER_VISIBLE_STATUS_CODES.includes(
        row.statusCode as (typeof USER_VISIBLE_STATUS_CODES)[number],
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }

    return toResponseDto(row, await this.images.signImages(row));
  }
}

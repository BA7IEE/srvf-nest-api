import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DictItemStatus, DictTypeStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import {
  ActivityListItemDto,
  ActivityOptionItemDto,
  ActivityOptionsQueryDto,
  ActivityOptionsResponseDto,
  ActivityResponseDto,
  CancelActivityDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  PublishActivityDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { deriveEffectiveActivityCapacity } from './activity-capacity';
import { ACTIVITY_PHASE_ENDED, deriveActivityPhase } from './activity-phase';
import { ActivityStateMachine } from './activity-state-machine';
import { promoteActivityWaitlist } from './activity-waitlist-promotion';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import { cancelActivityRegistrationLifecycle } from '../activity-registrations/activity-cancellation-lifecycle';
import { resolveEffectiveFacts } from './settlement-segment-projector';

// V2 第一阶段批次 3A activities service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.7 / §1.11 / §1.12
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - Role 过滤(Q-A7):USER 仅可见 statusCode ∈ {published, completed} 且 deletedAt=null
// - 状态机闭集:draft / published / cancelled / completed(completed 留字典占位,Q-A11)
// - 状态机转移:draft → published(publish);draft|published → cancelled(cancel);published → completed
// - completed/cancelled 终态仅允许展示字段白名单更新；软删另受参与数据守卫约束
// - 字典校验:activityTypeCode 必填,genderRequirementCode 传入时校验
// - 组织节点禁根:organizationId 必填,但 service 校验 organization.parentId !== null
// - 起止时间:startAt < endAt(创建必校;更新时若涉及任一字段则用合并后值复校)
// - audit:create / update / publish / cancel / softDelete 全部 hook activity.publish
// - Decimal 序列化:locationLongitude / locationLatitude 显式 toString()
//
// V2 批次 6 PR #4(第二波第二步):5 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;5 个 operation 共用 `activity.publish` 事件名,
// 通过 `extra.operation` 区分(沿 batch3 草案 §20.2 A1 有意设计,D2 同值挪字符串);
// resourceType 固定 `activity`,字段全部非敏感(打码矩阵未命中)。

const DICT_TYPE_ACTIVITY_TYPE = 'activity_type';
const DICT_TYPE_GENDER_REQUIREMENT = 'gender_requirement';

const ACTIVITY_STATUS_DRAFT = 'draft';
const ACTIVITY_STATUS_PUBLISHED = 'published';
const ACTIVITY_STATUS_COMPLETED = 'completed';
const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const ACTIVITY_STATUS_TERMINATED = 'terminated';

const TERMINAL_ACTIVITY_STATUS_CODES = new Set([
  ACTIVITY_STATUS_COMPLETED,
  ACTIVITY_STATUS_CANCELLED,
  ACTIVITY_STATUS_TERMINATED,
]);
const TERMINAL_ACTIVITY_UPDATE_FIELDS = new Set<keyof UpdateActivityDto>([
  'description',
  'coverImageUrl',
  'galleryImageUrls',
  'content',
  'registrationNotes',
]);

// 第 3 批第二刀：published 根活动只允许不改变执行、名额、组织、模板或状态语义的展示字段。
// title 是报名者的关键识别信息，直改必须走 change-review；这必须是显式正向闭集，任何新字段
// 默认进入 change-review，而不是随 DTO 增长悄然放行。
export const PUBLISHED_ACTIVITY_DISPLAY_FIELDS = [
  'description',
  'registrationNotes',
  'coverImageUrl',
  'galleryImageUrls',
  'content',
] as const satisfies ReadonlyArray<keyof UpdateActivityDto>;
const PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET = new Set<keyof UpdateActivityDto>(
  PUBLISHED_ACTIVITY_DISPLAY_FIELDS,
);

// USER 角色可见的状态白名单(Q-A7)。
const USER_VISIBLE_STATUS_CODES = [ACTIVITY_STATUS_PUBLISHED, ACTIVITY_STATUS_COMPLETED] as const;

// 完整字段 select(永不含 deletedAt 软删内部状态)。
const activitySafeSelect = {
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
  coverImageUrl: true,
  galleryImageUrls: true,
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
const activityListItemSelect = {
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
  coverImageUrl: true,
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
type ActivityListRow = Prisma.ActivityGetPayload<{ select: typeof activityListItemSelect }>;
type PrismaTx = Prisma.TransactionClient;

// 统一通知 S4(评审稿 §6.4):活动取消通知收件人 = 仍在册报名者 —— pending(待审)+ pass(已通过)+ waitlisted(候补);
// reject / cancelled 已出局不打扰。状态字面量镜像 activity-registration-state-machine 的
// ACTIVITY_REGISTRATION_STATUS(此处刻意用字面量,避免 activities → activity-registrations 跨模块耦合)。
const ACTIVE_REGISTRATION_STATUS_CODES = ['pending', 'pass', 'waitlisted'] as const;

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 逐面迁移第一批):统一判权大脑,5 个写方法
    // 判权从 rbac.can 切 authz.explain(见 assertCanOrThrow);list / findOne 仍无码仅登录不变。
    private readonly authz: AuthzService,
    // PR-L2:业务写 + audit + durable intent 同事务；独立 worker 仅在 commit 后执行通知 Effect。
    private readonly notificationProducer: ActivityNotificationProducer,
    // F1/A6(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权)。
    private readonly organizations: OrganizationsService,
    // Insurance lifecycle PR-A:Activity 仍持有根事务与聚合锁；保险策略只在 rollout gate
    // 开启且受保护字段真实变化时查询报名事实。
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly initiationPolicy: ActivityInitiationPolicy,
    private readonly publishReviewService: ActivityPublishReviewService,
    private readonly allocationModes: ActivityAllocationModeService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  // ============ helpers ============

  // Slow-4 T3(2026-06-11,评审稿 §3.5 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - create 无 ref(no-ref = GLOBAL-only,行为锁天然成立;scoped create 留后续批)
  //   - update/delete/publish/cancel 传 {type:'activity', id}(点动作,scoped 持有者树内可用)
  // NOT_FOUND 回退沿 PR9 范式(attendances.service.ts assertFinalReviewAuthzOrThrow):resource_not_found
  // 时退回 rbac.can 全局码判定——持码者 return(交回调用方后续 findActivityOrThrow 抛既有 ACTIVITY_NOT_FOUND,
  // 「先判权后查资源」行为锁不变),无码者 30100 防枚举。5 个写方法第一条语句调用;list / findOne 无码化
  // (仅登录)不变,Q-A7 USER 过滤逻辑原样保留。
  private async assertCanOrThrow(
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

  // Prisma Decimal 字段 → string;null 透传。NaN 不会出现(@db.Decimal 兜底)。
  private decimalToString(d: Prisma.Decimal | null): string | null {
    return d === null ? null : d.toString();
  }

  // Json 字段 → 强类型;Prisma 返回 JsonValue,DTO 用 Record<string, unknown> / string[]。
  private jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  private jsonAsStringArray(v: Prisma.JsonValue | null): string[] | null {
    if (v === null || !Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === 'string');
  }

  private toResponseDto(row: ActivityFullRow): ActivityResponseDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      allocationModeCode: row.allocationModeCode,
      organizationId: row.organizationId,
      initiatorMemberId: row.initiatorMemberId,
      workflowRevision: row.workflowRevision,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
      genderRequirementCode: row.genderRequirementCode,
      registrationDeadline: row.registrationDeadline,
      registrationNotes: row.registrationNotes,
      statusCode: row.statusCode,
      phase: deriveActivityPhase(row.startAt, row.endAt),
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
      cancelledBy: row.cancelledBy,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      isPublicRegistration: row.isPublicRegistration,
      requiresInsurance: row.requiresInsurance,
      registrationModeCode: row.registrationModeCode,
      visibilityCode: row.visibilityCode,
      defaultCheckInRadiusMeters: row.defaultCheckInRadiusMeters,
      defaultLocationRequired: row.defaultLocationRequired,
      archiveWaitingDays: row.archiveWaitingDays,
      registrationSchema: this.jsonAsObject(row.registrationSchema),
      coverImageUrl: row.coverImageUrl,
      galleryImageUrls: this.jsonAsStringArray(row.galleryImageUrls),
      content: this.jsonAsObject(row.content),
      locationLongitude: this.decimalToString(row.locationLongitude),
      locationLatitude: this.decimalToString(row.locationLatitude),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toListItemDto(row: ActivityListRow): ActivityListItemDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
      genderRequirementCode: row.genderRequirementCode,
      registrationDeadline: row.registrationDeadline,
      statusCode: row.statusCode,
      phase: deriveActivityPhase(row.startAt, row.endAt),
      isPublicRegistration: row.isPublicRegistration,
      requiresInsurance: row.requiresInsurance,
      coverImageUrl: row.coverImageUrl,
      locationLongitude: this.decimalToString(row.locationLongitude),
      locationLatitude: this.decimalToString(row.locationLatitude),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async assertDictItemValid(
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
  private async assertOrganizationValidAndNonRoot(
    organizationId: string,
    tx?: PrismaTx,
  ): Promise<void> {
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
  private assertStartEndValid(startAt: Date, endAt: Date): void {
    if (startAt.getTime() >= endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    }
  }

  private assertRegistrationDeadlineValid(deadline: Date | null, endAt: Date): void {
    if (deadline !== null && deadline.getTime() > endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
  }

  private assertV11DraftConfiguration(dto: CreateActivityDto | UpdateActivityDto): void {
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

  private async assertLivePositionWindowsWithinActivity(
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

  private async assertLiveSessionWindowsWithinActivity(
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

  private async findActivityOrThrow(id: string, tx?: PrismaTx): Promise<ActivityFullRow> {
    const client = tx ?? this.prisma;
    const found = await client.activity.findFirst({
      where: notDeletedWhere({ id }),
      select: activitySafeSelect,
    });
    if (!found) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return found;
  }

  private async lockAndFindActivityOrThrow(id: string, tx: PrismaTx): Promise<ActivityFullRow> {
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
  private async lockAndFindManagedActivityOrThrow(
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

  // ============ list ============

  // F1/A6(D7):批量聚合 registrationCount/attendanceSheetCount(includeStats=true 时),
  // 两条 groupBy 一次查完当前页全部 activityId,禁 N+1。
  private async attachStats(items: ActivityListItemDto[]): Promise<ActivityListItemDto[]> {
    if (items.length === 0) return items;
    const activityIds = items.map((i) => i.id);
    const [regGroups, sheetGroups] = await Promise.all([
      this.prisma.activityRegistration.groupBy({
        by: ['activityId'],
        where: { activityId: { in: activityIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.attendanceSheet.groupBy({
        by: ['activityId'],
        where: { activityId: { in: activityIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const regCountByActivity = new Map(regGroups.map((g) => [g.activityId, g._count._all]));
    const sheetCountByActivity = new Map(sheetGroups.map((g) => [g.activityId, g._count._all]));
    return items.map((item) => ({
      ...item,
      registrationCount: regCountByActivity.get(item.id) ?? 0,
      attendanceSheetCount: sheetCountByActivity.get(item.id) ?? 0,
    }));
  }

  // Q-A7:USER 强制白名单状态(忽略入参 statusCode,防 draft/cancelled 存在性泄漏);
  // list/options 共用同一份状态过滤构造。
  private applyStatusCodeFilter(
    filters: Prisma.ActivityWhereInput,
    currentUser: CurrentUserPayload,
    statusCode: string | undefined,
  ): void {
    if (currentUser.role === Role.USER) {
      filters.statusCode = { in: [...USER_VISIBLE_STATUS_CODES] };
    } else if (statusCode !== undefined) {
      filters.statusCode = statusCode;
    }
  }

  async list(
    query: ListActivitiesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityListItemDto>> {
    const {
      page,
      pageSize,
      statusCode,
      activityTypeCode,
      organizationId,
      isPublicRegistration,
      q,
      dateFrom,
      dateTo,
      includeDescendants,
      includeStats,
    } = query;

    const filters: Prisma.ActivityWhereInput = {};
    this.applyStatusCodeFilter(filters, currentUser, statusCode);
    if (activityTypeCode !== undefined) filters.activityTypeCode = activityTypeCode;
    if (organizationId !== undefined) {
      filters.organizationId = includeDescendants
        ? { in: await this.organizations.queryDescendantOrgIds(organizationId) }
        : organizationId;
    }
    if (isPublicRegistration !== undefined) filters.isPublicRegistration = isPublicRegistration;
    if (q !== undefined) {
      filters.title = { contains: q, mode: 'insensitive' };
    }
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.startAt = {
        ...(dateFrom !== undefined ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo !== undefined ? { lte: new Date(dateTo) } : {}),
      };
    }

    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: activityListItemSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);

    const items = rows.map((r) => this.toListItemDto(r));

    return {
      items: includeStats ? await this.attachStats(items) : items,
      total,
      page,
      pageSize,
    };
  }

  // ============ F1/A6 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影。**无 rbac 码**(镜像 list/findOne 现状:活动读无码仅登录,
  // RBAC_MAP §2.4 BD-3 已就"是否新增 activity.read.* 码"结论 won't-do——活动详情
  // login-only 天然可读,新增读码属收紧而非 additive,故沿用现状不新增)。
  async options(
    query: ActivityOptionsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityOptionsResponseDto> {
    const { q, statusCode, organizationId, limit } = query;

    const filters: Prisma.ActivityWhereInput = {};
    this.applyStatusCodeFilter(filters, currentUser, statusCode);
    if (organizationId !== undefined) filters.organizationId = organizationId;
    if (q !== undefined) {
      filters.title = { contains: q, mode: 'insensitive' };
    }

    const rows = await this.prisma.activity.findMany({
      where: notDeletedWhere(filters),
      select: { id: true, title: true, startAt: true, statusCode: true },
      orderBy: { createdAt: 'desc' },
      take: limit ?? 20,
    });

    const items: ActivityOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.title,
      startAt: r.startAt,
      statusCode: r.statusCode,
    }));
    return { items };
  }

  // ============ findOne ============

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

    return this.toResponseDto(row);
  }

  // ============ create ============

  async create(
    dto: CreateActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.assertCanOrThrow(currentUser, 'activity.create.record');
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    // Service callers may bypass Controller ValidationPipe; new runtime creates never rely on the
    // Prisma default as an implicit allocation policy.
    this.allocationModes.assertValidMode(dto.allocationModeCode);
    this.assertStartEndValid(startAt, endAt);
    this.assertRegistrationDeadlineValid(
      dto.registrationDeadline !== undefined ? new Date(dto.registrationDeadline) : null,
      endAt,
    );
    this.assertV11DraftConfiguration(dto);

    return this.prisma.$transaction(async (tx) => {
      const initiatorMemberId = this.config.activityResponsibilityWorkflow.enabled
        ? await this.initiationPolicy.resolveInitiator(
            currentUser,
            dto.organizationId,
            dto.initiatorMemberId,
            tx,
          )
        : undefined;
      await this.assertDictItemValid(
        DICT_TYPE_ACTIVITY_TYPE,
        dto.activityTypeCode,
        BizCode.ACTIVITY_TYPE_CODE_INVALID,
        tx,
      );
      if (dto.genderRequirementCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_GENDER_REQUIREMENT,
          dto.genderRequirementCode,
          BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          tx,
        );
      }
      await this.assertOrganizationValidAndNonRoot(dto.organizationId, tx);

      const data: Prisma.ActivityUncheckedCreateInput = {
        title: dto.title,
        activityTypeCode: dto.activityTypeCode,
        allocationModeCode: dto.allocationModeCode,
        organizationId: dto.organizationId,
        startAt,
        endAt,
        location: dto.location,
        statusCode: ACTIVITY_STATUS_DRAFT,
        ...(initiatorMemberId ? { initiatorMemberId } : {}),
      };
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.capacity !== undefined) data.capacity = dto.capacity;
      if (dto.genderRequirementCode !== undefined) {
        data.genderRequirementCode = dto.genderRequirementCode;
      }
      if (dto.registrationDeadline !== undefined) {
        data.registrationDeadline = new Date(dto.registrationDeadline);
      }
      if (dto.registrationNotes !== undefined) data.registrationNotes = dto.registrationNotes;
      if (dto.isPublicRegistration !== undefined) {
        data.isPublicRegistration = dto.isPublicRegistration;
      }
      if (dto.requiresInsurance !== undefined) {
        data.requiresInsurance = dto.requiresInsurance;
      }
      if (dto.registrationModeCode !== undefined) {
        data.registrationModeCode = dto.registrationModeCode;
      }
      if (dto.visibilityCode !== undefined) data.visibilityCode = dto.visibilityCode;
      if (dto.defaultCheckInRadiusMeters !== undefined) {
        data.defaultCheckInRadiusMeters = dto.defaultCheckInRadiusMeters;
      }
      if (dto.defaultLocationRequired !== undefined) {
        data.defaultLocationRequired = dto.defaultLocationRequired;
      }
      if (dto.archiveWaitingDays !== undefined) {
        data.archiveWaitingDays = dto.archiveWaitingDays;
      }
      if (dto.registrationSchema !== undefined) {
        data.registrationSchema = dto.registrationSchema as Prisma.InputJsonValue;
      }
      if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
      if (dto.galleryImageUrls !== undefined) {
        data.galleryImageUrls = dto.galleryImageUrls;
      }
      if (dto.content !== undefined) {
        data.content = dto.content as Prisma.InputJsonValue;
      }
      if (dto.locationLongitude !== undefined) data.locationLongitude = dto.locationLongitude;
      if (dto.locationLatitude !== undefined) data.locationLatitude = dto.locationLatitude;

      const created = await tx.activity.create({
        data,
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        nextStatusCode: ACTIVITY_STATUS_DRAFT,
        auditMeta,
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ update ============

  async update(
    id: string,
    dto: UpdateActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.assertCanOrThrow(currentUser, 'activity.update.record', { type: 'activity', id });
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    if (dto.allocationModeCode !== undefined) {
      this.allocationModes.assertValidMode(dto.allocationModeCode);
    }
    return this.prisma.$transaction(async (tx) => {
      // 所有活动写入口统一先锁 Activity，再重读状态、时间窗、岗位与 passCount 基线。
      const current =
        authorization === 'managed'
          ? await this.lockAndFindManagedActivityOrThrow(id, currentUser, tx)
          : await this.lockAndFindActivityOrThrow(id, tx);

      // Caller holds Activity FOR UPDATE through lockAndFind* above. Draft writes can change the
      // parent mode, so every historical child batch must agree before any validation or write.
      if (current.statusCode === ACTIVITY_STATUS_DRAFT) {
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          ...current,
          allocationModeCode: dto.allocationModeCode ?? current.allocationModeCode,
        });
      }

      // App 草稿写先裁定状态；已发布活动即使请求体恰有别的校验问题，也必须明确
      // 告知客户端走 change review，不能因参数校验掩掉阶段语义。
      if (authorization !== 'managed') this.assertV11DraftConfiguration(dto);

      if (this.config.activityResponsibilityWorkflow.enabled) {
        const publishedDisplayOnly =
          current.statusCode === ACTIVITY_STATUS_PUBLISHED && this.isPublishedDisplayOnly(dto);
        if (authorization === 'managed') {
          // Published 只有这一个显式展示白名单可走原 PATCH；其余字段仍必须走 change review。
          if (current.statusCode !== 'draft' && !publishedDisplayOnly) {
            throw new BizException(
              current.statusCode === ACTIVITY_STATUS_PUBLISHED
                ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
                : BizCode.ACTIVITY_STATUS_INVALID,
            );
          }
          if (!publishedDisplayOnly) {
            const pendingReview = await tx.activityPublishReview.count({
              where: { activityId: id, status: 'pending' },
            });
            if (pendingReview > 0) {
              throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
            }
            this.assertV11DraftConfiguration(dto);
          }
        } else {
          if (!publishedDisplayOnly) {
            const pendingReview = await tx.activityPublishReview.count({
              where: { activityId: id, status: 'pending' },
            });
            if (pendingReview > 0) {
              throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
            }
          }
          if (current.statusCode === ACTIVITY_STATUS_PUBLISHED && !publishedDisplayOnly) {
            throw new BizException(BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
          }
        }
      }

      // Q-A12:cancelled 拒改(沿 ActivityStateMachine update decision)。
      const transition = this.activityStateMachine.decide('update', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      if (
        TERMINAL_ACTIVITY_STATUS_CODES.has(current.statusCode) &&
        Object.keys(dto).some(
          (field) => !TERMINAL_ACTIVITY_UPDATE_FIELDS.has(field as keyof UpdateActivityDto),
        )
      ) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }

      // 字典校验(传入时)
      if (dto.activityTypeCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_ACTIVITY_TYPE,
          dto.activityTypeCode,
          BizCode.ACTIVITY_TYPE_CODE_INVALID,
          tx,
        );
      }
      if (dto.genderRequirementCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_GENDER_REQUIREMENT,
          dto.genderRequirementCode,
          BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          tx,
        );
      }
      if (dto.organizationId !== undefined) {
        if (
          this.config.activityResponsibilityWorkflow.enabled &&
          dto.organizationId !== current.organizationId
        ) {
          await this.initiationPolicy.assertInitiatorEligible(
            currentUser,
            dto.organizationId,
            current.initiatorMemberId,
            tx,
          );
        } else {
          await this.assertOrganizationValidAndNonRoot(dto.organizationId, tx);
        }
      }

      // 起止时间 + 报名截止复校(任一字段变化时,用合并后值)
      const nextStart = dto.startAt !== undefined ? new Date(dto.startAt) : current.startAt;
      const nextEnd = dto.endAt !== undefined ? new Date(dto.endAt) : current.endAt;
      if (
        dto.startAt !== undefined ||
        dto.endAt !== undefined ||
        dto.registrationDeadline !== undefined
      ) {
        const nextDeadline =
          dto.registrationDeadline !== undefined
            ? new Date(dto.registrationDeadline)
            : current.registrationDeadline;
        this.assertStartEndValid(nextStart, nextEnd);
        this.assertRegistrationDeadlineValid(nextDeadline, nextEnd);
        if (dto.startAt !== undefined || dto.endAt !== undefined) {
          await this.assertLivePositionWindowsWithinActivity(current.id, nextStart, nextEnd, tx);
          await this.assertLiveSessionWindowsWithinActivity(current.id, nextStart, nextEnd, tx);
        }
      }

      await this.insuranceRequirement.assertActivityInsuranceLifecycleMutable(
        {
          id: current.id,
          requiresInsurance: current.requiresInsurance,
          startAt: current.startAt,
          endAt: current.endAt,
        },
        {
          requiresInsurance: dto.requiresInsurance ?? current.requiresInsurance,
          startAt: nextStart,
          endAt: nextEnd,
        },
        tx,
      );

      let waitlistPromotionLimit: number | null | undefined;
      if (dto.capacity !== undefined) {
        // delta / live 岗位 / passCount 基线都必须在 Activity 聚合锁后读取；否则并发 / 重试
        // 可能各自按陈旧 capacity 计算递补 delta，或在岗位形态已变化时仍沿 Activity.capacity 判闸。
        const locked = await tx.activity.findUniqueOrThrow({
          where: { id: current.id },
          select: {
            capacity: true,
            activityPositions: {
              where: { deletedAt: null },
              select: { id: true },
              take: 1,
            },
          },
        });
        const passCount = await tx.activityRegistration.count({
          where: notDeletedWhere({ activityId: current.id, statusCode: 'pass' }),
        });
        if (dto.capacity !== null && dto.capacity < passCount) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
        }
        const livePositionCapacities = await tx.activityPosition.findMany({
          where: { activityId: current.id, deletedAt: null },
          select: { capacity: true },
        });
        if (
          dto.capacity !== null &&
          (livePositionCapacities.some((position) => position.capacity === null) ||
            livePositionCapacities.reduce(
              (total, position) => total + (position.capacity ?? 0),
              0,
            ) > dto.capacity)
        ) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
        }
        // B-D1（维护者 2026-08-01 拍板）：名额语义在岗位上，`Activity.capacity` 只是总上限 ——
        // 有 live 岗位时编辑它**不触发递补**，放人走岗位名额那条路（岗位扩容只递补本岗候补）。
        // 无 live 岗位活动的扩容递补行为逐字保持：调大按 delta、改无限递补全部、缩容不递补。
        const hasLiveActivityPositions = locked.activityPositions.length > 0;
        if (!hasLiveActivityPositions && locked.capacity !== null) {
          if (dto.capacity === null) {
            waitlistPromotionLimit = null;
          } else if (dto.capacity > locked.capacity) {
            waitlistPromotionLimit = dto.capacity - locked.capacity;
          }
        }
      }

      const data: Prisma.ActivityUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.activityTypeCode !== undefined) data.activityTypeCode = dto.activityTypeCode;
      if (dto.allocationModeCode !== undefined) data.allocationModeCode = dto.allocationModeCode;
      if (dto.organizationId !== undefined) {
        data.organization = { connect: { id: dto.organizationId } };
      }
      if (dto.startAt !== undefined) data.startAt = new Date(dto.startAt);
      if (dto.endAt !== undefined) data.endAt = new Date(dto.endAt);
      if (dto.location !== undefined) data.location = dto.location;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.capacity !== undefined) data.capacity = dto.capacity;
      if (dto.genderRequirementCode !== undefined) {
        data.genderRequirementCode = dto.genderRequirementCode;
      }
      if (dto.registrationDeadline !== undefined) {
        data.registrationDeadline = new Date(dto.registrationDeadline);
      }
      if (dto.registrationNotes !== undefined) data.registrationNotes = dto.registrationNotes;
      if (dto.isPublicRegistration !== undefined) {
        data.isPublicRegistration = dto.isPublicRegistration;
      }
      if (dto.requiresInsurance !== undefined) {
        data.requiresInsurance = dto.requiresInsurance;
      }
      if (dto.registrationModeCode !== undefined) {
        data.registrationModeCode = dto.registrationModeCode;
      }
      if (dto.visibilityCode !== undefined) data.visibilityCode = dto.visibilityCode;
      if (dto.defaultCheckInRadiusMeters !== undefined) {
        data.defaultCheckInRadiusMeters = dto.defaultCheckInRadiusMeters;
      }
      if (dto.defaultLocationRequired !== undefined) {
        data.defaultLocationRequired = dto.defaultLocationRequired;
      }
      if (dto.archiveWaitingDays !== undefined) {
        data.archiveWaitingDays = dto.archiveWaitingDays;
      }
      if (dto.registrationSchema !== undefined) {
        data.registrationSchema = dto.registrationSchema as Prisma.InputJsonValue;
      }
      if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
      if (dto.galleryImageUrls !== undefined) {
        data.galleryImageUrls = dto.galleryImageUrls;
      }
      if (dto.content !== undefined) {
        data.content = dto.content as Prisma.InputJsonValue;
      }
      if (dto.locationLongitude !== undefined) data.locationLongitude = dto.locationLongitude;
      if (dto.locationLatitude !== undefined) data.locationLatitude = dto.locationLatitude;

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data,
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logUpdate({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        changedFields: Object.keys(dto),
        auditMeta,
        tx,
      });

      const promotion =
        waitlistPromotionLimit !== undefined
          ? await promoteActivityWaitlist({
              activityId: current.id,
              activityPositionId: null,
              maxPromotions: waitlistPromotionLimit,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              auditMeta,
              tx,
              auditLogs: this.auditLogs,
            })
          : { activityTitle: updated.title, promoted: [] };

      const scheduleChanged =
        current.startAt.getTime() !== updated.startAt.getTime() ||
        current.endAt.getTime() !== updated.endAt.getTime() ||
        current.location !== updated.location;
      const notificationMemberIds = scheduleChanged
        ? [
            ...new Set(
              (
                await tx.activityRegistration.findMany({
                  where: notDeletedWhere({
                    activityId: current.id,
                    statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
                  }),
                  select: { memberId: true },
                })
              ).map((row) => row.memberId),
            ),
          ]
        : [];

      await this.notificationProducer.enqueueScheduleChange(tx, {
        activityId: current.id,
        activityTitle: updated.title,
        versionKey: updated.updatedAt.toISOString(),
        before: {
          startAt: current.startAt,
          endAt: current.endAt,
          location: current.location,
        },
        after: {
          startAt: updated.startAt,
          endAt: updated.endAt,
          location: updated.location,
        },
        requiresInsurance: updated.requiresInsurance,
        memberIds: notificationMemberIds,
      });
      await this.notificationProducer.enqueueWaitlistPromotions(tx, {
        activityTitle: promotion.activityTitle,
        promoted: promotion.promoted,
      });
      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.assertCanOrThrow(currentUser, 'activity.delete.record', { type: 'activity', id });
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    return this.prisma.$transaction(async (tx) => {
      const current =
        authorization === 'managed'
          ? await this.lockAndFindManagedActivityOrThrow(id, currentUser, tx)
          : await this.lockAndFindActivityOrThrow(id, tx);
      if (authorization === 'managed') {
        // 与 PATCH 同一正向白名单：published 必须给出 change-review-required，而不是
        // 用 RBAC 或通用 status 码掩盖“应走变更审核”的语义。
        if (current.statusCode !== 'draft') {
          throw new BizException(
            current.statusCode === ACTIVITY_STATUS_PUBLISHED
              ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
              : BizCode.ACTIVITY_STATUS_INVALID,
          );
        }
        const [reviewCount, registrationCount, attendanceSheetCount, checkInCount, identityCount] =
          await Promise.all([
            tx.activityPublishReview.count({ where: { activityId: current.id } }),
            tx.activityRegistration.count({ where: { activityId: current.id } }),
            tx.attendanceSheet.count({ where: { activityId: current.id } }),
            tx.activityCheckIn.count({ where: { activityId: current.id } }),
            tx.activityParticipationIdentity.count({ where: { activityId: current.id } }),
          ]);
        if (reviewCount > 0) {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        if (
          registrationCount > 0 ||
          attendanceSheetCount > 0 ||
          checkInCount > 0 ||
          identityCount > 0
        ) {
          throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
        }
      } else {
        if (
          this.config.activityResponsibilityWorkflow.enabled &&
          (await tx.activityPublishReview.count({
            where: { activityId: id, status: 'pending' },
          })) > 0
        ) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        }

        const [activeRegistrations, attendanceSheets] = await Promise.all([
          tx.activityRegistration.count({
            where: notDeletedWhere({
              activityId: current.id,
              statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
            }),
          }),
          tx.attendanceSheet.count({
            where: notDeletedWhere({ activityId: current.id }),
          }),
        ]);
        if (activeRegistrations > 0 || attendanceSheets > 0) {
          throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
        }
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const removed = await tx.activity.update({
        where: { id: current.id },
        data: { deletedAt: new Date() },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logSoftDelete({
        activityId: current.id,
        before: current,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        auditMeta,
        tx,
      });

      return this.toResponseDto(removed);
    });
  }

  // ============ publish ============

  // 状态机:draft → published;其他状态 → 20030(沿 ActivityStateMachine publish decision)。
  async publish(
    id: string,
    dto: PublishActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    if (this.config.activityResponsibilityWorkflow.enabled) {
      if (dto.requiresInsuranceConfirmed !== true) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      await this.publishReviewService.compatibilityPublish(id, dto, currentUser, auditMeta);
      return this.findOne(id, currentUser);
    }
    await this.assertCanOrThrow(currentUser, 'activity.publish.record', { type: 'activity', id });
    if (dto.requiresInsuranceConfirmed !== true) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndFindActivityOrThrow(id, tx);
      await this.allocationModes.assertLockedActivityConsistent(tx, current);

      const transition = this.activityStateMachine.decide('publish', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const now = new Date();
      if (current.endAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      if (
        current.registrationDeadline !== null &&
        current.registrationDeadline.getTime() < now.getTime()
      ) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data: {
          statusCode: nextStatusCode,
          publishedBy: currentUser.id,
          publishedAt: now,
        },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logPublish({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        nextStatusCode,
        auditMeta,
        tx,
      });

      await this.notificationProducer.enqueuePublished(tx, {
        activityId: updated.id,
        activityTitle: updated.title,
        publishedAt: now,
        startAt: updated.startAt,
        location: updated.location,
        requiresInsurance: updated.requiresInsurance,
        isPublicRegistration: updated.isPublicRegistration,
      });
      return this.toResponseDto(updated);
    });
  }

  // ============ cancel ============

  // 状态机:* → cancelled;已 cancelled 拒重复(20030;沿 ActivityStateMachine cancel decision)。
  async cancel(
    id: string,
    dto: CancelActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.cancel.record', { type: 'activity', id });
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndFindActivityOrThrow(id, tx);

      return this.cancelLocked({ current, dto, currentUser, auditMeta, tx });
    });
  }

  /**
   * Admin cancel 与 App 生命周期 cancel 共用的取消闭环。此处刻意保留旧闭环的
   * 状态机、pending review 撤回、报名联动取消、audit 与 durable notification；
   * 只有 App 调用方可在同一 Activity 锁事务里额外写入它的 operationKey/hash。
   */
  async cancelLocked(args: {
    current: ActivityFullRow;
    dto: CancelActivityDto;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
    tx: PrismaTx;
    idempotency?: { operationKey: string; requestHash: string };
  }): Promise<ActivityResponseDto> {
    const { current, dto, currentUser, auditMeta, tx, idempotency } = args;

    const transition = this.activityStateMachine.decide('cancel', current.statusCode);
    if (!transition.allowed) {
      throw new BizException(transition.biz);
    }
    const { nextStatusCode } = transition;

    // Admin 与 App lifecycle 调用方都已先持有同一 Activity 根锁。现场打卡也先锁
    // Activity，故在这里读取完整事件链可以把「第一条事实提交」与取消线性化：
    // 已被有效 void/replace 顶掉的事实不阻断，仍有效的任一事实则整笔取消零写拒绝。
    const punchEvents = await tx.attendancePunchEvent.findMany({
      where: { activityId: current.id },
      select: {
        id: true,
        eventTypeCode: true,
        occurredAt: true,
        supersedesEventId: true,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    if (resolveEffectiveFacts(punchEvents).length > 0) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }

    const cancelledAt = new Date();

    if (this.config.activityResponsibilityWorkflow.enabled) {
      await this.publishReviewService.cancelPendingForActivity(current.id, tx);
    }

    await claimAtStatus(tx, {
      target: 'activity',
      id: current.id,
      expectedStatus: current.statusCode,
      invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
    });

    // registration create 同样先锁 Activity；claim 后再取 active 收件集，确保等待期间提交、
    // 且会被本事务联动取消的新报名者不会漏出 commit 后的取消通知。
    const registrations = await tx.activityRegistration.findMany({
      where: notDeletedWhere({
        activityId: current.id,
        statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
      }),
      select: { memberId: true },
    });
    const notificationMemberIds = [...new Set(registrations.map((row) => row.memberId))];

    const updated = await tx.activity.update({
      where: { id: current.id },
      data: {
        statusCode: nextStatusCode,
        cancelledBy: currentUser.id,
        cancelledAt,
        cancelReason: dto.cancelReason ?? null,
        ...(idempotency === undefined
          ? {}
          : {
              cancelOperationKey: idempotency.operationKey,
              cancelRequestHash: idempotency.requestHash,
            }),
      },
      select: activitySafeSelect,
    });

    const cancelledPending = await cancelActivityRegistrationLifecycle({
      activityId: current.id,
      actorUserId: currentUser.id,
      cancelledAt,
      cancelReason: '活动已取消',
      tx,
    });

    await this.activityAuditRecorder.logCancel({
      activityId: current.id,
      before: current,
      after: updated,
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      priorStatusCode: current.statusCode,
      nextStatusCode,
      cancelReason: dto.cancelReason ?? null,
      pendingRegistrationsCancelled: cancelledPending.cancelledRegistrationCount,
      auditMeta,
      tx,
    });

    await this.notificationProducer.enqueueCancellation(tx, {
      activityId: current.id,
      activityTitle: updated.title,
      cancelledAt,
      cancelReason: dto.cancelReason ?? null,
      memberIds: notificationMemberIds,
    });
    return this.toResponseDto(updated);
  }

  // ============ complete(v0.40.0 参与域生命周期收口③ 管理端手动完结)============

  // 状态机:published → completed;其他态拒(20030;沿 ActivityStateMachine complete decision)。
  // D2-a 唯一完结通路；attendances.submit 不再跨 aggregate 写 Activity.completed。
  // audit 复用 activity-audit-recorder 既有伞事件 'activity.publish'(extra.operation='complete')。
  // **不发通知**(完结不是需要通知报名者的事件;沿 publish 无通知范式,区别于 cancel)。
  async complete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.complete.record', { type: 'activity', id });
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndFindActivityOrThrow(id, tx);
      if (this.config.activityResponsibilityWorkflow.enabled) {
        await this.publishReviewService.assertNoPendingChangeReview(id, tx);
      }

      const transition = this.activityStateMachine.decide('complete', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;
      if (deriveActivityPhase(current.startAt, current.endAt) !== ACTIVITY_PHASE_ENDED) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data: { statusCode: nextStatusCode },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logComplete({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        nextStatusCode,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  private isPublishedDisplayOnly(dto: UpdateActivityDto): boolean {
    const fields = Object.keys(dto) as Array<keyof UpdateActivityDto>;
    return (
      fields.length > 0 && fields.every((field) => PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET.has(field))
    );
  }
}

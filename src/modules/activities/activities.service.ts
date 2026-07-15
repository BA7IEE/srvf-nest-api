import { Injectable, Logger } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ACTIVITY_CHANGED,
  NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
} from '../notifications/notification.constants';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
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
import { deriveActivityPhase } from './activity-phase';
import { ActivityStateMachine } from './activity-state-machine';

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

const TERMINAL_ACTIVITY_STATUS_CODES = new Set([
  ACTIVITY_STATUS_COMPLETED,
  ACTIVITY_STATUS_CANCELLED,
]);
const TERMINAL_ACTIVITY_UPDATE_FIELDS = new Set<keyof UpdateActivityDto>([
  'description',
  'coverImageUrl',
  'galleryImageUrls',
  'content',
  'registrationNotes',
]);

// USER 角色可见的状态白名单(Q-A7)。
const USER_VISIBLE_STATUS_CODES = [ACTIVITY_STATUS_PUBLISHED, ACTIVITY_STATUS_COMPLETED] as const;

// 完整字段 select(永不含 deletedAt 软删内部状态)。
const activitySafeSelect = {
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
  registrationNotes: true,
  statusCode: true,
  publishedBy: true,
  publishedAt: true,
  cancelledBy: true,
  cancelledAt: true,
  cancelReason: true,
  isPublicRegistration: true,
  requiresInsurance: true,
  registrationSchema: true,
  coverImageUrl: true,
  galleryImageUrls: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
  createdAt: true,
  updatedAt: true,
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
} as const satisfies Prisma.ActivitySelect;

type ActivityFullRow = Prisma.ActivityGetPayload<{ select: typeof activitySafeSelect }>;
type ActivityListRow = Prisma.ActivityGetPayload<{ select: typeof activityListItemSelect }>;
type PrismaTx = Prisma.TransactionClient;

// 统一通知 S4(评审稿 §6.4):活动取消通知收件人 = 仍在册报名者 —— pending(待审)+ pass(已通过);
// reject / cancelled 已出局不打扰。状态字面量镜像 activity-registration-state-machine 的
// ACTIVITY_REGISTRATION_STATUS(此处刻意用字面量,避免 activities → activity-registrations 跨模块耦合)。
const ACTIVE_REGISTRATION_STATUS_CODES = ['pending', 'pass'] as const;

@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 逐面迁移第一批):统一判权大脑,5 个写方法
    // 判权从 rbac.can 切 authz.explain(见 assertCanOrThrow);list / findOne 仍无码仅登录不变。
    private readonly authz: AuthzService,
    // 统一通知 S4(评审稿 §6.4):活动取消 → 已报名者定向通知派发器(producer → notifications 单向直调,
    // commit 后事务外、try-catch 永不抛;防环:本服务绝不被通知模块回调)。
    private readonly notificationDispatcher: NotificationDispatcher,
    // F1/A6(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权)。
    private readonly organizations: OrganizationsService,
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
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: row.capacity,
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
      capacity: row.capacity,
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

  private async findActivityOrThrow(id: string, tx?: PrismaTx): Promise<ActivityFullRow> {
    const client = tx ?? this.prisma;
    const found = await client.activity.findFirst({
      where: notDeletedWhere({ id }),
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
  ): Promise<ActivityResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.create.record');
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    this.assertStartEndValid(startAt, endAt);
    this.assertRegistrationDeadlineValid(
      dto.registrationDeadline !== undefined ? new Date(dto.registrationDeadline) : null,
      endAt,
    );

    return this.prisma.$transaction(async (tx) => {
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
        organizationId: dto.organizationId,
        startAt,
        endAt,
        location: dto.location,
        statusCode: ACTIVITY_STATUS_DRAFT,
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
  ): Promise<ActivityResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.update.record', { type: 'activity', id });
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

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
        await this.assertOrganizationValidAndNonRoot(dto.organizationId, tx);
      }

      // 起止时间 + 报名截止复校(任一字段变化时,用合并后值)
      if (
        dto.startAt !== undefined ||
        dto.endAt !== undefined ||
        dto.registrationDeadline !== undefined
      ) {
        const nextStart = dto.startAt !== undefined ? new Date(dto.startAt) : current.startAt;
        const nextEnd = dto.endAt !== undefined ? new Date(dto.endAt) : current.endAt;
        const nextDeadline =
          dto.registrationDeadline !== undefined
            ? new Date(dto.registrationDeadline)
            : current.registrationDeadline;
        this.assertStartEndValid(nextStart, nextEnd);
        this.assertRegistrationDeadlineValid(nextDeadline, nextEnd);
      }

      if (dto.capacity !== undefined) {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${current.id} FOR UPDATE`;
        const passCount = await tx.activityRegistration.count({
          where: notDeletedWhere({ activityId: current.id, statusCode: 'pass' }),
        });
        if (dto.capacity < passCount) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
        }
      }

      const data: Prisma.ActivityUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.activityTypeCode !== undefined) data.activityTypeCode = dto.activityTypeCode;
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

      return {
        dto: this.toResponseDto(updated),
        activityId: current.id,
        activityTitle: updated.title,
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
        notificationMemberIds,
      };
    });

    if (result.notificationMemberIds.length > 0) {
      await this.dispatchScheduleChangeNotifications(result);
    }
    return result.dto;
  }

  // ============ softDelete ============

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.delete.record', { type: 'activity', id });
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

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
    await this.assertCanOrThrow(currentUser, 'activity.publish.record', { type: 'activity', id });
    if (dto.requiresInsuranceConfirmed !== true) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

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

      return {
        dto: this.toResponseDto(updated),
        activityId: updated.id,
        activityTitle: updated.title,
        startAt: updated.startAt,
        location: updated.location,
        requiresInsurance: updated.requiresInsurance,
        isPublicRegistration: updated.isPublicRegistration,
      };
    });

    if (result.isPublicRegistration) {
      await this.dispatchPublishedNotification(result);
    }
    return result.dto;
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
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

      const transition = this.activityStateMachine.decide('cancel', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const registrations = await tx.activityRegistration.findMany({
        where: notDeletedWhere({
          activityId: current.id,
          statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
        }),
        select: { memberId: true },
      });
      const notificationMemberIds = [...new Set(registrations.map((row) => row.memberId))];
      const cancelledAt = new Date();

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
          cancelledBy: currentUser.id,
          cancelledAt,
          cancelReason: dto.cancelReason ?? null,
        },
        select: activitySafeSelect,
      });

      const cancelledPending = await tx.activityRegistration.updateMany({
        where: notDeletedWhere({ activityId: current.id, statusCode: 'pending' }),
        data: {
          statusCode: 'cancelled',
          cancelledByUserId: currentUser.id,
          cancelledAt,
          cancelReason: '活动已取消',
        },
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
        pendingRegistrationsCancelled: cancelledPending.count,
        auditMeta,
        tx,
      });

      // 携带通知要素(活动名 + 取消原因)出事务;dto 仍为对外返回体。收件人在 commit 后由 registration 解析。
      return {
        dto: this.toResponseDto(updated),
        activityId: current.id,
        activityTitle: updated.title,
        cancelReason: dto.cancelReason ?? null,
        notificationMemberIds,
      };
    });

    // 活动取消定向通知(统一通知 S4;评审稿 §6.4 / §6.2):**事务 commit 之后、事务外**遍历已报名者逐人派。
    // **绝不破坏取消状态机行为锁**(* → cancelled 已在事务内 commit);派发失败只记日志,不阻断、不回滚。
    await this.dispatchCancellationNotifications(
      result.activityId,
      result.activityTitle,
      result.cancelReason,
      result.notificationMemberIds,
    );

    return result.dto;
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
      const current = await this.findActivityOrThrow(id, tx);

      const transition = this.activityStateMachine.decide('complete', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

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

  // 派发「活动取消」定向通知(仅站内,goal:S4 站内为主、微信 opt-in 延后 —— 避免对 N 报名者微信 fan-out 延迟)。
  // 收件人 = 该活动仍在册报名者(pending + pass;registration→member 解析,memberId 去重)。
  // **整体 try-catch 永不抛 + 单人派发再各自吞**:任一人派发失败只记日志,不阻断其余、不破坏已 commit 的取消(行为锁)。
  private async dispatchCancellationNotifications(
    activityId: string,
    activityTitle: string,
    cancelReason: string | null,
    memberIds: string[],
  ): Promise<void> {
    try {
      const reasonSuffix = cancelReason ? ` 取消原因:${cancelReason}` : '';
      for (const memberId of memberIds) {
        try {
          await this.notificationDispatcher.dispatchTargeted({
            recipientMemberId: memberId,
            notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
            title: '活动已取消',
            body: `您报名的「${activityTitle}」已取消。${reasonSuffix}`,
            channels: [NOTIFICATION_CHANNEL_IN_APP],
          });
        } catch (err) {
          this.logger.error(
            `activity cancel notification dispatch failed (activity=${activityId}, member=${memberId}): ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `activity cancel notification fan-out failed (activity=${activityId}): ${(err as Error).message}`,
      );
    }
  }

  private async dispatchPublishedNotification(input: {
    activityId: string;
    activityTitle: string;
    startAt: Date;
    location: string;
    requiresInsurance: boolean;
  }): Promise<void> {
    try {
      const insurance = input.requiresInsurance
        ? ' 本活动要求有效保险，请在报名前确认覆盖期。'
        : '';
      await this.notificationDispatcher.dispatchSystemMemberBroadcast({
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
        title: '新活动已发布',
        body: `「${input.activityTitle}」已发布，开始时间 ${input.startAt.toISOString()}，地点 ${input.location}。${insurance}`,
      });
    } catch (err) {
      this.logger.error(
        `activity publish notification failed (activity=${input.activityId}): ${(err as Error).message}`,
      );
    }
  }

  private async dispatchScheduleChangeNotifications(input: {
    activityId: string;
    activityTitle: string;
    before: { startAt: Date; endAt: Date; location: string };
    after: { startAt: Date; endAt: Date; location: string };
    requiresInsurance: boolean;
    notificationMemberIds: string[];
  }): Promise<void> {
    const changed: string[] = [];
    if (input.before.startAt.getTime() !== input.after.startAt.getTime()) {
      changed.push(
        `开始时间：${input.before.startAt.toISOString()} → ${input.after.startAt.toISOString()}`,
      );
    }
    if (input.before.endAt.getTime() !== input.after.endAt.getTime()) {
      changed.push(
        `结束时间：${input.before.endAt.toISOString()} → ${input.after.endAt.toISOString()}`,
      );
    }
    if (input.before.location !== input.after.location) {
      changed.push(`地点：${input.before.location} → ${input.after.location}`);
    }
    const insurance = input.requiresInsurance
      ? ' 保险覆盖按原日期核验，请按调整后的活动时段重新确认。'
      : '';
    for (const memberId of input.notificationMemberIds) {
      try {
        await this.notificationDispatcher.dispatchTargeted({
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
          title: '活动安排已变更',
          body: `您报名的「${input.activityTitle}」安排有变更：${changed.join('；')}。${insurance}`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        });
      } catch (err) {
        this.logger.error(
          `activity change notification failed (activity=${input.activityId}, member=${memberId}): ${(err as Error).message}`,
        );
      }
    }
  }
}

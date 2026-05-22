import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityListItemDto,
  ActivityResponseDto,
  CancelActivityDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityStateMachine } from './activity-state-machine';

// V2 第一阶段批次 3A activities service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.7 / §1.11 / §1.12
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - Role 过滤(Q-A7):USER 仅可见 statusCode ∈ {published, completed} 且 deletedAt=null
// - 状态机闭集:draft / published / cancelled / completed(completed 留字典占位,Q-A11)
// - 状态机转移:draft → published(publish);* → cancelled(cancel,但 cancelled → cancelled 抛 20030)
// - Q-A12:cancelled Activity 拒改(update / publish 拒绝);软删允许(D3)
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
  coverImageUrl: true,
  locationLongitude: true,
  locationLatitude: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivitySelect;

type ActivityFullRow = Prisma.ActivityGetPayload<{ select: typeof activitySafeSelect }>;
type ActivityListRow = Prisma.ActivityGetPayload<{ select: typeof activityListItemSelect }>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
  ) {}

  // ============ helpers ============

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
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
      cancelledBy: row.cancelledBy,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      isPublicRegistration: row.isPublicRegistration,
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
      isPublicRegistration: row.isPublicRegistration,
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

  async list(
    query: ListActivitiesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityListItemDto>> {
    const { page, pageSize, statusCode, activityTypeCode, organizationId, isPublicRegistration } =
      query;

    const filters: Prisma.ActivityWhereInput = {};
    if (currentUser.role === Role.USER) {
      // Q-A7:USER 强制白名单状态,忽略入参 statusCode。
      filters.statusCode = { in: [...USER_VISIBLE_STATUS_CODES] };
    } else if (statusCode !== undefined) {
      filters.statusCode = statusCode;
    }
    if (activityTypeCode !== undefined) filters.activityTypeCode = activityTypeCode;
    if (organizationId !== undefined) filters.organizationId = organizationId;
    if (isPublicRegistration !== undefined) filters.isPublicRegistration = isPublicRegistration;

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

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
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
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    this.assertStartEndValid(startAt, endAt);

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
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

      // Q-A12:cancelled 拒改(沿 ActivityStateMachine update decision)。
      const transition = this.activityStateMachine.decide('update', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
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

      // 起止时间复校(任一字段变化时,用合并后值)
      if (dto.startAt !== undefined || dto.endAt !== undefined) {
        const nextStart = dto.startAt !== undefined ? new Date(dto.startAt) : current.startAt;
        const nextEnd = dto.endAt !== undefined ? new Date(dto.endAt) : current.endAt;
        this.assertStartEndValid(nextStart, nextEnd);
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

      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

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
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

      const transition = this.activityStateMachine.decide('publish', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const updated = await tx.activity.update({
        where: { id: current.id },
        data: {
          statusCode: nextStatusCode,
          publishedBy: currentUser.id,
          publishedAt: new Date(),
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
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findActivityOrThrow(id, tx);

      const transition = this.activityStateMachine.decide('cancel', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const updated = await tx.activity.update({
        where: { id: current.id },
        data: {
          statusCode: nextStatusCode,
          cancelledBy: currentUser.id,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
        select: activitySafeSelect,
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
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import {
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  ApproveRegistrationDto,
  CancelRegistrationDto,
  CreateMyRegistrationDto,
  CreateRegistrationDto,
  ExportRegistrationsQueryDto,
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
  RejectRegistrationDto,
} from './activity-registrations.dto';

// V2 第一阶段批次 3A activity-registrations service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.1 / §1.3 / §1.6 / §1.15
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - 状态机闭集 4 态:pending / pass / reject / cancelled
// - approve: pending → pass(capacity 复核;只 pass 占名额)
// - reject:  pending → reject(reviewNote 必填)
// - cancel:  pending|pass → cancelled(cancelled 释放名额)
// - Q-A3:USER 自助 vs ADMIN 代报名拆开;USER 路径 memberId 强制注入 currentUser.user.memberId
// - 报名前校验:activity 存在 + 未取消 + 公开报名 + capacity 未满
// - partial unique:同 activity 同 member active 报名唯一(deletedAt IS NULL AND statusCode != 'cancelled');
//   P2002 兜底 → ACTIVITY_REGISTRATION_ALREADY_EXISTS(21002)
// - USER 越权访问他人 registration → 404(沿 §1.7 风格,避免存在性泄漏)
// - audit:create / review(approve/reject/cancel)hook
//
// Q-A6 CSV export:
// - 不引入 csv-stringify(no new deps);手写 escapeCsvField
// - 默认 scope=pass;可选 scope=all
// - 输出 UTF-8 + BOM(让 Excel 自动识别中文)
// - 不写库 / 不落 export_logs / 不生成 AttendanceRecord(Q-A6 三条副作用禁止)
//
// V2 批次 6 PR #5(第二波第三步):6 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;2 个事件名 `registration.create` / `registration.review`
// 共用 6 个 operation,通过 `extra.viaPath` / `extra.action` 区分(沿 batch3 草案 §20.2 A2 / A3
// 有意设计,D2 同值挪字符串);resourceType 固定 `activity_registration`,字段全部非敏感
// (打码矩阵未命中,与 PR #3 / PR #4 范式一致;extras 字段是用户自定义 JSON,本次纯迁移
// 不引入打码,若后续业务认为含敏感字段需独立批次评审)。
// **`exportCsv` 的 `auditPlaceholder('registration.review', ...)` 调用保持 pino-only 不迁移**
// (read/export 行为,无 DB mutation,沿 Q1=A 当前阶段不记录查看行为)。

const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const REGISTRATION_STATUS_PENDING = 'pending';
const REGISTRATION_STATUS_PASS = 'pass';
const REGISTRATION_STATUS_CANCELLED = 'cancelled';

const registrationSafeSelect = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNote: true,
  extras: true,
  cancelledByUserId: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityRegistrationSelect;

// 列表精简 select:仅必要字段 + Member 摘要(memberNo / displayName)。
const registrationListSelect = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedAt: true,
  cancelledAt: true,
  createdAt: true,
  member: {
    select: {
      memberNo: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

type RegistrationFullRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationSafeSelect;
}>;
type RegistrationListRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationListSelect;
}>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ActivityRegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly registrationStateMachine: ActivityRegistrationStateMachine,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // Slow-4 T3(2026-06-11,评审稿 §3.6 / D-S4-8):RBAC 判权(沿 P0-F assertCanOrThrow 范式)。
  // 管理端 6 端点第一条语句调用;list / exportCsv 共用 read(D4=A 判例)。
  // App 自助端点(app-my-registrations.service.ts)不走 RBAC,self-scope 不变。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  private toResponseDto(row: RegistrationFullRow): ActivityRegistrationResponseDto {
    return {
      id: row.id,
      activityId: row.activityId,
      memberId: row.memberId,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      extras: this.jsonAsObject(row.extras),
      cancelledByUserId: row.cancelledByUserId,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toListItemDto(row: RegistrationListRow): ActivityRegistrationListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      memberId: row.memberId,
      memberNo: row.member?.memberNo ?? null,
      memberDisplayName: row.member?.displayName ?? null,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedAt: row.reviewedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
    };
  }

  // 找 activity 并校验存在(创建报名 / 列表 / 导出 / capacity 复核共用)。
  private async findActivityOrThrow(
    activityId: string,
    tx?: PrismaTx,
  ): Promise<{
    id: string;
    statusCode: string;
    isPublicRegistration: boolean;
    capacity: number | null;
  }> {
    const client = tx ?? this.prisma;
    const act = await client.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: {
        id: true,
        statusCode: true,
        isPublicRegistration: true,
        capacity: true,
      },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return act;
  }

  // 找 registration 并校验存在(管理端 approve / reject / cancel 共用)。
  private async findRegistrationOrThrow(
    activityId: string,
    id: string,
    tx?: PrismaTx,
  ): Promise<RegistrationFullRow> {
    const client = tx ?? this.prisma;
    const reg = await client.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.activityId !== activityId) {
      // 沿 §1.7 风格:跨 activity 访问 → 404(避免存在性泄漏)
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return reg;
  }

  // 找队员端 USER 的 memberId(必须绑定,否则视作"无队员身份")。
  private async resolveUserMemberIdOrThrow(userId: string, tx?: PrismaTx): Promise<string> {
    const client = tx ?? this.prisma;
    const u = await client.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    if (!u || u.memberId === null) {
      // 用户未关联队员:沿 v2 通用语义,返 MEMBER_NOT_FOUND(15001)。
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    return u.memberId;
  }

  // 校验 member 存在(ADMIN 代报名);USER 路径走 resolveUserMemberIdOrThrow。
  private async assertMemberExists(memberId: string, tx: PrismaTx): Promise<void> {
    const m = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  // 报名前的 Activity 状态 / 公开性 / 名额校验。
  private async assertActivityRegistrable(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; capacity: number | null }> {
    const act = await this.findActivityOrThrow(activityId, tx);
    if (act.statusCode === ACTIVITY_STATUS_CANCELLED) {
      throw new BizException(BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN);
    }
    if (!act.isPublicRegistration) {
      throw new BizException(BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION);
    }
    return { id: act.id, capacity: act.capacity };
  }

  // capacity 复核(create / approve 共用)。pass 占名额(决议表 Q-D17)。
  private async assertCapacityNotExceeded(
    activityId: string,
    capacity: number | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (capacity === null) return; // 不限名额
    const passCount = await tx.activityRegistration.count({
      where: notDeletedWhere({ activityId, statusCode: REGISTRATION_STATUS_PASS }),
    });
    if (passCount >= capacity) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    }
  }

  // partial unique 预检查:同 activity 同 member 已有 active(deletedAt=null AND
  // statusCode != 'cancelled')报名 → 21002。
  private async assertNoActiveRegistration(
    activityId: string,
    memberId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const existing = await tx.activityRegistration.findFirst({
      where: {
        activityId,
        memberId,
        deletedAt: null,
        statusCode: { not: REGISTRATION_STATUS_CANCELLED },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
    }
  }

  // P2002 兜底(partial unique index name:activity_registrations_activity_member_active_unique)。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // ============ 管理端:list ============

  async list(
    activityId: string,
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record');
    // activity 存在性校验(管理员看不存在的活动 → 404)。
    await this.findActivityOrThrow(activityId);

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 管理端:create(ADMIN 代报名)============

  async create(
    activityId: string,
    dto: CreateRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.create.record');
    return this.prisma.$transaction(async (tx) => {
      const act = await this.assertActivityRegistrable(activityId, tx);
      await this.assertMemberExists(dto.memberId, tx);
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);
      await this.assertNoActiveRegistration(activityId, dto.memberId, tx);

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.activityRegistration.create({
          data: {
            activityId,
            memberId: dto.memberId,
            statusCode: REGISTRATION_STATUS_PENDING,
            ...(dto.extras !== undefined ? { extras: dto.extras as Prisma.InputJsonValue } : {}),
          },
          select: registrationSafeSelect,
        }),
      );

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'admin',
        activityId,
        targetMemberId: dto.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ 队员端:createMy(USER 自助)============

  async createMy(
    activityId: string,
    dto: CreateMyRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id, tx);
      const act = await this.assertActivityRegistrable(activityId, tx);
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);
      await this.assertNoActiveRegistration(activityId, memberId, tx);

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.activityRegistration.create({
          data: {
            activityId,
            memberId,
            statusCode: REGISTRATION_STATUS_PENDING,
            ...(dto.extras !== undefined ? { extras: dto.extras as Prisma.InputJsonValue } : {}),
          },
          select: registrationSafeSelect,
        }),
      );

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'self',
        activityId,
        targetMemberId: memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ 管理端:approve ============

  async approve(
    activityId: string,
    id: string,
    dto: ApproveRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.approve.record');
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('approve', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      // capacity 复核(approve 转 pass 占名额,事务内重新计数避免 race)。
      const act = await this.findActivityOrThrow(activityId, tx);
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'approve',
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 管理端:reject ============

  async reject(
    activityId: string,
    id: string,
    dto: RejectRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.reject.record');
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('reject', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reject',
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 管理端:cancel(代取消)============

  async cancelAdmin(
    activityId: string,
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.cancel.record');
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          cancelledByUserId: currentUser.id,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logCancel({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'admin',
        cancelReason: dto.cancelReason ?? null,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 队员端:listMy ============

  async listMy(
    query: ListMyRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id);

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { memberId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 队员端:findMy ============

  async findMy(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityRegistrationResponseDto> {
    const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id);

    const reg = await this.prisma.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.memberId !== memberId) {
      // 沿 §1.7 风格:USER 越权 → 404
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return this.toResponseDto(reg);
  }

  // ============ 队员端:cancelMy ============

  async cancelMy(
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id, tx);

      const reg = await tx.activityRegistration.findFirst({
        where: notDeletedWhere({ id }),
        select: registrationSafeSelect,
      });
      if (!reg || reg.memberId !== memberId) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
      }

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          cancelledByUserId: currentUser.id,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logCancel({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'self',
        cancelReason: dto.cancelReason ?? null,
        activityId: reg.activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 管理端:CSV export(Q-A6)============

  // 返回纯字符串(BOM + CSV);controller 包成 StreamableFile。
  // **不写库 / 不落 export_logs / 不生成 AttendanceRecord**(Q-A6 三条副作用禁止)。
  async exportCsv(
    activityId: string,
    query: ExportRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<string> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record');
    await this.findActivityOrThrow(activityId);

    const scope = query.scope ?? 'pass';
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if (scope === 'pass') {
      filters.statusCode = REGISTRATION_STATUS_PASS;
    }
    const where = notDeletedWhere(filters);

    const rows = await this.prisma.activityRegistration.findMany({
      where,
      select: {
        id: true,
        memberId: true,
        statusCode: true,
        registeredAt: true,
        reviewedAt: true,
        reviewNote: true,
        cancelledAt: true,
        cancelReason: true,
        member: { select: { memberNo: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    auditPlaceholder('registration.review', {
      operatorUserId: currentUser.id,
      activityId,
      operation: 'export',
      scope,
      rowsCount: rows.length,
    });

    return this.formatRowsAsCsv(rows);
  }

  // 简单 CSV encoder(沿"不引入新依赖"):双引号转义 + 含逗号/换行/双引号字段用双引号包裹。
  private formatRowsAsCsv(
    rows: Array<{
      id: string;
      memberId: string;
      statusCode: string;
      registeredAt: Date;
      reviewedAt: Date | null;
      reviewNote: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
      member: { memberNo: string; displayName: string } | null;
    }>,
  ): string {
    const HEADERS = [
      'registration_id',
      'member_id',
      'member_no',
      'display_name',
      'status_code',
      'registered_at',
      'reviewed_at',
      'review_note',
      'cancelled_at',
      'cancel_reason',
    ];
    // 入参类型显式收紧为标量(string / Date / null),避免落 Object.toString 的
    // '[object Object]' 默认序列化(@typescript-eslint/no-base-to-string)。
    const escapeField = (value: string | Date | null): string => {
      if (value === null) return '';
      const s = value instanceof Date ? value.toISOString() : value;
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines: string[] = [HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          escapeField(r.id),
          escapeField(r.memberId),
          escapeField(r.member?.memberNo ?? null),
          escapeField(r.member?.displayName ?? null),
          escapeField(r.statusCode),
          escapeField(r.registeredAt),
          escapeField(r.reviewedAt),
          escapeField(r.reviewNote),
          escapeField(r.cancelledAt),
          escapeField(r.cancelReason),
        ].join(','),
      );
    }
    return lines.join('\n');
  }
}

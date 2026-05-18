import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AuditContextDto, AuditLogQueryDto, AuditLogResponseDto } from './audit-logs.dto';
import { auditLogSafeSelect, type SafeAuditLog } from './audit-logs.select';
import type { AuditContext, AuditLogEvent, AuditMeta } from './audit-logs.types';

// V2 第一阶段批次 6 audit_logs service(D6 v1.1 §4 / §6 / §10 / §11)。
//
// 三个能力:
// 1. log()                — 第一批落库入口,接受 tx 透传(D9);PR #2 起 emergency-contacts /
//                            certificates 调用此方法替代 auditPlaceholder
// 2. list()               — 分页查列表,ADMIN where 注入(§6.3);稳定排序 createdAt desc + id desc
// 3. findOne()            — 单条详情,assertCanReadAuditLog 二次校验(§6.2 / §6.4)
//
// 红线:
// - **不暴露** update / delete / softDelete 方法,审计写入后不可改不可删(R1)
// - **不审计 audit_logs 自身**(F6;list / findOne 不调 log())
// - `success` 默认 true,BizException 回滚后不写入(D-B fail-fast);本批次无 success=false 写入路径

type PrismaTx = Prisma.TransactionClient;

// log() 输入契约。actorUserId / actorRoleSnap 由调用方从 currentUser 取并显式传入。
// meta 由 controller 层从 @Req() 构造(D8);before / after / extra 按事件语义可省略。
// tx 在写操作 service 内部传(D9);未来非事务调用方需另行评估(R12)。
export interface AuditLogInput {
  event: AuditLogEvent;
  actorUserId: string | null;
  actorRoleSnap: Role | null;
  resourceType: string;
  resourceId: string | null;
  meta: AuditMeta;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tx?: PrismaTx;
}

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // 沿 P0-F PR-1 范式(permissions.service.ts:41-45)+ PR-4B 评审稿 §8.2:
  // 业务方法首句调用,RBAC 拒抛 RBAC_FORBIDDEN(30100,HTTP 403)。
  // **仅** list / findOne 调用;`log()` 写入路径绝对不接 rbac.can()(沿 PR-4B 评审稿 §8.5 + 批次 6 R1 红线)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // ============ 落库入口(PR #2 起被业务 service 调用) ============

  // 严格按 AuditContext 锁形(D7)构造 context;3 必填 + 3 可选:
  // - requestId / ip / ua 永远写入(ip / ua 可为 null,但字段必存在;requestId 必为非空字符串)
  // - before / after / extra 仅当调用方传入时写入(undefined 不写入,避免 JSON 里出现 "undefined" 字面或冗余 null)
  async log(input: AuditLogInput): Promise<void> {
    const context: AuditContext = {
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      ua: input.meta.ua,
    };
    if (input.before !== undefined) context.before = input.before;
    if (input.after !== undefined) context.after = input.after;
    if (input.extra !== undefined) context.extra = input.extra;

    const client = input.tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        actorRoleSnap: input.actorRoleSnap,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        event: input.event,
        context: context as unknown as Prisma.InputJsonValue,
        // success 默认 true(schema @default);D-B fail-fast 路径下不需要显式传
      },
    });
  }

  // ============ list(分页 + 过滤 + 权限 where 注入) ============

  async list(
    query: AuditLogQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AuditLogResponseDto>> {
    // P0-F PR-4B RBAC 入口判权(沿评审稿 §4.2 / §8.2;D1=A / D4=A list/findOne 共用 code)。
    // 数据范围 ADMIN where 注入仍在下方(§2 步骤 2),业务护栏 service 层保留(沿评审稿 §8.3)。
    await this.assertCanOrThrow(currentUser, 'audit-log.read.entry');

    const { page, pageSize, resourceType, resourceId, event, actorUserId, startDate, endDate } =
      query;

    // 1) 收集 QueryDto 过滤条件(各字段独立 AND)
    const where: Prisma.AuditLogWhereInput = {};
    if (resourceType !== undefined) where.resourceType = resourceType;
    if (resourceId !== undefined) where.resourceId = resourceId;
    if (event !== undefined) where.event = event;
    if (actorUserId !== undefined) where.actorUserId = actorUserId;
    if (startDate !== undefined || endDate !== undefined) {
      where.createdAt = {};
      if (startDate !== undefined) where.createdAt.gte = new Date(startDate);
      if (endDate !== undefined) where.createdAt.lte = new Date(endDate);
    }

    // 2) ADMIN 权限 where 强制注入(§6.3):只能看自己 OR 操作对象是 USER 的记录
    // SUPER_ADMIN 不注入,可看全部;USER 已被 Guard 挡,不会进来
    if (currentUser.role === Role.ADMIN) {
      where.OR = [{ actorUserId: currentUser.id }, { actorRoleSnap: Role.USER }];
    }

    // 3) 稳定排序:createdAt desc tie-breaker id desc(R8)
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        select: auditLogSafeSelect,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toResponseDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ findOne(detail + 二次权限校验) ============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<AuditLogResponseDto> {
    // P0-F PR-4B RBAC 入口判权(沿评审稿 §4.2 / §8.2;D1=A / D4=A list/findOne 共用 code)。
    // detail 业务级越级码 14101 在 assertCanReadAuditLog 二次校验中保留(沿评审稿 §8.3)。
    await this.assertCanOrThrow(currentUser, 'audit-log.read.entry');

    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      select: auditLogSafeSelect,
    });
    if (!row) throw new BizException(BizCode.AUDIT_LOG_NOT_FOUND);

    this.assertCanReadAuditLog(currentUser, row);

    return this.toResponseDto(row);
  }

  // ============ 权限二次校验(§6.2 / §6.4 / D-D) ============

  // SUPER_ADMIN     → 全部可看
  // ADMIN           → 只能看 actorUserId === self OR actorRoleSnap === USER
  //                   越级查 SUPER_ADMIN 的 detail → 14101 FORBIDDEN_AUDIT_LOG_READ
  // USER            → Guard 已挡,此处不应到达;为防御性 fallback,落 14101
  //
  // 注意:list 路径通过 where 注入做"查不到",detail 路径明确返 14101,二者语义有别。
  private assertCanReadAuditLog(
    currentUser: CurrentUserPayload,
    log: Pick<SafeAuditLog, 'actorUserId' | 'actorRoleSnap'>,
  ): void {
    if (currentUser.role === Role.SUPER_ADMIN) return;
    if (currentUser.role === Role.ADMIN) {
      if (log.actorUserId === currentUser.id) return;
      if (log.actorRoleSnap === Role.USER) return;
      throw new BizException(BizCode.FORBIDDEN_AUDIT_LOG_READ);
    }
    // USER 已被 Guard 挡;到这里说明 Guard 失效,防御性抛 14101
    throw new BizException(BizCode.FORBIDDEN_AUDIT_LOG_READ);
  }

  // ============ row → ResponseDto ============

  // context 在 DB 是 JsonValue;运行时按 AuditContext 锁形构造写入,因此可直接 cast。
  // 历史脏数据(如手工 SQL 写入)会被运行时类型强制接受,但 e2e 强断言每条 audit 必含
  // requestId / ip / ua 三字段(D6 v1.1 §12)。
  private toResponseDto(row: SafeAuditLog): AuditLogResponseDto {
    return {
      id: row.id,
      createdAt: row.createdAt,
      actorUserId: row.actorUserId,
      actorRoleSnap: row.actorRoleSnap,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      event: row.event,
      context: row.context as unknown as AuditContextDto,
      success: row.success,
    };
  }
}

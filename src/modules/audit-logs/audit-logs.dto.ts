import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段批次 6 audit_logs 模块 DTO 集合(D6 v1.1 §5 / §10 / §11)。
//
// 入参:仅 AuditLogQueryDto(2 接口全部 GET,无 Body / Patch / Post);
// 出参:AuditLogResponseDto + 嵌套 AuditContextDto。
//
// 绝对禁止入参字段(forbidNonWhitelisted 兜底):任何 audit 修改 / 创建意图字段;
// 本模块**不**对外开放 POST / PATCH / PUT / DELETE / export 接口(F5)。

// ============ 嵌套:AuditContext 锁形(D6 v1.1 §10.1) ============

// 与 audit-logs.types.ts 的 AuditContext interface 严格同步:
// - 3 必填:requestId / ip / ua(ip 与 ua 可为 null 但字段必须存在)
// - 3 可选:before / after / extra(按事件语义决定)
//
// before / after / extra 是 Record<string, unknown>,Swagger 标 type: 'object' + additionalProperties: true,
// 不进一步限定 schema(由各事件类型在 service 调用方决定具体形状)。
export class AuditContextDto {
  @ApiProperty({
    description: '请求 ID(nestjs-pino req.id;非空字符串),用于跨日志关联',
    example: 'c1xqgkb0000001abcdef234567',
  })
  requestId!: string;

  @ApiPropertyOptional({
    description: '请求来源 IP(request.ip;测试 / 内部调用可能为 null)',
    nullable: true,
    example: '127.0.0.1',
  })
  ip!: string | null;

  @ApiPropertyOptional({
    description: 'User-Agent(request.headers["user-agent"];curl / 内部调用可能为 null)',
    nullable: true,
    example: 'Mozilla/5.0 ...',
  })
  ua!: string | null;

  @ApiPropertyOptional({
    description: '操作前的资源快照(create 场景无;敏感字段已由 service 调用方打码)',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  before?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '操作后的资源快照(softDelete 场景无;敏感字段已由 service 调用方打码)',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  after?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '调用方自定义 metadata(targetMemberId / operation 等;非敏感字段)',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  extra?: Record<string, unknown>;
}

// ============ 出参:AuditLogResponseDto ============

// 与 auditLogSafeSelect 严格同步:增删字段两边同时改。
// 字段集等于 AuditLog model 的 9 个业务字段(无 actorUser relation 详情)。
export class AuditLogResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '审计记录写入时间(=操作发生时间,审计记录不可改不可删)',
  })
  createdAt!: Date;

  @ApiPropertyOptional({
    description: '操作人 User.id;系统操作 / 未登录场景为 null',
    nullable: true,
  })
  actorUserId!: string | null;

  @ApiPropertyOptional({
    description: '操作时的角色快照(Role enum;事后查 user 表取最新角色不可靠,审计取快照)',
    enum: Role,
    nullable: true,
  })
  actorRoleSnap!: Role | null;

  @ApiProperty({
    description: '资源类型(第一批枚举值:emergency_contact / certificate;String,不用 Prisma enum)',
    example: 'emergency_contact',
  })
  resourceType!: string;

  @ApiPropertyOptional({
    description: '资源 ID(create 失败时可为 null)',
    nullable: true,
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  resourceId!: string | null;

  @ApiProperty({
    description: '审计事件(AuditLogEvent union 同值;String 不用 Prisma enum)',
    example: 'emergency-contact.write',
  })
  event!: string;

  @ApiProperty({
    description: '审计上下文(AuditContext 锁形 6 字段:3 必填 + 3 可选)',
    type: AuditContextDto,
  })
  context!: AuditContextDto;

  @ApiProperty({
    description: '操作是否成功(D-B fail-fast:audit 与业务同事务,失败回滚整体;现仅 true)',
    example: true,
  })
  success!: boolean;
}

// ============ 入参:Query ============

// 8 字段白名单(D6 v1.1 §5):
// - page / pageSize           — 继承 PaginationQueryDto
// - resourceType / resourceId — 按资源过滤
// - event                     — 按事件名过滤
// - actorUserId               — 按操作人过滤
// - startDate / endDate       — 按 createdAt 时间窗过滤(ISO 8601 字符串,service 端转 Date 做 gte / lte)
//
// 不开 success / actorRoleSnap 过滤:本批次按 D6 v1.1 §5 严格 8 字段。
export class AuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按资源类型过滤(emergency_contact / certificate)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  resourceType?: string;

  @ApiPropertyOptional({
    description: '按资源 ID 过滤(配合 resourceType 查某条资源的全部审计记录)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  resourceId?: string;

  @ApiPropertyOptional({
    description: '按事件名过滤(AuditLogEvent union 值)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  event?: string;

  @ApiPropertyOptional({
    description: '按操作人 User.id 过滤(管理员查自己时填 currentUser.id)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  actorUserId?: string;

  @ApiPropertyOptional({
    description: '时间窗起点(ISO 8601;createdAt >= startDate)',
    example: '2026-05-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: '时间窗终点(ISO 8601;createdAt <= endDate)',
    example: '2026-05-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

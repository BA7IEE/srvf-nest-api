import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1–F4 各 DTO 文件同名 helper 惯例,本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3):任职(position-assignments)CRUD DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// organizationId 由组织轴路径参数 :orgId 提供,**不**进 body;status / *ByUserId / 时间戳(除任期)由 service 写。

// ============ F5/E1 expand 展开子对象(路线图 §4;D6 约定沿 F2–F4 落地形态)============

export const POSITION_ASSIGNMENT_EXPAND_TOKENS = ['member', 'position', 'organization'] as const;
export type PositionAssignmentExpandToken = (typeof POSITION_ASSIGNMENT_EXPAND_TOKENS)[number];

// 仅 `?expand=member` 命中时出现。独立 admin-surface class,不 extends / Pick / Omit(沿本仓隔离惯例)。
export class PositionAssignmentExpandedMemberDto {
  @ApiProperty({ description: '队员主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

// 仅 `?expand=position` 命中时出现。
export class PositionAssignmentExpandedPositionDto {
  @ApiProperty({ description: '职务定义主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '职务 code(kebab,如 team-leader)' })
  code!: string;

  @ApiProperty({ description: '职务名称' })
  name!: string;

  @ApiProperty({ description: '职务类别(LEADER 正职 / DEPUTY 副职 / STAFF 干事)' })
  categoryCode!: string;
}

// 仅 `?expand=organization` 命中时出现。
export class PositionAssignmentExpandedOrganizationDto {
  @ApiProperty({ description: '组织节点主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '组织名称' })
  name!: string;

  @ApiPropertyOptional({ description: '组织缩写(可空)', nullable: true })
  code!: string | null;

  @ApiProperty({ description: '节点类型字典 code' })
  nodeTypeCode!: string;
}

// ============ 出参 ============

export class PositionAssignmentResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '组织节点外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({ description: '职务定义外键(指向 organization_positions.id)' })
  positionId!: string;

  @ApiProperty({ description: '队员外键(指向 members.id)' })
  memberId!: string;

  @ApiProperty({
    description: '任职状态(ACTIVE 在任 / ENDED 已结束 / REVOKED 已撤销)',
    enum: AssignmentStatus,
    example: AssignmentStatus.ACTIVE,
  })
  status!: AssignmentStatus;

  @ApiProperty({ description: '任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '任命人 userId', nullable: true })
  appointedByUserId!: string | null;

  @ApiPropertyOptional({ description: '撤销人 userId', nullable: true })
  revokedByUserId!: string | null;

  @ApiPropertyOptional({
    description: '任命来源(announcement-2026 / manual / import)',
    nullable: true,
  })
  appointmentSource!: string | null;

  @ApiProperty({ description: '兼任标记(回填公告"（兼）";不影响授权)', example: false })
  isConcurrent!: boolean;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description: '队员摘要(仅 GET /position-assignments 总表且 ?expand 含 member 时返回;默认省略)',
    type: () => PositionAssignmentExpandedMemberDto,
  })
  member?: PositionAssignmentExpandedMemberDto;

  @ApiPropertyOptional({
    description:
      '职务摘要(仅 GET /position-assignments 总表且 ?expand 含 position 时返回;默认省略)',
    type: () => PositionAssignmentExpandedPositionDto,
  })
  position?: PositionAssignmentExpandedPositionDto;

  @ApiPropertyOptional({
    description:
      '组织摘要(仅 GET /position-assignments 总表且 ?expand 含 organization 时返回;默认省略)',
    type: () => PositionAssignmentExpandedOrganizationDto,
  })
  organization?: PositionAssignmentExpandedOrganizationDto;
}

// ============ 入参:任命(POST /organizations/:orgId/position-assignments) ============

// 严格白名单:**禁止** organizationId(由路径 :orgId 提供)/ id / status / *ByUserId / 时间戳(除任期)/ deletedAt。
export class CreatePositionAssignmentDto {
  @ApiProperty({
    description: '职务定义 id(职务与 org 类别对应规则均须 ACTIVE)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  positionId!: string;

  @ApiProperty({
    description: '被任命队员 id(必须存在)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({ description: '任期起(ISO 8601;必填)', example: '2026-07-01T00:00:00.000Z' })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;可空;有值须晚于任期起)',
    example: '2027-06-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({
    description: '兼任标记(回填公告"（兼）";默认 false;不影响授权)',
  })
  @IsOptional()
  @IsBoolean()
  isConcurrent?: boolean;

  @ApiPropertyOptional({
    description: '任命来源(自由短串,如 manual / import / announcement-2026)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appointmentSource?: string;

  @ApiPropertyOptional({ description: '备注(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ============ F5/E1 入参:全局分页总表(GET /position-assignments) ============

export class PagePositionAssignmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按组织节点精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId:是否展开其全部后代组织(默认 false)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按队员精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberId?: string;

  @ApiPropertyOptional({ description: '按职务定义精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  positionId?: string;

  @ApiPropertyOptional({
    description:
      '按任职状态过滤(缺省 = 全部未软删,含 REVOKED 历史 —— 总表口径,与组织轴「仅 ACTIVE」刻意不同)',
    enum: AssignmentStatus,
  })
  @IsOptional()
  @IsEnum(AssignmentStatus)
  status?: AssignmentStatus;

  @ApiPropertyOptional({
    description:
      '模糊搜索(命中队员 memberNo+displayName + 职务 code+name + 组织 name+code;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description:
      'expand 展开(逗号分隔白名单:member,position,organization;缺省 = 不展开,响应形状与既有端点一致)',
    example: 'member,position,organization',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  expand?: string;
}

// ============ F5/E1 入参:dry-run 任命预检(POST /position-assignments/preview) ============

// 与组织轴 create 同参 + organizationId(扁平入参无路径段);只校验不写库。
export class PreviewPositionAssignmentDto {
  @ApiProperty({ description: '目标组织节点 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiProperty({ description: '职务定义 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  positionId!: string;

  @ApiProperty({ description: '被任命队员 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({
    description: '任期起(ISO 8601;必填,与 create 同参)',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601;可空;有值须晚于任期起)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '兼任标记(与 create 参数集对齐;纯展示,不参与校验)' })
  @IsOptional()
  @IsBoolean()
  isConcurrent?: boolean;

  @ApiPropertyOptional({ description: '任命来源(与 create 参数集对齐;不参与校验)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appointmentSource?: string;

  @ApiPropertyOptional({ description: '备注(与 create 参数集对齐;不参与校验)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ============ F5/E1 出参:dry-run 任命预检结果 ============

export class PositionAssignmentViolationDto {
  @ApiProperty({
    description:
      '底层 BizCode(镜像任命 policy:17030 member inactive / 32022 inactive/规则不匹配 / 32025 归属 / 32024 严格兼任 / 32021 防重 / 32023 人数上限 / 32026 任期；存在性 11001/32001/15001)',
  })
  bizCode!: number;

  @ApiProperty({ description: '人类可读说明(与 create 抛出的 BizException.message 同源)' })
  message!: string;
}

export class PositionAssignmentPreviewResponseDto {
  @ApiProperty({ description: '是否可任命(violations 为空即 true;dry-run 结论,零写入)' })
  valid!: boolean;

  @ApiProperty({
    description:
      '违规项列表(逐项收集 —— 区别于 create 的 first-failure 抛错;valid=true 时为空数组)',
    type: () => [PositionAssignmentViolationDto],
  })
  violations!: PositionAssignmentViolationDto[];
}

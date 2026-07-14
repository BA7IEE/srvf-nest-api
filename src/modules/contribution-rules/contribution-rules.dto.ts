import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContributionRuleStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段批次 5-A contribution_rules 模块 DTO 集合。
// 详见 docs/批次5-A_贡献值规则CRUD_API前评审.md v1.1 §3.2 / §3.3。
//
// 三态语义(沿 PR #22 attendance contributionPoints 范式):
//   omit / undefined → 入库 null(可选字段)
//   显式 null        → ValidateIf 跳过 @IsNumber,入库 null
//   number           → 正常类型校验,入库 Decimal
//
// 绝对禁止入参字段(全局 ValidationPipe + forbidNonWhitelisted 兜底):
//   id / createdAt / updatedAt / deletedAt / deletedByUserId / createdByUserId / updatedByUserId
//
// UpdateContributionRuleDto 额外禁止(决议 B3 + E8):
//   activityTypeCode / attendanceRoleCode / durationThreshold
//   PATCH 不在白名单 → ValidationPipe 抛 BAD_REQUEST(40000;不开 23030)

// ============ 出参 ============

export class ContributionRuleResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '活动类型字典 code(typeCode=activity_type)',
    maxLength: 64,
    example: 'demo_type',
  })
  activityTypeCode!: string;

  @ApiProperty({
    description: '考勤角色字典 code(typeCode=attendance_role)',
    maxLength: 64,
    example: 'commander',
  })
  attendanceRoleCode!: string;

  @ApiPropertyOptional({
    description:
      '时长档位阈值(小时;Decimal(5,2);null = 无档位,该规则对所有服务时长使用 pointsBelow)',
    nullable: true,
    type: 'number',
    example: 2.5,
  })
  durationThreshold!: number | null;

  @ApiProperty({
    description: '≤ 阈值(或无档位)的预填分值(Decimal(5,2))',
    type: 'number',
    example: 1.0,
  })
  pointsBelow!: number;

  @ApiPropertyOptional({
    description:
      '> 阈值的预填分值(Decimal(5,2);非 null 时要求 durationThreshold 非 null 且 pointsAbove > pointsBelow)',
    nullable: true,
    type: 'number',
    example: 1.5,
  })
  pointsAbove!: number | null;

  @ApiPropertyOptional({
    description:
      '已废弃的历史每日上限字段(Decimal(5,2);attendance 预填与贡献聚合均不读取;全局上限由 GLOBAL_DAILY_CONTRIBUTION_CAP 决定)',
    nullable: true,
    type: 'number',
    example: null,
  })
  dailyCap!: number | null;

  @ApiProperty({
    description: '规则状态(ACTIVE 参与 attendance 预填;INACTIVE 不参与)',
    enum: ContributionRuleStatus,
    example: ContributionRuleStatus.ACTIVE,
  })
  status!: ContributionRuleStatus;

  @ApiPropertyOptional({ description: '运营备注', nullable: true, maxLength: 500 })
  remark!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiPropertyOptional({ description: '创建人 User.id', nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ description: '最近更新人 User.id', nullable: true })
  updatedByUserId!: string | null;
}

// ============ 入参:Create ============

// 必填 3 字段:activityTypeCode / attendanceRoleCode / pointsBelow。
// durationThreshold / pointsAbove / dailyCap / status / remark 可省略;
// durationThreshold / pointsAbove / dailyCap 三个字段支持显式 null(沿三态语义)。
export class CreateContributionRuleDto {
  @ApiProperty({
    description: '活动类型字典 code(必填;typeCode=activity_type)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode!: string;

  @ApiProperty({
    description: '考勤角色字典 code(必填;typeCode=attendance_role)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode!: string;

  @ApiPropertyOptional({
    description: '时长档位阈值(小时;Decimal(5,2);可省略 / 显式 null = 无档位)',
    nullable: true,
    type: 'number',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  durationThreshold?: number | null;

  @ApiProperty({
    description: '≤ 阈值(或无档位)的预填分值(Decimal(5,2);必填;≥ 0)',
    type: 'number',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pointsBelow!: number;

  @ApiPropertyOptional({
    description:
      '> 阈值的预填分值(Decimal(5,2);可省略 / 显式 null;非 null 时要求 durationThreshold 非 null 且 > pointsBelow,否则 23010)',
    nullable: true,
    type: 'number',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pointsAbove?: number | null;

  @ApiPropertyOptional({
    description:
      '已废弃的历史每日上限字段(Decimal(5,2);可省略 / 显式 null;attendance 预填与贡献聚合均不读取)',
    nullable: true,
    type: 'number',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  dailyCap?: number | null;

  @ApiPropertyOptional({
    description: '规则状态(可省略,默认 ACTIVE)',
    enum: ContributionRuleStatus,
  })
  @IsOptional()
  @IsEnum(ContributionRuleStatus)
  status?: ContributionRuleStatus;

  @ApiPropertyOptional({ description: '运营备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

// ============ 入参:Update ============

// 决议 B3 + E8:PATCH 严格白名单仅 5 字段。
// activityTypeCode / attendanceRoleCode / durationThreshold 不接受,
// 改维度必须停用旧规则后新建(由全局 ValidationPipe forbidNonWhitelisted 兜底)。
export class UpdateContributionRuleDto {
  @ApiPropertyOptional({
    description: '≤ 阈值(或无档位)的预填分值',
    type: 'number',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pointsBelow?: number;

  @ApiPropertyOptional({
    description:
      '> 阈值的预填分值(显式 null = 清空;非 null 时校验 durationThreshold 与 > pointsBelow)',
    nullable: true,
    type: 'number',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pointsAbove?: number | null;

  @ApiPropertyOptional({
    description: '每日上限(显式 null = 清空)',
    nullable: true,
    type: 'number',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  dailyCap?: number | null;

  @ApiPropertyOptional({
    description: '规则状态(ACTIVE ↔ INACTIVE 切换)',
    enum: ContributionRuleStatus,
  })
  @IsOptional()
  @IsEnum(ContributionRuleStatus)
  status?: ContributionRuleStatus;

  @ApiPropertyOptional({
    description: '运营备注(显式 null = 清空)',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

// ============ 列表 query ============

// 分页 + 多字段过滤;沿 v1 §4 PaginationQueryDto。
// 不暴露 includeDeleted / deletedAt 过滤(沿 v1 §10)。
export class ContributionRuleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按活动类型字典 code 过滤',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  activityTypeCode?: string;

  @ApiPropertyOptional({
    description: '按考勤角色字典 code 过滤',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  attendanceRoleCode?: string;

  @ApiPropertyOptional({
    description: '按规则状态过滤',
    enum: ContributionRuleStatus,
  })
  @IsOptional()
  @IsEnum(ContributionRuleStatus)
  status?: ContributionRuleStatus;
}

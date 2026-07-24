import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AppManagedRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按报名状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

export class AppManagedRegistrationActivityParamsDto {
  @ApiProperty({ description: '活动 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppManagedRegistrationParamsDto extends AppManagedRegistrationActivityParamsDto {
  @ApiProperty({ description: '报名记录 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  registrationId!: string;
}

export class AppManagedRegistrationPositionDto {
  @ApiProperty({ description: '活动岗位 id' })
  activityPositionId!: string;

  @ApiProperty({ description: '活动岗位名称' })
  name!: string;
}

export class AppManagedRegistrationMemberDto {
  @ApiProperty({ description: '队员 id' })
  id!: string;

  @ApiProperty({ description: '队员编号', nullable: true, type: String })
  memberNo!: string | null;

  @ApiProperty({ description: '队员显示名', nullable: true, type: String })
  displayName!: string | null;
}

export class AppManagedRegistrationListItemDto {
  @ApiProperty({ description: '报名记录 id' })
  registrationId!: string;

  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({
    description: '活动岗位摘要；无岗位报名为 null',
    nullable: true,
    type: () => AppManagedRegistrationPositionDto,
  })
  activityPosition!: AppManagedRegistrationPositionDto | null;

  @ApiProperty({ description: '报名队员摘要', type: () => AppManagedRegistrationMemberDto })
  member!: AppManagedRegistrationMemberDto;

  @ApiProperty({ description: '报名状态字典 code' })
  statusCode!: string;

  @ApiProperty({
    description: '候补排位；非 waitlisted 为 null',
    nullable: true,
    type: Number,
  })
  waitlistPosition!: number | null;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiProperty({ description: '审核时间', nullable: true, type: Date })
  reviewedAt!: Date | null;

  @ApiProperty({ description: '取消时间', nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

export class AppManagedRegistrationDto {
  @ApiProperty({ description: '报名记录 id' })
  registrationId!: string;

  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '报名队员 id' })
  memberId!: string;

  @ApiProperty({ description: '报名状态字典 code' })
  statusCode!: string;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiProperty({ description: '审核时间', nullable: true, type: Date })
  reviewedAt!: Date | null;

  @ApiProperty({
    description: '审核备注或拒绝理由',
    nullable: true,
    type: String,
  })
  reviewNote!: string | null;

  @ApiProperty({
    description: '报名扩展字段',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  extras!: Record<string, unknown> | null;

  @ApiProperty({ description: '取消时间', nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ description: '取消原因', nullable: true, type: String })
  cancelReason!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class ApproveAppManagedRegistrationDto {
  @ApiPropertyOptional({ description: '审核备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

export class RejectAppManagedRegistrationDto {
  @ApiProperty({ description: '拒绝理由', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewNote!: string;
}

export class CancelAppManagedRegistrationDto {
  @ApiPropertyOptional({ description: '取消原因', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}

export class BulkReviewAppManagedRegistrationsDto {
  @ApiProperty({
    description: '逐条审批的报名 id；1 至 100 条、不可重复',
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(8, 64, { each: true })
  ids!: string[];

  @ApiPropertyOptional({
    description: '统一审核备注；批量拒绝未传或空白时写入默认理由',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

export class AppManagedRegistrationBulkFailureDto {
  @ApiProperty({ description: '失败的报名 id' })
  id!: string;

  @ApiProperty({ description: '该条失败的 BizCode' })
  code!: number;

  @ApiProperty({ description: '安全业务提示' })
  message!: string;
}

export class AppManagedRegistrationBulkResponseDto {
  @ApiProperty({ description: '成功报名 id；保持请求顺序', type: [String] })
  succeeded!: string[];

  @ApiProperty({
    description: '逐条失败结果；保持请求顺序',
    type: [AppManagedRegistrationBulkFailureDto],
  })
  failed!: AppManagedRegistrationBulkFailureDto[];
}

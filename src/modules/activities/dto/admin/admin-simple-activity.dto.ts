import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AdminSimpleActivityPlaceDto } from './admin-simple-activity-place.dto';

export class AdminSimpleActivityInstanceDto {
  @ApiProperty({
    description: '本次实例人数，null 明确不限；不修改模板容量',
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: 2147483647,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity!: number | null;
  @ApiProperty({
    description: '本次报名截止；null 明确不限',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDateString()
  registrationDeadline!: string | null;
  @ApiProperty({
    description: '本次活动说明；null 清空',
    type: String,
    nullable: true,
    maxLength: 2000,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(2000)
  description!: string | null;
  @ApiProperty({
    description: '本次参与准备；null 清空',
    type: String,
    nullable: true,
    maxLength: 2000,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(2000)
  registrationNotes!: string | null;
}

export class AdminSimpleActivityFactsDto {
  @ApiProperty({ description: '本次活动标题', minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;
  @ApiProperty({ description: '本人具备发起资格的组织 ID', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;
  @ApiProperty({ description: '本次开始时间', format: 'date-time' })
  @IsDateString()
  startAt!: string;
  @ApiProperty({ description: '本次结束时间', format: 'date-time' })
  @IsDateString()
  endAt!: string;
  @ApiProperty({
    description: '文字地点；有明确地点快照时以服务端最终主地点为准',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location!: string;
}

export class AdminCreateSimpleActivityDto extends AdminSimpleActivityFactsDto {
  @ApiProperty({
    description: '精确模板版本 ID，不接受族 ID 或自动取最新',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  templateVersionId!: string;
  @ApiProperty({ description: '同内容重试复用的创建幂等键', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
  @ApiPropertyOptional({
    description: '仅确认模板容量，必须等值；不是实例覆盖',
    nullable: true,
    type: Number,
    minimum: 1,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  confirmedCapacity?: number | null;
  @ApiProperty({
    description: '缺省文字地点的明确可见性',
    enum: ['public', 'accepted', 'staff', 'command'],
  })
  @IsIn(['public', 'accepted', 'staff', 'command'])
  defaultPlaceVisibilityCode!: 'public' | 'accepted' | 'staff' | 'command';
  @ApiPropertyOptional({
    description: '可选封闭实例参数；缺省保留模板默认和旧 Quick hash',
    type: () => AdminSimpleActivityInstanceDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminSimpleActivityInstanceDto)
  instance?: AdminSimpleActivityInstanceDto;
  @ApiPropertyOptional({
    description: '活动及唯一场次使用同一份类型化地点，省略复制文字地点',
    type: () => [AdminSimpleActivityPlaceDto],
    minItems: 1,
    maxItems: 6,
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AdminSimpleActivityPlaceDto)
  places?: AdminSimpleActivityPlaceDto[];
}

export class AdminSaveSimpleActivityDto extends AdminSimpleActivityFactsDto {
  @ApiProperty({
    description: '最近一次读取所得完整草稿并发指纹，不是授权凭据',
    pattern: '^[0-9a-f]{64}$',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDraftHash!: string;
  @ApiProperty({
    description: '完整目标实例参数；不接受局部补丁',
    type: () => AdminSimpleActivityInstanceDto,
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminSimpleActivityInstanceDto)
  instance!: AdminSimpleActivityInstanceDto;
  @ApiProperty({
    description: '完整目标地点，保留现有用途结构',
    type: () => [AdminSimpleActivityPlaceDto],
    minItems: 1,
    maxItems: 6,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AdminSimpleActivityPlaceDto)
  places!: AdminSimpleActivityPlaceDto[];
}

export class AdminSimpleTemplateOptionsQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '本人拟发起组织 ID', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;
}

export class AdminSubmitSimpleActivityReviewDto {
  @ApiProperty({ description: '提交审核幂等键', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
  @ApiProperty({ description: '确认读取最终草稿并提交审核，只能为 true', example: true })
  @IsBoolean()
  @Equals(true)
  confirmation!: boolean;

  @ApiPropertyOptional({
    description:
      '确认时 GET simple-draft 返回的 draftHash；提供时拒绝已变更的简单草稿。省略保留旧版提交最新草稿语义。仅接受现行简单模板配置白名单；资格规则或模板外专业配置须使用专业流程。保留模板默认值不代表用户已逐项阅读，非完整 proposal 确认令牌。',
    pattern: '^[0-9a-f]{64}$',
  })
  @OmittableOnly()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDraftHash?: string;
}

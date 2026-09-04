import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import {
  AppActivityCreationPlaceDto,
  CREATION_PLACE_VISIBILITIES,
} from './app-managed-activity-creation-place.dto';

/** App-only request value; never derived from an Admin DTO. */
export class AppActivityCreationRequestDto {
  @ApiProperty({ description: '客户端操作键；同一命令重试必须复用', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ description: '活动标题；紧急模式只填写简短任务名', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: '目标组织 ID，必须有效且不是根组织', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;

  @ApiProperty({ description: '开始时间，紧急模式可填写估计时间', format: 'date-time' })
  @IsDateString()
  startAt!: string;

  @ApiProperty({ description: '结束时间，必须晚于开始时间', format: 'date-time' })
  @IsDateString()
  endAt!: string;

  @ApiProperty({
    description: '地点文字；紧急模式仅限粗略地点，不填精确坐标',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location!: string;
}

export class AppQuickActivityCreationDto extends AppActivityCreationRequestDto {
  @ApiProperty({
    description: '精确 Template Version ID，不接受 Family ID',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  templateVersionId!: string;

  @ApiPropertyOptional({
    description: '发起人；省略为本人，代设仍校验既有权限',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  initiatorMemberId?: string;

  @ApiPropertyOptional({
    description: '确认模板容量，仅允许等值；null 表示模板不设容量',
    nullable: true,
    minimum: 1,
    type: Number,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  confirmedCapacity?: number | null;

  @ApiProperty({
    description: '模板文字地点转换为本地快照时使用的明确可见性',
    enum: CREATION_PLACE_VISIBILITIES,
  })
  @IsIn(CREATION_PLACE_VISIBILITIES)
  defaultPlaceVisibilityCode!: (typeof CREATION_PLACE_VISIBILITIES)[number];

  @ApiPropertyOptional({
    description: '按活动/场次 scope 指定地点；未指定 scope 复制模板文字地点',
    type: () => [AppActivityCreationPlaceDto],
    minItems: 1,
    maxItems: 200,
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AppActivityCreationPlaceDto)
  places?: AppActivityCreationPlaceDto[];
}

export class AppEmergencyActivityCreationDto extends AppActivityCreationRequestDto {
  @ApiProperty({
    description: '明确发起人 ID；仍校验本人/代设与目标组织资格',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  initiatorMemberId!: string;

  @ApiProperty({ description: '既有活动类型字典码，不从任务名猜测', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode!: string;

  @ApiProperty({
    description: '明确的既有分配方式',
    enum: ['first_come', 'qualification_rank', 'lottery'],
  })
  @IsIn(['first_come', 'qualification_rank', 'lottery'])
  allocationModeCode!: string;

  @ApiPropertyOptional({
    description: '呼叫组织（包含其子树）；与 memberIds 恰选一个非空集合',
    type: [String],
    minItems: 1,
    maxItems: 100,
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(8, { each: true })
  @MaxLength(64, { each: true })
  organizationIds?: string[];

  @ApiPropertyOptional({
    description: '呼叫成员；必须有效且处于调用者获准组织范围，不回显名单',
    type: [String],
    minItems: 1,
    maxItems: 1000,
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(8, { each: true })
  @MaxLength(64, { each: true })
  memberIds?: string[];
}

export class AppActivityCreationDetailDto {
  @ApiProperty({ description: '首次创建的 Activity ID' })
  activityId!: string;

  @ApiProperty({ description: '首次创建时间，不随重放改变', format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ description: '本命令创建时的状态，不代表后续实时状态', enum: ['draft'] })
  createdStatusCode!: 'draft';
}

export class AppEmergencyCreationFollowUpDto {
  @ApiProperty({
    description: '固定补齐事项',
    enum: [
      'session',
      'position',
      'detailed_location',
      'equipment',
      'attendance',
      'outcome',
      'incident_relation',
    ],
  })
  itemCode!: string;

  @ApiProperty({
    description: '由现有权威事实计算；不提供任意完成开关',
    enum: ['pending', 'verified', 'unrepresentable'],
  })
  statusCode!: string;
}

export class AppActivityCreationResultDto {
  @ApiProperty({
    description: '首次安全创建结果；不包含精确地点、名单或签名 URL',
    type: () => AppActivityCreationDetailDto,
  })
  activity!: AppActivityCreationDetailDto;

  @ApiProperty({ description: '创建方式', enum: ['quick', 'professional', 'emergency'] })
  mode!: 'quick' | 'professional' | 'emergency';

  @ApiProperty({ description: '是否重放同一成功命令' })
  @IsBoolean()
  replayed!: boolean;

  @ApiProperty({
    description: '当前可证明的紧急补齐状态，非紧急为空数组',
    type: () => [AppEmergencyCreationFollowUpDto],
  })
  followUpItems!: AppEmergencyCreationFollowUpDto[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { AppActivityCreationRequestDto } from './app-managed-activity-creation.dto';
import { AppActivityCreationPlaceDto } from './app-managed-activity-creation-place.dto';
import {
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
} from './app-managed-activity-draft.dto';
import { ManagedRegistrationFormDefinitionInputDto } from './app-registration-form.dto';
import { AppActivityQualificationRuleInputDto } from './app-activity-qualification-rules.dto';

export class AppProfessionalCreationSessionDto {
  @ApiProperty({
    description: '既有场次配置；不开放不透明 JSON',
    type: () => CreateAppManagedActivitySessionDto,
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateAppManagedActivitySessionDto)
  session!: CreateAppManagedActivitySessionDto;

  @ApiProperty({
    description: '该场次的岗位配置，code 在场次内唯一',
    type: () => [CreateAppManagedActivitySessionPositionDto],
    maxItems: 100,
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateAppManagedActivitySessionPositionDto)
  positions!: CreateAppManagedActivitySessionPositionDto[];
}

export class AppCreationQualificationRuleSetDto {
  @ApiPropertyOptional({
    description: '本次新建场次 code；省略表示活动级资格',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionCode?: string;

  @ApiPropertyOptional({
    description: '本次场次内岗位 code；仅在同时提供 sessionCode 时使用',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionCode?: string;

  @ApiProperty({
    description: '既有受控资格规则，不接收自由形态 valueJson',
    type: () => [AppActivityQualificationRuleInputDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppActivityQualificationRuleInputDto)
  rules!: AppActivityQualificationRuleInputDto[];
}

export class AppProfessionalActivityCreationDto extends AppActivityCreationRequestDto {
  @ApiProperty({ description: '既有活动类型字典码', minLength: 1, maxLength: 64 })
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
    description: '发起人；省略为本人，代设仍受权限控制',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  initiatorMemberId?: string;

  @ApiPropertyOptional({ description: '活动说明', maxLength: 5000 })
  @OmittableOnly()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    description: '活动容量；null 表示不设容量',
    nullable: true,
    minimum: 1,
    type: Number,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({ description: '既有性别要求字典码', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string;

  @ApiPropertyOptional({
    description: '报名截止时间；null 表示不另设',
    nullable: true,
    format: 'date-time',
    type: String,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsDateString()
  registrationDeadline?: string | null;

  @ApiPropertyOptional({ description: '报名说明', maxLength: 2000 })
  @OmittableOnly()
  @IsString()
  @MaxLength(2000)
  registrationNotes?: string;

  @ApiPropertyOptional({ description: '是否公开报名；沿既有草稿语义' })
  @OmittableOnly()
  @IsBoolean()
  isPublicRegistration?: boolean;

  @ApiPropertyOptional({ description: '是否要求既有保险资格，不创建保险记录' })
  @OmittableOnly()
  @IsBoolean()
  requiresInsurance?: boolean;

  @ApiPropertyOptional({
    description: '既有报名方式',
    enum: ['open_apply', 'invitation_only', 'admin_only', 'paused'],
  })
  @OmittableOnly()
  @IsIn(['open_apply', 'invitation_only', 'admin_only', 'paused'])
  registrationModeCode?: string;

  @ApiPropertyOptional({
    description: '活动可见性，不决定地点可见性',
    enum: ['internal', 'invitation'],
  })
  @OmittableOnly()
  @IsIn(['internal', 'invitation'])
  visibilityCode?: string;

  @ApiPropertyOptional({ description: '既有默认定位要求' })
  @OmittableOnly()
  @IsBoolean()
  defaultLocationRequired?: boolean;

  @ApiPropertyOptional({
    description: '默认签到半径（米）；沿既有校验',
    minimum: 1,
    maximum: 10000,
  })
  @OmittableOnly()
  @IsInt()
  @Min(1)
  @Max(10000)
  defaultCheckInRadiusMeters?: number;

  @ApiPropertyOptional({ description: '归档等待天数', minimum: 0, maximum: 365 })
  @OmittableOnly()
  @IsInt()
  @Min(0)
  @Max(365)
  archiveWaitingDays?: number;

  @ApiProperty({
    description: '完整场次及其岗位；在同一根事务写入',
    type: () => [AppProfessionalCreationSessionDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppProfessionalCreationSessionDto)
  sessions!: AppProfessionalCreationSessionDto[];

  @ApiPropertyOptional({
    description: '明确可见性的活动/场次本地地点；每个提供的 scope 恰好一条 primary',
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

  @ApiPropertyOptional({
    description: 'B3 受治理表单；敏感题没有逐题批准前拒绝',
    type: () => ManagedRegistrationFormDefinitionInputDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedRegistrationFormDefinitionInputDto)
  form?: ManagedRegistrationFormDefinitionInputDto;

  @ApiPropertyOptional({
    description: '本次活动/场次/岗位的既有资格配置',
    type: () => [AppCreationQualificationRuleSetDto],
    maxItems: 200,
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AppCreationQualificationRuleSetDto)
  qualificationRuleSets?: AppCreationQualificationRuleSetDto[];
}

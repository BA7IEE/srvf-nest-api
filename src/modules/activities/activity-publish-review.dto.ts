import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { UpdateAppManagedActivityDto } from './dto/app/app-managed-activity.dto';
import { ManagedRegistrationFormDefinitionInputDto } from './dto/app/app-registration-form.dto';
import { AppActivityQualificationRuleInputDto } from './dto/app/app-activity-qualification-rules.dto';
import { AppActivityMetricSelectionInputDto } from './dto/app/app-activity-metric-selection.dto';
import {
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
  UpdateAppManagedActivitySessionDto,
  UpdateAppManagedActivitySessionPositionDto,
} from './dto/app/app-managed-activity-draft.dto';

const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

export class ActivityPublishReviewResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  activityId!: string;
  @ApiProperty({ enum: ['initial', 'change'] })
  requestType!: string;
  @ApiProperty()
  requestVersion!: number;
  @ApiProperty()
  baseRevision!: number;
  @ApiProperty({ enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'] })
  status!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  snapshot!: Record<string, unknown>;
  @ApiProperty()
  directPublish!: boolean;
  @ApiPropertyOptional({
    description: 'B7 定向发布的会员受众标签 code；NULL 表示历史广播审核',
    type: [String],
    nullable: true,
  })
  audienceTagCodes!: string[] | null;
  @ApiPropertyOptional({
    description:
      '组织定向的目标组织 id(自动含全部下级);NULL 表示未按组织定向。与 audienceTagCodes 取交集',
    type: [String],
    nullable: true,
  })
  audienceOrganizationIds!: string[] | null;
  @ApiProperty()
  submittedByUserId!: string;
  @ApiProperty()
  submittedAt!: Date;
  @ApiProperty({ nullable: true, type: String })
  reviewedByUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date })
  reviewedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String })
  reviewNote!: string | null;
  @ApiProperty()
  createdAt!: Date;
  @ApiProperty()
  updatedAt!: Date;
  @ApiProperty()
  activityTitle!: string;
  @ApiProperty()
  organizationId!: string;
  @ApiProperty({ nullable: true, type: String })
  initiatorMemberId!: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: '详情读面返回的服务端变更差异',
  })
  changeDiff?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '详情读面返回的当前受影响参与身份人数' })
  affectedMemberCount?: number;
}

export class ListActivityPublishReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'returned', 'withdrawn', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ enum: ['initial', 'change'] })
  @IsOptional()
  @IsIn(['initial', 'change'])
  requestType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants: boolean = false;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  initiatorQ?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityQ?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  submittedFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  submittedTo?: string;
}

export class ApproveActivityPublishReviewDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  @Equals(true)
  requiresInsuranceConfirmed!: boolean;

  @ApiPropertyOptional({
    description: '审核操作幂等标识；V8 时长政策选择提案批准时必填',
    minLength: 8,
    maxLength: 128,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey?: string;
}

export class ReturnActivityPublishReviewDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewNote!: string;

  @ApiPropertyOptional({ description: '审核操作幂等标识', minLength: 8, maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey?: string;
}

/**
 * 初次发布提审只接受明确确认与客户端幂等键；快照永远从受锁的数据库现场生成，
 * 不接受客户端传入的 Activity / Session JSON。
 */
export class SubmitActivityPublishReviewDto {
  @ApiProperty({ description: '客户端幂等操作标识', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ description: '提交发布审核的明确确认；只能为 true', example: true })
  @IsBoolean()
  @Equals(true)
  confirmation!: boolean;
}

export class ChangeReviewSessionUpdateDto extends UpdateAppManagedActivitySessionDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;
}

export class ChangeReviewSessionCreateDto extends CreateAppManagedActivitySessionDto {
  @ApiPropertyOptional({
    description: '本次 proposal 内新场次的稳定引用；岗位 create 可用该值作为 sessionId',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  clientRef?: string;
}

export class ChangeReviewSessionCancelDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;
}

export class ChangeReviewSessionCollectionsDto {
  @ApiProperty({ type: [ChangeReviewSessionCreateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionCreateDto)
  create!: ChangeReviewSessionCreateDto[];

  @ApiProperty({ type: [ChangeReviewSessionUpdateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionUpdateDto)
  update!: ChangeReviewSessionUpdateDto[];

  @ApiProperty({ type: [ChangeReviewSessionCancelDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionCancelDto)
  cancel!: ChangeReviewSessionCancelDto[];
}

export class ChangeReviewSessionPositionCreateDto extends CreateAppManagedActivitySessionPositionDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  /**
   * Optional for an otherwise unchanged historical position-create command. It becomes required
   * when this same proposal attaches a qualification RuleSet to the newly created position.
   */
  @ApiPropertyOptional({
    description: '本次 proposal 内新岗位的稳定引用；qualificationRuleSets 可用该值作为 positionId',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  clientRef?: string;
}

export class ChangeReviewSessionPositionUpdateDto extends UpdateAppManagedActivitySessionPositionDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId!: string;
}

export class ChangeReviewSessionPositionCancelDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId!: string;
}

export class ChangeReviewSessionPositionCollectionsDto {
  @ApiProperty({ type: [ChangeReviewSessionPositionCreateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionPositionCreateDto)
  create!: ChangeReviewSessionPositionCreateDto[];

  @ApiProperty({ type: [ChangeReviewSessionPositionUpdateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionPositionUpdateDto)
  update!: ChangeReviewSessionPositionUpdateDto[];

  @ApiProperty({ type: [ChangeReviewSessionPositionCancelDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewSessionPositionCancelDto)
  cancel!: ChangeReviewSessionPositionCancelDto[];
}

/**
 * A scope accepts either an existing database id or a proposal-local clientRef. It is resolved
 * against the frozen session/position collections before being canonicalized into the versioned
 * proposal target (the current new-proposal envelope is V6).
 */
export class ChangeReviewQualificationRuleScopeDto {
  @ApiProperty({ nullable: true, minLength: 1, maxLength: 64, type: String })
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string | null;

  @ApiProperty({ nullable: true, minLength: 1, maxLength: 64, type: String })
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionId!: string | null;
}

export class ChangeReviewQualificationRuleSetUpsertDto {
  @ApiProperty({ type: () => ChangeReviewQualificationRuleScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeReviewQualificationRuleScopeDto)
  scope!: ChangeReviewQualificationRuleScopeDto;

  @ApiProperty({ type: () => [AppActivityQualificationRuleInputDto], minItems: 1 })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppActivityQualificationRuleInputDto)
  rules!: AppActivityQualificationRuleInputDto[];
}

export class ChangeReviewQualificationRuleSetCancelDto {
  @ApiProperty({ type: () => ChangeReviewQualificationRuleScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeReviewQualificationRuleScopeDto)
  scope!: ChangeReviewQualificationRuleScopeDto;
}

export class ChangeReviewQualificationRuleSetCollectionsDto {
  @ApiProperty({ type: [ChangeReviewQualificationRuleSetUpsertDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewQualificationRuleSetUpsertDto)
  create!: ChangeReviewQualificationRuleSetUpsertDto[];

  @ApiProperty({ type: [ChangeReviewQualificationRuleSetUpsertDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewQualificationRuleSetUpsertDto)
  update!: ChangeReviewQualificationRuleSetUpsertDto[];

  @ApiProperty({ type: [ChangeReviewQualificationRuleSetCancelDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewQualificationRuleSetCancelDto)
  cancel!: ChangeReviewQualificationRuleSetCancelDto[];
}

/**
 * V8 keeps the ref kind explicit: an existing row id and a clientRef created by this proposal
 * are both opaque strings, but they must never be resolved through the same ambiguous field.
 */
export class ChangeReviewTimePolicySelectionScopeDto {
  @ApiProperty({ enum: ['activity', 'session', 'position'] })
  @IsIn(['activity', 'session', 'position'])
  layerCode!: 'activity' | 'session' | 'position';

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionClientRef?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionClientRef?: string;
}

export class ChangeReviewTimePolicyPointerDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  policyId!: string;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  versionId!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  definitionHash!: string;
}

export class ChangeReviewTimePolicySelectionValueDto {
  @ApiProperty({ enum: ['inherit', 'explicit'] })
  @IsIn(['inherit', 'explicit'])
  mode!: 'inherit' | 'explicit';

  @ApiProperty({ type: () => ChangeReviewTimePolicyPointerDto, nullable: true })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeReviewTimePolicyPointerDto)
  pointer!: ChangeReviewTimePolicyPointerDto | null;
}

export class ChangeReviewTimePolicySelectionChangeDto {
  @ApiProperty({ type: () => ChangeReviewTimePolicySelectionScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeReviewTimePolicySelectionScopeDto)
  scope!: ChangeReviewTimePolicySelectionScopeDto;

  @ApiProperty({ type: () => ChangeReviewTimePolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeReviewTimePolicySelectionValueDto)
  selection!: ChangeReviewTimePolicySelectionValueDto;
}

/**
 * 已发布活动的唯一变更申请。children 三组都是完整集合，故单一场次的改动只是
 * `sessions.update` 只有一项的特例，不另设旁路 endpoint。
 */
export class ChangeReviewDto extends SubmitActivityPublishReviewDto {
  @ApiProperty({ type: UpdateAppManagedActivityDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateAppManagedActivityDto)
  activityPatch!: UpdateAppManagedActivityDto;

  @ApiProperty({ type: ChangeReviewSessionCollectionsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ChangeReviewSessionCollectionsDto)
  sessions!: ChangeReviewSessionCollectionsDto;

  @ApiProperty({ type: ChangeReviewSessionPositionCollectionsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ChangeReviewSessionPositionCollectionsDto)
  positions!: ChangeReviewSessionPositionCollectionsDto;

  /**
   * Omitted keeps the active Form; explicit null retires it on approval; an object replaces it.
   * The proposal service, not this DTO, canonicalizes and binds it into the generated versioned
   * proposal snapshot (the current new-proposal envelopes are V7 and V8).
   */
  @ApiPropertyOptional({ nullable: true, type: () => ManagedRegistrationFormDefinitionInputDto })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedRegistrationFormDefinitionInputDto)
  registrationForm?: ManagedRegistrationFormDefinitionInputDto | null;

  /** Omitted retains active RuleSets; explicit collection commands are frozen in V5. */
  @ApiPropertyOptional({ type: () => ChangeReviewQualificationRuleSetCollectionsDto })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => ChangeReviewQualificationRuleSetCollectionsDto)
  qualificationRuleSets?: ChangeReviewQualificationRuleSetCollectionsDto;

  /**
   * Omitted retains the frozen current selection. An explicit value is a V7 proposal write and
   * therefore must carry the revision observed by the caller; the service rechecks both after
   * catalogue-lock waits before it writes anything.
   */
  @ApiPropertyOptional({
    description: '可选的完整指标选择；传入时必须与 expectedMetricSelectionRevision 成对出现',
    type: () => AppActivityMetricSelectionInputDto,
  })
  @ValidateIf(
    (object: ChangeReviewDto, value: unknown) =>
      value !== undefined || object.expectedMetricSelectionRevision !== undefined,
  )
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityMetricSelectionInputDto)
  metricSelection?: AppActivityMetricSelectionInputDto;

  @ApiPropertyOptional({
    description: '提交 metricSelection 时读取到的当前指标选择 revision',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(
    (object: ChangeReviewDto, value: unknown) =>
      value !== undefined || object.metricSelection !== undefined,
  )
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedMetricSelectionRevision?: number;

  /**
   * Optional V8 selection patch.  It uses the same bounded command grammar as the standalone
   * draft endpoint, but clientRef is explicit for targets created in this very proposal.
   */
  @ApiPropertyOptional({
    type: () => [ChangeReviewTimePolicySelectionChangeDto],
    minItems: 1,
    maxItems: 100,
  })
  @ValidateIf(
    (object: ChangeReviewDto, value: unknown) =>
      value !== undefined || object.expectedTimePolicySelectionRevision !== undefined,
  )
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChangeReviewTimePolicySelectionChangeDto)
  timePolicySelectionChanges?: ChangeReviewTimePolicySelectionChangeDto[];

  @ApiPropertyOptional({
    description: '提交 timePolicySelectionChanges 时读取到的当前时长选择 revision',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(
    (object: ChangeReviewDto, value: unknown) =>
      value !== undefined || object.timePolicySelectionChanges !== undefined,
  )
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedTimePolicySelectionRevision?: number;
}

export class ActivityTemplateResolutionResponseDto {
  @ApiProperty({ nullable: true, type: String })
  templateVersionId!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: '活动级最终解析值及 template/activity/system-default 来源',
  })
  activity!: Record<string, unknown>;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      '场次及岗位的最终解析值与来源；每个 resolution.source 仅为 template、activity 或 system-default',
  })
  sessions!: Array<Record<string, unknown>>;
}

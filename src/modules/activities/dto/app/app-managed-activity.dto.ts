import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AppManagedActivityParamsDto {
  @ApiProperty({ description: 'Activity.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

export class AppManagedActivityPositionParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: 'ActivityPosition.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityPositionId!: string;
}

export class AppManagedActivityAssignmentParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: 'ActivityResponsibilityAssignment.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  assignmentId!: string;
}

export class AppManagedActivitiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '活动状态过滤',
    enum: ['draft', 'published', 'cancelled', 'completed'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'published', 'cancelled', 'completed'])
  statusCode?: string;
}

export class AppActivityInitiationOrganizationOptionDto {
  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  pathLabel!: string;

  @ApiProperty({ enum: ['membership', 'cross-org-grant'] })
  source!: 'membership' | 'cross-org-grant';

  @ApiPropertyOptional({
    enum: ['PRIMARY', 'SECONDARY', 'TEMPORARY', 'SUPPORT'],
    nullable: true,
  })
  membershipType!: 'PRIMARY' | 'SECONDARY' | 'TEMPORARY' | 'SUPPORT' | null;
}

// App 入参物理隔离；禁止从 Admin DTO 派生。薄壳再显式重组成内部 DTO。
export class CreateAppManagedActivityDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode!: string;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;

  @ApiProperty()
  @IsDateString()
  startAt!: string;

  @ApiProperty()
  @IsDateString()
  endAt!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  registrationDeadline?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublicRegistration?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresInsurance?: boolean;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  registrationSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImageUrl?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLongitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLatitude?: number;
}

export class UpdateAppManagedActivityDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ minimum: 1, nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  registrationDeadline?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublicRegistration?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresInsurance?: boolean;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  registrationSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImageUrl?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLongitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLatitude?: number;
}

export class AppManagedMemberSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  memberNo!: string;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  gradeCode!: string | null;
}

export class AppManagedMyResponsibilityDto {
  @ApiProperty({ enum: ['owner', 'collaborator'] })
  responsibilityType!: string;

  @ApiProperty()
  canManageRegistrations!: boolean;

  @ApiProperty()
  canManageAttendance!: boolean;
}

export class AppManagedPublishReviewSummaryDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  latestRequestId!: string | null;

  @ApiPropertyOptional({ enum: ['initial', 'change'], nullable: true })
  requestType!: 'initial' | 'change' | null;

  @ApiPropertyOptional({
    enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'],
    nullable: true,
  })
  status!: 'pending' | 'approved' | 'returned' | 'withdrawn' | 'cancelled' | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  reviewNote!: string | null;

  @ApiProperty()
  canDirectPublish!: boolean;
}

export class AppManagedActivityCountsDto {
  @ApiProperty()
  pendingRegistrations!: number;

  @ApiProperty()
  waitlistedRegistrations!: number;

  @ApiProperty()
  attendanceSheets!: number;

  @ApiProperty()
  unresolvedAttendanceSheets!: number;
}

export class AppManagedActivityProjectionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  activityTypeCode!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty()
  location!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  capacity!: number | null;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty()
  workflowRevision!: number;

  @ApiProperty()
  requiresInsurance!: boolean;

  @ApiProperty()
  isPublicRegistration!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AppManagedActivityClosureDto {
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  attendanceDeclaredCompleteAt!: Date | null;

  @ApiProperty({
    enum: [
      'draft',
      'publish-review-pending',
      'published',
      'waiting-attendance-declaration',
      'attendance-first-review',
      'attendance-returned',
      'attendance-final-review',
      'closed',
    ],
  })
  status!:
    | 'draft'
    | 'publish-review-pending'
    | 'published'
    | 'waiting-attendance-declaration'
    | 'attendance-first-review'
    | 'attendance-returned'
    | 'attendance-final-review'
    | 'closed';

  @ApiPropertyOptional({ nullable: true, type: String })
  nextAction!: string | null;
}

export class AppManagedActivityDetailDto {
  @ApiProperty({ type: AppManagedActivityProjectionDto })
  activity!: AppManagedActivityProjectionDto;

  @ApiPropertyOptional({ type: AppManagedMemberSummaryDto, nullable: true })
  initiator!: AppManagedMemberSummaryDto | null;

  @ApiPropertyOptional({ type: AppManagedMemberSummaryDto, nullable: true })
  owner!: AppManagedMemberSummaryDto | null;

  @ApiPropertyOptional({ type: AppManagedMyResponsibilityDto, nullable: true })
  myResponsibility!: AppManagedMyResponsibilityDto | null;

  @ApiProperty({ type: AppManagedPublishReviewSummaryDto })
  publishReview!: AppManagedPublishReviewSummaryDto;

  @ApiProperty({ type: AppManagedActivityCountsDto })
  counts!: AppManagedActivityCountsDto;

  @ApiProperty({ type: AppManagedActivityClosureDto })
  closure!: AppManagedActivityClosureDto;
}

export class AppManagedActivityListItemDto {
  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty({ enum: ['initiator', 'owner', 'collaborator'] })
  relationship!: 'initiator' | 'owner' | 'collaborator';

  @ApiProperty()
  pendingRegistrations!: number;

  @ApiProperty()
  unresolvedAttendanceSheets!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  nextAction!: string | null;
}

export class AppCollaboratorOptionDto extends AppManagedMemberSummaryDto {
  @ApiProperty({ enum: ['participant', 'organization-member'] })
  eligibilitySource!: 'participant' | 'organization-member';
}

export class AppCollaboratorOptionsResponseDto {
  @ApiProperty({ type: [AppCollaboratorOptionDto] })
  items!: AppCollaboratorOptionDto[];
}

export class CreateAppManagedActivityPositionDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, type: 'integer' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ type: 'integer', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class AppActivityChangePositionDto extends CreateAppManagedActivityPositionDto {
  @ApiPropertyOptional({
    description: '现有岗位 ID；与 clientRef 二选一',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityPositionId?: string;

  @ApiPropertyOptional({
    description: '新岗位的请求内稳定引用；与 activityPositionId 二选一',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  clientRef?: string;
}

export class AppSubmitActivityChangeReviewDto {
  @ApiProperty({ type: UpdateAppManagedActivityDto })
  @ValidateNested()
  @Type(() => UpdateAppManagedActivityDto)
  activity!: UpdateAppManagedActivityDto;

  @ApiPropertyOptional({
    description: '完整岗位 proposal；省略表示保持现有岗位不变，缺失现有 ID 表示软删除',
    type: [AppActivityChangePositionDto],
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AppActivityChangePositionDto)
  positions?: AppActivityChangePositionDto[];
}

export class UpdateAppManagedActivityPositionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, type: 'integer' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class AppManagedActivityPositionDto {
  @ApiProperty()
  activityPositionId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  attendanceRoleCode!: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  capacity!: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  startAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  endAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CreateAppManagedCollaboratorDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  memberId!: string;

  @ApiProperty()
  @IsBoolean()
  canManageRegistrations!: boolean;

  @ApiProperty()
  @IsBoolean()
  canManageAttendance!: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class TransferAppManagedActivityOwnerDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  newOwnerMemberId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty()
  @IsBoolean()
  retainPreviousOwnerAsCollaborator!: boolean;
}

export class AppManagedResponsibilityAssignmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  memberId!: string;

  @ApiProperty({ enum: ['owner', 'collaborator'] })
  responsibilityType!: string;

  @ApiProperty()
  canManageRegistrations!: boolean;

  @ApiProperty()
  canManageAttendance!: boolean;

  @ApiProperty({ enum: ['active', 'ended', 'revoked'] })
  status!: string;

  @ApiProperty()
  startedAt!: Date;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  endedAt!: Date | null;

  @ApiProperty()
  assignedByUserId!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  endedByUserId!: string | null;

  @ApiProperty()
  source!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ type: AppManagedMemberSummaryDto })
  member!: AppManagedMemberSummaryDto;
}

export class AppManagedResponsibilitiesDto {
  @ApiProperty()
  activityId!: string;

  @ApiPropertyOptional({ type: AppManagedMemberSummaryDto, nullable: true })
  initiator!: AppManagedMemberSummaryDto | null;

  @ApiPropertyOptional({ type: AppManagedResponsibilityAssignmentDto, nullable: true })
  owner!: AppManagedResponsibilityAssignmentDto | null;

  @ApiProperty({ type: [AppManagedResponsibilityAssignmentDto] })
  collaborators!: AppManagedResponsibilityAssignmentDto[];

  @ApiProperty()
  legacyUnassigned!: boolean;
}

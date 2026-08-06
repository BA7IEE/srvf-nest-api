import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppManagedActivityParamsDto } from './app-managed-activity.dto';

export class AppManagedActivitySessionParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: 'ActivitySession.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;
}

export class AppManagedActivitySessionPositionParamsDto extends AppManagedActivitySessionParamsDto {
  @ApiProperty({ description: 'ActivitySessionPosition.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId!: string;
}

export class AppManagedActivitySessionsQueryDto extends PaginationQueryDto {}

export class AppManagedActivitySessionPositionsQueryDto extends PaginationQueryDto {}

export class CreateAppManagedActivitySessionDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  startAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  endAt!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  locationText!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  meetingPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  executionPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evacuationPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber({ maxDecimalPlaces: 7 })
  longitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber({ maxDecimalPlaces: 7 })
  latitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  capacity?: number | null;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  checkInOpenAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  checkInCloseAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  checkOutOpenAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  checkOutCloseAt!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  preparationStartAt?: string | null;

  @ApiProperty()
  @IsBoolean()
  locationRequired!: boolean;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  radiusMeters?: number | null;

  @ApiPropertyOptional({ type: Number, default: 15 })
  @OmittableOnly()
  @IsInt()
  lateGraceMinutes?: number;

  @ApiPropertyOptional({ type: Number, default: 15 })
  @OmittableOnly()
  @IsInt()
  earlyLeaveThresholdMinutes?: number;

  @ApiPropertyOptional({ type: Number, default: 0 })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
}

export class UpdateAppManagedActivitySessionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  locationText?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  meetingPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  executionPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evacuationPoint?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber({ maxDecimalPlaces: 7 })
  longitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber({ maxDecimalPlaces: 7 })
  latitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  capacity?: number | null;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  checkInOpenAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  checkInCloseAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  checkOutOpenAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  checkOutCloseAt?: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  preparationStartAt?: string | null;

  @ApiPropertyOptional()
  @OmittableOnly()
  @IsBoolean()
  locationRequired?: boolean;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  radiusMeters?: number | null;

  @ApiPropertyOptional({ type: Number })
  @OmittableOnly()
  @IsInt()
  lateGraceMinutes?: number;

  @ApiPropertyOptional({ type: Number })
  @OmittableOnly()
  @IsInt()
  earlyLeaveThresholdMinutes?: number;

  @ApiPropertyOptional({ type: Number })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
}

export class AppManagedActivitySessionDto {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  @ApiProperty()
  locationText!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  meetingPoint!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  executionPoint!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  evacuationPoint!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  capacity!: number | null;

  @ApiProperty({ format: 'date-time' })
  checkInOpenAt!: Date;

  @ApiProperty({ format: 'date-time' })
  checkInCloseAt!: Date;

  @ApiProperty({ format: 'date-time' })
  checkOutOpenAt!: Date;

  @ApiProperty({ format: 'date-time' })
  checkOutCloseAt!: Date;

  @ApiPropertyOptional({ nullable: true, type: Date })
  preparationStartAt!: Date | null;

  @ApiProperty()
  locationRequired!: boolean;

  @ApiPropertyOptional({ nullable: true, type: Number })
  radiusMeters!: number | null;

  @ApiProperty({ enum: ['system', 'template', 'activity', 'session', 'position'] })
  locationPolicySourceCode!: string;

  @ApiProperty()
  accuracyWarningMeters!: number;

  @ApiProperty()
  lateGraceMinutes!: number;

  @ApiProperty()
  earlyLeaveThresholdMinutes!: number;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty()
  workflowRevision!: number;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CreateAppManagedActivitySessionPositionDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode!: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  capacity?: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Boolean })
  @IsOptional()
  @IsBoolean()
  locationRequired?: boolean | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  radiusMeters?: number | null;

  @ApiPropertyOptional({ nullable: true, minLength: 8, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  leaderMemberId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  equipmentNotes?: string | null;

  @ApiPropertyOptional({ type: Number, default: 0 })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
}

export class UpdateAppManagedActivitySessionPositionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode?: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  capacity?: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time', type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Boolean })
  @IsOptional()
  @IsBoolean()
  locationRequired?: boolean | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  radiusMeters?: number | null;

  @ApiPropertyOptional({ nullable: true, minLength: 8, maxLength: 64, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  leaderMemberId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  equipmentNotes?: string | null;

  @ApiPropertyOptional({ type: Number })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
}

export class AppManagedActivitySessionPositionDto {
  @ApiProperty()
  positionId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  attendanceRoleCode!: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  capacity!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Date })
  startAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: Date })
  endAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Boolean })
  locationRequired!: boolean | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  radiusMeters!: number | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  leaderMemberId!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  equipmentNotes!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

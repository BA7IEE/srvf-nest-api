import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { ATTENDANCE_SHEET_STATUS_VALUES } from '../../attendances.dto';

export class AppManagedAttendanceActivityParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppManagedAttendanceSheetParamsDto extends AppManagedAttendanceActivityParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  sheetId!: string;
}

export class AppManagedAttendanceSheetsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ATTENDANCE_SHEET_STATUS_VALUES, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

export class AppManagedActivityCheckInsQueryDto extends PaginationQueryDto {}

export class AppManagedAttendanceRecordInputDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  roleCode!: string;

  @ApiProperty()
  @IsDateString()
  checkInAt!: string;

  @ApiProperty()
  @IsDateString()
  checkOutAt!: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  serviceHours?: number;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceStatusCode!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  registrationId?: string;
}

export class CreateAppManagedAttendanceSheetDto {
  @ApiProperty({ type: () => [AppManagedAttendanceRecordInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AppManagedAttendanceRecordInputDto)
  records!: AppManagedAttendanceRecordInputDto[];
}

export class UpdateAppManagedAttendanceSheetDto {
  @ApiPropertyOptional({ type: () => [AppManagedAttendanceRecordInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AppManagedAttendanceRecordInputDto)
  records?: AppManagedAttendanceRecordInputDto[];
}

export class ResubmitAppManagedAttendanceSheetDto {}

export class AppManagedAttendanceSheetDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() submitterUserId!: string;
  @ApiProperty() submittedAt!: Date;
  @ApiProperty({ enum: ATTENDANCE_SHEET_STATUS_VALUES }) statusCode!: string;
  @ApiProperty({ nullable: true, type: String }) reviewerUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) reviewNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) finalReviewerUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) finalReviewedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) finalReviewNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastSubmittedByUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) lastSubmittedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) returnedByUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) returnedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) returnNote!: string | null;
  @ApiProperty({ nullable: true, enum: ['first', 'final'] })
  returnedFromStageCode!: 'first' | 'final' | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AppManagedAttendanceSheetListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() submitterUserId!: string;
  @ApiProperty() submittedAt!: Date;
  @ApiProperty({ enum: ATTENDANCE_SHEET_STATUS_VALUES }) statusCode!: string;
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: Date;
}

export class AppManagedAttendanceMemberDto {
  @ApiProperty() id!: string;
  @ApiProperty() memberNo!: string;
  @ApiProperty() displayName!: string;
}

export class AppManagedAttendanceRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() sheetId!: string;
  @ApiProperty() memberId!: string;
  @ApiProperty({ nullable: true, type: () => AppManagedAttendanceMemberDto })
  member!: AppManagedAttendanceMemberDto | null;
  @ApiProperty() roleCode!: string;
  @ApiProperty() checkInAt!: Date;
  @ApiProperty() checkOutAt!: Date;
  @ApiProperty({ type: String }) serviceHours!: string;
  @ApiProperty() attendanceStatusCode!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) registrationId!: string | null;
  @ApiProperty({ nullable: true, type: String }) contributionPoints!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AppManagedAttendanceSheetDetailDto {
  @ApiProperty({ type: () => AppManagedAttendanceSheetDto })
  sheet!: AppManagedAttendanceSheetDto;
  @ApiProperty({ type: () => [AppManagedAttendanceRecordDto] })
  records!: AppManagedAttendanceRecordDto[];
}

export class AppManagedActivityCheckInDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() registrationId!: string;
  @ApiProperty({ type: () => AppManagedAttendanceMemberDto })
  member!: AppManagedAttendanceMemberDto;
  @ApiProperty() checkInAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) checkOutAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) checkInDistance!: string | null;
  @ApiProperty({ nullable: true, type: String }) checkOutDistance!: string | null;
  @ApiProperty() geoVerified!: boolean;
  @ApiProperty() outOfRange!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AppManagedAttendanceDraftRecordDto {
  @ApiProperty() memberId!: string;
  @ApiProperty() roleCode!: string;
  @ApiProperty() checkInAt!: Date;
  @ApiProperty() checkOutAt!: Date;
  @ApiProperty({ type: Number }) serviceHours!: number;
  @ApiProperty() attendanceStatusCode!: 'present';
  @ApiProperty() registrationId!: string;
}

export class AppManagedAttendanceDraftFlagDto {
  @ApiProperty() registrationId!: string;
  @ApiProperty() memberId!: string;
  @ApiProperty() noCheckOut!: boolean;
  @ApiProperty() outOfRange!: boolean;
  @ApiProperty() unverified!: boolean;
}

export class AppManagedAttendanceDraftAbsentDto {
  @ApiProperty() registrationId!: string;
  @ApiProperty() memberId!: string;
  @ApiProperty() memberNo!: string;
  @ApiProperty() displayName!: string;
}

export class AppManagedAttendanceSheetDraftDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: () => [AppManagedAttendanceDraftRecordDto] })
  records!: AppManagedAttendanceDraftRecordDto[];
  @ApiProperty({ type: () => [AppManagedAttendanceDraftFlagDto] })
  flags!: AppManagedAttendanceDraftFlagDto[];
  @ApiProperty({ type: () => [AppManagedAttendanceDraftAbsentDto] })
  absentRegistrations!: AppManagedAttendanceDraftAbsentDto[];
}

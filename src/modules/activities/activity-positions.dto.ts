import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ActivityPositionsActivityParamsDto {
  @ApiProperty({ description: '所属活动 Activity.id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class ActivityPositionParamsDto {
  @ApiProperty({ description: '所属活动 Activity.id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ description: '活动岗位 ActivityPosition.id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityPositionId!: string;
}

export class ActivityPositionResponseDto {
  @ApiProperty({ description: '活动岗位 ActivityPosition.id' })
  activityPositionId!: string;

  @ApiProperty({ description: '所属活动 Activity.id' })
  activityId!: string;

  @ApiProperty({ description: '岗位名称' })
  name!: string;

  @ApiProperty({ description: '考勤角色字典 code(typeCode=attendance_role)' })
  attendanceRoleCode!: string;

  @ApiPropertyOptional({
    description: '岗位名额上限(NULL=不限)',
    nullable: true,
    type: 'integer',
  })
  capacity!: number | null;

  @ApiPropertyOptional({
    description: '岗位开始时间(NULL=沿活动时间窗)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  startAt!: Date | null;

  @ApiPropertyOptional({
    description: '岗位结束时间(NULL=沿活动时间窗)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  endAt!: Date | null;

  @ApiPropertyOptional({
    description: '岗位性别限制字典 code(typeCode=gender_requirement;NULL=不追加限制)',
    nullable: true,
    type: String,
  })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({ description: '岗位说明', nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ description: '显式排序值(升序)', type: 'integer' })
  sortOrder!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class CreateActivityPositionDto {
  @ApiProperty({ description: '岗位名称(同活动 live 名称唯一)', minLength: 1, maxLength: 64 })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({
    description: '考勤角色字典 code(typeCode=attendance_role;须 active)',
    minLength: 1,
    maxLength: 64,
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode!: string;

  @ApiPropertyOptional({
    description: '岗位名额上限(NULL=不限)',
    nullable: true,
    minimum: 1,
    type: 'integer',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({
    description: '岗位开始时间(须与 endAt 同空同有且位于活动窗内)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({
    description: '岗位结束时间(须与 startAt 同空同有且位于活动窗内)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({
    description: '岗位性别限制字典 code(typeCode=gender_requirement;须 active)',
    nullable: true,
    maxLength: 64,
    type: String,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({
    description: '岗位说明',
    nullable: true,
    maxLength: 500,
    type: String,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ description: '显式排序值(默认 0)', default: 0, type: 'integer' })
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateActivityPositionDto {
  @ApiPropertyOptional({
    description: '岗位名称(同活动 live 名称唯一)',
    minLength: 1,
    maxLength: 64,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description: '考勤角色字典 code(typeCode=attendance_role;须 active)',
    minLength: 1,
    maxLength: 64,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode?: string;

  @ApiPropertyOptional({
    description: '岗位名额上限(NULL=不限)',
    nullable: true,
    minimum: 1,
    type: 'integer',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({
    description: '岗位开始时间(NULL=沿活动时间窗；须与 endAt 同空同有)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({
    description: '岗位结束时间(NULL=沿活动时间窗；须与 startAt 同空同有)',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional({
    description: '岗位性别限制字典 code(typeCode=gender_requirement;NULL=不追加限制)',
    nullable: true,
    maxLength: 64,
    type: String,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;

  @ApiPropertyOptional({
    description: '岗位说明',
    nullable: true,
    maxLength: 500,
    type: String,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ description: '显式排序值', type: 'integer' })
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

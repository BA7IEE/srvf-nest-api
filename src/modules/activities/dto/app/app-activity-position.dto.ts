import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class AppActivityPositionsParamsDto {
  @ApiProperty({ description: '目标活动 Activity.id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppActivityPositionDto {
  @ApiProperty({ description: '活动岗位 ActivityPosition.id' })
  activityPositionId!: string;

  @ApiProperty({ description: '岗位名称' })
  name!: string;

  @ApiProperty({ description: '考勤角色字典 code(typeCode=attendance_role)' })
  attendanceRoleCode!: string;

  @ApiPropertyOptional({ description: '岗位名额上限(NULL=不限)', nullable: true, type: 'integer' })
  capacity!: number | null;

  @ApiPropertyOptional({
    description: '当前剩余名额(NULL=不限；0 仍可提交并进入候补)',
    nullable: true,
    type: 'integer',
  })
  remainingCapacity!: number | null;

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
    description: '岗位性别限制字典 code(NULL=不追加限制)',
    nullable: true,
    type: String,
  })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({ description: '岗位说明', nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ description: '显式排序值(升序)', type: 'integer' })
  sortOrder!: number;

  @ApiProperty({
    description: '当前队员是否可提交报名(满员仍为 true 并进入候补；保险在提交时最终校验)',
  })
  canRegister!: boolean;
}

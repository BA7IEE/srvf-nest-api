import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class ActivityResponsibilityMemberDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  memberNo!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ nullable: true, type: String })
  gradeCode!: string | null;
}

export class ActivityResponsibilityAssignmentDto {
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

  @ApiProperty({ nullable: true, type: Date })
  endedAt!: Date | null;

  @ApiProperty()
  assignedByUserId!: string;

  @ApiProperty({ nullable: true, type: String })
  endedByUserId!: string | null;

  @ApiProperty()
  source!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ type: ActivityResponsibilityMemberDto })
  member!: ActivityResponsibilityMemberDto;
}

export class ActivityResponsibilitiesResponseDto {
  @ApiProperty()
  activityId!: string;

  @ApiProperty({ nullable: true, type: ActivityResponsibilityMemberDto })
  initiator!: ActivityResponsibilityMemberDto | null;

  @ApiProperty({ nullable: true, type: ActivityResponsibilityAssignmentDto })
  owner!: ActivityResponsibilityAssignmentDto | null;

  @ApiProperty({ type: [ActivityResponsibilityAssignmentDto] })
  collaborators!: ActivityResponsibilityAssignmentDto[];

  @ApiProperty()
  legacyUnassigned!: boolean;
}

export class CreateActivityCollaboratorDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
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

export class TransferActivityOwnerDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
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

export class ClaimLegacyActivityDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
  ownerMemberId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AssignLegacyActivityInitiatorDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ActivityResponsibilityParamsDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class ActivityResponsibilityAssignmentParamsDto extends ActivityResponsibilityParamsDto {
  @ApiProperty()
  @IsString()
  @Length(8, 64)
  assignmentId!: string;
}

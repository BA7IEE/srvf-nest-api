import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export const ACTIVITY_INVITATION_SCOPE_VALUES = ['activity', 'session', 'position'] as const;
export type ActivityInvitationScope = (typeof ACTIVITY_INVITATION_SCOPE_VALUES)[number];

export class AppManagedActivityInvitationActivityParamsDto {
  @ApiProperty({ description: '活动 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppManagedActivityInvitationParamsDto extends AppManagedActivityInvitationActivityParamsDto {
  @ApiProperty({ description: '邀请 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  invitationId!: string;
}

export class AppMyActivityInvitationParamsDto {
  @ApiProperty({ description: '邀请 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  invitationId!: string;
}

export class AppManagedActivityInvitationsQueryDto extends PaginationQueryDto {}

export class CreateAppManagedActivityInvitationDto {
  @ApiProperty({ description: '受邀队员 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiPropertyOptional({
    description: '场次 id；省略或 null 表示活动级邀请',
    minLength: 8,
    maxLength: 64,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  sessionId?: string | null;

  @ApiPropertyOptional({
    description: '场次岗位 id；提供时必须同时提供同活动的 sessionId',
    minLength: 8,
    maxLength: 64,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  positionId?: string | null;

  @ApiProperty({ description: '邀请过期时间(必须晚于服务端当前时刻)', format: 'date-time' })
  @IsDateString()
  expiresAt!: string;
}

export class RevokeAppManagedActivityInvitationDto {
  @ApiProperty({ description: '撤回原因', minLength: 1 })
  @IsString()
  @MinLength(1)
  reason!: string;
}

export class DeclineAppMyActivityInvitationDto {
  @ApiProperty({ description: '调用方生成的幂等操作键', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiPropertyOptional({ description: '拒绝原因', nullable: true })
  @IsOptional()
  @IsString()
  reason?: string | null;
}

export class AppActivityInvitationDto {
  @ApiProperty({ description: '邀请 id' })
  invitationId!: string;

  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '受邀队员 id' })
  memberId!: string;

  @ApiPropertyOptional({ description: '场次 id；活动级邀请为 null', nullable: true })
  sessionId!: string | null;

  @ApiPropertyOptional({ description: '场次岗位 id；非岗位邀请为 null', nullable: true })
  positionId!: string | null;

  @ApiProperty({ description: '邀请范围', enum: ACTIVITY_INVITATION_SCOPE_VALUES })
  scope!: ActivityInvitationScope;

  @ApiProperty({
    description: '邀请状态',
    enum: ['pending', 'accepted', 'declined', 'revoked', 'expired'],
  })
  status!: string;

  @ApiProperty({ description: '过期时间' })
  expiresAt!: Date;

  @ApiPropertyOptional({ description: '应答时间', nullable: true })
  respondedAt!: Date | null;

  @ApiPropertyOptional({ description: '撤回时间', nullable: true })
  revokedAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

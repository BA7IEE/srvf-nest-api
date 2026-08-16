import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class AppManagedAttendanceQrSessionParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '活动场次 ID' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;
}

export class AppManagedAttendanceQrIssueParamsDto extends AppManagedAttendanceQrSessionParamsDto {
  @ApiProperty({ enum: ['check-in', 'check-out'], description: '二维码允许的打卡动作 URL 段' })
  @IsIn(['check-in', 'check-out'])
  action!: 'check-in' | 'check-out';
}

export class AppManagedAttendanceQrCredentialParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '二维码凭证 ID' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  credentialId!: string;
}

export class IssueAppManagedAttendanceQrDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的幂等操作键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;
}

export class RevokeAppManagedAttendanceQrDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的幂等操作键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '作废二维码的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

// Safe metadata only. The durable token digest, operation key and raw usable QR token never cross
// this presenter boundary.
export class AppManagedAttendanceQrCredentialDto {
  @ApiProperty({ description: '二维码凭证 ID' })
  credentialId!: string;

  @ApiProperty({ description: '活动 ID' })
  activityId!: string;

  @ApiProperty({ description: '场次 ID' })
  sessionId!: string;

  @ApiProperty({ enum: ['check_in', 'check_out'] })
  actionCode!: string;

  @ApiProperty({ minimum: 1, description: '同场次同动作内递增的版本号' })
  credentialVersion!: number;

  @ApiProperty({ enum: ['active', 'revoked', 'expired'] })
  statusCode!: string;

  @ApiProperty({ type: Date, format: 'date-time' })
  validFrom!: Date;

  @ApiProperty({ type: Date, format: 'date-time' })
  validUntil!: Date;

  @ApiProperty({ type: Date, format: 'date-time' })
  issuedAt!: Date;

  @ApiPropertyOptional({ nullable: true, type: Date, format: 'date-time' })
  revokedAt!: Date | null;
}

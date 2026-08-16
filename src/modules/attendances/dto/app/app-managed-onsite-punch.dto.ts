import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class AppManagedOnsiteSessionParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '场次 ID' })
  @IsString()
  @Length(8, 64)
  sessionId!: string;
}

export class AppManagedOnsitePunchEventParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '不可变现场事件 ID' })
  @IsString()
  @Length(8, 64)
  eventId!: string;
}

export class EarlyDepartureCloseAppManagedOnsitePunchDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '永久参与身份 ID' })
  @IsString()
  @Length(8, 64)
  participationIdentityId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '特殊提前离场的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ minLength: 1, maxLength: 128, description: '现场事件防重键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventKey!: string;
}

export class CorrectAppManagedOnsitePunchDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的幂等操作键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '更正的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

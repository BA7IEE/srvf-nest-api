import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

export class AppManagedActivityOnsiteParticipationParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '当前受管活动 Activity.id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

export class CreateAppManagedActivityOnsiteParticipationDto {
  @ApiProperty({ description: '调用方生成的幂等操作键', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '现场参加的目标队员 id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  memberId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '目标已排期场次 id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 64,
    description: '该场次的现场岗位 id；有 live 岗位时必填',
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: '现场临时参加的批准原因；服务端会 trim 后保存',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppManagedActivityOnsiteParticipationReceiptDto {
  @ApiProperty({ description: 'canonical ActivityRegistration.id' })
  registrationId!: string;

  @ApiProperty({ description: '本次新增的 immutable ActivityRegistrationRevision.id' })
  registrationRevisionId!: string;

  @ApiProperty({ description: '永久 ActivityParticipationIdentity.id' })
  participationIdentityId!: string;

  @ApiProperty({ description: '本次新增的 immutable ActivityParticipationRevision.id' })
  participationRevisionId!: string;

  @ApiProperty({ enum: ['pass'], description: '固定为 pass，表示现场参加已批准' })
  statusCode!: 'pass';

  @ApiProperty({ enum: ['onsite'], description: '固定为 onsite，表示现场临时补录' })
  sourceCode!: 'onsite';

  @ApiProperty({
    type: String,
    nullable: true,
    description: '本次现场参加对应的场次岗位 id；无岗位时为 null',
  })
  positionId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: '本次现场批准时间（ISO 8601）' })
  approvedAt!: Date;
}

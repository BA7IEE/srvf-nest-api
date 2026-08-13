import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AppManagedActivityAllocationParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

export class AppManagedActivityAllocationBatchParamsDto extends AppManagedActivityAllocationParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  batchId!: string;
}

class AllocationOperationKeyDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的幂等操作键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;
}

export class PrepareAppManagedActivityAllocationBatchDto extends AllocationOperationKeyDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '本次冻结的活动场次' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @ApiPropertyOptional({
    nullable: true,
    minLength: 8,
    maxLength: 64,
    description: '可选岗位；null 表示场次级批次',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId?: string | null;
}

export class CommitAppManagedActivityAllocationBatchDto extends AllocationOperationKeyDto {}

export class VoidAppManagedActivityAllocationBatchDto extends AllocationOperationKeyDto {
  @ApiProperty({ minLength: 1, maxLength: 500, description: '作废原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppActivityAllocationCandidateDto {
  @ApiProperty()
  participationIdentityId!: string;

  @ApiProperty()
  registrationId!: string;

  @ApiProperty()
  acceptedAt!: Date;

  @ApiPropertyOptional({ nullable: true, description: '仅 qualification_rank 产生四位小数分数' })
  qualificationScore!: string | null;

  @ApiProperty({ enum: ['pass', 'warn', 'fail'] })
  qualificationResultCode!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  lotteryOrder!: number | null;

  @ApiPropertyOptional({ nullable: true, enum: ['allocated', 'waitlisted', 'not_selected'] })
  resultCode!: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  waitlistRank!: number | null;
}

export class AppActivityAllocationBatchDto {
  @ApiProperty()
  batchId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiPropertyOptional({ nullable: true })
  positionId!: string | null;

  @ApiProperty({ enum: ['qualification_rank', 'lottery'] })
  modeCode!: string;

  @ApiProperty({ enum: ['preparing', 'committed', 'voided'] })
  statusCode!: string;

  @ApiProperty()
  algorithmVersionCode!: string;

  @ApiPropertyOptional({ nullable: true, description: '仅已提交 lottery 批次回显' })
  randomSeedReveal!: string | null;

  @ApiPropertyOptional({ nullable: true })
  committedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  voidReason!: string | null;

  @ApiPropertyOptional({ nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: [AppActivityAllocationCandidateDto] })
  candidates!: AppActivityAllocationCandidateDto[];
}

export class AppActivityAllocationCommandReceiptDto {
  @ApiProperty({ enum: ['prepare', 'commit', 'void'] })
  commandCode!: string;

  @ApiProperty()
  responseHash!: string;

  @ApiProperty({ type: () => AppActivityAllocationBatchDto })
  @Type(() => AppActivityAllocationBatchDto)
  batch!: AppActivityAllocationBatchDto;
}

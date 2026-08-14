import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AppManagedActivityAllocationParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

export class AppManagedActivityAllocationBatchParamsDto extends AppManagedActivityAllocationParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '已冻结的分配批次 ID' })
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
    type: String,
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
  @ApiProperty({ description: '候选人的永久参与身份 ID' })
  participationIdentityId!: string;

  @ApiProperty({ description: '候选人所属报名记录 ID' })
  registrationId!: string;

  @ApiProperty({ description: '服务器受理该报名修订的时间' })
  acceptedAt!: Date;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '仅 qualification_rank 产生四位小数分数',
  })
  qualificationScore!: string | null;

  @ApiProperty({ enum: ['pass', 'warn', 'fail'], description: '冻结时的目标资格结论' })
  qualificationResultCode!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'integer',
    minimum: 1,
    description: '已提交 lottery 的抽签顺序',
  })
  lotteryOrder!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['allocated', 'waitlisted', 'not_selected'],
    description: '提交后的不可变分配结果',
  })
  resultCode!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'integer',
    minimum: 1,
    description: '原岗位内的稳定候补序号',
  })
  waitlistRank!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '仅 waitlisted 候选人的原岗位锚点',
  })
  waitlistPositionId!: string | null;
}

export class AppActivityAllocationBatchDto {
  @ApiProperty({ description: '分配批次 ID' })
  batchId!: string;

  @ApiProperty({ description: '活动 ID' })
  activityId!: string;

  @ApiProperty({ description: '批次目标场次 ID' })
  sessionId!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '批次目标岗位；null 表示场次级批次',
  })
  positionId!: string | null;

  @ApiProperty({ enum: ['qualification_rank', 'lottery'], description: '冻结的分配算法模式' })
  modeCode!: string;

  @ApiProperty({ enum: ['preparing', 'committed', 'voided'], description: '批次当前生命周期状态' })
  statusCode!: string;

  @ApiProperty({ description: '冻结时使用的算法版本' })
  algorithmVersionCode!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '仅已提交 lottery 批次回显的服务端 seed',
  })
  randomSeedReveal!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: '提交完成时间',
  })
  committedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: '作废原因' })
  voidReason!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: '作废完成时间',
  })
  voidedAt!: Date | null;

  @ApiProperty({
    type: [AppActivityAllocationCandidateDto],
    description: '安全可读的冻结候选人与结果',
  })
  candidates!: AppActivityAllocationCandidateDto[];
}

export class AppActivityAllocationCommandReceiptDto {
  @ApiProperty({ enum: ['prepare', 'commit', 'void'], description: '已执行或重放的命令类型' })
  commandCode!: string;

  @ApiProperty({ description: '命令回执的稳定 SHA-256 哈希' })
  responseHash!: string;

  @ApiProperty({ type: () => AppActivityAllocationBatchDto, description: '命令对应的安全批次视图' })
  @Type(() => AppActivityAllocationBatchDto)
  batch!: AppActivityAllocationBatchDto;
}

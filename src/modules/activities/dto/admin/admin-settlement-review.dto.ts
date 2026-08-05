import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

/** Admin 面专属 DTO；不被 App DTO 继承，也不向 App 面返回。 */
export class AdminSettlementReviewParamsDto {
  @ApiProperty({ description: 'AttendanceSettlementVersion.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  id!: string;
}

export class AdminSettlementApproveCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的审核幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '审核人确认过的封场凭证标识' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  evidenceSealId!: string;

  @ApiProperty({ minimum: 0, description: '审核人确认过的证据修订号' })
  @IsInt()
  @Min(0)
  evidenceRevision!: number;

  @ApiProperty({ minimum: 0, description: '审核人确认过的人口修订号' })
  @IsInt()
  @Min(0)
  populationRevision!: number;

  @ApiProperty({ minimum: 0, description: '审核人确认过的工作流修订号' })
  @IsInt()
  @Min(0)
  workflowRevision!: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: '审核人确认过的不可变版本内容摘要哈希',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  contentHash!: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500, description: '通过时可选的审核备注' })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class AdminSettlementReturnCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的审核幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '审核人确认过的封场凭证标识' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  evidenceSealId!: string;

  @ApiProperty({ minimum: 0, description: '审核人确认过的证据修订号' })
  @IsInt()
  @Min(0)
  evidenceRevision!: number;

  @ApiProperty({ minimum: 0, description: '审核人确认过的人口修订号' })
  @IsInt()
  @Min(0)
  populationRevision!: number;

  @ApiProperty({ minimum: 0, description: '审核人确认过的工作流修订号' })
  @IsInt()
  @Min(0)
  workflowRevision!: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: '审核人确认过的不可变版本内容摘要哈希',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  contentHash!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '退回原因；不能是空白文本' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

export class AdminSettlementReviewResponseDto {
  @ApiProperty({ description: '所属活动标识' })
  activityId!: string;

  @ApiProperty({ description: '所属结算运行标识' })
  settlementRunId!: string;

  @ApiProperty({ description: '被审核的不可变结算版本标识' })
  settlementVersionId!: string;

  @ApiProperty({ minimum: 1, description: '被审核的不可变结算版本号' })
  settlementVersion!: number;

  @ApiProperty({ enum: ['first', 'final'], description: '一审或终审阶段' })
  stageCode!: 'first' | 'final';

  @ApiProperty({ enum: ['approve', 'return'], description: '通过或退回动作' })
  actionCode!: 'approve' | 'return';

  @ApiProperty({ description: 'append-only 审核动作标识' })
  reviewActionId!: string;

  @ApiProperty({ description: '动作前的结算运行状态' })
  runStatusBefore!: string;

  @ApiProperty({ description: '动作后的结算运行状态' })
  runStatusAfter!: string;

  @ApiProperty({ description: '动作后的结算版本状态' })
  versionStatusAfter!: string;

  @ApiProperty({ nullable: true, type: String, description: '终审通过创建或恢复的账本批次标识' })
  ledgerPostingBatchId!: string | null;

  @ApiProperty({ nullable: true, type: String, description: '终审账本批次状态；非终审通过时为空' })
  ledgerPostingBatchStatus!: string | null;

  @ApiProperty({ description: '是否命中同一幂等键的既有审核结果' })
  replayed!: boolean;
}

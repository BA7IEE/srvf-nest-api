import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** App 面专属 DTO；不从任何 Admin DTO 派生。 */
export class AppSettlementGenerateCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的结算草稿幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;
}

export class AppSettlementSubmitCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的结算提交幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minimum: 1, description: '客户端确认过的 working draft 版本号' })
  @IsInt()
  @Min(1)
  expectedDraftVersion!: number;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '客户端确认过的 EvidenceSeal.id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  evidenceSealId!: string;

  @ApiProperty({ example: true, description: '已确认将不可变版本提交送审；只能为 true' })
  @IsBoolean()
  @Equals(true)
  confirmation!: boolean;
}

/** returned 版本重新提交时的显式确认锚点；不复用 Admin DTO。 */
export class AppSettlementResubmitCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的重新提交幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '客户端确认过的 EvidenceSeal.id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  evidenceSealId!: string;

  @ApiProperty({ minimum: 1, description: '客户端确认过的 returned 后当前 working draft 版本号' })
  @IsInt()
  @Min(1)
  expectedDraftVersion!: number;

  @ApiProperty({ example: true, description: '已确认将新版本重新提交送审；只能为 true' })
  @IsBoolean()
  @Equals(true)
  confirmation!: boolean;
}

export class AppSettlementCloseCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的关账幂等键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '客户端确认过的已生效结算版本 id' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  expectedSettlementVersionId!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: 64,
    description: '客户端确认过的 committed posting batch id',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  expectedPostingBatchId!: string;
}

export class AppSettlementGenerateResponseDto {
  @ApiProperty({ enum: ['draft', 'job'], description: '同步草稿或异步任务分支' })
  outcome!: 'draft' | 'job';

  @ApiProperty({ description: '活动标识' })
  activityId!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '草稿所属结算运行标识；异步任务时为空',
  })
  settlementRunId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '同步生成的草稿版本标识；异步任务时为空',
  })
  settlementVersionId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '同步生成的草稿版本号；异步任务时为空',
  })
  settlementVersion!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '草稿包含的人员数；异步任务时为空',
  })
  personCount!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '草稿覆盖的场次参与数；异步任务时为空',
  })
  sessionParticipationCount!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '异步草稿任务标识；同步草稿时为空',
  })
  jobId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '异步草稿任务状态；同步草稿时为空',
  })
  statusCode!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '异步草稿任务总项数；同步草稿时为空',
  })
  total!: number | null;

  @ApiProperty({ description: '是否命中同一幂等键的既有结果' })
  replayed!: boolean;
}

export class AppSettlementSubmitResponseDto {
  @ApiProperty({ description: '活动标识' })
  activityId!: string;

  @ApiProperty({ description: '结算运行标识' })
  settlementRunId!: string;

  @ApiProperty({ description: '新建不可变结算版本标识' })
  settlementVersionId!: string;

  @ApiProperty({ minimum: 1, description: '新建不可变结算版本号' })
  settlementVersion!: number;

  @ApiProperty({ nullable: true, type: String, description: '被本次提交替代的上一个版本标识' })
  priorVersionId!: string | null;

  @ApiProperty({ nullable: true, type: String, description: '本次固化来源的草稿版本标识' })
  draftVersionId!: string | null;

  @ApiProperty({ description: '不可变版本引用的封场凭证标识' })
  evidenceSealId!: string;

  @ApiProperty({ minimum: 0, description: '冻结的证据修订号' })
  evidenceRevision!: number;

  @ApiProperty({ minimum: 0, description: '冻结的结算人口修订号' })
  populationRevision!: number;

  @ApiProperty({ minimum: 0, description: '冻结的活动工作流修订号' })
  workflowRevision!: number;

  @ApiProperty({ minimum: 1, description: '冻结的封场凭证修订号' })
  sealRevision!: number;

  @ApiProperty({ minimum: 0, description: '不可变版本的人员数' })
  personCount!: number;

  @ApiProperty({ minimum: 0, description: '不可变版本的场次参与数' })
  sessionParticipationCount!: number;

  @ApiProperty({ minimum: 0, description: '不可变版本的服务段数' })
  serviceSegmentCount!: number;

  @ApiProperty({ minimum: 0, description: '不可变结算结果行数' })
  resultRowCount!: number;

  @ApiProperty({ description: '不可变版本内容摘要哈希' })
  contentHash!: string;

  @ApiProperty({ description: '是否命中同一幂等键的既有结果' })
  replayed!: boolean;
}

export class AppSettlementCloseGapDto {
  @ApiProperty({ description: '未通过关账检查的缺口标识' })
  gapCode!: string;

  @ApiProperty({ description: '对应的业务错误码' })
  bizCode!: number;

  @ApiProperty({ description: '可展示的缺口说明' })
  message!: string;

  @ApiProperty({ minimum: 0, description: '命中该缺口的数量' })
  count!: number;
}

export class AppSettlementCloseCheckDto {
  @ApiProperty({ description: '关账检查标识' })
  gapCode!: string;

  @ApiProperty({ description: '对应的业务错误码' })
  bizCode!: number;

  @ApiProperty({ description: '该检查是否通过' })
  passed!: boolean;

  @ApiProperty({ minimum: 0, description: '该检查关联的数量' })
  count!: number;
}

export class AppSettlementCloseResponseDto {
  @ApiProperty({ enum: ['closed', 'blocked'], description: '关账成功或被检查缺口阻断' })
  outcome!: 'closed' | 'blocked';

  @ApiProperty({ description: '活动标识' })
  activityId!: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: '已关账运行标识；阻断时为空' })
  settlementRunId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '新增关账凭证标识；阻断时为空',
  })
  closureRevisionId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '新增关账凭证修订号；阻断时为空',
  })
  revision!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '关账对应已生效结算版本；阻断时为空',
  })
  settlementVersionId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '关账对应已提交账本批次；阻断时为空',
  })
  postingBatchId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Date,
    format: 'date-time',
    description: '实际关账时间；阻断时为空',
  })
  closedAt!: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Date,
    format: 'date-time',
    description: '最早可归档时间；阻断时为空',
  })
  archiveWaitingUntil!: Date | null;

  @ApiProperty({ type: () => [AppSettlementCloseCheckDto], description: '全部关账检查的安全摘要' })
  checks!: AppSettlementCloseCheckDto[];

  @ApiProperty({ type: () => [AppSettlementCloseGapDto], description: '阻断关账的缺口安全摘要' })
  gaps!: AppSettlementCloseGapDto[];

  @ApiPropertyOptional({
    nullable: true,
    type: Boolean,
    description: '成功关账时是否命中幂等重放；阻断时为空',
  })
  replayed!: boolean | null;
}

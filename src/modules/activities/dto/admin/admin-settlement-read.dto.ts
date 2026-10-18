import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsString, MaxLength, MinLength } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AdminSettlementVersionReadParamsDto {
  @ApiProperty({ description: 'AttendanceSettlementVersion.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  settlementVersionId!: string;
}

export class AdminSettlementPostingBatchParamsDto {
  @ApiProperty({ description: 'AttendanceSettlementVersion.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  id!: string;
}

export class AdminMemberParticipationLedgerParamsDto {
  @ApiProperty({ description: 'Member.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  memberId!: string;
}

export class ListAdminAttendanceSettlementsQueryDto extends PaginationQueryDto {}

export class ListAdminMemberParticipationLedgerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按 ledgerDate 过滤下界（含，ISO 8601 日期）',
    format: 'date',
  })
  @OmittableOnly()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: '按 ledgerDate 过滤上界（含，ISO 8601 日期）',
    format: 'date',
  })
  @OmittableOnly()
  @IsDateString()
  dateTo?: string;
}

export class AdminAttendanceSettlementListItemDto {
  @ApiProperty()
  settlementVersionId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  activityTitle!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty()
  statusCode!: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  submittedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  postingBatchStatusCode!: string | null;
}

export class AdminSettlementReviewGapDto {
  @ApiProperty()
  gapCode!: string;

  @ApiProperty({ minimum: 0 })
  count!: number;
}

export class AdminSettlementReviewVersionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty()
  evidenceSealId!: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  submittedAt!: Date | null;

  @ApiProperty()
  contentHash!: string;

  @ApiProperty({ minimum: 0 })
  evidenceRevision!: number;

  @ApiProperty({ minimum: 0 })
  populationRevision!: number;

  @ApiProperty({ minimum: 0 })
  workflowRevision!: number;

  @ApiProperty({ minimum: 0 })
  personCount!: number;

  @ApiProperty({ minimum: 0 })
  sessionParticipationCount!: number;

  @ApiProperty({ minimum: 0 })
  serviceSegmentCount!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  priorVersionId!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  returnFromStage!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  returnReason!: string | null;
}

export class AdminSettlementReviewDiffDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  priorVersionId!: string | null;

  @ApiProperty({ minimum: 0 })
  addedItemCount!: number;

  @ApiProperty({ minimum: 0 })
  removedItemCount!: number;

  @ApiProperty({ minimum: 0 })
  changedItemCount!: number;
}

export class AdminSettlementSealRevisionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ minimum: 1 })
  sealRevision!: number;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty({ minimum: 0 })
  evidenceRevision!: number;

  @ApiProperty({ minimum: 0 })
  populationRevision!: number;

  @ApiProperty({ minimum: 0 })
  workflowRevision!: number;

  @ApiProperty({ minimum: 0 })
  manualReviewPendingCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  sealedAt!: Date;
}

export class AdminContributionProofEvaluationDto {
  @ApiProperty({ description: '参与身份 ID，不按队员合并' })
  participationIdentityId!: string;
  @ApiProperty({ description: '冻结贡献政策版本 ID' })
  policyVersionId!: string;
  @ApiProperty({ description: '冻结政策定义 SHA-256' })
  definitionHash!: string;
  @ApiProperty({ description: '冻结评价器版本' })
  evaluatorVersion!: number;
  @ApiProperty({ description: '发布快照中的考勤角色' })
  attendanceRoleCode!: string;
  @ApiProperty({ description: '独立认定类别，不从志愿小时反推' })
  timeCategoryCode!: string;
  @ApiProperty({ description: '合并同一评价单元后的非负整秒' })
  durationSeconds!: number;
  @ApiProperty({ description: '政策计算分值，固定两位小数文本' })
  calculatedPoints!: string;
  @ApiProperty({ description: '政策认定分值，无人工覆盖' })
  recognizedPoints!: string;
  @ApiProperty({ description: '冻结评价解释码，不含政策完整配置' })
  explanationCode!: string;
}

export class AdminContributionProofDto {
  @ApiProperty({ description: '冻结计算制度，旧版本省略整个证明字段', enum: ['policy_v1'] })
  regimeCode!: string;
  @ApiProperty({ description: '贡献未准备或来源已陈旧；不能将空值当零分' })
  pending!: boolean;
  @ApiProperty({ description: '完整同版本证明 ID；pending 时为空', type: String, nullable: true })
  revisionId!: string | null;
  @ApiProperty({ description: '真实证明来源；pending 时为空', type: String, nullable: true })
  sourceKindCode!: string | null;
  @ApiProperty({ description: '冻结政策选择摘要', type: String, nullable: true })
  selectionHash!: string | null;
  @ApiProperty({ description: '冻结贡献来源集合摘要', type: String, nullable: true })
  sourceSetHash!: string | null;
  @ApiProperty({ description: '冻结评价集合摘要', type: String, nullable: true })
  evaluationSetHash!: string | null;
  @ApiProperty({
    description: '全证明认定总分；pending 时为空而非默认零',
    type: String,
    nullable: true,
  })
  recognizedPointsTotal!: string | null;
  @ApiProperty({ description: '完整评价集合数量；pending 时为空', type: Number, nullable: true })
  evaluationCount!: number | null;
  @ApiProperty({ description: '解释预览仅显示前100项；为true时不能当全量明细' })
  hasMore!: boolean;
  @ApiProperty({
    description: '按评价单元稳定排序的解释预览，不返回来源大JSON',
    type: () => [AdminContributionProofEvaluationDto],
    maxItems: 100,
  })
  evaluations!: AdminContributionProofEvaluationDto[];
}

export class AdminSettlementReviewDetailDto {
  @ApiPropertyOptional({
    description: '同一审核版本的冻结贡献证明；历史legacy省略',
    type: () => AdminContributionProofDto,
  })
  contributionProof?: AdminContributionProofDto;
  @ApiProperty({ type: AdminSettlementReviewVersionDto })
  version!: AdminSettlementReviewVersionDto;

  @ApiProperty({ type: AdminSettlementReviewDiffDto })
  diff!: AdminSettlementReviewDiffDto;

  @ApiProperty({ type: () => [AdminSettlementSealRevisionDto] })
  sealRevisions!: AdminSettlementSealRevisionDto[];

  @ApiProperty({ type: () => [AdminSettlementReviewGapDto] })
  gaps!: AdminSettlementReviewGapDto[];
}

export class AdminSettlementPostingBatchDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  settlementVersionId!: string;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty({ minimum: 0 })
  preparedCount!: number;

  @ApiProperty({ minimum: 0 })
  totalCount!: number;

  @ApiProperty({ minimum: 0 })
  failureCount!: number;

  @ApiProperty()
  effective!: boolean;

  @ApiProperty()
  effectiveLabel!: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  preparedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  committedAt!: Date | null;
}

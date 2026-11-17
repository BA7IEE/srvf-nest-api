import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../../common/dto/pagination.dto';

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

export class ListAdminAttendanceSettlementsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '活动标题或版本提交人的 username/nickname，忽略大小写',
    maxLength: 200,
  })
  @OmittableOnly()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: '仅搜索活动标题，忽略大小写', maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MaxLength(200)
  activityQ?: string;

  @ApiPropertyOptional({ description: '精确活动 ID', minLength: 8, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId?: string;

  @ApiPropertyOptional({
    description: '新版版本状态；approved 不等于已入账。draft 不进入审核列表',
    enum: ['draft', 'submitted', 'returned', 'approved', 'voided'],
  })
  @OmittableOnly()
  @IsIn(['draft', 'submitted', 'returned', 'approved', 'voided'])
  statusCode?: string;

  @ApiPropertyOptional({
    enum: ['first', 'final'],
    description: '仅筛选等待一审/终审的 submitted 版本，按该版本的审核动作判断',
  })
  @OmittableOnly()
  @IsIn(['first', 'final'])
  reviewStage?: string;

  @ApiPropertyOptional({
    description: '活动承办组织，始终与授权范围求交',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ description: '有 organizationId 时包含下属组织', default: false })
  @OmittableOnly()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: 'submittedAt 下界，ISO8601，含边界' })
  @OmittableOnly()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'submittedAt 上界，ISO8601，含边界；纯日期按 UTC 当日零点解释',
  })
  @OmittableOnly()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: '按需返回活动摘要；默认省略', enum: ['activity'] })
  @OmittableOnly()
  @IsIn(['activity'])
  expand?: string;
}

export class AdminSettlementActivitySummaryDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  title!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startAt!: Date;
  @ApiProperty({ type: String })
  organizationId!: string;
}

export class AdminSettlementSubmitterDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  username!: string;
  @ApiProperty({ type: String, nullable: true })
  nickname!: string | null;
}

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

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['first', 'final'],
    description: 'submitted 版本当前待审阶段，其他状态为null；不是操作授权',
  })
  reviewStage!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  submittedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  postingBatchStatusCode!: string | null;

  @ApiProperty({
    type: () => AdminSettlementSubmitterDto,
    nullable: true,
    description: '该版本的创建/提交人；不是当前活动负责人',
  })
  submittedBy!: AdminSettlementSubmitterDto | null;

  @ApiPropertyOptional({
    type: () => AdminSettlementActivitySummaryDto,
    description: '仅 expand=activity 返回当前活动摘要，不是版本冻结内容',
  })
  activity?: AdminSettlementActivitySummaryDto;
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

export class AdminSettlementResultMemberDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  memberNo!: string;
  @ApiProperty()
  realName!: string;
  @ApiProperty({ type: String, nullable: true })
  nickname!: string | null;
  @ApiProperty()
  label!: string;
}

export class AdminSettlementResultSessionDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty()
  name!: string;
}

export class AdminSettlementFrozenTimeBucketDto {
  @ApiProperty()
  categoryCode!: string;
  @ApiProperty({ type: Number, nullable: true })
  calculatedSeconds!: number | null;
  @ApiProperty()
  recognizedSeconds!: number;
}

export class AdminSettlementFrozenResultDto {
  @ApiProperty({
    enum: ['legacy', 'ready', 'pending'],
    description: '原生分值来自本版本完整贡献证明，不对100条预览求和',
  })
  contributionResultState!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '本身份全部原生评价单元的计算分值，未准备为null',
  })
  nativeCalculatedContributionPoints!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '本身份全部原生评价单元的认定分值；完整证明中无适用评价为0.00',
  })
  nativeRecognizedContributionPoints!: string | null;
  @ApiProperty({
    enum: ['legacy', 'ready', 'pending'],
    description:
      'legacy 使用冻结遗留小时；ready 使用版本绑定的已提交分类或正式更正替换值；pending 不把缺证明显示为零',
  })
  timeResultState!: string;
  @ApiProperty({
    type: () => [AdminSettlementFrozenTimeBucketDto],
    nullable: true,
    description:
      '请求版本自身或其不可变绑定的时间分类，不读当前指针；更正仅展示正式替换值，calculatedSeconds为空。不含来源JSON、政策配置和自由文本',
  })
  timeBuckets!: AdminSettlementFrozenTimeBucketDto[] | null;
  @ApiProperty({ description: '该版本的人员结果修订 ID，不是当前草稿行' })
  id!: string;
  @ApiProperty({ description: '同一队员多场次保留不同身份，不合并或截断' })
  participationIdentityId!: string;
  @ApiProperty()
  revision!: number;
  @ApiProperty()
  resultCode!: string;
  @ApiProperty()
  lateFlag!: boolean;
  @ApiProperty()
  earlyLeaveFlag!: boolean;
  @ApiProperty({ description: '版本冻结的认定小时文本；不等于已正式生效的志愿小时' })
  recognizedServiceHours!: string;
  @ApiProperty({ description: '版本冻结的计算小时文本；不从当前打卡重算' })
  calculatedServiceHours!: string;
  @ApiProperty({
    description: '版本冻结的遗留认定分值；policy_v1 的正式贡献以 contributionProof 为准',
  })
  recognizedContributionPoints!: string;
  @ApiProperty()
  calculatedContributionPoints!: string;
  @ApiProperty({ description: '认定与计算存在调整；不返回自由文本说明' })
  hasAdjustment!: boolean;
  @ApiProperty({
    type: () => AdminSettlementResultMemberDto,
    description: '当前人员最小展示资料；数值结果仍绑定历史版本，不宣称人员姓名为冻结快照',
  })
  member!: AdminSettlementResultMemberDto;
  @ApiProperty({ type: () => AdminSettlementResultSessionDto })
  session!: AdminSettlementResultSessionDto;
}

export class AdminSettlementFrozenResultsPageDto extends PageResultDto<AdminSettlementFrozenResultDto> {
  @ApiProperty({ type: () => [AdminSettlementFrozenResultDto] })
  declare items: AdminSettlementFrozenResultDto[];
}

export class AdminSettlementReviewDetailDto {
  @ApiProperty({
    description:
      '按身份稳定分页的本版本冻结结果，total 为场次参与身份数；draft 返回 null，不把可变草稿冒充冻结结果',
    type: () => AdminSettlementFrozenResultsPageDto,
    nullable: true,
  })
  results!: AdminSettlementFrozenResultsPageDto | null;

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

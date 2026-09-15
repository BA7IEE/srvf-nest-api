import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppManagedActivityParamsDto } from './app-managed-activity.dto';

const CATEGORIES = ['volunteer_service', 'training', 'organization', 'non_creditable'] as const;

export class AppTimeShadowCategoryDto {
  @ApiProperty({ description: '指定时长修订中的桶 ID，可用于既有来源下钻' })
  bucketId!: string;
  @ApiProperty({ description: '冻结分类；非志愿类别不并入志愿时长' })
  categoryCode!: string;
  @ApiProperty({ description: '新计算秒数；未知保留 null', type: Number, nullable: true })
  calculatedSeconds!: number | null;
  @ApiProperty({ description: '新认定秒数' })
  recognizedSeconds!: number;
  @ApiProperty({ description: '存在人工认定，不返回原始理由' })
  manuallyAdjusted!: boolean;
}

export class AppTimeShadowItemDto {
  @ApiProperty({ description: '参与身份 ID，不按成员合并' })
  participationIdentityId!: string;
  @ApiProperty({
    description: '数值比较结果，不构成放行',
    enum: ['matched', 'different', 'not_comparable'],
  })
  status!: string;
  @ApiProperty({ description: '已证事实或 unexplained；不自动接受差异', type: [String] })
  reasons!: string[];
  @ApiProperty({ description: '旧计算小时精确换算为秒；缺项为 null', type: Number, nullable: true })
  legacyCalculatedSeconds!: number | null;
  @ApiProperty({ description: '旧认定小时精确换算为秒；缺项为 null', type: Number, nullable: true })
  legacyRecognizedSeconds!: number | null;
  @ApiProperty({
    description: '新志愿计算秒减旧计算秒；不可比较为 null',
    type: Number,
    nullable: true,
  })
  calculatedDifferenceSeconds!: number | null;
  @ApiProperty({
    description: '新志愿认定秒减旧认定秒；不可比较为 null',
    type: Number,
    nullable: true,
  })
  recognizedDifferenceSeconds!: number | null;
  @ApiProperty({
    description: '该身份各分类桶，不混合非志愿类别',
    type: [AppTimeShadowCategoryDto],
  })
  categories!: AppTimeShadowCategoryDto[];
}

export class AppTimeShadowPageDto extends PageResultDto<AppTimeShadowItemDto> {
  @ApiProperty({ description: '按参与身份稳定排序的本页结果', type: [AppTimeShadowItemDto] })
  declare items: AppTimeShadowItemDto[];
}

export class AppTimeShadowSummaryDto {
  @ApiProperty({ description: '双方身份并集总数' })
  total!: number;
  @ApiProperty({ description: '精确相等身份数，不代表政策批准' })
  matched!: number;
  @ApiProperty({ description: '可比较但存在差额身份数' })
  different!: number;
  @ApiProperty({ description: '不可比较身份数' })
  notComparable!: number;
  @ApiProperty({ description: '双方皆空，不能作为零差异验收' })
  empty!: boolean;
}

export class AppTimeShadowReportDto {
  @ApiProperty({ description: '报告格式版本', enum: [1] })
  formatVersion!: number;
  @ApiProperty({ description: '比较器版本', enum: [1] })
  comparatorVersion!: number;
  @ApiProperty({ description: '活动 ID' })
  activityId!: string;
  @ApiProperty({ description: '同链结算 run ID' })
  settlementRunId!: string;
  @ApiProperty({ description: '明确旧提交版本 ID，绝不各取 latest' })
  settlementVersionId!: string;
  @ApiProperty({ description: '明确 submitted 时长修订 ID' })
  timeRevisionId!: string;
  @ApiProperty({ description: '旧版本已存内容 hash，仅作版本锚，不声称已重算验证' })
  legacyContentHash!: string;
  @ApiProperty({ description: 'D4 冻结草稿 hash，与旧提交 hash 分开' })
  draftContentHash!: string;
  @ApiProperty({ description: 'D4 来源集合 hash' })
  sourceSetHash!: string;
  @ApiProperty({ description: 'D4 桶集合 hash' })
  bucketContentHash!: string;
  @ApiProperty({ description: '完整比较输入指纹；跨页不一致必须拒绝拼接' })
  inputFingerprint!: string;
  @ApiProperty({ description: '完整集合摘要，非当前页摘要', type: AppTimeShadowSummaryDto })
  summary!: AppTimeShadowSummaryDto;
  @ApiProperty({ description: '标准分页结果', type: AppTimeShadowPageDto })
  resultPage!: AppTimeShadowPageDto;
}

export class AppTimeSettlementAllocationParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  allocationRevisionId!: string;
}

export class AppTimeSettlementRevisionParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timeRevisionId!: string;
}

export class AppTimeSettlementSourcesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bucketId?: string;
}

// App-only DTOs. No mapped types or Admin inheritance; the service parses the exact command.
export class AppTimeSettlementCommandDto {
  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedDraftVersion!: number;
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  expectedEvidenceSealId!: string;
}

export class AppPrepareTimeSettlementDto extends AppTimeSettlementCommandDto {
  @ApiProperty({ minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedTimeRevision!: number;
}

export class AppSubmitTimeSettlementDto extends AppTimeSettlementCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timeRevisionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedBucketContentHash!: string;
}

export class AppTimeSettlementManualSliceDto {
  @ApiProperty({ enum: CATEGORIES })
  @IsIn(CATEGORIES)
  categoryCode!: (typeof CATEGORIES)[number];
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  startAt!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  endAt!: string;
}

export class AppTimeSettlementSliceDto extends AppTimeSettlementManualSliceDto {
  @ApiProperty({ enum: ['service_segment'] })
  intervalKindCode!: 'service_segment';
}

export class AppRecognizeTimeSettlementDto extends AppTimeSettlementCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sourceSegmentId!: string;
  @ApiProperty({ minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedEvidenceRevision!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedPopulationRevision!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedWorkflowRevision!: number;
  @ApiProperty({ enum: ['automatic', 'manual'] })
  @IsIn(['automatic', 'manual'])
  recognitionModeCode!: 'automatic' | 'manual';
  @ApiProperty({ type: [String], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  evidenceAttachmentIds!: string[];
  @ApiPropertyOptional({
    description: '人工认定必填；自动认定禁止携带',
    minLength: 1,
    maxLength: 1024,
  })
  @ValidateIf((row: AppRecognizeTimeSettlementDto) => row.recognitionModeCode === 'manual')
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  manualReason?: string;
  @ApiPropertyOptional({
    description: '人工认定必填；自动认定禁止携带',
    type: () => [AppTimeSettlementManualSliceDto],
    minItems: 1,
    maxItems: 500,
  })
  @ValidateIf((row: AppRecognizeTimeSettlementDto) => row.recognitionModeCode === 'manual')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AppTimeSettlementManualSliceDto)
  slices?: AppTimeSettlementManualSliceDto[];
}

export class AppTimeSettlementAllocationResultDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty() activityId!: string;
  @ApiProperty() allocationRevisionId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() sourceSegmentId!: string;
  @ApiProperty() sourceSegmentRevision!: number;
  @ApiProperty({ enum: ['automatic', 'manual'] }) recognitionModeCode!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) allocationHash!: string;
  @ApiProperty() sliceCount!: number;
  @ApiProperty() evidenceCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AppTimeSettlementResultDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty() activityId!: string;
  @ApiProperty() timeRevisionId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['draft', 'submitted'] }) kindCode!: string;
  @ApiProperty() settlementRunId!: string;
  @ApiProperty() settlementVersionId!: string;
  @ApiProperty() settlementVersion!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) contentHash!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) bucketContentHash!: string;
  @ApiProperty() bucketCount!: number;
  @ApiProperty() sourceCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AppTimeSettlementRevisionDto {
  @ApiProperty() activityId!: string;
  @ApiProperty() timeRevisionId!: string;
  @ApiProperty() settlementRunId!: string;
  @ApiProperty() settlementVersionId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['draft', 'submitted'] }) kindCode!: string;
  @ApiProperty({ type: String, nullable: true }) sourceDraftTimeRevisionId!: string | null;
  @ApiProperty() evidenceSealId!: string;
  @ApiProperty() evidenceRevision!: number;
  @ApiProperty() populationRevision!: number;
  @ApiProperty() workflowRevision!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) bucketContentHash!: string;
  @ApiProperty() bucketCount!: number;
  @ApiProperty() sourceCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AppTimeSettlementRunDto {
  @ApiProperty() settlementRunId!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty({ type: Number, nullable: true }) currentDraftVersion!: number | null;
  @ApiProperty({ type: Number, nullable: true }) currentSubmittedVersion!: number | null;
}
export class AppTimeSettlementDraftDto {
  @ApiProperty() settlementVersionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true }) evidenceSealId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) evidenceRevision!: number | null;
  @ApiProperty({ type: Number, nullable: true }) populationRevision!: number | null;
  @ApiProperty({ type: Number, nullable: true }) workflowRevision!: number | null;
  @ApiProperty() sealCurrent!: boolean;
}
export class AppTimeSettlementBlockerDto {
  @ApiProperty() code!: string;
  @ApiProperty({ minimum: 1 }) count!: number;
}
export class AppTimeSettlementWorkbenchDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: () => AppTimeSettlementRunDto, nullable: true })
  run!: AppTimeSettlementRunDto | null;
  @ApiProperty({ type: () => AppTimeSettlementDraftDto, nullable: true })
  draft!: AppTimeSettlementDraftDto | null;
  @ApiProperty({ type: () => AppTimeSettlementRevisionDto, nullable: true })
  latestRevision!: AppTimeSettlementRevisionDto | null;
  @ApiProperty() ready!: boolean;
  @ApiProperty({ type: () => [AppTimeSettlementBlockerDto] })
  blockers!: AppTimeSettlementBlockerDto[];
}

export class AppTimeSettlementSourceDto {
  @ApiProperty() sourceSegmentId!: string;
  @ApiProperty() participationIdentityId!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() sourceSegmentRevision!: number;
  @ApiProperty() statusCode!: string;
  @ApiProperty() resultCode!: string;
  @ApiProperty({ format: 'date-time' }) checkInAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) checkOutAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) allocationRevisionId!: string | null;
  @ApiProperty() allocationRevision!: number;
  @ApiProperty({ type: String, nullable: true }) exclusionReasonCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) blockerCode!: string | null;
}

export class AppTimeSettlementBucketDto {
  @ApiProperty() bucketId!: string;
  @ApiProperty() timeRevisionId!: string;
  @ApiProperty() participationIdentityId!: string;
  @ApiProperty({ enum: CATEGORIES }) categoryCode!: string;
  @ApiProperty({ type: Number, nullable: true }) calculatedSeconds!: number | null;
  @ApiProperty() recognizedSeconds!: number;
  @ApiProperty({ type: String, nullable: true, pattern: '^[0-9]+$' }) rawCalculatedMilliseconds!:
    | string
    | null;
  @ApiProperty({ pattern: '^[0-9]+$' }) rawRecognizedMilliseconds!: string;
  @ApiProperty({ type: String, nullable: true }) timePolicyVersionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) definitionHash!: string | null;
  @ApiProperty({ type: Number, nullable: true }) evaluatorVersion!: number | null;
  @ApiProperty({ type: Number, nullable: true }) quantumSeconds!: number | null;
  @ApiProperty() hasAdjustment!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['no_valid_segment'] }) emptyReasonCode!:
    | string
    | null;
}
export class AppTimeSettlementBucketSourceDto {
  @ApiProperty() sourceId!: string;
  @ApiProperty() bucketId!: string;
  @ApiProperty() timeRevisionId!: string;
  @ApiProperty() allocationRevisionId!: string;
  @ApiProperty() sourceSegmentId!: string;
  @ApiProperty() sourceSegmentRevision!: number;
  @ApiProperty({ type: String, nullable: true, pattern: '^[0-9]+$' }) rawCalculatedMilliseconds!:
    | string
    | null;
  @ApiProperty({ pattern: '^[0-9]+$' }) rawRecognizedMilliseconds!: string;
}

export class AppTimeLedgerCategoryTotalDto {
  @ApiProperty({ description: '时长分类', enum: CATEGORIES }) categoryCode!: string;
  @ApiProperty({ description: '分类总秒数（精确十进制字符串）', pattern: '^[0-9]+$' })
  recognizedSecondsTotal!: string;
}
export class AppTimeLedgerEntryDto {
  @ApiProperty({ description: '不可变分录ID' }) id!: string;
  @ApiProperty({ description: '冻结来源桶ID' }) bucketId!: string;
  @ApiProperty({ description: '参与身份ID' }) participationIdentityId!: string;
  @ApiProperty({ description: '时长分类', enum: CATEGORIES }) categoryCode!: string;
  @ApiProperty({
    description: '认定秒数，含零值',
    type: 'integer',
    minimum: 0,
    maximum: 2147483647,
  })
  recognizedSeconds!: number;
}
export class AppTimeLedgerPageDto {
  @ApiProperty({ description: '页码', minimum: 1 }) page!: number;
  @ApiProperty({ description: '每页条数', minimum: 1, maximum: 100 }) pageSize!: number;
  @ApiProperty({ description: '分录总条数', minimum: 0, maximum: 8000 }) total!: number;
  @ApiProperty({ description: '分录列表', type: () => [AppTimeLedgerEntryDto] })
  items!: AppTimeLedgerEntryDto[];
}
export class AppTimeLedgerReportDto {
  @ApiProperty({ description: '已提交账本批次ID' }) postingBatchId!: string;
  @ApiProperty({ description: '不可变清单ID' }) manifestId!: string;
  @ApiProperty({ description: '确切分类修订ID' }) timeRevisionId!: string;
  @ApiProperty({ description: '内容格式版本', enum: [1] }) formatVersion!: number;
  @ApiProperty({ description: '账本完整内容指纹', pattern: '^[a-f0-9]{64}$' }) contentHash!: string;
  @ApiProperty({ description: '完整分录条数', minimum: 0, maximum: 8000 }) entryCount!: number;
  @ApiProperty({ description: '全部分类总秒数（不等同于志愿服务时长）', pattern: '^[0-9]+$' })
  recognizedSecondsTotal!: string;
  @ApiProperty({ description: '固定四类汇总，含零值', type: () => [AppTimeLedgerCategoryTotalDto] })
  categories!: AppTimeLedgerCategoryTotalDto[];
  @ApiProperty({ description: '稳定分页的分录', type: () => AppTimeLedgerPageDto })
  resultPage!: AppTimeLedgerPageDto;
}

export class AppTimeSettlementEvidenceDto {
  @ApiProperty() attachmentId!: string;
  @ApiProperty() ordinal!: number;
}
export class AppTimeSettlementRoleMappingDto {
  @ApiProperty() attendanceRoleCode!: string;
  @ApiProperty({ enum: CATEGORIES }) category!: string;
}
export class AppTimeSettlementSpecialIntervalDto {
  @ApiProperty({ enum: ['exclude', 'manual', 'category'] }) mode!: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) category?: string;
}
export class AppTimeSettlementSpecialIntervalsDto {
  @ApiProperty({ type: () => AppTimeSettlementSpecialIntervalDto })
  preparation!: AppTimeSettlementSpecialIntervalDto;
  @ApiProperty({ type: () => AppTimeSettlementSpecialIntervalDto })
  duty!: AppTimeSettlementSpecialIntervalDto;
  @ApiProperty({ type: () => AppTimeSettlementSpecialIntervalDto })
  travel!: AppTimeSettlementSpecialIntervalDto;
}
export class AppTimeSettlementRoundingDto {
  @ApiProperty({ enum: ['floor'] }) mode!: 'floor';
  @ApiProperty() quantumSeconds!: number;
}
export class AppTimeSettlementEvidencePolicyDto {
  @ApiProperty({ type: [String], enum: ['punch_event', 'service_segment', 'attachment'] })
  requiredSources!: string[];
  @ApiProperty() requireManualRecognition!: boolean;
}
export class AppTimeSettlementManualPolicyDto {
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ enum: [true] }) reasonRequired?: true;
  @ApiPropertyOptional() evidenceRequired?: boolean;
}
export class AppTimeSettlementPolicyDto {
  @ApiProperty({ enum: CATEGORIES }) defaultCategory!: string;
  @ApiProperty({ type: () => [AppTimeSettlementRoleMappingDto] })
  roleMappings!: AppTimeSettlementRoleMappingDto[];
  @ApiProperty() allowSplit!: boolean;
  @ApiProperty({ type: () => AppTimeSettlementSpecialIntervalsDto })
  specialIntervals!: AppTimeSettlementSpecialIntervalsDto;
  @ApiProperty({ type: () => AppTimeSettlementRoundingDto })
  rounding!: AppTimeSettlementRoundingDto;
  @ApiProperty({ type: () => AppTimeSettlementEvidencePolicyDto })
  evidence!: AppTimeSettlementEvidencePolicyDto;
  @ApiProperty({ type: () => AppTimeSettlementManualPolicyDto })
  manualAdjustment!: AppTimeSettlementManualPolicyDto;
}
export class AppTimeSettlementAllocationDetailDto {
  @ApiProperty() allocationRevisionId!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() sourceSegmentId!: string;
  @ApiProperty() sourceSegmentRevision!: number;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['automatic', 'manual'] }) recognitionModeCode!: string;
  @ApiProperty() allocationHash!: string;
  @ApiProperty() sliceCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: () => [AppTimeSettlementSliceDto], maxItems: 500 })
  slices!: AppTimeSettlementSliceDto[];
  @ApiProperty({ type: () => [AppTimeSettlementEvidenceDto], maxItems: 500 })
  evidence!: AppTimeSettlementEvidenceDto[];
  @ApiProperty() participationIdentityId!: string;
  @ApiProperty({ type: String, nullable: true }) manualReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) settlementDraftVersionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) settlementEvidenceSealId!: string | null;
  @ApiProperty() policyVersionId!: string;
  @ApiProperty() definitionHash!: string;
  @ApiProperty() evaluatorVersion!: number;
  @ApiProperty({ type: () => AppTimeSettlementPolicyDto }) policy!: AppTimeSettlementPolicyDto;
  @ApiProperty({ format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) effectiveUntil!:
    | string
    | null;
}

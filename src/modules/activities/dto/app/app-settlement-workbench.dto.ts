import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppManagedActivityParamsDto } from './app-managed-activity.dto';

const APP_SETTLEMENT_RESULT_CODES = [
  'present',
  'leave',
  'absent',
  'cancelled',
  'not_selected',
  'waitlist_expired',
  'review_expired',
  'invitation_expired',
  'exempt',
  'early_departure_zero',
] as const;

const APP_SETTLEMENT_EDITABLE_RESULT_CODES = APP_SETTLEMENT_RESULT_CODES.filter(
  (code) => code !== 'early_departure_zero',
);

export class AppSettlementItemParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: 'ActivityParticipationIdentity.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  identityId!: string;
}

export class AppSettlementVersionParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: 'AttendanceSettlementVersion.id', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  versionId!: string;
}

export class AppSettlementItemsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 ActivitySession.id 过滤', minLength: 8, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  session?: string;

  @ApiPropertyOptional({ enum: APP_SETTLEMENT_RESULT_CODES, description: '按已认定结果过滤' })
  @OmittableOnly()
  @IsIn(APP_SETTLEMENT_RESULT_CODES)
  result?: (typeof APP_SETTLEMENT_RESULT_CODES)[number];

  @ApiPropertyOptional({ description: '按队员编号或姓名模糊搜索', maxLength: 100 })
  @OmittableOnly()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class AppSettlementUpdateDraftItemDto {
  @ApiProperty({ minimum: 1, description: '客户端读取到的 currentDraftVersion' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedDraftVersion!: number;

  @ApiProperty({
    enum: APP_SETTLEMENT_EDITABLE_RESULT_CODES,
    description: '负责人认定的结算结果；early_departure_zero 仅由现场事实投影产生',
  })
  @IsIn(APP_SETTLEMENT_EDITABLE_RESULT_CODES)
  resultCode!: (typeof APP_SETTLEMENT_EDITABLE_RESULT_CODES)[number];

  @ApiProperty({ minimum: 0, maximum: 999.99, description: '负责人认定的服务时长' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999.99)
  recognizedServiceHours!: number;

  @ApiProperty({ minimum: 0, maximum: 999.99, description: '负责人认定的贡献值' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999.99)
  recognizedContributionPoints!: number;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '本次负责人调整原因' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppSettlementGapDto {
  @ApiProperty({ description: '可定位的结算缺口码' })
  gapCode!: string;

  @ApiProperty({ minimum: 0, description: '命中该缺口的数量' })
  count!: number;
}

export class AppSettlementRunSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  statusCode!: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  currentDraftVersion!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  currentSubmittedVersion!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  currentPostedVersion!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  currentClosureRevision!: number | null;
}

export class AppSettlementSealSummaryDto {
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
}

export class AppSettlementVersionPointerDto {
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
}

export class AppSettlementClosureSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ minimum: 1 })
  revision!: number;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty()
  settlementVersionId!: string;

  @ApiProperty()
  postingBatchId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  closedAt!: Date;
}

export class AppSettlementWorkbenchResponseDto {
  @ApiProperty()
  activityId!: string;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementRunSummaryDto })
  run!: AppSettlementRunSummaryDto | null;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementSealSummaryDto })
  seal!: AppSettlementSealSummaryDto | null;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementVersionPointerDto })
  draft!: AppSettlementVersionPointerDto | null;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementVersionPointerDto })
  submitted!: AppSettlementVersionPointerDto | null;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementVersionPointerDto })
  posted!: AppSettlementVersionPointerDto | null;

  @ApiPropertyOptional({ nullable: true, type: AppSettlementClosureSummaryDto })
  closure!: AppSettlementClosureSummaryDto | null;

  @ApiProperty({ type: () => [AppSettlementGapDto] })
  gaps!: AppSettlementGapDto[];
}

export class AppSettlementItemSessionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class AppSettlementItemMemberDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  memberNo!: string;

  @ApiProperty()
  displayName!: string;
}

export class AppSettlementItemDto {
  @ApiProperty()
  identityId!: string;

  @ApiProperty({ enum: ['pending', 'determined'] })
  decisionCode!: 'pending' | 'determined';

  @ApiProperty({ type: AppSettlementItemSessionDto })
  session!: AppSettlementItemSessionDto;

  @ApiProperty({ type: AppSettlementItemMemberDto })
  member!: AppSettlementItemMemberDto;

  @ApiPropertyOptional({ nullable: true, type: String, enum: APP_SETTLEMENT_RESULT_CODES })
  resultCode!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  recognizedServiceHours!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  recognizedContributionPoints!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  calculatedServiceHours!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  calculatedContributionPoints!: number | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  adjustmentReason!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Boolean })
  lateFlag!: boolean | null;

  @ApiPropertyOptional({ nullable: true, type: Boolean })
  earlyLeaveFlag!: boolean | null;
}

export class AppSettlementUpdatedDraftItemResponseDto {
  @ApiProperty()
  settlementVersionId!: string;

  @ApiProperty({ minimum: 1 })
  settlementVersion!: number;

  @ApiProperty()
  identityId!: string;

  @ApiProperty({ enum: APP_SETTLEMENT_RESULT_CODES })
  resultCode!: string;

  @ApiProperty()
  recognizedServiceHours!: number;

  @ApiProperty()
  recognizedContributionPoints!: number;

  @ApiProperty()
  calculatedServiceHours!: number;

  @ApiProperty()
  calculatedContributionPoints!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  adjustmentReason!: string | null;

  @ApiProperty()
  lateFlag!: boolean;

  @ApiProperty()
  earlyLeaveFlag!: boolean;
}

export class AppSettlementVersionDetailHeaderDto extends AppSettlementVersionPointerDto {
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

export class AppSettlementVersionDiffDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  priorVersionId!: string | null;

  @ApiProperty({ minimum: 0 })
  addedItemCount!: number;

  @ApiProperty({ minimum: 0 })
  removedItemCount!: number;

  @ApiProperty({ minimum: 0 })
  changedItemCount!: number;
}

export class AppSettlementSealRevisionDto extends AppSettlementSealSummaryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  sealedAt!: Date;
}

export class AppSettlementVersionDetailResponseDto {
  @ApiProperty({ type: AppSettlementVersionDetailHeaderDto })
  version!: AppSettlementVersionDetailHeaderDto;

  @ApiProperty({ type: AppSettlementVersionDiffDto })
  diff!: AppSettlementVersionDiffDto;

  @ApiProperty({ type: () => [AppSettlementSealRevisionDto] })
  sealRevisions!: AppSettlementSealRevisionDto[];
}

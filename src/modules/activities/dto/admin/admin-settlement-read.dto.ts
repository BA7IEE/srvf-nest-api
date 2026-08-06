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

export class AdminSettlementReviewDetailDto {
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

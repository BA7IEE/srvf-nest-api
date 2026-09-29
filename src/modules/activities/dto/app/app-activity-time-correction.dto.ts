import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppManagedActivityParamsDto } from './app-managed-activity.dto';

const CORRECTION_REQUEST_TYPES = [
  'result',
  'service',
  'time',
  'points',
  'person_identity',
  'other',
] as const;

export class AppActivityTimeCorrectionParamsDto extends AppManagedActivityParamsDto {
  @ApiProperty({ description: '不可变更正申请 ID', minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  requestId!: string;
}

/**
 * App 人工提交/重提交入参。变更正文由领域 parser 做 schema v2/v3 的完整闭集
 * 校验；DTO 只负责拒绝非对象与没有业务意义的传输形状。
 */
export class AppSubmitActivityTimeCorrectionDto {
  @ApiProperty({ nullable: true, minLength: 8, maxLength: 64 })
  @ValidateIf((_row, value) => value !== null)
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  participationIdentityId!: string | null;

  @ApiProperty({ enum: CORRECTION_REQUEST_TYPES })
  @IsString()
  @IsIn(CORRECTION_REQUEST_TYPES)
  requestTypeCode!: (typeof CORRECTION_REQUEST_TYPES)[number];

  @ApiProperty({
    description: '更正正文；服务端按 schemaVersion 的严格闭集解析并 canonicalize',
    type: Object,
  })
  @IsObject()
  requestedChangeJson!: Record<string, unknown>;

  @ApiProperty({ minLength: 1, maxLength: 1024 })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  reason!: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @OmittableOnly()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  attachmentIds?: string[];

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

export class AppReviewActivityTimeCorrectionDto {
  @ApiProperty({ enum: ['approve', 'return', 'reject'] })
  @IsString()
  @IsIn(['approve', 'return', 'reject'])
  actionCode!: 'approve' | 'return' | 'reject';

  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedRequestVersion!: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 1024 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  note?: string;
}

export class AppPrepareActivityTimeCorrectionDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  expectedBaseSettlementVersionId!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

export class AppCommitActivityTimeCorrectionDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  expectedBaseSettlementVersionId!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  correctionApplicationId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  postingBatchId!: string;
}

export class AppActivityTimeCorrectionListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '非负责人审核者必须指定其当前有资格查看的精确基础结算版本',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  baseSettlementVersionId?: string;
}

/** The existing page grammar also bounds a proof's immutable source rows to 100 per detail call. */
export class AppActivityTimeCorrectionDetailQueryDto extends PaginationQueryDto {}

export class AppActivityTimeCorrectionSubmitResultDto {
  @ApiProperty() requestId!: string;
  @ApiProperty() requestVersion!: number;
  @ApiProperty() activityId!: string;
  @ApiProperty() settlementRunId!: string;
  @ApiProperty() baseSettlementVersionId!: string;
  @ApiProperty({ nullable: true }) baseResultRevisionId!: string | null;
  @ApiProperty() baseClosureRevision!: number;
  @ApiProperty({ enum: ['pending'] }) statusCode!: string;
  @ApiProperty() replayed!: boolean;
}

/**
 * A resubmit either creates a fresh pending request or accurately reports that
 * the old returned request was voided because its base drifted.  Keeping this
 * discriminated shape prevents a client from mistaking drift for success.
 */
export class AppActivityTimeCorrectionResubmitResultDto {
  @ApiProperty({ enum: ['resubmitted', 'voided'] }) outcome!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional() requestVersion?: number;
  @ApiPropertyOptional() activityId?: string;
  @ApiPropertyOptional() settlementRunId?: string;
  @ApiPropertyOptional() baseSettlementVersionId?: string;
  @ApiPropertyOptional({ nullable: true }) baseResultRevisionId?: string | null;
  @ApiPropertyOptional() baseClosureRevision?: number;
  @ApiPropertyOptional({ enum: ['pending'] }) statusCode?: string;
  @ApiPropertyOptional() replayed?: boolean;
  @ApiPropertyOptional({ nullable: true }) currentSettlementVersionId?: string | null;
}

export class AppActivityTimeCorrectionReviewResultDto {
  @ApiProperty({ enum: ['reviewed', 'voided'] }) outcome!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional() statusCode?: string;
  @ApiPropertyOptional() runStatus?: string;
  @ApiPropertyOptional() reviewedByUserId?: string;
  @ApiPropertyOptional({ nullable: true }) currentSettlementVersionId?: string | null;
  @ApiPropertyOptional() replayed?: boolean;
}

export class AppActivityTimeCorrectionPrepareResultDto {
  @ApiProperty() requestId!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() postingBatchId!: string;
  @ApiProperty() settlementVersionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) requestHash!: string;
  @ApiPropertyOptional({ pattern: '^[0-9a-f]{64}$', nullable: true })
  sourceProofHash!: string | null;
  @ApiProperty() replayed!: boolean;
}

export class AppActivityTimeCorrectionCommitResultDto {
  @ApiProperty() requestId!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() postingBatchId!: string;
  @ApiProperty() settlementVersionId!: string;
  @ApiProperty() settlementVersion!: number;
  @ApiProperty({ enum: ['applied'] }) correctionStatus!: string;
  @ApiProperty({ enum: ['committed'] }) applicationStatus!: string;
  @ApiProperty() replayed!: boolean;
}

export class AppActivityTimeCorrectionListItemDto {
  @ApiProperty() requestId!: string;
  @ApiProperty() requestVersion!: number;
  @ApiProperty() baseSettlementVersionId!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) reviewedAt!: string | null;
}

export class AppActivityTimeCorrectionDetailDto extends AppActivityTimeCorrectionListItemDto {
  @ApiProperty() requestTypeCode!: string;
  @ApiProperty({ type: Object, nullable: true }) requestedChangeJson!: Record<
    string,
    unknown
  > | null;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty({ type: [String], nullable: true }) attachmentIds!: string[] | null;
  @ApiPropertyOptional({ nullable: true }) reviewNote!: string | null;
  @ApiPropertyOptional({ nullable: true }) resubmittedFromRequestId!: string | null;
  @ApiPropertyOptional({ nullable: true }) resubmittedSuccessorRequestId!: string | null;
  @ApiPropertyOptional({ pattern: '^[0-9a-f]{64}$', nullable: true }) sourceProofHash!:
    | string
    | null;
  @ApiProperty({ enum: ['not_frozen', 'frozen'] }) evidenceStatusCode!: string;
  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: '冻结来源快照分页；仅当前合格申请人或审核者可见，单页最多 100 项',
  })
  sourcePage!: {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  } | null;
}

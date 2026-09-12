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
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppManagedActivityParamsDto } from './app-managed-activity.dto';

const CATEGORIES = ['volunteer_service', 'training', 'organization', 'non_creditable'] as const;

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

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class ShadowWindowParamDto {
  @ApiProperty({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' })
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u)
  windowId!: string;
}
export class ShadowCandidateParamDto extends ShadowWindowParamDto {
  @ApiProperty({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' })
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u)
  auditLogId!: string;
}
export class ShadowAttemptParamDto extends ShadowWindowParamDto {
  @ApiProperty({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' })
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u)
  attemptId!: string;
}
export class ShadowEvidencePageQueryDto extends PaginationQueryDto {}

export class ShadowWindowEvidenceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() deploymentDigest!: string;
  @ApiProperty() configDigest!: string;
  @ApiProperty() signedMappingVersion!: string;
  @ApiProperty({ type: String, nullable: true }) registrationReceiptId!: string | null;
  @ApiProperty({ type: String, nullable: true }) manifestHash!: string | null;
  @ApiProperty({ enum: ['registered', 'legacy_unsigned'] }) registrationStatus!:
    | 'registered'
    | 'legacy_unsigned';
}

export class ShadowCandidateEvidenceDto {
  @ApiProperty() auditLogId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() event!: string;
  @ApiProperty({ type: String, nullable: true }) operation!: string | null;
  @ApiProperty({ type: String, nullable: true }) sheetId!: string | null;
  @ApiProperty({ type: String, nullable: true }) activityId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sheetVersion!: number | null;
  @ApiProperty({ type: String, nullable: true }) attemptId!: string | null;
  @ApiProperty({ type: String, nullable: true }) terminalId!: string | null;
  @ApiProperty({ type: String, nullable: true }) terminalStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) expectedRecordCount!: number | null;
  @ApiProperty() comparisonCount!: number;
  @ApiProperty() equalCount!: number;
  @ApiProperty() mismatchCount!: number;
  @ApiProperty() holdCount!: number;
  @ApiProperty() errorCount!: number;
  @ApiProperty({ type: String, nullable: true }) committedFactHash!: string | null;
  @ApiProperty({ type: [String] }) reasonCodes!: string[];
  @ApiProperty() primaryClassification!: string;
  @ApiProperty() rawUnresolved!: boolean;
  @ApiProperty() netUnresolved!: boolean;
  @ApiProperty() missingStart!: boolean;
  @ApiProperty() missingTerminal!: boolean;
  @ApiProperty() notApplicable!: boolean;
  @ApiProperty({ type: String, nullable: true }) dispositionId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) revision!: number | null;
  @ApiProperty({ type: String, nullable: true }) previousDispositionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) decisionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) approvalReceiptId!: string | null;
  @ApiProperty({ type: String, nullable: true }) signedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) approvalReference!: string | null;
  @ApiProperty({ type: String, nullable: true }) basisCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) evidenceHash!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '当前单候选签字锚点；分页不计算，返回null',
  })
  candidateEvidenceHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) signedAt!: string | null;
  @ApiProperty({ enum: ['unsigned', 'current', 'stale_evidence'] }) signatureStatus!:
    | 'unsigned'
    | 'current'
    | 'stale_evidence';
}

export class ShadowWindowSummaryDto {
  @ApiProperty({ type: ShadowWindowEvidenceDto }) window!: ShadowWindowEvidenceDto;
  @ApiProperty() candidateCount!: number;
  @ApiProperty() attemptCount!: number;
  @ApiProperty() terminalCount!: number;
  @ApiProperty() rawMissingStartCount!: number;
  @ApiProperty() rawMissingTerminalCount!: number;
  @ApiProperty() rawUnresolvedCount!: number;
  @ApiProperty() notApplicableCount!: number;
  @ApiProperty() netUnresolvedCount!: number;
  @ApiProperty() netMissingStartCount!: number;
  @ApiProperty() netMissingTerminalCount!: number;
  @ApiProperty() failedCount!: number;
  @ApiProperty() mismatchCount!: number;
  @ApiProperty() holdCount!: number;
  @ApiProperty() errorCount!: number;
  @ApiProperty() sourceOrChainAnomalyCount!: number;
  @ApiProperty() staleSignatureCount!: number;
  @ApiProperty() anomalousReceiptCount!: number;
  @ApiProperty({ enum: ['zero_visible_candidates', 'evidence_visible'] }) observationStatus!:
    | 'zero_visible_candidates'
    | 'evidence_visible';
}

export class ShadowComparisonEvidenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() attemptId!: string;
  @ApiProperty() recordId!: string;
  @ApiProperty() memberId!: string;
  @ApiProperty() classificationCode!: string;
  @ApiProperty() comparable!: boolean;
  @ApiProperty() factHash!: string;
  @ApiProperty() legacySourceHash!: string;
  @ApiProperty({ type: String, nullable: true }) policySourceHash!: string | null;
  @ApiProperty({ type: String, nullable: true }) legacyPoints!: string | null;
  @ApiProperty({ type: String, nullable: true }) policyPoints!: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationSeconds!: number | null;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty() hashAlgorithmCode!: string;
  @ApiProperty() canonicalVersion!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

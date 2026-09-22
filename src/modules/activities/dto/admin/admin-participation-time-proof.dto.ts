import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

const ADMIN_PROOF_CATEGORIES = [
  'legacy_recognized_service',
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;

export class AdminParticipationTimeProofQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'date', example: '2026-01-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  dateFrom!: string;

  @ApiProperty({ format: 'date', example: '2026-12-31' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  dateTo!: string;
}

export class AdminParticipationTimeProofItemDto {
  @ApiProperty({ format: 'date' })
  ledgerDate!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '历史旧账可能早于分类根账，因此可为 null',
  })
  rootManifestId!: string | null;

  @ApiProperty()
  participationIdentityId!: string;

  @ApiProperty({ enum: ADMIN_PROOF_CATEGORIES })
  sourceCategoryCode!: (typeof ADMIN_PROOF_CATEGORIES)[number];

  @ApiProperty()
  sourceEntryId!: string;

  @ApiProperty({ type: String, nullable: true })
  latestCorrectionManifestId!: string | null;

  @ApiProperty({ enum: ['legacy_ledger', 'classified_time_ledger'] })
  sourceMode!: 'legacy_ledger' | 'classified_time_ledger';

  @ApiProperty({ minimum: 0 })
  recognizedSeconds!: number;
}

export class AdminParticipationTimeProofResponseDto {
  @ApiProperty({ example: 1 })
  proofVersion!: 1;

  @ApiProperty({ example: 'activity-time-v1' })
  cutoverReceiptId!: string;

  @ApiProperty({ format: 'date-time' })
  cutoverAt!: string;

  @ApiProperty({ format: 'date-time' })
  asOf!: string;

  @ApiProperty()
  memberId!: string;

  @ApiProperty({ format: 'date' })
  dateFrom!: string;

  @ApiProperty({ format: 'date' })
  dateTo!: string;

  @ApiProperty({ minimum: 0 })
  legacyRecognizedSeconds!: number;

  @ApiProperty({ minimum: 0 })
  volunteerServiceSeconds!: number;

  @ApiProperty({ minimum: 0 })
  trainingSeconds!: number;

  @ApiProperty({ minimum: 0 })
  organizationSeconds!: number;

  @ApiProperty({ minimum: 0 })
  nonCreditableSeconds!: number;

  @ApiProperty({ minimum: 0 })
  eligibleServiceSeconds!: number;

  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  proofSetHash!: string;

  @ApiProperty({ example: false })
  isPubliclyVerifiable!: false;

  @ApiProperty({ example: 'database_cutover_root_binding_v1' })
  provenance!: string;

  @ApiProperty({ type: AdminParticipationTimeProofItemDto, isArray: true })
  items!: AdminParticipationTimeProofItemDto[];

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number;
}

import { ApiProperty } from '@nestjs/swagger';

/** Admin 账本读面专属投影；App 面另有独立 DTO，避免把 memberId 暴露到 self surface。 */
export class AdminParticipationLedgerEntryDto {
  @ApiProperty()
  entryKey!: string;

  @ApiProperty()
  postingBatchId!: string;

  @ApiProperty()
  memberId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  participationIdentityId!: string;

  @ApiProperty()
  resultRevisionId!: string;

  @ApiProperty({ format: 'date', description: '北京自然日 YYYY-MM-DD' })
  ledgerDate!: string;

  @ApiProperty()
  entryTypeCode!: string;

  @ApiProperty()
  serviceHoursDelta!: number;

  @ApiProperty()
  recognizedPointsDelta!: number;

  @ApiProperty()
  creditedPointsDelta!: number;

  @ApiProperty()
  cappedOutPointsDelta!: number;
}

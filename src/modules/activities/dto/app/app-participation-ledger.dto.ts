import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

/** App self 账本只含本人可见的业务投影，不返回 memberId 或内部 batch 指针。 */
export class AppParticipationLedgerEntryDto {
  @ApiProperty()
  entryKey!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  participationIdentityId!: string;

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

export class ListAppMyParticipationLedgerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按活动 id 过滤本人已生效分录', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MaxLength(64)
  activityId?: string;
}

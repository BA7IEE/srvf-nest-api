import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class AppActivityFeedbackActivityIdParamDto {
  @ApiProperty({
    description: '活动 Activity.id',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

// App 写 DTO 独立于 Admin DTO；PUT 是本人评价完整替换，comment 缺省或 null 都会清空为 null。
export class UpsertActivityFeedbackDto {
  @ApiProperty({ description: '1-5 星总分', minimum: 1, maximum: 5, example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({
    description: '可选评价文字；缺省或 null 表示无文字评价',
    type: String,
    maxLength: 500,
    nullable: true,
    example: '活动组织顺畅，协作体验很好。',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string | null;
}

export class AppActivityFeedbackDto {
  @ApiProperty({ description: '1-5 星总分', minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ description: '评价文字', nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ description: '首次评价时间(ISO 8601 UTC)', type: Date })
  createdAt!: Date;

  @ApiProperty({ description: '最近修改时间(ISO 8601 UTC)', type: Date })
  updatedAt!: Date;
}

export class AppActivityFeedbackResponseDto {
  @ApiProperty({
    description: '本人评价；尚未评价时为 null',
    type: () => AppActivityFeedbackDto,
    nullable: true,
  })
  feedback!: AppActivityFeedbackDto | null;

  @ApiProperty({ description: '当前是否满足 completed、窗口与 approved 到场资格' })
  canSubmit!: boolean;

  @ApiProperty({
    description: '评价窗口关闭时刻(Activity.endAt + 配置天数，ISO 8601 UTC)',
    format: 'date-time',
  })
  windowClosesAt!: string;
}

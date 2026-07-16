import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ActivityFeedbackActivityIdParamDto {
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

export class AdminActivityFeedbackListItemDto {
  @ApiProperty({ description: '评价人队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '评价人显示名' })
  displayName!: string;

  @ApiProperty({ description: '1-5 星总分', minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ description: '评价文字', nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ description: '首次评价时间(ISO 8601 UTC)', type: Date })
  createdAt!: Date;

  @ApiProperty({ description: '最近修改时间(ISO 8601 UTC)', type: Date })
  updatedAt!: Date;
}

export class ActivityFeedbackAggregateDto {
  @ApiProperty({ description: '未软删评价数' })
  count!: number;

  @ApiProperty({
    description: '平均星级；无评价时为 null，非空时四舍五入保留两位',
    nullable: true,
    type: Number,
  })
  avgRating!: number | null;
}

export class ActivityFeedbackRatingBucketDto {
  @ApiProperty({ description: '星级', minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ description: '该星级的未软删评价数' })
  count!: number;
}

export class AdminActivityFeedbackSummaryDto extends ActivityFeedbackAggregateDto {
  @ApiProperty({
    description: '固定 1-5 星五桶分布，零桶也显式返回',
    type: [ActivityFeedbackRatingBucketDto],
  })
  ratingDistribution!: ActivityFeedbackRatingBucketDto[];

  @ApiProperty({
    description:
      '评价人数 / (当前 approved 考勤 distinct member ∪ 已提交评价 member)去重数；分母为 0 时为 0，四位小数',
    minimum: 0,
    maximum: 1,
  })
  feedbackRate!: number;
}

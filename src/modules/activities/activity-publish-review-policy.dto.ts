import { ApiProperty } from '@nestjs/swagger';
import { TimePolicyDefinitionDto } from './dto/admin/activity-time-policy.dto';
import { ContributionPolicyDefinitionDto } from './dto/system/contribution-policy.dto';

/** This review-scoped endpoint accepts no catalogue identifiers or other query parameters. */
export class ActivityPublishReviewReferencedPoliciesQueryDto {}

export class ActivityPublishReviewReferencedPolicyVersionDto {
  @ApiProperty({ description: '冻结审核实际引用的政策ID' })
  policyId!: string;

  @ApiProperty({ description: '冻结审核实际引用的不可变版本ID' })
  versionId!: string;

  @ApiProperty({ description: '版本号' })
  version!: number;

  @ApiProperty({ description: '政策定义结构版本', enum: [1] })
  schemaVersion!: number;

  @ApiProperty({ description: '政策解释器版本', enum: [1] })
  evaluatorVersion!: number;

  @ApiProperty({
    description: '与冻结引用和完整政策定义重新计算结果一致的摘要',
    pattern: '^[0-9a-f]{64}$',
  })
  definitionHash!: string;

  @ApiProperty({ description: '已绑定到定义摘要的生效开始时刻' })
  effectiveFrom!: string;

  @ApiProperty({ description: '已绑定到定义摘要的生效结束时刻', type: String, nullable: true })
  effectiveUntil!: string | null;
}

export class ActivityPublishReviewReferencedTimePolicyDto extends ActivityPublishReviewReferencedPolicyVersionDto {
  @ApiProperty({ description: '审核引用版本的完整时长政策定义', type: TimePolicyDefinitionDto })
  definition!: TimePolicyDefinitionDto;
}

export class ActivityPublishReviewReferencedContributionPolicyDto extends ActivityPublishReviewReferencedPolicyVersionDto {
  @ApiProperty({
    description: '审核引用版本的完整贡献政策定义',
    type: ContributionPolicyDefinitionDto,
  })
  definition!: ContributionPolicyDefinitionDto;
}

export class ActivityPublishReviewReferencedPoliciesResponseDto {
  @ApiProperty({ description: '关联的审核记录ID' })
  reviewId!: string;

  @ApiProperty({ description: '关联的活动ID' })
  activityId!: string;

  @ApiProperty({ description: '经现有提案解析器验证的冻结快照结构版本' })
  snapshotSchemaVersion!: number;

  @ApiProperty({ description: '关联冻结快照的摘要；不是当前草稿hash', pattern: '^[0-9a-f]{64}$' })
  snapshotHash!: string;

  @ApiProperty({
    description: '冻结base和target中实际引用的时长版本，去重且不包含目录其他版本',
    type: [ActivityPublishReviewReferencedTimePolicyDto],
  })
  timePolicies!: ActivityPublishReviewReferencedTimePolicyDto[];

  @ApiProperty({
    description: '冻结base和target中实际引用的贡献版本，去重且不包含目录其他版本',
    type: [ActivityPublishReviewReferencedContributionPolicyDto],
  })
  contributionPolicies!: ActivityPublishReviewReferencedContributionPolicyDto[];
}

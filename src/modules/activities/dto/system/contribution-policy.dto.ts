import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

const TIME_CATEGORY_CODES = [
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;
const POLICY_STATUS_CODES = ['draft', 'active', 'retired'] as const;

export class ContributionPolicyResultDto {
  @ApiProperty({ description: '确认积分，固定两位小数，范围0.00–999.99', example: '1.50' })
  @IsString()
  @Matches(/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/u)
  recognizedPoints!: string;

  @ApiProperty({
    description: '稳定解释代码',
    pattern: '^[a-z][a-z0-9_.-]{0,63}$',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{0,63}$/u)
  explanationCode!: string;
}

export class ContributionPolicyDurationBandDto extends ContributionPolicyResultDto {
  @ApiProperty({
    description: '包含式时长上限（秒）；最后一档固定为null',
    type: Number,
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  maxSecondsInclusive!: number | null;
}

export class ContributionPolicyCategoryRuleDto {
  @ApiProperty({ description: '时长分类代码', enum: TIME_CATEGORY_CODES })
  @IsIn(TIME_CATEGORY_CODES)
  timeCategoryCode!: string;

  @ApiProperty({
    description: '严格递增的时长档；最后一档必须无上限',
    type: [ContributionPolicyDurationBandDto],
    minItems: 1,
    maxItems: 16,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => ContributionPolicyDurationBandDto)
  durationBands!: ContributionPolicyDurationBandDto[];
}

export class ContributionPolicyRoleRuleDto {
  @ApiProperty({ description: '出勤角色代码', minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  attendanceRoleCode!: string;

  @ApiProperty({
    description: '该角色的分类规则；同一分类不得重复',
    type: [ContributionPolicyCategoryRuleDto],
    maxItems: 4,
  })
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ContributionPolicyCategoryRuleDto)
  categoryRules!: ContributionPolicyCategoryRuleDto[];
}

export class ContributionPolicyDefinitionDto {
  @ApiProperty({ description: '无匹配规则时的默认结果', type: ContributionPolicyResultDto })
  @ValidateNested()
  @Type(() => ContributionPolicyResultDto)
  defaultResult!: ContributionPolicyResultDto;

  @ApiProperty({
    description: '按出勤角色定义的贡献规则；角色代码不得重复',
    type: [ContributionPolicyRoleRuleDto],
    maxItems: 64,
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ContributionPolicyRoleRuleDto)
  roleRules!: ContributionPolicyRoleRuleDto[];
}

export class SystemListContributionPoliciesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '精确政策代码', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/u)
  code?: string;
}

export class SystemListContributionPolicyVersionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '版本状态', enum: POLICY_STATUS_CODES })
  @OmittableOnly()
  @IsIn(POLICY_STATUS_CODES)
  statusCode?: string;
}

export class ContributionPolicyVersionParamDto {
  @ApiProperty({ description: '政策ID', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  id!: string;

  @ApiProperty({ description: '版本ID', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  versionId!: string;
}

export class SystemContributionPolicyResponseDto {
  @ApiProperty({ description: '政策ID' })
  id!: string;
  @ApiProperty({ description: '稳定代码' })
  code!: string;
  @ApiProperty({ description: '政策名称' })
  name!: string;
  @ApiProperty({ description: '政策说明', type: String, nullable: true })
  description!: string | null;
  @ApiProperty({ description: '创建时间' })
  createdAt!: string;
  @ApiProperty({ description: '更新时间' })
  updatedAt!: string;
}

export class SystemContributionPolicyVersionSummaryDto {
  @ApiProperty({ description: '版本ID' })
  id!: string;
  @ApiProperty({ description: '政策ID' })
  policyId!: string;
  @ApiProperty({ description: '版本号' })
  version!: number;
  @ApiProperty({ description: '定义结构版本' })
  schemaVersion!: number;
  @ApiProperty({ description: '解释器版本' })
  evaluatorVersion!: number;
  @ApiProperty({ description: '版本语义摘要' })
  definitionHash!: string;
  @ApiProperty({ description: '生效开始' })
  effectiveFrom!: string;
  @ApiProperty({ description: '生效结束', type: String, nullable: true })
  effectiveUntil!: string | null;
  @ApiProperty({ description: '生命周期状态', enum: POLICY_STATUS_CODES })
  statusCode!: string;
  @ApiProperty({ description: '激活时间', type: String, nullable: true })
  activatedAt!: string | null;
  @ApiProperty({ description: '退役时间', type: String, nullable: true })
  retiredAt!: string | null;
  @ApiProperty({ description: '创建时间' })
  createdAt!: string;
  @ApiProperty({ description: '更新时间' })
  updatedAt!: string;
}

export class SystemContributionPolicyVersionResponseDto extends SystemContributionPolicyVersionSummaryDto {
  @ApiProperty({ description: '已校验的完整政策定义', type: ContributionPolicyDefinitionDto })
  definition!: ContributionPolicyDefinitionDto;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const INSURANCE_DATE_STATUSES = ['upcoming', 'active', 'expired'] as const;

export type InsuranceDateStatus = (typeof INSURANCE_DATE_STATUSES)[number];

export class MemberInsuranceOverviewSummaryDto {
  @ApiProperty({
    description:
      '截至 asOfDate，日期处于有效区间内的个人自购保险记录数；包含 pending/verified/rejected',
  })
  dateActiveSelfPurchasedCount!: number;

  @ApiProperty({
    description: '截至 asOfDate，日期有效且审核事实完整的个人自购保险记录数',
  })
  confirmedActiveSelfPurchasedCount!: number;

  @ApiProperty({
    description: '截至 asOfDate，日期有效的队内统一保险覆盖数',
  })
  dateActiveTeamProvidedCount!: number;

  @ApiProperty({
    description:
      '是否存在系统已确认的当前保险来源：确认自购或有效团队覆盖任一即可；不等价于具体活动或入队资格',
  })
  hasConfirmedCoverage!: boolean;

  @ApiPropertyOptional({
    description: '当前已确认保险来源中最晚的到期日期；无已确认来源时为 null',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  confirmedCoverageThrough!: Date | null;
}

export class MemberInsuranceOverviewSelfItemDto {
  @ApiProperty({ description: '个人自购保险记录 id' })
  id!: string;

  @ApiProperty({ description: '保险公司' })
  insurerName!: string;

  @ApiProperty({ description: '个人自购保单号' })
  policyNumber!: string;

  @ApiPropertyOptional({
    description: '起保日期；null 表示未填写下界',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  coverageStart!: Date | null;

  @ApiProperty({ description: '到期日期；包含当日' })
  coverageEnd!: Date;

  @ApiProperty({ description: '审核状态：pending / verified / rejected' })
  reviewStatusCode!: string;

  @ApiProperty({ description: '乐观并发版本号' })
  version!: number;

  @ApiPropertyOptional({
    description: '最近审核时间',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  reviewedAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({
    description: '相对 asOfDate 的日期状态',
    enum: INSURANCE_DATE_STATUSES,
  })
  dateStatus!: InsuranceDateStatus;
}

export class MemberInsuranceOverviewTeamItemDto {
  @ApiProperty({ description: '团队保险覆盖行 id' })
  coverageId!: string;

  @ApiProperty({ description: '团队保单 id' })
  policyId!: string;

  @ApiProperty({ description: '承保公司' })
  insurerName!: string;

  @ApiProperty({ description: '起保日期' })
  coverageStart!: Date;

  @ApiProperty({ description: '到期日期；包含当日' })
  coverageEnd!: Date;

  @ApiProperty({ description: '该队员加入本保单覆盖名单的时间' })
  coverageAddedAt!: Date;

  @ApiProperty({
    description: '相对 asOfDate 的日期状态',
    enum: INSURANCE_DATE_STATUSES,
  })
  dateStatus!: InsuranceDateStatus;
}

export class MemberInsuranceOverviewResponseDto {
  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({
    description: '本次派生状态使用的北京日，存储/响应按 UTC 午夜规范化',
  })
  asOfDate!: Date;

  @ApiProperty({ type: () => MemberInsuranceOverviewSummaryDto })
  summary!: MemberInsuranceOverviewSummaryDto;

  @ApiProperty({ type: [MemberInsuranceOverviewSelfItemDto] })
  selfPurchased!: MemberInsuranceOverviewSelfItemDto[];

  @ApiProperty({ type: [MemberInsuranceOverviewTeamItemDto] })
  teamProvided!: MemberInsuranceOverviewTeamItemDto[];
}

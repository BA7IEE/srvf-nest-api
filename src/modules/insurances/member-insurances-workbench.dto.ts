import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 保险审核工作台 DTO(2026-08-23)。
//
// 它解锁的是 `INSURANCE_ENFORCEMENT_ENABLED` 的前置:开关一开,所有「录了但没审」的
// 记录当场失效。开之前必须能回答「哪些还没审」—— 而在本刀之前,只有按 memberId 的
// 单人端点,要回答这个问题只能把每个队员挨个点一遍。
//
// PII 口径见 `member-insurance-projection.ts`:保单号**恒掩码**,本文件不提供明文字段,
// 也**不**接受任何「返明文」的开关参数 —— 跨队员面永不返明文是结构性的,不是可配的。

/** `MemberInsurance.reviewStatusCode` 的取值域(prisma/schema.prisma:2870 注释同源)。 */
export const MEMBER_INSURANCE_REVIEW_STATUS_CODES = ['pending', 'verified', 'rejected'] as const;
export type MemberInsuranceReviewStatusCode = (typeof MEMBER_INSURANCE_REVIEW_STATUS_CODES)[number];

// ============ 入参 ============

// extends PaginationQueryDto 是唯一允许例外(common 跨模块公共 DTO,非 admin 模块 DTO)。
export class ListMemberInsuranceWorkbenchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按审核状态筛选;**不传 = 不筛**(返回全部状态)',
    enum: MEMBER_INSURANCE_REVIEW_STATUS_CODES,
  })
  // 「可省略」而不是「可为空」:不传 = 不筛;显式 null 稳定 400,
  // 不会穿过契约层被 service 的 `query.reviewStatusCode ? ...` 当成「没传」吞掉。
  @OmittableOnly()
  @IsIn(MEMBER_INSURANCE_REVIEW_STATUS_CODES)
  reviewStatusCode?: MemberInsuranceReviewStatusCode;
}

// ============ 出参 ============

export class MemberInsuranceWorkbenchMemberDto {
  @ApiProperty({ description: '队员 id(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员真实姓名' })
  realName!: string;

  @ApiPropertyOptional({ description: '外号', nullable: true })
  nickname!: string | null;

  @ApiProperty({ description: '统一展示标签 `编号 · 姓名(外号)`' })
  label!: string;
}

export class MemberInsuranceWorkbenchItemDto {
  @ApiProperty({ description: '保险记录 id(cuid);审核端点的 :insuranceId' })
  id!: string;

  @ApiProperty({ description: '所属队员', type: MemberInsuranceWorkbenchMemberDto })
  member!: MemberInsuranceWorkbenchMemberDto;

  @ApiProperty({ description: '保险公司' })
  insurerName!: string;

  @ApiPropertyOptional({
    description:
      '保单号**掩码值**(前 2 + `****` + 后 2;≤4 位整体打码)。跨队员面永不返明文 —— 需要明文请走单人端点 `GET /admin/v1/members/:memberId/insurances`',
    nullable: true,
  })
  policyNumberMasked!: string | null;

  @ApiPropertyOptional({ description: '起保日期(可空 = 未填写,不参与起保校验)', nullable: true })
  coverageStart!: Date | null;

  @ApiProperty({ description: '到期日期(有效性唯一依据;覆盖含当日)' })
  coverageEnd!: Date;

  @ApiProperty({ description: '审核状态(pending / verified / rejected)' })
  reviewStatusCode!: string;

  @ApiProperty({ description: '并发控制版本号;审核端点 expectedVersion 必填,直接取这个值' })
  version!: number;

  @ApiPropertyOptional({ description: '最近审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

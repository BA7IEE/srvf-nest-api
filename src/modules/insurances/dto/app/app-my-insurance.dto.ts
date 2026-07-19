import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// 保险模块 T2 App 出参 DTO(2026-06-13;评审稿 insurance-module-review.md §3.2 端点 1-4)。
// 独立 App DTO,**禁止**从 insurances.dto.ts(admin)派生(extends / Pick / Omit /
// IntersectionType / PartialType / OmitType 均越权;沿 AGENTS §19.7 D-6)。
// 字段集刻意不含 memberId(本人查本人,沿 app-my-registrations 字段集纪律 §16.B.2)。
export class AppMyInsuranceDto {
  @ApiProperty({ description: '保险记录 id(cuid)' })
  id!: string;

  @ApiProperty({ description: '保险公司' })
  insurerName!: string;

  @ApiProperty({ description: '保单号' })
  policyNumber!: string;

  @ApiPropertyOptional({ description: '起保日期(可空 = 未填写)', nullable: true })
  coverageStart!: Date | null;

  @ApiProperty({ description: '到期日期(有效性唯一依据;覆盖含当日)' })
  coverageEnd!: Date;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '审核状态(pending / verified / rejected)' })
  reviewStatusCode!: string;

  @ApiProperty({ description: '并发控制版本号' })
  version!: number;

  @ApiPropertyOptional({ description: '最近审核时间', nullable: true })
  reviewedAt!: Date | null;
}

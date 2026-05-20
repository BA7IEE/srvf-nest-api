import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Phase 2 P2-5b App `PATCH /api/app/v1/my/registrations/:id/cancel` 入参 DTO。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.4 v0.1 严格 1 字段 + D-P2-5-9
// 保持可选(降低 App 用户取消摩擦);类名独立,**严禁** extends / Pick / Omit /
// IntersectionType / PartialType / OmitType / mapped-types 任一构造方式复用 admin
// CancelRegistrationDto(沿 §8.1 #1 + 风险 14.1 + Phase 0.7 §2.2)。
//
// 字段集字面与 admin `CancelRegistrationDto` 一致是**有意 zero-drift**(沿
// §8.2.4 末段);但**类层级不复用**。
export class CancelAppMyRegistrationDto {
  @ApiPropertyOptional({
    description: '取消原因(可选;沿 D-P2-5-9)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}

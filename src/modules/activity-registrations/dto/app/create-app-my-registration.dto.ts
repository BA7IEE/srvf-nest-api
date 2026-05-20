import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, Length } from 'class-validator';

// Phase 2 P2-5b App `POST /api/app/v1/my/registrations` 入参 DTO。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.4 v0.1 严格 2 字段;
// 类名独立,**严禁** extends / Pick / Omit / IntersectionType / PartialType /
// OmitType / mapped-types 任一构造方式复用 admin CreateRegistrationDto /
// CreateMyRegistrationDto(沿 §8.1 #1 + 风险 14.1 + Phase 0.7 §2.2)。
//
// 明确禁止字段(`forbidNonWhitelisted` 兜底;DTO 自身白名单是第一道防线):
//   memberId / userId / statusCode / submittedAt / registeredAt / reviewedBy /
//   reviewedAt / reviewNote / cancelledByUserId / cancelledAt / cancelReason /
//   id / deletedAt / createdAt / updatedAt
// (沿 §8.2.4 + activity-registrations.dto.ts:18-24 既有禁止清单 + Phase 2 §10.11a)
export class CreateAppMyRegistrationDto {
  @ApiProperty({
    description: '目标活动 id(必填;前置 published 校验失败统一 ACTIVITY_NOT_FOUND=20001)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiPropertyOptional({
    description: '扩展字段(用户自定义 Json;沿 v2 Q-A13 不嵌套校验,沿 D-P2-5-12)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  extras?: Record<string, unknown>;
}

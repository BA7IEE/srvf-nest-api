import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// Phase 2 P2-5a `GET /api/app/v1/my/activities` query DTO。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.4 v0.1 严格 3 字段
// (`page` / `pageSize` 沿 `PaginationQueryDto` + 可选 `registrationStatusCode`)。
//
// **命名刻意区分**:`registrationStatusCode` 而非 `statusCode`,显式表达"是本人 registration
// 状态,不是活动状态";避免与 `Activity.statusCode` 概念混淆(沿 §8.2.4 + Phase 0.6 §4.4
// 字典 code 语义清晰)。
//
// 沿 §16.B.4 + §14.7 风险表:**不**支持 `activityTypeCode` / `organizationId` /
// `keyword` / `isPublicRegistration` / 任何 admin 字段;`forbidNonWhitelisted` 兜底 + DTO 自身白名单。
//
// `extends PaginationQueryDto` 是唯一允许例外(沿 §8.1)。
export class ListAppMyActivitiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按本人 registration 状态过滤(pending / pass / reject / cancelled);默认全集',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationStatusCode?: string;
}

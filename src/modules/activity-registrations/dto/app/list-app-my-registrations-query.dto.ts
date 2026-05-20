import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// Phase 2 P2-5a `GET /api/app/v1/my/registrations` query DTO。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.4 v0.1 严格 3 字段
// (`page` / `pageSize` 沿 `PaginationQueryDto` + 可选 `statusCode`)。
//
// 沿 §16.B.4 默认锁定:**不支持** `activityId` filter(产品需要 P2.x 单独立项);
// **不支持** 任何其它字段(`forbidNonWhitelisted` 兜底)。
//
// `extends PaginationQueryDto` 是唯一允许例外(沿 §8.1 + P2-4 范式):
// `PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共 DTO,**非** admin
// 模块 DTO,不违反"禁止 extends admin DTO"铁律。
export class ListAppMyRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按报名状态过滤(pending / pass / reject / cancelled);默认全集',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// Phase 2 P2-6 `GET /api/app/v1/my/attendance-records` query DTO。
// 沿 docs/app-api-p2-6-attendance-records-review.md §6.1 D-P2-6-9 严格 3 字段
// (`page` / `pageSize` 沿 `PaginationQueryDto` + 可选 `activityId`)。
//
// 沿 §6.2 严禁字段:`memberId` / `userId` / `sheetId` / `registrationId` /
// `statusCode` / `roleCode` / `dateFrom` / `dateTo` / `sortBy`;`forbidNonWhitelisted`
// 兜底任何越界字段。
//
// `extends PaginationQueryDto` 是唯一允许例外(沿 §6.1 + P2-5a 范式):
// `PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共 DTO,**非** admin
// 模块 DTO,不违反 D-P2-6-4 "禁止 extends admin DTO" 铁律。
export class ListAppMyAttendanceRecordsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按活动 id 过滤(可选;仅返该活动下的 approved Sheet records);默认全集',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  activityId?: string;
}

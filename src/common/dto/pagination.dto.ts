import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// 分页入参铁律(ARCHITECTURE.md §7.3):
// - 字段固定 page / pageSize,默认 page=1 / pageSize=20,pageSize 上限 100
// - 禁止 limit/offset / skip/take / cursor 等变体
// - Prisma 查询时换算 skip = (page - 1) * pageSize,take = pageSize
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: '页码',
    default: 1,
    minimum: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: '每页数量',
    default: 20,
    minimum: 1,
    maximum: 100,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

// 分页出参铁律:items / total / page / pageSize 固定,不允许 list/count/rows 变体。
// 默认排序 orderBy: { createdAt: 'desc' }(由各 service 实现保证)。
//
// items 字段在具体接口的 Swagger schema 中由 @ApiWrappedPageResponse(Dto) 装饰器
// 通过 allOf 注入正确的元素类型;此处仅占位描述,确保 PageResultDto 类被 Swagger
// 注册为 named schema。
export class PageResultDto<T> {
  @ApiProperty({
    description: '当前页数据列表;实际元素类型由具体接口指定',
    isArray: true,
  })
  items!: T[];

  @ApiProperty({ description: '总记录数', example: 0 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页数量', example: 20 })
  pageSize!: number;
}

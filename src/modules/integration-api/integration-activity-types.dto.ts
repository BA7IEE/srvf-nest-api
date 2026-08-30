import { ApiProperty } from '@nestjs/swagger';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** Integration surface 的独立查询 DTO；仅允许标准分页字段。 */
export class ListIntegrationActivityTypesQueryDto extends PaginationQueryDto {}

/** 外部系统只读活动类型参考数据的最小字段集。 */
export class IntegrationActivityTypeItemDto {
  @ApiProperty({ description: '活动类型稳定业务码', example: 'training' })
  code!: string;

  @ApiProperty({ description: '活动类型显示名称', example: '培训' })
  label!: string;

  @ApiProperty({ description: '排序权重', example: 0 })
  sortOrder!: number;
}

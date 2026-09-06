import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AppActivityMetricSetPointerDto } from './app-activity-metric-selection.dto';

export class AppActivityMetricOptionsQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '拟发起活动的组织 ID；按当前队员资格校验',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;
}

export class AppActivityMetricSetOptionDto extends AppActivityMetricSetPointerDto {
  @ApiProperty({ description: '指标集名称' })
  name!: string;
}

export class AppActivityTemplateFamilyOptionDto {
  @ApiProperty({ description: '全局模板族 ID' })
  id!: string;
  @ApiProperty({ description: '模板族稳定编码' })
  code!: string;
  @ApiProperty({ description: '模板族名称' })
  name!: string;
  @ApiProperty({ description: '模板分类码' })
  categoryCode!: string;
}

/** App-only safe summary; never returns definitions, forms or raw authorization data. */
export class AppActivityTemplateVersionOptionDto {
  @ApiProperty({ description: '精确模板版本 ID' })
  id!: string;
  @ApiProperty({ description: '模板稳定编码' })
  code!: string;
  @ApiProperty({ description: '模板版本名称' })
  name!: string;
  @ApiProperty({ description: '显式版本号', minimum: 1 })
  version!: number;
  @ApiProperty({ description: '定义 schema 版本', enum: [1, 2, 3] })
  schemaVersion!: number;
  @ApiProperty({ description: '精确版本内容 hash', pattern: '^[0-9a-f]{64}$' })
  definitionHash!: string;
  @ApiProperty({ description: '仅返回当前可新选版本', enum: ['active'] })
  statusCode!: 'active';
  @ApiProperty({ description: '活动类型码' })
  activityTypeCode!: string;
  @ApiProperty({ description: '全局模板族摘要', type: () => AppActivityTemplateFamilyOptionDto })
  family!: AppActivityTemplateFamilyOptionDto;
  @ApiProperty({
    description: '有效期元数据起点，不按当前时间设 Gate',
    type: String,
    format: 'date-time',
  })
  effectiveFrom!: Date;
  @ApiProperty({
    description: '有效期元数据终点',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  effectiveTo!: Date | null;
  @ApiProperty({ description: '创建时间', type: String, format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({ description: '更新时间', type: String, format: 'date-time' })
  updatedAt!: Date;
}

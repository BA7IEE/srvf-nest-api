import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsArray,
  IsNumber,
  IsString,
  Length,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AppManagedStaffScanManualConfirmationDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '已核验的永久参与身份 ID' })
  @IsString()
  @Length(8, 64)
  participationIdentityId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '未能扫码时的人工确认原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppManagedOnsiteLocationDto {
  @ApiPropertyOptional({ minimum: -180, maximum: 180, description: 'WGS84 经度，按场次策略可选' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ minimum: -90, maximum: 90, description: 'WGS84 纬度，按场次策略可选' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 99_999_999.99, description: '定位精度(米)' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99_999_999.99)
  accuracy?: number;
}

export class AppManagedStaffScanDto {
  @ApiProperty({ enum: ['check_in', 'check_out'], description: '工作人员执行的现场动作' })
  @IsIn(['check_in', 'check_out'])
  actionCode!: 'check_in' | 'check_out';

  @ApiProperty({ minLength: 1, maxLength: 128, description: '客户端生成的全局现场事件防重键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventKey!: string;

  @ApiPropertyOptional({
    type: () => AppManagedStaffScanManualConfirmationDto,
    description: '可信成员码不可用时，由工作人员明确确认的目标身份；与 memberCredential 二选一',
  })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => AppManagedStaffScanManualConfirmationDto)
  manualConfirmation?: AppManagedStaffScanManualConfirmationDto;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 4096,
    description: '从成员本人受保护二维码读取的短时签名凭证；与 manualConfirmation 二选一',
  })
  @OmittableOnly()
  @IsString()
  @Length(1, 4096)
  memberCredential?: string;

  @ApiPropertyOptional({
    type: () => AppManagedOnsiteLocationDto,
    description: '按场次策略可选的 WGS84 定位快照',
  })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => AppManagedOnsiteLocationDto)
  location?: AppManagedOnsiteLocationDto;
}

export class AppManagedProxyPunchDto {
  @ApiProperty({ enum: ['check_in', 'check_out'], description: '负责人代为执行的现场动作' })
  @IsIn(['check_in', 'check_out'])
  actionCode!: 'check_in' | 'check_out';

  @ApiProperty({ minLength: 1, maxLength: 128, description: '客户端生成的全局现场事件防重键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventKey!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '经现场工作台已核验的永久参与身份 ID' })
  @IsString()
  @Length(8, 64)
  participationIdentityId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '单人代签或代退的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: () => AppManagedOnsiteLocationDto,
    description: '按场次策略可选的 WGS84 定位快照',
  })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => AppManagedOnsiteLocationDto)
  location?: AppManagedOnsiteLocationDto;
}

export class AppManagedBulkPunchJobDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 96,
    pattern: '^[A-Za-z0-9_-]+$',
    description: '客户端生成的批量操作防重键，仅允许 ASCII 字母、数字、下划线和连字符',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  operationKey!: string;

  @ApiProperty({ enum: ['check_in', 'check_out'], description: '批量执行的现场动作' })
  @IsIn(['check_in', 'check_out'])
  actionCode!: 'check_in' | 'check_out';

  @ApiProperty({ minLength: 1, maxLength: 500, description: '批量代签或代退的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 500,
    description: '已从受控现场名单选择的永久参与身份 ID；服务端去重并按 UTF-8 字节序冻结',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(8, 64, { each: true })
  participationIdentityIds!: string[];

  @ApiPropertyOptional({
    type: () => AppManagedOnsiteLocationDto,
    description: '按场次策略可选的 WGS84 定位快照',
  })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => AppManagedOnsiteLocationDto)
  location?: AppManagedOnsiteLocationDto;
}

export class AppManagedImportPreviewFormDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 96,
    pattern: '^[A-Za-z0-9_-]+$',
    description: '客户端生成的导入预览防重键，仅允许 ASCII 字母、数字、下划线和连字符',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  operationKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 500, description: '本次现场导入的明确原因' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppManagedImportExecuteDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 96,
    pattern: '^[A-Za-z0-9_-]+$',
    description: '客户端生成的导入执行防重键，仅允许 ASCII 字母、数字、下划线和连字符',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  operationKey!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$', description: '预览冻结的 CSV SHA-256 摘要' })
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/u)
  fileDigest!: string;

  @ApiProperty({ enum: ['attendance-import-csv/v1'], description: '预览冻结的解析器版本' })
  @IsIn(['attendance-import-csv/v1'])
  parserVersion!: 'attendance-import-csv/v1';

  @ApiProperty({ pattern: '^[0-9a-f]{64}$', description: '预览冻结的行摘要 SHA-256' })
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/u)
  previewHash!: string;
}

export class AppManagedImportPreviewParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '已冻结的 CSV 导入预览任务 ID' })
  @IsString()
  @Length(8, 64)
  previewId!: string;
}

export class AppManagedImportPreviewQueryDto extends PaginationQueryDto {}

export class AppManagedImportPreviewItemDto {
  @ApiProperty({ minimum: 1, description: 'CSV 物理行号（header 为第 1 行）' })
  line!: number;

  @ApiProperty({ description: '该行静态预览状态' })
  statusCode!: string;

  @ApiPropertyOptional({ nullable: true, description: '安全错误码，不含原始单元格内容' })
  lastErrorCode!: string | null;

  @ApiPropertyOptional({ nullable: true, description: '安全提示，不含原始单元格内容' })
  safeMessage!: string | null;
}

export class AppManagedImportPreviewItemPageDto {
  @ApiProperty({ type: () => [AppManagedImportPreviewItemDto] })
  items!: AppManagedImportPreviewItemDto[];

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number;
}

export class AppManagedImportPreviewDto {
  @ApiProperty()
  jobId!: string;

  @ApiProperty()
  statusCode!: string;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  succeeded!: number;

  @ApiProperty({ minimum: 0 })
  failed!: number;

  @ApiProperty({ minimum: 0 })
  skipped!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  fileDigest!: string;

  @ApiProperty({ example: 'attendance-import-csv/v1' })
  parserVersion!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  previewHash!: string;

  @ApiProperty({ type: () => AppManagedImportPreviewItemPageDto })
  items!: AppManagedImportPreviewItemPageDto;
}

export class AppManagedOnsiteBatchJobParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '现场批任务 ID' })
  @IsString()
  @Length(8, 64)
  jobId!: string;
}

export class AppManagedOnsiteBatchJobReceiptDto {
  @ApiProperty({ description: '后台批任务 ID' })
  jobId!: string;

  @ApiProperty({ enum: ['pending', 'processing', 'succeeded', 'partial_failed', 'failed'] })
  statusCode!: string;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  succeeded!: number;

  @ApiProperty({ minimum: 0 })
  failed!: number;

  @ApiProperty({ minimum: 0 })
  skipped!: number;

  @ApiProperty({ description: '本次是否命中相同 operationKey 与请求摘要的既有回执' })
  replayed!: boolean;
}

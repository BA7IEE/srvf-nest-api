import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
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

export class AppManagedOfflinePackageIssueDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 96,
    pattern: '^[A-Za-z0-9_-]+$',
    description: '离线包签发防重键',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  operationKey!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Za-z0-9._:-]+$',
    description: '受控现场设备稳定标识',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/u)
  deviceId!: string;
}

export class AppManagedOfflinePackageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  deviceId!: string;

  @ApiProperty({ minimum: 1 })
  packageVersion!: number;

  @ApiProperty({ enum: [0] })
  packageKeyVersion!: 0;

  @ApiProperty({ enum: ['active', 'review_required', 'revoked', 'expired'] })
  statusCode!: string;

  @ApiProperty({ format: 'date-time' })
  validFrom!: Date;

  @ApiProperty({ format: 'date-time' })
  validUntil!: Date;

  @ApiProperty({ format: 'date-time' })
  uploadUntil!: Date;

  @ApiProperty({ minimum: 1 })
  sequenceStart!: number;

  @ApiProperty({ minimum: 1 })
  nextExpectedSequence!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  ruleSnapshotHash!: string;

  @ApiProperty({ minimum: 0 })
  workflowRevision!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  participantSnapshotHash!: string;
}

export class AppManagedOfflinePackageIssueReceiptDto {
  @ApiProperty({ type: () => AppManagedOfflinePackageDto })
  package!: AppManagedOfflinePackageDto;

  @ApiProperty({ minLength: 1, description: '仅首次签发及精确重放返回的签名离线包 token' })
  packageToken!: string;
}

export class AppManagedOfflinePackageParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '离线考勤包 ID' })
  @IsString()
  @Length(8, 64)
  packageId!: string;
}

export class AppManagedOfflineActivityParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppManagedOfflineReviewItemParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '负责人管理的活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '离线复核项 ID' })
  @IsString()
  @Length(8, 64)
  reviewItemId!: string;
}

export class AppManagedOfflineOperationDto {
  @ApiProperty({ minLength: 1, maxLength: 96, pattern: '^[A-Za-z0-9_-]+$' })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  operationKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AppManagedOfflineUploadDto {
  @ApiProperty({ minLength: 1, maxLength: 8192 })
  @IsString()
  @Length(1, 8192)
  packageToken!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0, allowNaN: false, allowInfinity: false })
  @Min(1)
  sequence!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/u)
  priorHash!: string;

  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  eventKey!: string;

  @ApiProperty({ enum: ['check_in', 'check_out'] })
  @IsIn(['check_in', 'check_out'])
  actionCode!: 'check_in' | 'check_out';

  @ApiProperty({ format: 'date-time' })
  @IsDateString({ strict: true })
  deviceTime!: string;

  @ApiProperty({ minLength: 1, maxLength: 4096 })
  @IsString()
  @Length(1, 4096)
  memberCredential!: string;

  @ApiPropertyOptional({ type: () => AppManagedOnsiteLocationDto })
  @OmittableOnly()
  @ValidateNested()
  @Type(() => AppManagedOnsiteLocationDto)
  location?: AppManagedOnsiteLocationDto;

  @ApiProperty({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' })
  @IsString()
  @Length(1, 256)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  signature!: string;
}

export class AppManagedOfflineReviewQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minLength: 8, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  sessionId?: string;

  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] })
  @OmittableOnly()
  @IsIn(['pending', 'approved', 'rejected'])
  statusCode?: 'pending' | 'approved' | 'rejected';
}

export class AppManagedOfflineReviewItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  packageId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty({ minimum: 1 })
  sequence!: number;

  @ApiProperty()
  eventKey!: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] })
  statusCode!: string;

  @ApiProperty({
    enum: [
      'operator_authorization_revoked',
      'package_revoked',
      'package_expired',
      'device_mismatch',
      'sequence_gap',
      'sequence_duplicate',
      'future_time',
      'time_out_of_window',
      'hash_chain_invalid',
      'signature_invalid',
      'participant_snapshot_mismatch',
    ],
  })
  anomalyCode!: string;

  @ApiProperty({ enum: ['approvable', 'reject_only'] })
  approvalPolicyCode!: string;

  @ApiProperty({ nullable: true, type: String })
  participationIdentityId!: string | null;

  @ApiProperty({ enum: ['check_in', 'check_out'], nullable: true })
  actionCode!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: Date })
  deviceTime!: Date | null;

  @ApiProperty({ format: 'date-time' })
  stagedAt!: Date;

  @ApiProperty({ format: 'date-time', nullable: true, type: Date })
  reviewedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String })
  reviewReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  formalPunchEventId!: string | null;
}

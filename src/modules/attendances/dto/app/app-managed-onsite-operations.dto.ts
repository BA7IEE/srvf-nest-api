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
  ValidateIf,
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

// AC-068「500/2000/10000 人不要求业务人员手工拆 200 人数组」。
//
// 这里**没有**把 500 改大 —— 合同追踪矩阵 I55 明写现有 200/500 人批量「当前合理，保留现有
// 正确方向」，开发文档 §11.5 也把「item 批次 100 至 500 条」定位成吞吐参数并明写它
// 「**不形成业务上限**」。数组上限该守的是单请求体积；不该由它逼业务人员手工分页。
//
// 于是走「传条件、不传 id 列表」：客户端提交本场次的选择条件，服务端在 SQL 里把它展开成
// 任务项（见 attendance-onsite-batch-job.service.ts 的 INSERT ... SELECT），绑定参数个数与
// 人数无关，一个 identity id 都不进应用内存（开发文档 §11.4）。既有 500 条 id 列表入口
// 原样保留，行为一字不改。
export class AppManagedBulkPunchSelectionDto {
  // ⚠️ 刻意**可省略**而不是必填。契约语义门(L6/R11,规则 B3 `request-required-added`)
  // 把「可选父对象下的必填叶子」也算作破坏性变更 —— 它不建模「只有传了 selection 才要求
  // mode」这层条件性。而这里客观上**没有任何老调用方会受影响**:selection 整个是新增的
  // 可选字段,老调用方一律走 participationIdentityIds。
  //
  // 两条出路里选了闸自己给的第 ① 条「用兼容写法让它变成 additive」,而不是第 ② 条申报破坏:
  // 申报一条并不存在的破坏,会往审计记录里写假事实,还要维护者为此点一次环境审批。
  // 当前闭集只有一个值,省略即取它;将来加第二种模式时,新值仍然要显式写。
  @ApiPropertyOptional({
    enum: ['session-all'],
    default: 'session-all',
    description:
      '选择条件模式；session-all = 路径上这一场次的全部参与身份（可再用下面两个条件收窄）。' +
      '可省略，当前闭集只有这一个值，省略即取它',
  })
  @OmittableOnly()
  @IsIn(['session-all'])
  mode = 'session-all' as const;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 20,
    description: '可选收窄：只选当前状态码命中的参与身份；不传表示不按状态收窄',
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  statusCodes?: string[];

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 64,
    description: '可选收窄：只选该岗位下的参与身份；不传表示不按岗位收窄',
  })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  positionId?: string;
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

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 500,
    description:
      '已从受控现场名单选择的永久参与身份 ID；服务端去重并按 UTF-8 字节序冻结。' +
      '与 selection 二选一（必须恰好给一个）；本字段的 500 条上限刻意保留（见 selection 说明）',
  })
  @ValidateIf((dto: AppManagedBulkPunchJobDto) => dto.selection === undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(8, 64, { each: true })
  participationIdentityIds?: string[];

  @ApiPropertyOptional({
    type: () => AppManagedBulkPunchSelectionDto,
    description:
      'AC-068：改为提交“选择条件”而不是 id 列表，服务端自行把整场次展开成任务项。' +
      '与 participationIdentityIds 二选一（必须恰好给一个）',
  })
  @ValidateIf((dto: AppManagedBulkPunchJobDto) => dto.participationIdentityIds === undefined)
  @ValidateNested()
  @Type(() => AppManagedBulkPunchSelectionDto)
  selection?: AppManagedBulkPunchSelectionDto;

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

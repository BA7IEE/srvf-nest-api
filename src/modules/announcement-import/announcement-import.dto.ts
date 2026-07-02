import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupervisionScopeMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):公告导入 preview/execute 两段式 DTO。
//
// **设计铁律(决断①②③):**
// - 结构化 rows 入参,后端不做自然语言解析(公告文本→rows 由运营/AI 线下产)。
// - 行内几乎全部字段为可选(仅做类型/格式校验):一批几十行里某一行缺字段/写错,
//   **不应该** 让 class-validator 把整个请求 400 掉 —— 完整性/存在性判断下沉到 service 层逐行产出
//   `status: blocked` + `reasons[]`,和其它业务失败走同一条"deny 是数据"路径(沿 authz/explain 决断②范式)。
// - 双锚铁律(R7):execute 只接受带 memberNo + orgCode 的行;preview 对只有 displayName 的行做辅助解析
//   (唯一命中 → 回显建议,仍需人工确认;多义/零命中 → needs-manual)。**绝不按姓名自动落库**。
//
// **组织行 code 双重用途:** 既是 Organization.code(全局唯一,持久落库),也是同一请求内本批新建组
// 供 positions[] / supervisions[] 的 orgCode 引用键(service 按 organizations[] 声明顺序处理,
// 父必须先于子出现;详见 announcement-import.service.ts 顶部注释)。

// ============ 请求行 ============

export class ImportOrganizationRowDto {
  @ApiPropertyOptional({
    description:
      '新组的永久 code(全局唯一;同时作为本请求内 positions[]/supervisions[].orgCode 的引用键)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @ApiPropertyOptional({ description: '父组织 code(必须已存在,或为本请求更早声明的组织行 code)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  parentCode?: string;

  @ApiPropertyOptional({ description: '组名', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: "设立状态('provisional' 表筹备组;不传 = 未设置)",
    enum: ['formal', 'provisional'],
  })
  @IsOptional()
  @IsIn(['formal', 'provisional'])
  establishmentStatusCode?: string;

  @ApiPropertyOptional({ description: '组功能字典 code(留口)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupFunctionCode?: string;

  @ApiPropertyOptional({ description: '同级排序权重', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ImportPositionRowDto {
  @ApiPropertyOptional({ description: '队员编号(双锚之一;execute 必须提供)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberNo?: string;

  @ApiPropertyOptional({
    description: '姓名(仅 preview 辅助解析用;唯一命中 active 队员时回显建议 memberNo,仍需人工确认)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({
    description: '组织 code(双锚之一;可引用已存在组织,或本请求 organizations[] 新建的组织)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  orgCode?: string;

  @ApiPropertyOptional({ description: '职务 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  positionCode?: string;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601;须晚于任期起)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '是否兼任(不传 = false)' })
  @IsOptional()
  @IsBoolean()
  isConcurrent?: boolean;

  @ApiPropertyOptional({ description: '备注', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @ApiPropertyOptional({
    description: "任命来源标记(不传 = 'announcement-2026')",
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appointmentSource?: string;
}

export class ImportSupervisionRowDto {
  @ApiPropertyOptional({ description: '分管人队员编号(双锚之一;execute 必须提供)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supervisorMemberNo?: string;

  @ApiPropertyOptional({
    description: '姓名(仅 preview 辅助解析用;语义同 ImportPositionRowDto.displayName)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({
    description: '被分管组织 code(双锚之一;可引用已存在组织,或本请求 organizations[] 新建的组织)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  orgCode?: string;

  @ApiPropertyOptional({ description: '分管范围(不传 = TREE)', enum: SupervisionScopeMode })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601;须晚于任期起)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// preview 与 execute 复用同一请求形状(两段式对同一批 rows 先诊断后落库)。
export class AnnouncementImportRequestDto {
  @ApiPropertyOptional({ type: () => [ImportOrganizationRowDto], description: '待建组节点行' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportOrganizationRowDto)
  organizations?: ImportOrganizationRowDto[];

  @ApiPropertyOptional({ type: () => [ImportPositionRowDto], description: '待任命行' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportPositionRowDto)
  positions?: ImportPositionRowDto[];

  @ApiPropertyOptional({ type: () => [ImportSupervisionRowDto], description: '待建分管行' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportSupervisionRowDto)
  supervisions?: ImportSupervisionRowDto[];
}

// ============ 响应行(决断④:deny/blocked 是数据,不是异常)============

export const IMPORT_ROW_STATUS_VALUES = [
  'ok',
  'blocked',
  'already-exists',
  'needs-manual',
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUS_VALUES)[number];

export class ImportRowIssueDto {
  @ApiPropertyOptional({
    description: '底层 BizCode(合成原因如"缺 memberNo"/"姓名多义" 为 null)',
    nullable: true,
  })
  bizCode!: number | null;

  @ApiProperty({
    description: '人类可读说明(直接取自被复用 service 抛出的 BizException.message,或合成说明)',
  })
  message!: string;
}

export class ImportOrganizationRowResultDto {
  @ApiProperty({ type: () => ImportOrganizationRowDto, description: '原样回显入参行' })
  row!: ImportOrganizationRowDto;

  @ApiProperty({ enum: IMPORT_ROW_STATUS_VALUES })
  status!: ImportRowStatus;

  @ApiProperty({ type: () => [ImportRowIssueDto] })
  reasons!: ImportRowIssueDto[];

  @ApiPropertyOptional({
    description: '已建/命中的组织 id(dry-run 亦返回"本应创建"的 id)',
    nullable: true,
  })
  organizationId?: string | null;
}

export class ImportPositionRowResultDto {
  @ApiProperty({ type: () => ImportPositionRowDto, description: '原样回显入参行' })
  row!: ImportPositionRowDto;

  @ApiProperty({ enum: IMPORT_ROW_STATUS_VALUES })
  status!: ImportRowStatus;

  @ApiProperty({ type: () => [ImportRowIssueDto] })
  reasons!: ImportRowIssueDto[];

  @ApiPropertyOptional({
    description: 'displayName 唯一命中 active 队员时的建议 memberNo(仅 needs-manual 可能带值)',
    nullable: true,
  })
  suggestedMemberNo?: string | null;

  @ApiPropertyOptional({ description: '已建/命中的任职记录 id', nullable: true })
  positionAssignmentId?: string | null;
}

export class ImportSupervisionRowResultDto {
  @ApiProperty({ type: () => ImportSupervisionRowDto, description: '原样回显入参行' })
  row!: ImportSupervisionRowDto;

  @ApiProperty({ enum: IMPORT_ROW_STATUS_VALUES })
  status!: ImportRowStatus;

  @ApiProperty({ type: () => [ImportRowIssueDto] })
  reasons!: ImportRowIssueDto[];

  @ApiPropertyOptional({
    description: 'displayName 唯一命中 active 队员时的建议 memberNo(仅 needs-manual 可能带值)',
    nullable: true,
  })
  suggestedMemberNo?: string | null;

  @ApiPropertyOptional({ description: '已建/命中的分管记录 id', nullable: true })
  supervisionAssignmentId?: string | null;
}

export class ImportSummaryDto {
  @ApiProperty({ description: '本次请求总行数(三类合计)' })
  total!: number;

  @ApiProperty() ok!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty({ description: "status='already-exists' 行数(execute 语境下 = 幂等 skip)" })
  alreadyExists!: number;
  @ApiProperty() needsManual!: number;
}

export class AnnouncementImportResultDto {
  @ApiProperty({ type: () => [ImportOrganizationRowResultDto] })
  organizations!: ImportOrganizationRowResultDto[];

  @ApiProperty({ type: () => [ImportPositionRowResultDto] })
  positions!: ImportPositionRowResultDto[];

  @ApiProperty({ type: () => [ImportSupervisionRowResultDto] })
  supervisions!: ImportSupervisionRowResultDto[];

  @ApiProperty({ type: () => ImportSummaryDto })
  summary!: ImportSummaryDto;
}

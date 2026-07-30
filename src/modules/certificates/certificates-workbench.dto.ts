import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CertificateSource } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 证书标准库 PR-5(冻结稿 §13.6 / §14 / §15.2):全局证书工作台。
//
// 与 `GET /admin/v1/members/:memberId/certificates` 的区别不是「同一个查询换个入口」:
// 那个是**单人档案**视角(memberId 在路径上、按 member ref 判权);
// 工作台是**跨人**视角,必须先把可见组织范围下推到 SQL 再计数(§15.7)——
// 否则 total 与 stats 会把范围外的行也算进去,而那是最容易被忽略的一类越权:
// 列表看不到,但计数泄露了「存在多少」。

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_SCHEMA = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as const;

/** 4 态持久状态闭集(与 cert_status 字典一致)。 */
const CERT_STATUS_CODES = ['pending', 'verified', 'expired', 'rejected'] as const;

// ============ 非分页过滤(列表与 stats **共用同一组**,§14)============
//
// 抽成基类而不是各写一遍:§14 明确 stats「接受同一组非分页过滤」。
// 两份定义迟早分叉,而分叉的表现是「列表和统计对不上」——
// 那种 bug 在页面上看起来像数据错乱,排查时却查不出任何一侧单独有错。
export class CertificateWorkbenchFilterDto {
  @ApiPropertyOptional({
    description:
      '模糊搜索:队员编号 / 队员展示名 / 证书标准名称与 code / 发证机构。' +
      '**第一版刻意不搜完整证书编号** —— 那是 L2 数据,可搜即可枚举(§13.6)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional({ description: '按队员过滤', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  memberId?: string;

  @ApiPropertyOptional({
    description: '按组织过滤(经队员的 active PRIMARY 归属;与判权可见范围取交集)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  organizationId?: string;

  @ApiPropertyOptional({ description: '组织过滤是否含下级(闭包展开)', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按证书标准 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  standardCode?: string;

  @ApiPropertyOptional({ description: '按类别字典 code 过滤(经 Standard)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryCode?: string;

  @ApiPropertyOptional({ description: '按等级字典 code 过滤(经 Standard)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  levelCode?: string;

  @ApiPropertyOptional({ description: '按持久状态过滤', enum: CERT_STATUS_CODES })
  @IsOptional()
  @IsIn(CERT_STATUS_CODES)
  certStatusCode?: string;

  @ApiPropertyOptional({ description: '按来源过滤', enum: CertificateSource })
  @IsOptional()
  @IsIn(Object.values(CertificateSource))
  sourceCode?: CertificateSource;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '发证日 ≥(含)' })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedFrom 必须是 YYYY-MM-DD 纯日期' })
  issuedFrom?: string;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '发证日 ≤(含)' })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedTo 必须是 YYYY-MM-DD 纯日期' })
  issuedTo?: string;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '到期日 ≥(含);终身有效不匹配' })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiresFrom 必须是 YYYY-MM-DD 纯日期' })
  expiresFrom?: string;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '到期日 ≤(含);终身有效不匹配' })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiresTo 必须是 YYYY-MM-DD 纯日期' })
  expiresTo?: string;
}

export class ListCertificateWorkbenchQueryDto extends CertificateWorkbenchFilterDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page: number = 1;

  @ApiPropertyOptional({ description: '每页数量', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize: number = 20;
}

// PaginationQueryDto 的字段范围校验(@Min/@Max)在此复用其常量,不重复魔数。
export const WORKBENCH_PAGE_DEFAULTS = {
  page: 1,
  pageSize: 20,
  maxPageSize: 100,
} as const satisfies Record<string, number>;

// ============ 出参 ============

/** Standard 摘要(§15.2 允许返回的白名单之一)。 */
export class WorkbenchStandardSummaryDto {
  @ApiProperty({ description: 'Standard id' })
  id!: string;

  @ApiProperty({ description: 'Standard code' })
  code!: string;

  @ApiProperty({ description: 'Standard 名称' })
  name!: string;

  @ApiProperty({ description: '类别字典 code' })
  categoryCode!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true, type: String })
  levelCode!: string | null;
}

/** 队员摘要(§13.6 的 q 可搜编号与展示名,故出参也给这两项)。 */
export class WorkbenchMemberSummaryDto {
  @ApiProperty({ description: 'Member id' })
  id!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员展示名' })
  displayName!: string;
}

// §15.2 工作台**永不返回**:完整 certNumber / verifyNote / verifiedBy / imageKeys /
// signed URL / sourceClaimId。这个 DTO 因此刻意不含它们 —— 出参形状由 TypeScript 兜底,
// 想返回就必须先来改这个类,不可能顺手多返一个字段。
export class CertificateWorkbenchItemDto {
  @ApiProperty({ description: '证书 id' })
  id!: string;

  @ApiProperty({ description: '队员摘要', type: WorkbenchMemberSummaryDto })
  member!: WorkbenchMemberSummaryDto;

  @ApiProperty({ description: '证书标准摘要', type: WorkbenchStandardSummaryDto })
  standard!: WorkbenchStandardSummaryDto;

  @ApiProperty({ description: '发证机构(审核/录入时的名称快照)' })
  issuingOrg!: string;

  @ApiPropertyOptional({
    description: '证书编号掩码(形如 SZ****01;无编号为 null)。**完整编号不在本端点返回**',
    nullable: true,
    type: String,
  })
  certNumberMasked!: string | null;

  @ApiProperty({ description: '发证日期' })
  issuedAt!: Date;

  @ApiPropertyOptional({ description: '最后有效日(null = 终身有效)', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({ description: '持久状态(4 态闭集)', enum: CERT_STATUS_CODES })
  certStatusCode!: string;

  @ApiProperty({
    description:
      '当前有效展示状态(§14):`certStatusCode=verified` 且 `expiredAt < 北京 today` 时为 ' +
      '`expired`,其余等于 `certStatusCode`。**不是第五个持久状态** —— 它不入库,' +
      '每次读时按今天算,所以不依赖到期 cron 是否已经跑过',
    enum: CERT_STATUS_CODES,
  })
  effectiveStatusCode!: string;

  @ApiProperty({ description: '来源', enum: CertificateSource })
  sourceCode!: CertificateSource;

  @ApiProperty({ description: '是否存在证据(布尔;取证据走 evidence-urls 端点)' })
  evidenceAvailable!: boolean;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

export class CertificateWorkbenchStatsDto {
  @ApiProperty({ description: '待核验(certStatusCode=pending)' })
  pending!: number;

  @ApiProperty({
    description: '有效(verified 且〔expiredAt 为空 或 expiredAt ≥ today〕)',
  })
  verified!: number;

  @ApiProperty({
    description:
      '已过期(certStatusCode=expired **或**〔verified 且 expiredAt < today〕)—— ' +
      '第二个分支是关键:cron 每天 09:00 才翻态,只信持久状态会在它跑之前少算',
  })
  expired!: number;

  @ApiProperty({ description: '已驳回(certStatusCode=rejected)' })
  rejected!: number;

  @ApiProperty({ description: '60 天内到期(verified 且 expiredAt ∈ [today, today+60])' })
  expiringWithin60Days!: number;

  @ApiProperty({ description: '终身有效(verified 且 expiredAt 为空)' })
  permanent!: number;
}

// 让 PaginationQueryDto 参与编译期引用,避免「文档说复用、实际没复用」的漂移。
export type WorkbenchPaginationContract = Pick<PaginationQueryDto, 'page' | 'pageSize'>;

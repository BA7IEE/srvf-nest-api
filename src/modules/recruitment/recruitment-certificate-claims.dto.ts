import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecruitmentCertificateClaimStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { RECRUITMENT_CERT_CATEGORIES } from './recruitment.constants';
import {
  IsIn,
  IsInt,
  IsString,
  IsDateString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// 证书标准库 PR-4a-1(冻结稿 §13.4 / §15.4 / §8.3):招新证书申报管理端 DTO。
//
// 第四轮评审 P1(null 契约,**本文件是 1970-01-01 那条的落点**):
// 本文件全部 16 处可选入参一律 `@OmittableOnly()` —— 没有一个字段是「可清空」的。
// 逐类理由:
//   - 审核入参(ReviewCertificateClaimDto 七项):它们是**审核结论**,
//     每一项要么由 decision 分支判成必填(standardId / issuedAt / note),
//     要么由认定规则判成「必须传 / 不得传」(issuer / certNumber / expiredAt)——
//     三种状态里没有「传 null 表示清空」这一种。
//   - 公开面凭证(wechatCode / phone / code):二选一通道,不传即走另一条;
//     传 null 不是「不用这条通道」,是把 null 当凭证送进去。
//   - 申报事实(Submit / Resubmit 六项):重传是**整份替换**自报事实
//     (service 对每个字段都无条件赋值,不做 `!== undefined` 三态),
//     「这次不填某项」的表达就是不传;传 null 会被 `?? null` 折叠成不填,
//     语义上恰好等价,但契约层不该留这条同义通道 —— 它是下一次误用的入口。
// 唯一真会写 null 的是 service 自己(REJECT 清空标准化结论),那是服务端的动作,
// 不是客户端能提交的入参。
//
// 敏感边界(§15.4),与 Certificate 详情同款范式:
//   Admin 列表/详情默认只给 `certNumberMasked` + `imageCount` + 状态 + 建议 Standard;
//   完整编号与图片 URL 要求 `recruitment-application.read.sensitive`。
//   `imageKeys` **永不出现在任何响应**(§5.5 / D-CERT-024)—— 只给计数与
//   「有没有图」,取图走独立的 image-urls 端点(短 TTL + no-store)。

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_SCHEMA = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as const;

// ============ 出参 ============

/** 已解析 Standard 的摘要(未解析时为 null)。 */
export class ClaimStandardSummaryDto {
  @ApiProperty({ description: 'Standard id' })
  id!: string;

  @ApiProperty({ description: 'Standard code', example: 'bsafe_l2' })
  code!: string;

  @ApiProperty({ description: 'Standard 名称' })
  name!: string;

  @ApiProperty({ description: '类别字典 code(门槛派生只认这个,不认申请人的 categoryHintCode)' })
  categoryCode!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true, type: String })
  levelCode!: string | null;
}

export class RecruitmentCertificateClaimAdminDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '所属报名 id' })
  applicationId!: string;

  @ApiProperty({ description: 'CAS 版本号(重传 / 审核互防覆盖;review 必须回传当前值)' })
  version!: number;

  @ApiProperty({ description: '申报状态', enum: RecruitmentCertificateClaimStatus })
  status!: RecruitmentCertificateClaimStatus;

  @ApiProperty({ description: '申请人选的类别提示(**不是**审核结论)' })
  categoryHintCode!: string;

  @ApiPropertyOptional({
    description: '申请人填的证书名称(自由文本)',
    nullable: true,
    type: String,
  })
  rawCertificateName!: string | null;

  @ApiPropertyOptional({
    description: '申请人建议的 Standard(仅建议,审核员可更正;D-CERT-016)',
    nullable: true,
    type: ClaimStandardSummaryDto,
  })
  suggestedStandard!: ClaimStandardSummaryDto | null;

  @ApiPropertyOptional({
    description: '审核锁定的 Standard;null = 待分类(§11.1)',
    nullable: true,
    type: ClaimStandardSummaryDto,
  })
  standard!: ClaimStandardSummaryDto | null;

  @ApiPropertyOptional({ description: '审核锁定的认定规则 id', nullable: true, type: String })
  recognitionPolicyId!: string | null;

  @ApiPropertyOptional({ description: '审核锁定的认可机构 id', nullable: true, type: String })
  recognitionIssuerId!: string | null;

  @ApiPropertyOptional({ description: '发证机构(审核时的名称快照)', nullable: true, type: String })
  issuingOrg!: string | null;

  @ApiPropertyOptional({
    description: '证书编号掩码(恒返;形如 SZ****01;无编号为 null)',
    nullable: true,
    type: String,
  })
  certNumberMasked!: string | null;

  @ApiPropertyOptional({
    description: '证书编号明文(L2;仅持 recruitment-application.read.sensitive 时返回,否则恒 null)',
    nullable: true,
    type: String,
  })
  certNumberFull!: string | null;

  @ApiPropertyOptional({ description: '发证日期', nullable: true })
  issuedAt!: Date | null;

  @ApiPropertyOptional({ description: '最后有效日(null = 终身)', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({
    description: '证据图数量(**永不返 key**;取图走 image-urls 端点)',
    example: 2,
  })
  imageCount!: number;

  @ApiPropertyOptional({
    description: '审核人 User.id(L2;仅持 read.sensitive 时返回)',
    nullable: true,
    type: String,
  })
  reviewedByUserId!: string | null;

  @ApiPropertyOptional({ description: '审核时刻', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({
    description: '审核备注(L2 自由文本;仅持 read.sensitive 时返回)',
    nullable: true,
    type: String,
  })
  reviewNote!: string | null;

  @ApiPropertyOptional({ description: '发号时刻', nullable: true })
  promotedAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class RecruitmentCertificateClaimListResponseDto {
  @ApiProperty({
    description: '该报名的全部未软删申报(createdAt ASC)',
    type: [RecruitmentCertificateClaimAdminDto],
  })
  items!: RecruitmentCertificateClaimAdminDto[];
}

export class RecruitmentCertificateClaimImageUrlsResponseDto {
  @ApiProperty({ description: '申报 id' })
  claimId!: string;

  @ApiProperty({
    description: '证据图短 TTL signed-URL(**不返 key**;响应带 Cache-Control: no-store)',
    type: [String],
  })
  urls!: string[];

  @ApiProperty({ description: 'URL 过期时刻(TTL ≤ 300s,§15.5)' })
  expiresAt!: Date;
}

// ============ 公开面:证书标准选项(§13.3)============

// 申请人侧选择器。**刻意不从 Admin DTO 派生**(recruitment/CLAUDE.md 铁律:
// 新 open DTO 不得从 Admin DTO 派生)—— 派生会让 Admin 加字段时公开面被动扩面。
export class PublicCertificateStandardOptionDto {
  @ApiProperty({ description: 'Standard id(提交申报时作为 suggestedStandardId 回传)' })
  id!: string;

  @ApiProperty({ description: 'Standard code', example: 'bsafe_l2' })
  code!: string;

  @ApiProperty({ description: 'Standard 名称' })
  name!: string;

  @ApiProperty({ description: '类别字典 code' })
  categoryCode!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true, type: String })
  levelCode!: string | null;

  @ApiProperty({
    description:
      '当前是否可被认定(= 有生效认定规则)。**false 代表「已收录、待认定」**——' +
      '申请人可以选它作为建议,但后台不得据此直接通过(§11.2 / §13.3)',
    example: true,
  })
  currentlyRecognized!: boolean;
}

export class PublicCertificateStandardOptionsResponseDto {
  @ApiProperty({
    description: '可供申请人选择的证书标准(仅 ACTIVE CREDENTIAL,且按招新证书类别过滤)',
    type: [PublicCertificateStandardOptionDto],
  })
  items!: PublicCertificateStandardOptionDto[];
}

// ============ 公开面:申请人视角的申报(§8.1)============

// 申请人只看得到自己填的事实 + 状态 + 驳回说明。
// **刻意不含** standardId / recognitionPolicyId / recognitionIssuerId / reviewedByUserId ——
// 那是审核结论与队内主数据,申请人无需也不该看到(§15.1)。
// 编号回显掩码而不是明文:哪怕是他自己填的,也没有理由让一次公开 GET 把它再吐一遍。
export class PublicCertificateClaimDto {
  @ApiProperty({ description: '申报 id(重传 / 撤回时回传)' })
  id!: string;

  @ApiProperty({ description: 'CAS 版本号(重传 / 撤回必须回传当前值)' })
  version!: number;

  @ApiProperty({ description: '申报状态', enum: RecruitmentCertificateClaimStatus })
  status!: RecruitmentCertificateClaimStatus;

  @ApiProperty({ description: '本人选的类别提示' })
  categoryHintCode!: string;

  @ApiPropertyOptional({ description: '本人填的证书名称', nullable: true, type: String })
  rawCertificateName!: string | null;

  @ApiPropertyOptional({
    description: '本人建议的证书标准 id(仅建议,最终分类由审核决定)',
    nullable: true,
    type: String,
  })
  suggestedStandardId!: string | null;

  @ApiPropertyOptional({ description: '本人填的发证机构', nullable: true, type: String })
  issuingOrg!: string | null;

  @ApiPropertyOptional({
    description: '证书编号掩码(形如 SZ****01;无编号为 null)',
    nullable: true,
    type: String,
  })
  certNumberMasked!: string | null;

  @ApiPropertyOptional({ description: '发证日期', nullable: true })
  issuedAt!: Date | null;

  @ApiPropertyOptional({ description: '最后有效日', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({ description: '已上传证据图数量(**不返 key、不返 URL**)', example: 2 })
  imageCount!: number;

  @ApiPropertyOptional({
    description: '审核说明(驳回 / 要求补材料时对本人可见)',
    nullable: true,
    type: String,
  })
  reviewNote!: string | null;

  @ApiProperty({ description: '提交时间' })
  createdAt!: Date;

  @ApiProperty({ description: '最后更新时间' })
  updatedAt!: Date;
}

export class PublicCertificateClaimResultDto {
  @ApiProperty({ description: '本次操作后的申报', type: PublicCertificateClaimDto })
  claim!: PublicCertificateClaimDto;

  @ApiProperty({
    description: '本次报名当前的全部未软删申报数量(上限 10;达上限后新提交返 28059)',
    example: 2,
  })
  claimCount!: number;
}

// ============ 入参 ============

export class ClaimIdParamDto {
  @ApiProperty({ description: '证书申报 id(cuid)' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  id!: string;
}

export class ApplicationIdParamDto {
  @ApiProperty({ description: '报名 id(cuid)' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  applicationId!: string;
}

// §8.3 审核请求。三种 decision 的必填项不同,由 service 按 decision 分支校验
// (DTO 层无法表达「APPROVE 时 standardId 必填」这种条件必填而不牺牲 400 的清晰度)。
export class ReviewCertificateClaimDto {
  @ApiProperty({
    description: 'APPROVE = 通过并锁定标准化事实 / REJECT = 拒绝 / NEEDS_INFO = 要求补充材料',
    enum: ['APPROVE', 'REJECT', 'NEEDS_INFO'],
  })
  @IsIn(['APPROVE', 'REJECT', 'NEEDS_INFO'])
  decision!: 'APPROVE' | 'REJECT' | 'NEEDS_INFO';

  @ApiProperty({
    description: 'CAS 版本号:必须等于当前 claim.version,否则 28058(防与申请人重传互相覆盖)',
    example: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @ApiPropertyOptional({
    description: 'APPROVE 必填:审核员选定的具体 CREDENTIAL Standard(可更正申请人的建议)',
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  standardId?: string;

  @ApiPropertyOptional({
    description: 'ALLOWLIST 规则必填;FIXED 可不传(后端选唯一);FREE_TEXT 不得传',
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  recognitionIssuerId?: string;

  @ApiPropertyOptional({ description: 'FREE_TEXT 规则必填的自由机构名', maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg?: string;

  @ApiPropertyOptional({ description: '按认定规则的 certNumberMode 校验', maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string;

  @ApiPropertyOptional({
    description: 'APPROVE 必填:发证日期(纯 YYYY-MM-DD,不得晚于今天)',
    ...DATE_ONLY_SCHEMA,
    example: '2026-07-01',
  })
  @OmittableOnly()
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  issuedAt?: string;

  @ApiPropertyOptional({
    description: '最后有效日(按 validityMode:FIXED_MONTHS 不得传、PERMANENT 不得传)',
    ...DATE_ONLY_SCHEMA,
    example: '2028-06-30',
  })
  @OmittableOnly()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiredAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  expiredAt?: string;

  @ApiPropertyOptional({
    description: 'REJECT / NEEDS_INFO 必填的说明(申请人进度可见);APPROVE 可选',
    maxLength: 500,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

// §8.2 末段:发号前发现 APPROVED 结论错误时的独立「撤回审核」动作。
export class RevokeCertificateClaimReviewDto {
  @ApiProperty({ description: 'CAS 版本号', example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @ApiProperty({ description: '撤回原因(必填;写高价值审计)', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

// ============ 公开面入参(§8.1;multipart 文件位 images)============

// 双通道凭证。三个公开端点共用 —— 抽成基类而不是各写一遍,
// 是为了让「通道二选一」这条规则只有一处定义(§13.3)。
class PublicClaimCredentialDto {
  @ApiPropertyOptional({
    description: '通道①:微信 wx.login code(与 phone+code 二选一)',
    maxLength: 128,
  })
  @OmittableOnly()
  @IsString()
  @MaxLength(128)
  wechatCode?: string;

  @ApiPropertyOptional({ description: '通道②:手机号(配合 code)' })
  @OmittableOnly()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: '通道②:短信验证码(消费一码)' })
  @OmittableOnly()
  @IsString()
  @MaxLength(10)
  code?: string;
}

export class SubmitCertificateClaimDto extends PublicClaimCredentialDto {
  @ApiProperty({
    description: '证书类别提示(仅提示;最终分类由审核决定)',
    enum: RECRUITMENT_CERT_CATEGORIES as unknown as string[],
  })
  @IsIn(RECRUITMENT_CERT_CATEGORIES, { message: '证书类别非法' })
  categoryHintCode!: string;

  @ApiPropertyOptional({ description: '证书名称(自由文本)', maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MaxLength(128)
  rawCertificateName?: string;

  @ApiPropertyOptional({
    description:
      '建议的证书标准 id(来自公开标准选项端点;「不确定」时不传 —— 不确定是合法选项,§8.1)',
    maxLength: 32,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  suggestedStandardId?: string;

  @ApiPropertyOptional({ description: '发证机构(自由文本)', maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MaxLength(128)
  issuingOrg?: string;

  @ApiPropertyOptional({ description: '证书编号', maxLength: 128 })
  @OmittableOnly()
  @IsString()
  @MaxLength(128)
  certNumber?: string;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '发证日期', example: '2026-07-01' })
  @OmittableOnly()
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  issuedAt?: string;

  @ApiPropertyOptional({ ...DATE_ONLY_SCHEMA, description: '最后有效日', example: '2028-06-30' })
  @OmittableOnly()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiredAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  expiredAt?: string;
}

// 重传 = 换图 + 可选改自报事实。CAS `version` 必填:审核员可能正在看这条,
// 不带版本号的重传会静默盖掉刚落的审核结论(§5.5)。
export class ResubmitCertificateClaimDto extends SubmitCertificateClaimDto {
  @ApiProperty({ description: 'CAS 版本号:必须等于当前 claim.version,否则 28058', example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class WithdrawCertificateClaimDto extends PublicClaimCredentialDto {
  @ApiProperty({ description: 'CAS 版本号', example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

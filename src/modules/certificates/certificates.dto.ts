import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

// V2 第一阶段批次 2 certificates 模块 DTO 集合。
// 详见 docs:批次2_API前评审_certificates.md §3 + 草案 v1.0 §4 / §5.1 / §13。
//
// **绝对禁止**入参字段(全部由全局 ValidationPipe + forbidNonWhitelisted 兜底):
// - id / memberId / createdAt / updatedAt / deletedAt(系统字段)
// - certStatusCode / verifiedBy / verifiedAt / verifyNote(状态机内部;通过 verify/reject 动作接口写)
// - isInternal(Q-S7 + Q-A3:本批次 service 始终写 false,DTO 不接受)
// - supersededByCertId(本批次零 API 暴露;假数据走 prisma.create)
// - expireNotifyDueAt(后台任务字段,本批次不实装)
//
// 字段长度上限对齐草案 v1.0 §5.1:
// - issuingOrg 128 / certNumber 128(Q-D3) / verifyNote 500(Q-S5) / 字典 code 64

// ============ 出参 ============

export class CertificateResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '关联队员外键(指向 members.id;N:1)' })
  memberId!: string;

  // 证书标准库 PR-4b(⚠️ 契约破坏):`certTypeCode` / `certSubTypeCode` / `isInternal`
  // **已从出参移除**,列也已 DROP。类别、等级、内部属性的唯一权威是 CertificateStandard,
  // 用 `standardId` 去取(§6 数据权威表明令禁止实例侧副本)。
  @ApiProperty({ description: '颁发机构(CT-4;认定规则解析后的名称快照)' })
  issuingOrg!: string;

  // 证书标准库 PR-1(冻结稿 §15.3):完整证书编号是 L2(可用于外部查询或冒用),
  // 拆成「恒返掩码 + 明文按权限」两个字段,而不是沿 member-profiles 的「同名字段原地打码」。
  //
  // 为何拆名:同名打码有已知的 FE 回写陷阱 —— 管理端编辑表单 round-trip 会把掩码值
  // 当真值写回,覆盖真实编号(member-profiles 只能靠 admin-web 侧「值含 * 则 delete」
  // 的约定缓解)。`certNumber` 是 PATCH 可写字段,踩中概率高;读出参改名后,
  // 表单拿不到可直接回写的 `certNumber`,陷阱在结构上不成立。
  // 显式 `type: String`:Swagger 插件对 `string | null` 的推导不稳(实测把 Full 推成
  // `type: object`、Masked 干脆无 type),契约里的类型必须是确定的,前端才能 codegen。
  @ApiPropertyOptional({
    description: '证书编号掩码(CT-5;恒返;形如 SZ****01;无编号为 null)',
    type: String,
    nullable: true,
  })
  certNumberMasked!: string | null;

  @ApiPropertyOptional({
    description:
      '证书编号明文(CT-5;L2;仅持 certificate.read.sensitive 且通过该证书 scoped 判权时返回,否则恒 null)',
    type: String,
    nullable: true,
  })
  certNumberFull!: string | null;

  @ApiProperty({ description: '颁发日期(CT-6;ISO 8601)' })
  issuedAt!: Date;

  @ApiPropertyOptional({
    description: '到期日(CT-7;NULL = 终身有效;Q-S4)',
    nullable: true,
  })
  expiredAt!: Date | null;

  @ApiProperty({
    description: '核验状态字典 code(CT-8;4 态闭集 pending / verified / expired / rejected)',
  })
  certStatusCode!: string;

  @ApiPropertyOptional({
    description:
      '核验人 Member.id(CT-9a;L2 跨成员身份;仅持 certificate.read.sensitive 时返回,否则恒 null;§15.3)',
    nullable: true,
  })
  verifiedBy!: string | null;

  @ApiPropertyOptional({ description: '核验时间(CT-9b)', nullable: true })
  verifiedAt!: Date | null;

  @ApiPropertyOptional({
    description:
      '核验备注(CT-9c;L2 自由文本;仅持 certificate.read.sensitive 时返回,否则恒 null;§15.3)',
    nullable: true,
  })
  verifyNote!: string | null;

  // §15.3 普通读返 evidenceAvailable 布尔,让前端知道「有没有证据可看」而不泄露任何
  // key / URL;真正取证据走 §13.5 的 evidence-urls 端点(PR-5)。
  // 当前证据事实源是 `Certificate.imageKeys`;PR-4a 起改读 sourceClaim.imageKeys,
  // PR-4b 删该列 —— 届时本字段只换取值来源,对外契约不变。
  @ApiProperty({ description: '是否存在证据图(布尔;不返 key / URL;取证据走 evidence-urls 端点)' })
  evidenceAvailable!: boolean;

  // 证书标准库 PR-4a-3(§9.1 步骤 7):标准化事实四列进出参。
  // 它们是队内主数据的**引用**(L1 配置面),不是敏感字段 —— 前端靠 standardId
  // 显示「这是哪个标准」,靠 sourceCode 决定 evidence 从哪读(§13.5)。
  // 与 certificateSafeSelect 同步维护(该 select 注释里写明了这条约束)。
  @ApiPropertyOptional({
    description: '证书标准 id(PR-4b 收紧为恒非空)',
    nullable: true,
    type: String,
  })
  standardId!: string | null;

  @ApiPropertyOptional({
    description: '录入 / 审核时锁定的认定规则 id(PR-4b 收紧为恒非空)',
    nullable: true,
    type: String,
  })
  recognitionPolicyId!: string | null;

  @ApiPropertyOptional({
    description: '认可机构 id(FREE_TEXT 规则下为 null,机构名见 issuingOrg)',
    nullable: true,
    type: String,
  })
  recognitionIssuerId!: string | null;

  @ApiPropertyOptional({
    description: '来源:ADMIN = 管理端录入 / RECRUITMENT = 招新发号搬运(PR-4b 收紧为恒非空)',
    enum: ['ADMIN', 'RECRUITMENT'],
    nullable: true,
  })
  sourceCode!: string | null;

  @ApiPropertyOptional({
    description: '替代关系:被替代的旧证书 id(CT-12;不做反向冗余,Q-S6 / Q-D2)',
    nullable: true,
  })
  supersededByCertId!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 列表项 DTO:精简版(草案 §13.1 默认隐藏)。
// 不返:certNumber / verifyNote / verifiedBy / verifiedAt / supersededByCertId。
export class CertificateListItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '关联队员外键' })
  memberId!: string;

  // PR-4b:列表同样移除三个实例侧副本,改带 standardId / sourceCode。
  @ApiProperty({ description: '证书标准 id(类别 / 等级 / 内部属性都 join Standard 取)' })
  standardId!: string;

  @ApiProperty({ description: '来源:ADMIN 或 RECRUITMENT', enum: ['ADMIN', 'RECRUITMENT'] })
  sourceCode!: string;

  @ApiProperty({ description: '颁发机构' })
  issuingOrg!: string;

  @ApiProperty({ description: '颁发日期' })
  issuedAt!: Date;

  @ApiPropertyOptional({ description: '到期日(NULL = 终身有效)', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({ description: '核验状态字典 code(4 态闭集)' })
  certStatusCode!: string;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// §12 判据级别闭集。声明在两个 DTO **之前** —— 装饰器在类定义时求值,
// 写在后面会撞 TDZ(本仓 admin-api F-sequence 已经栽过一次)。
export const QUALIFICATION_CRITERION_TYPES = ['category', 'standard'] as const;
export type QualificationCriterionType = (typeof QUALIFICATION_CRITERION_TYPES)[number];

// 证书标准库 · 评审 findings F4(冻结稿 §12,⚠️ **契约破坏**):
// 出参从三字段扩到五字段,并把 `certTypeCode` 换成 `criterionType` + `criterionCode`。
//
// 为什么要返 `matchedCertificateId` 与 `expiredAt`:只回一个布尔,调用方拿到 `false`
// 无法区分「没有这张证」与「有但过期了」,拿到 `true` 也无法回答「什么时候要提醒续期」。
// 多张证书命中时选哪一张必须是**确定**的(见 service 的四级稳定排序)——
// 否则同一个人同一次查询可能返回不同的 `matchedCertificateId`。
export class QualificationFlagResponseDto {
  @ApiProperty({ description: '查询的 Member.id' })
  memberId!: string;

  @ApiProperty({
    description: '判据级别(回显入参)',
    enum: QUALIFICATION_CRITERION_TYPES,
  })
  criterionType!: QualificationCriterionType;

  @ApiProperty({ description: '判据 code(回显入参)' })
  criterionCode!: string;

  @ApiProperty({
    description: '是否具备资质(已核验 + 未过期 + 未软删;§10.5 / §12)',
  })
  qualified!: boolean;

  @ApiPropertyOptional({
    description: '命中的证书 id(四级稳定排序选出的那一张;不具备资质时为 null)',
    type: String,
    nullable: true,
  })
  matchedCertificateId!: string | null;

  @ApiPropertyOptional({
    description: '命中证书的最后有效日(null = 终身有效,或不具备资质)',
    type: Date,
    nullable: true,
  })
  expiredAt!: Date | null;
}

// ============ 日期入参口径(证书标准库 PR-1 · 冻结稿 §10.2)============

// 「所有证书日期只接受 YYYY-MM-DD,不再接受带时区和时分秒的任意 ISO datetime。」
//
// 为什么收紧:`expiredAt` 是**最后有效日**(§10.1),是一个日历日而不是瞬间。
// 放开 datetime 会让 `2026-08-01T00:00:00+08:00` 与 `2026-08-01T00:00:00Z` 这类
// 输入落到不同的北京日(前者 08-01、后者 07-31),同一个"意图日期"产生两种入库结果。
// 收成纯日期后,归一只有一条路径,客户端也无法用时区偷偷改天。
//
// 两个装饰器各管一件事,缺一不可:
// - `@Matches` 管**形状**(必须恰好 10 位纯日期,拒绝任何时分秒/时区后缀);
// - `@IsDateString({ strict: true })` 管**日历真实性**(拒绝 2026-02-30 / 2027-02-29
//   这类形状合法但不存在的日期 —— 光靠正则拦不住)。
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_DESC = '纯日期 YYYY-MM-DD(不接受时分秒与时区;按北京日历日入库)';

// 同时把口径写进 OpenAPI schema,而不是只写在 description 里 ——
// `@Matches` 不会被 Swagger 插件推导成 `pattern`,契约里就只剩一句人类可读的说明,
// 前端 codegen 拿不到可执行约束。PR-6 要求前端适配日期格式收紧,这里必须是机器可读的。
const DATE_ONLY_SCHEMA = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as const;

// ============ 入参:Create ============

// 必填:certTypeCode / issuingOrg / issuedAt;其余可选(schema 可空,Q-D4 / Q-D5)。
// 证书标准库 PR-4a-3(冻结稿 §9.1):**契约破坏性变化**。
// 入参从「两个字典 code + 自由文本机构」改为「一个 Standard id + 按认定规则的机构入参」:
//   certTypeCode / certSubTypeCode  →  standardId
//   issuingOrg(恒必填自由文本)      →  recognitionIssuerId 或 issuingOrg,由该 Standard
//                                       当前生效认定规则的 issuerPolicy 决定该传哪个
//
// 为什么不保留旧字段做兼容:两套入参就是两个事实源,而 category 猜 Standard 是
// 冻结稿明令禁止的(§21 硬禁区)。旧字段留着,下一个人就会用它。
export class CreateCertificateDto {
  @ApiProperty({
    description:
      '证书标准 id(必填;须为 ACTIVE 且 CREDENTIAL —— 证书族 FAMILY 不可持有)。' +
      '来源:GET /admin/v1/certificate-standards/options',
    maxLength: 32,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  standardId!: string;

  @ApiPropertyOptional({
    description: '认可机构 id。ALLOWLIST 规则**必填**;FIXED 可不传(后端选唯一);FREE_TEXT 不得传',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  recognitionIssuerId?: string;

  @ApiPropertyOptional({
    description: 'FREE_TEXT 规则**必填**的自由机构名;FIXED / ALLOWLIST 不得传',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg?: string;

  @ApiPropertyOptional({ description: '证书编号(中敏感)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string;

  @ApiProperty({
    description: `颁发日期(${DATE_ONLY_DESC};不得晚于今天;必填)`,
    ...DATE_ONLY_SCHEMA,
    example: '2026-07-01',
  })
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  issuedAt!: string;

  @ApiPropertyOptional({
    description: `最后有效日(${DATE_ONLY_DESC};不填 = 终身有效)`,
    ...DATE_ONLY_SCHEMA,
    example: '2028-06-30',
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiredAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  expiredAt?: string;
}

// ============ 入参:Update ============

// PATCH 语义:全字段 optional;**绝对禁止** certStatusCode / verifiedBy / verifiedAt / verifyNote /
//   isInternal / supersededByCertId / expireNotifyDueAt(forbidNonWhitelisted 兜底)。
// Q-A4 决议:接受 issuedAt / expiredAt 资料修正。
// 证书标准库 PR-4a-3(§9.2):`standardId` **只在 pending 态可改**(纠正选错的标准),
// 非 pending 传它 → 18033。这条不做进 DTO 是因为它依赖行状态,DTO 看不到 ——
// 但「改了 Standard 就重选当前 ACTIVE Policy 并完整重校验」这条由 service 保证。
// 评审 findings F3:**三态语义**在契约层就要能表达,否则 service 无论怎么写都猜不出来。
//
//   字段不出现        → 保持库内现值
//   字段出现且为 null → 清空
//   字段出现且有值    → 用新值
//
// 可空字段用 `string | null` + `@IsOptional()`(class-validator 对 null 与 undefined
// 都跳过校验,所以显式 null 能穿过校验层抵达 service,由 service 区分二者)。
// **不可空**的 `issuedAt` 不能用 `@IsOptional()` —— 那会让 `issuedAt: null` 静默通过再被
// service 的 `??` 悄悄换成库内值,客户端以为自己清空了。改用 `@ValidateIf`:
// 只要 key 出现就必须过 `@Matches`,null 因此稳定 400。
export class UpdateCertificateDto {
  @ApiPropertyOptional({
    description: '证书标准 id(**仅 pending 态可改** —— 纠正选错的标准;非 pending → 18033)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  standardId?: string;

  @ApiPropertyOptional({
    description: '认可机构 id(按认定规则的 issuerPolicy;传 null = 清空)',
    maxLength: 32,
    // 显式 `type: String` 不能省:Swagger 插件对 `string | null` 的推导不稳,
    // 实测会推成 `type: object` —— 前端 codegen 拿到的就不是字符串了。
    // 出参侧(CertificateResponseDto)早有同款注释,入参侧这次由 contract 快照抓出来。
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  recognitionIssuerId?: string | null;

  @ApiPropertyOptional({
    description: 'FREE_TEXT 规则的自由机构名(传 null = 清空)',
    maxLength: 128,
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg?: string | null;

  @ApiPropertyOptional({
    description: '证书编号(传 null = 清空;OPTIONAL 编号规则下可改回无编号)',
    maxLength: 128,
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string | null;

  @ApiPropertyOptional({
    description: `颁发日期(${DATE_ONLY_DESC};不得晚于今天;Q-A4 决议:允许资料修正)。库内 NOT NULL,**不接受 null**`,
    ...DATE_ONLY_SCHEMA,
    example: '2026-07-01',
  })
  @ValidateIf((o: UpdateCertificateDto) => o.issuedAt !== undefined)
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  issuedAt?: string;

  @ApiPropertyOptional({
    description: `最后有效日(${DATE_ONLY_DESC};Q-A4 决议:允许资料修正)。**不传 = 保持原值,传 null = 清成终身有效**`,
    ...DATE_ONLY_SCHEMA,
    example: '2028-06-30',
    nullable: true,
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiredAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  expiredAt?: string | null;
}

// ============ 入参:Verify ============

// 核验通过动作 DTO;state transition pending → verified 由 service 控制。
// **不接收** certStatusCode / verifiedBy / verifiedAt / issuedAt / expiredAt(Q-A4 决议)。
// 轻量类:仅 verifyNote 可选(verify 通过时备注非必填)。
export class VerifyCertificateDto {
  @ApiPropertyOptional({ description: '核验备注(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  verifyNote?: string;
}

// ============ 入参:Reject ============

// 核验拒绝动作 DTO;verifyNote 必填(业务严格,DTO 严格记录拒绝理由)。
// **不接收** certStatusCode / verifiedBy / verifiedAt / issuedAt / expiredAt(Q-A4 决议)。
export class RejectCertificateDto {
  @ApiProperty({ description: '拒绝原因(必填)', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  verifyNote!: string;
}

// ============ 入参:QualificationFlag(query 参数) ============

// 资质判定 query 参数 DTO。NestJS 默认不强制 @Query() 必填,
// 需走 DTO + 全局 ValidationPipe(transform + whitelist + forbidNonWhitelisted)兜底校验。
//
// 证书标准库 · 评审 findings F4(冻结稿 §12,⚠️ **契约破坏**):
// 旧参数 `certTypeCode` 只能表达「大类级」一种判据,而 §12 要的是两级:
//
//   criterionType = category  → 按 Standard.categoryCode 匹配(cert_type 字典 code)
//   criterionType = standard  → 按 Standard.code 匹配(具体到某一个标准)
//
// **旧 `certTypeCode` 直接删除、不做兼容**:两套入参就是两个事实源,
// 而且 `certTypeCode=first_aid` 与 `criterionType=category&criterionCode=first_aid`
// 语义完全重合 —— 留着只会让下一个人以为它们有区别。
// `forbidNonWhitelisted` 会把继续发 `certTypeCode` 的调用方直接拒成 400,
// 而不是静默当成「没传判据」返回一个错误答案。
//
// 判据一律用**稳定 code**,不收 cuid(§12 明写「不使用跨环境不稳定的 cuid 作为业务规则参数」)——
// 岗位要求、活动门槛这类配置将来会引用它,而 cuid 换个环境就失效。
export class QualificationFlagQueryDto {
  @ApiProperty({
    description: '判据级别:category = 按证书大类;standard = 按具体证书标准',
    enum: QUALIFICATION_CRITERION_TYPES,
    example: 'category',
  })
  @IsIn(QUALIFICATION_CRITERION_TYPES)
  criterionType!: QualificationCriterionType;

  @ApiProperty({
    description:
      '判据 code(稳定 code,非 cuid)。criterionType=category 时为 cert_type 字典 code;' +
      'criterionType=standard 时为 CertificateStandard.code',
    maxLength: 64,
    example: 'first_aid',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  criterionCode!: string;
}

// ============ 证书标准库 PR-5(冻结稿 §13.5):证据读取 ============

export class CertificateEvidenceUrlsResponseDto {
  @ApiProperty({ description: '证书 id' })
  certificateId!: string;

  @ApiProperty({
    description:
      '证据来源:RECRUITMENT 读 sourceClaim.imageKeys;ADMIN 读 ownerType=certificate 的标准 Attachment',
    enum: ['ADMIN', 'RECRUITMENT'],
  })
  sourceCode!: string;

  @ApiProperty({
    description:
      '证据短 TTL signed-URL(**只返 URL 不返 key**;响应带 Cache-Control: no-store)。' +
      'ADMIN 来源经 AttachmentsService 的可读性 + pinned ledger 解析,' +
      'provider/ledger 状态不确定的项**不出现在数组里**(fail-closed,不回退裸 key)',
    type: [String],
  })
  urls!: string[];

  @ApiPropertyOptional({
    description: 'URL 过期时刻(RECRUITMENT 来源 TTL ≤300s;ADMIN 来源由 attachments 侧决定)',
    nullable: true,
  })
  expiresAt!: Date | null;
}

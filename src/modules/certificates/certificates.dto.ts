import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

  @ApiProperty({ description: '证书大类字典 code(CT-2;字典 cert_type)' })
  certTypeCode!: string;

  @ApiPropertyOptional({
    description: '证书子类型 / 等级字典 code(CT-3;字典 cert_sub_type;Q-D4 schema 可空)',
    nullable: true,
  })
  certSubTypeCode!: string | null;

  @ApiProperty({ description: '颁发机构(CT-4;自由文本)' })
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

  @ApiProperty({ description: '是否本会颁发(CT-11;本批次 service 始终写 false)' })
  isInternal!: boolean;

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

  @ApiProperty({ description: '证书大类字典 code' })
  certTypeCode!: string;

  @ApiPropertyOptional({ description: '证书子类型 / 等级字典 code', nullable: true })
  certSubTypeCode!: string | null;

  @ApiProperty({ description: '颁发机构' })
  issuingOrg!: string;

  @ApiProperty({ description: '颁发日期' })
  issuedAt!: Date;

  @ApiPropertyOptional({ description: '到期日(NULL = 终身有效)', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({ description: '核验状态字典 code(4 态闭集)' })
  certStatusCode!: string;

  @ApiProperty({ description: '是否本会颁发' })
  isInternal!: boolean;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class QualificationFlagResponseDto {
  @ApiProperty({ description: '查询的 Member.id' })
  memberId!: string;

  @ApiProperty({ description: '查询的证书大类 code' })
  certTypeCode!: string;

  @ApiProperty({
    description: '是否具备资质(已核验 + 未过期 + 未软删;草案 §9.3 / Q-S9)',
  })
  qualified!: boolean;
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

  @ApiPropertyOptional({ description: '认可机构 id(按认定规则的 issuerPolicy)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  recognitionIssuerId?: string;

  @ApiPropertyOptional({ description: 'FREE_TEXT 规则的自由机构名', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg?: string;

  @ApiPropertyOptional({ description: '证书编号', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string;

  @ApiPropertyOptional({
    description: `颁发日期(${DATE_ONLY_DESC};不得晚于今天;Q-A4 决议:允许资料修正)`,
    ...DATE_ONLY_SCHEMA,
    example: '2026-07-01',
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'issuedAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  issuedAt?: string;

  @ApiPropertyOptional({
    description: `最后有效日(${DATE_ONLY_DESC};Q-A4 决议:允许资料修正;不填 = 保持原值)`,
    ...DATE_ONLY_SCHEMA,
    example: '2028-06-30',
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, { message: 'expiredAt 必须是 YYYY-MM-DD 纯日期' })
  @IsDateString({ strict: true })
  expiredAt?: string;
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
// 缺 certTypeCode → @IsString 失败 → 400。
export class QualificationFlagQueryDto {
  @ApiProperty({ description: '证书大类 code(必填)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certTypeCode!: string;
}

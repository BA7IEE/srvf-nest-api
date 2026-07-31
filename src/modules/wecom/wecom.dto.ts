import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { WecomCredentialStatus } from './wecom.types';

// 企业微信接入 T2(2026-08-01):WeCom Settings DTO 集合(冻结稿 §6.1;镜像 wechat.dto Settings 段)
//
// **入参 DTO 字段白名单铁律**(纵深防御;全局 forbidNonWhitelisted 兜底):
// - UpdateWecomSettingsDto:**禁止** corpSecret / corpSecretEncrypted / credentialConfigured /
//   callbackToken / encodingAesKey / accessToken / id / createdAt / updatedAt / updatedBy
//   (冻结稿 §6.1「DTO whitelist 严格拒绝任何 secret/token/callback key 字段」;
//    §0.3 明确第一版不加回调 Token 与 EncodingAESKey —— 连字段位都不开)
// - ResetWecomCredentialsDto:仅 corpSecret
//
// **出参 DTO**(§5.5 L3 红线):
// - WecomSettingsResponseDto **永不**包含 corpSecret 明文 / 密文 / access token /
//   configurationGeneration;corpId 只回显**掩码**;GET 不存在时返 `data: null`

// === 字段长度 / 取值常量 ===
const CORP_ID_MAX_LENGTH = 64;
const WEB_BASE_URL_MAX_LENGTH = 255;
const REMARKS_MAX_LENGTH = 500;
const SECRET_MAX_LENGTH = 256;
// providerType 在 schema 侧是 String 不是 Prisma enum(冻结稿 §5.1 逐字),
// 故取值闭集由 DTO 的 @IsIn 把关(写入口),运行时另有第②重(WecomService.resolveRoute)。
export const WECOM_PROVIDER_TYPES = ['DEV_STUB', 'WECOM'] as const;
export type WecomProviderType = (typeof WECOM_PROVIDER_TYPES)[number];

// ============ Settings 出参 ============

export class WecomSettingsResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  @ApiProperty({
    description: '通道类型(production-like 禁 DEV_STUB)',
    enum: WECOM_PROVIDER_TYPES,
  })
  providerType!: WecomProviderType;

  @ApiProperty({ description: '全局启用开关;false 时登录与消息全部 fail-closed' })
  enabled!: boolean;

  @ApiProperty({ description: '登录开关;false 时 OAuth authorize / login / bind-self 不可用' })
  loginEnabled!: boolean;

  @ApiProperty({ description: '消息开关;false 时不创建新的 WeCom intent' })
  messageEnabled!: boolean;

  @ApiPropertyOptional({
    description: '企业 CorpID 的**掩码**回显(如 ww12****cdef);全值不出响应(§5.5)',
    nullable: true,
  })
  corpIdMasked!: string | null;

  @ApiPropertyOptional({ description: '自建应用 AgentID(非 secret,可回显)', nullable: true })
  agentId!: number | null;

  @ApiPropertyOptional({
    description: 'H5 站点 origin(仅 origin,不含 path/query/fragment);production 必须 HTTPS',
    nullable: true,
  })
  webBaseUrl!: string | null;

  @ApiProperty({ description: 'DB 层是否已配置凭证(运行时状态看 credentialStatus)' })
  credentialConfigured!: boolean;

  @ApiProperty({
    description:
      '凭证状态三档(configured / missing / invalid);CorpSecret 明文与密文永不回显。' +
      'invalid = 密文在但解不开(WECOM_ENCRYPTION_KEY 轮换或密文被篡改),此时通道 fail-closed',
    enum: WecomCredentialStatus,
  })
  credentialStatus!: WecomCredentialStatus;

  @ApiPropertyOptional({ description: '运维备注(不参与 configurationGeneration)', nullable: true })
  remarks!: string | null;

  @ApiPropertyOptional({ description: '最后更新人 User.id', nullable: true })
  updatedBy!: string | null;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

// ============ Settings 入参 ============

export class UpdateWecomSettingsDto {
  @ApiPropertyOptional({
    description: '通道类型;production-like 环境拒绝 DEV_STUB(冻结稿 §5.1 规则 4 第①重)',
    enum: WECOM_PROVIDER_TYPES,
  })
  @OmittableOnly()
  @IsIn(WECOM_PROVIDER_TYPES)
  providerType?: WecomProviderType;

  @ApiPropertyOptional({ description: '全局启用开关' })
  @OmittableOnly()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: '登录开关;置 true 时必须同时 enabled=true(否则 40000)',
  })
  @OmittableOnly()
  @IsBoolean()
  loginEnabled?: boolean;

  @ApiPropertyOptional({
    description: '消息开关;置 true 时必须同时 enabled=true(否则 40000)',
  })
  @OmittableOnly()
  @IsBoolean()
  messageEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      '企业 CorpID;**仅当 active WecomIdentity 数为 0 时可改**,否则 36020' +
      '(改 CorpID 等于换一整套身份口径,已绑定的人会集体失配)',
  })
  @OmittableOnly()
  @IsString()
  @MaxLength(CORP_ID_MAX_LENGTH)
  corpId?: string;

  @ApiPropertyOptional({ description: '自建应用 AgentID(正整数)' })
  @OmittableOnly()
  @IsInt()
  @Min(1)
  agentId?: number;

  @ApiPropertyOptional({
    description:
      'H5 站点 origin,如 https://app.example.com;**仅 origin** —— ' +
      'OAuth callback path 与通知 detail path 由代码固定拼接,不接受外部传入(防开放重定向)',
  })
  @OmittableOnly()
  @IsString()
  @MaxLength(WEB_BASE_URL_MAX_LENGTH)
  webBaseUrl?: string;

  @ApiPropertyOptional({ description: '运维备注' })
  @OmittableOnly()
  @IsString()
  @MaxLength(REMARKS_MAX_LENGTH)
  remarks?: string;
}

export class ResetWecomCredentialsDto {
  @ApiProperty({
    description: '企业微信自建应用 CorpSecret 明文;Service 层 AES-256-GCM 加密后落库;**永不回显**',
    minLength: 1,
    maxLength: SECRET_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SECRET_MAX_LENGTH)
  corpSecret!: string;
}

// ============ test-connection 出参(冻结稿 §6.1)============

export class WecomVisibilitySummaryDto {
  @ApiProperty({ description: '应用可见范围内直接成员**数量**' })
  directUsers!: number;

  @ApiProperty({ description: '应用可见范围内部门**数量**' })
  parties!: number;

  @ApiProperty({ description: '应用可见范围内标签**数量**' })
  tags!: number;
}

// ⚠️ 只有计数,**没有任何 ID**(冻结稿 §6.1 第 4 条)。
// 诊断接口回一份成员 / 部门 / 标签 ID 列表,就等于把通讯录做成了一个导出端点 ——
// 而"不接通讯录"正是 §0.3 的硬禁区。计数够回答"配没配对",ID 不是诊断必需。
export class WecomTestConnectionResponseDto {
  @ApiProperty({ description: '整体连通性结论' })
  ok!: boolean;

  @ApiProperty({ description: '本次诊断使用的通道类型', enum: WECOM_PROVIDER_TYPES })
  providerType!: WecomProviderType;

  @ApiProperty({ description: '凭证状态三档', enum: WecomCredentialStatus })
  credentialStatus!: WecomCredentialStatus;

  @ApiProperty({ description: '是否成功取到 access token(强制跳过缓存取新的)' })
  tokenAcquired!: boolean;

  @ApiProperty({ description: '`agent/get` 返回的 agentid 是否与配置一致' })
  agentMatched!: boolean;

  @ApiProperty({ description: '应用是否处于启用状态(上游 close=0)' })
  agentEnabled!: boolean;

  @ApiPropertyOptional({ description: '应用名称(上游回执;非敏感)', nullable: true })
  agentName!: string | null;

  @ApiProperty({ description: '可见范围**计数**摘要(不含任何成员/部门/标签 ID)' })
  visibilitySummary!: WecomVisibilitySummaryDto;

  @ApiProperty({
    description:
      '是否已配置 webBaseUrl(可信域名的**本地**前置条件)。' +
      '⚠️ 它证明不了企业微信后台那侧登记了可信域名 —— 那只能由真实 OAuth 回跳验证',
  })
  redirectDomainConfigured!: boolean;

  @ApiProperty({ description: '诊断时刻' })
  checkedAt!: Date;
}

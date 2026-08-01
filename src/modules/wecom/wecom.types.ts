// 企业微信接入 T2(2026-08-01):运行时类型
//
// 冻结稿 §5.1 / §6.1 / §7.1 / §7.2。
//
// 这些类型仅在 Service / Provider / 测试中使用;
// **API DTO 出参永不包含 `credentials`**(CorpSecret 明文与密文皆 L3 红线,§5.5)。

// 凭证状态三档(镜像 wechat / sms CredentialStatus 语义)
// - configured:credentialConfigured=true 且 CorpSecret 密文成功解密
// - missing:credentialConfigured=false 或密文列为 null
// - invalid:credentialConfigured=true 但解密失败
//   (§5.1 规则 10:第一版不支持 key rotation —— Key 一变就落到这一档并 fail-closed,
//    刻意不做"自动重加密",那需要旧 key 还在手上,而"key 已经换了"正是本档的前提)
export enum WecomCredentialStatus {
  CONFIGURED = 'configured',
  MISSING = 'missing',
  INVALID = 'invalid',
}

// 运行时合成的企业微信配置。
// `credentials` 明文仅在 Service / Provider 内部传递,**不进任何 API 出参 / 日志 / audit**。
export interface WecomSettingsResolved {
  id: string;
  // 仅供进程内 token cache 等值比较(§5.1 规则 8:不落库,由 effect 字段做 SHA-256 opaque hash)。
  // 不得进入日志 / audit / response / error。`remarks` 不参与(规则 9)——
  // 改一句备注不该让全进程的 access token 作废。
  configurationGeneration: string;
  providerType: string; // DEV_STUB | WECOM
  enabled: boolean;
  loginEnabled: boolean;
  messageEnabled: boolean;
  corpId: string | null;
  agentId: number | null;
  webBaseUrl: string | null;
  credentials: { corpSecret: string } | null;
  credentialStatus: WecomCredentialStatus;
  remarks: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  createdAt: Date;
}

// `agent/get` 快照(冻结稿 §6.1 / §7.1 规则 12)。
// ⚠️ `allowUserIds / allowPartyIds / allowTagIds` **不得穿过 service 边界** ——
// 只在 WecomService 内被计数,计数后即弃。这是 §6.1 第 4 条的执行位:
// test-connection 是"连通性诊断",不是"通讯录导出接口"。
export interface WecomAgentSnapshot {
  agentId: number;
  name: string;
  close: number;
  allowUserCount: number;
  allowPartyCount: number;
  allowTagCount: number;
}

// 应用消息发送入参(T5B 才真正消费;T2 只定形状,Provider 留桩)。
export interface WecomTextCardInput {
  toUser: string;
  title: string;
  description: string;
  url: string;
  btnTxt?: string;
}

// 发送结果(判别联合):不抛异常,逐收件人记账(镜像 wechat SendSubscribeMessageResult)。
// errCode 为企业微信 errcode 字符串或归一化标签,**永不含** CorpSecret / access_token / 完整 URL。
export type WecomSendResult =
  | { ok: true; msgId: string | null; invalidUsers: string[]; unlicensedUsers: string[] }
  | { ok: false; errCode: string; errMsg: string };

// Durable Effect caller 可在每次真实外部调用紧前重验自己的 lease/fence(§7.1 规则 13)。
// Provider 不解释 guard 错误;必须按原值向调用方冒泡 —— fence 丢失时**不启动 Provider**。
export type WecomBeforeEffect = () => Promise<void>;

// 企业微信 Provider 统一接口(冻结稿 §7.1;第一版仅四种能力)。
// T2 只消费 getAccessToken / getAgent(test-connection);
// exchangeOAuthCode 归 T3,sendTextCard 归 T5B —— 接口一次定形,避免后续反复改签名。
export interface WecomProvider {
  exchangeOAuthCode(input: { code: string }): Promise<{ wecomUserId: string }>;

  getAccessToken(forceRefresh?: boolean, beforeEffect?: WecomBeforeEffect): Promise<string>;

  getAgent(
    accessToken: string,
    agentId: number,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomAgentSnapshot>;

  sendTextCard(
    accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomSendResult>;
}

// 通道不可用(settings 缺失 / 未启用 / 凭证未配置或无效 / production-like 下 DEV_STUB /
// corpId 或 agentId 缺失)。WecomService 映射为 BizCode.WECOM_CHANNEL_NOT_CONFIGURED(36030)。
export class WecomChannelUnavailableError extends Error {
  constructor(reason: string) {
    super(`WECOM_CHANNEL_UNAVAILABLE: ${reason}`);
    this.name = 'WecomChannelUnavailableError';
  }
}

// 上游调用失败(非确定性配置类的其余 errcode / HTTP 非 2xx / 非 JSON / 超时 / 网络 / 缺协议字段)。
// WecomService 映射为 BizCode.WECOM_API_FAILED(36031)。
// errMsg 为归一化标签或 errcode,**不含** CorpSecret / access_token / 完整 URL / 完整上游 errmsg
//(§6.1 末段:失败不回显上游 URL、token、Secret、完整 errmsg 或可见范围 ID)。
export class WecomApiError extends Error {
  constructor(
    readonly errCode: string,
    readonly errMsg: string,
  ) {
    super(`WECOM_API_FAILED: ${errCode} ${errMsg}`);
    this.name = 'WecomApiError';
  }
}

// OAuth code / 身份类失败(§7.1 规则 4;T3 消费)。
// 公开面统一映射 36010 —— 不区分"code 无效"与"这个人没绑定",防账号存在性侧写。
export class WecomOAuthInvalidError extends Error {
  constructor(readonly errCode: string) {
    super(`WECOM_OAUTH_INVALID: errcode=${errCode}`);
    this.name = 'WecomOAuthInvalidError';
  }
}

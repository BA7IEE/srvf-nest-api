import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  WECOM_DEV_STUB_USER_ID_HASH_LENGTH,
  WECOM_DEV_STUB_USER_ID_PREFIX,
} from '../wecom.constants';
import {
  WecomApiError,
  WecomOAuthInvalidError,
  type WecomAgentSnapshot,
  type WecomBeforeEffect,
  type WecomProvider,
  type WecomSendResult,
  type WecomTextCardInput,
} from '../wecom.types';

// 企业微信接入 T2(2026-08-01):DevStub Provider(冻结稿 §7.2)
//
// 非生产联调通道:不调任何外部服务,按 code 返**确定性**假 wecomUserId
// `dev-wecom-<sha256(code) 前 24 位>` —— e2e / 本地联调可用不同 code 造多个"企业微信成员",
// 同 code 恒得同 id(绑定 → 登录全链可测)。
//
// 为什么是 hash 而不是像 wechat DevStub 那样直接拼 code:
// wecomUserId 是 L2 身份标识,直接把 code 拼进去会让"一次性凭证"以明文形式
// 长期留在 wecom_identities 表里 —— stub 也不给这个坏范式开口子(§7.2「code 本身不进入返回」)。
//
// **production/smoke 双重拒绝**(§7.2):
//   第①重 —— WecomSettingsService.updateSettings 写入口拒 providerType=DEV_STUB
//   第②重 —— WecomService.resolveRoute 运行时再拒
// 故本 Provider 在生产物理不可达。
//
// 显式测试故障码(§7.2「提供显式测试故障码以覆盖 invalid-code、API failure、timeout」):
//   code 含 `wecomerr-oauth`   → 抛 WecomOAuthInvalidError(覆盖 36010 分支)
//   code 含 `wecomerr-api`     → 抛 WecomApiError(覆盖 36031 分支)
//   code 含 `wecomerr-timeout` → 抛 WecomApiError('TIMEOUT')(覆盖超时归一)
// 镜像 wechat DevStub `wxerr-<code>` 注入范式。

const DEV_STUB_ACCESS_TOKEN = 'dev-stub-wecom-access-token';
const DEV_STUB_AGENT_NAME = 'DEV STUB 自建应用';

@Injectable()
export class DevStubWecomProvider implements WecomProvider {
  private readonly logger = new Logger(DevStubWecomProvider.name);

  exchangeOAuthCode(input: { code: string }): Promise<{ wecomUserId: string }> {
    this.logger.debug('[DEV_STUB] exchangeOAuthCode called');
    this.maybeInjectFailure(input.code);
    const digest = createHash('sha256')
      .update(input.code)
      .digest('hex')
      .slice(0, WECOM_DEV_STUB_USER_ID_HASH_LENGTH);
    return Promise.resolve({ wecomUserId: `${WECOM_DEV_STUB_USER_ID_PREFIX}${digest}` });
  }

  async getAccessToken(_forceRefresh?: boolean, beforeEffect?: WecomBeforeEffect): Promise<string> {
    if (beforeEffect) await beforeEffect();
    this.logger.debug('[DEV_STUB] getAccessToken called');
    return DEV_STUB_ACCESS_TOKEN;
  }

  // 确定性 agent 快照:agentId 原样回填(故 agentMatched 恒 true)、close=0(启用)、
  // 可见范围给固定小计数 —— e2e 断言 visibilitySummary 形状而不依赖真实通讯录。
  async getAgent(
    _accessToken: string,
    agentId: number,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomAgentSnapshot> {
    if (beforeEffect) await beforeEffect();
    this.logger.debug('[DEV_STUB] getAgent called');
    return {
      agentId,
      name: DEV_STUB_AGENT_NAME,
      close: 0,
      allowUserCount: 2,
      allowPartyCount: 1,
      allowTagCount: 0,
    };
  }

  // T5B 才真正消费;stub 给确定性成功回执,不做投递语义模拟。
  async sendTextCard(
    _accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomSendResult> {
    if (beforeEffect) await beforeEffect();
    this.logger.debug('[DEV_STUB] sendTextCard called');
    return {
      ok: true,
      msgId: `dev-wecom-msgid-${input.toUser.slice(-8)}`,
      invalidUsers: [],
      unlicensedUsers: [],
    };
  }

  private maybeInjectFailure(code: string): void {
    if (code.includes('wecomerr-oauth')) {
      throw new WecomOAuthInvalidError('40029');
    }
    if (code.includes('wecomerr-timeout')) {
      throw new WecomApiError('TIMEOUT', 'dev-stub injected timeout');
    }
    if (code.includes('wecomerr-api')) {
      throw new WecomApiError('HTTP_ERROR', 'dev-stub injected api failure');
    }
  }
}

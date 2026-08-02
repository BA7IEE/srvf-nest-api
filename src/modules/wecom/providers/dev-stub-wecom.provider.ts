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

  /**
   * T5B(2026-08-02)真正消费。默认给确定性成功回执;并按 `toUser` 提供**投递语义故障注入**,
   * 让 §10.7 的回执分类矩阵可以在**不实连企业微信**的前提下逐条跑通(真机联调归 T6)。
   *
   * 为什么按 `toUser` 而不是像 OAuth 那样按 `code`:消息路径上根本没有 code,
   * 唯一由测试完全掌控的入参就是绑定时写进 `wecom_identities.wecomUserId` 的那个值。
   *
   * ⚠️ 注入前缀一律 `wecomerr-`,与真实企业微信 userid 命名空间不重叠;
   * 且本 Provider 在 production/smoke 物理不可达(双重拒绝,见文件头),故不构成生产风险。
   */
  async sendTextCard(
    _accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomSendResult> {
    if (beforeEffect) await beforeEffect();
    this.logger.debug('[DEV_STUB] sendTextCard called');

    // errcode=0 但该 userid 被上游判为无效 / 无接口许可 —— 冻结稿 §10.7 第 2 条明确
    // 这两种**不得记 SENT**。stub 必须能造出"成功回执里带坏消息"这种形状,
    // 否则那条判据在测试里根本没机会红。
    if (input.toUser.includes('wecomerr-invaliduser')) {
      return { ok: true, msgId: null, invalidUsers: [input.toUser], unlicensedUsers: [] };
    }
    if (input.toUser.includes('wecomerr-unlicensed')) {
      return { ok: true, msgId: null, invalidUsers: [], unlicensedUsers: [input.toUser] };
    }
    // 全部无效:官方以 81013 整体报错。
    if (input.toUser.includes('wecomerr-81013')) {
      return { ok: false, errCode: '81013', errMsg: 'dev-stub injected 81013' };
    }
    // 45009 限流:终态 dead 供人工 replay,**不盲重试**。
    if (input.toUser.includes('wecomerr-ratelimit')) {
      return { ok: false, errCode: '45009', errMsg: 'dev-stub injected 45009' };
    }
    // 单 touser 请求收到 invalidparty/invalidtag(真实 Provider 归一化后的同一标签)。
    if (input.toUser.includes('wecomerr-party')) {
      return {
        ok: false,
        errCode: 'INVALID_PARTY_OR_TAG',
        errMsg: 'dev-stub injected invalidparty',
      };
    }
    // 网络 / 超时 / 5xx 类暂态:走既有重试上限。
    if (input.toUser.includes('wecomerr-net')) {
      return { ok: false, errCode: 'FETCH_ERROR', errMsg: 'dev-stub injected network failure' };
    }
    // token 失效:强刷一次后重试一次(既有 40014/42001 语义)。
    if (input.toUser.includes('wecomerr-token')) {
      return { ok: false, errCode: '42001', errMsg: 'dev-stub injected token invalid' };
    }

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

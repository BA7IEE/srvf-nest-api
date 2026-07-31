import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { RbacService } from '../permissions/rbac.service';
import { DevStubWecomProvider } from './providers/dev-stub-wecom.provider';
import { WecomRealProvider } from './providers/wecom.provider';
import type { WecomTestConnectionResponseDto, WecomProviderType } from './wecom.dto';
import { WecomSettingsService } from './wecom-settings.service';
import {
  WecomApiError,
  WecomChannelUnavailableError,
  WecomCredentialStatus,
  type WecomProvider,
  type WecomSettingsResolved,
} from './wecom.types';

// 企业微信接入 T2(2026-08-01):企业微信通道编排(冻结稿 §6.1 / §7.1)
//
// resolve 语义(镜像 wechat/sms「不静默 fallback」拍板):settings 缺失 / 未启用 /
// 凭证缺失或无效 / production-like 下 DEV_STUB → 一律抛 WecomChannelUnavailableError。
// **静默 fallback 到 stub 会把配置错误伪装成正常工作** —— 登录链路上这等于假身份进生产。
//
// 第②重 production-like 禁 DEV_STUB(第①重在 WecomSettingsService.updateSettings 写入口)。
//
// 域错误 → BizCode 映射边界归本 Service:
//   WecomChannelUnavailableError → 36030 / WecomApiError → 36031 / WecomOAuthInvalidError → 36010(T3)
// 调用方只面对 BizException。

@Injectable()
export class WecomService {
  private readonly logger = new Logger(WecomService.name);

  constructor(
    private readonly settings: WecomSettingsService,
    private readonly devStub: DevStubWecomProvider,
    private readonly real: WecomRealProvider,
    private readonly rbac: RbacService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  /**
   * POST /api/system/v1/wecom-settings/test-connection(冻结稿 §6.1)
   *
   * 只读诊断:强制跳过 token cache 取新 token → 立即 `agent/get` 核对 agentid 与 close。
   * **不发送消息、不读取完整通讯录、不修改身份**;可见范围只计数,不返回任何 ID。
   * **不写 audit**(§6.1 末段);失败 pino 只记固定错误类。
   */
  async testConnection(user: CurrentUserPayload): Promise<WecomTestConnectionResponseDto> {
    if (!(await this.rbac.can(user, 'wecom-setting.test.connection'))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const resolved = await this.settings.getActiveSettings();
    if (resolved === null) {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    const agentId = resolved.agentId;
    if (agentId === null) {
      // agentId 缺失就无从核对 —— 与"凭证没配"同类,归 36030
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }

    try {
      const provider = this.routeFor(resolved);
      // 强制 forceRefresh:诊断要证明"现在这套凭证能换到 token",
      // 命中缓存等于用一份可能是几小时前配置换来的 token 冒充当前状态。
      const accessToken = await provider.getAccessToken(true);
      const agent = await provider.getAgent(accessToken, agentId);

      return {
        ok: agent.agentId === agentId && agent.close === 0,
        providerType: resolved.providerType as WecomProviderType,
        credentialStatus: resolved.credentialStatus,
        tokenAcquired: true,
        agentMatched: agent.agentId === agentId,
        agentEnabled: agent.close === 0,
        agentName: agent.name === '' ? null : agent.name,
        visibilitySummary: {
          directUsers: agent.allowUserCount,
          parties: agent.allowPartyCount,
          tags: agent.allowTagCount,
        },
        // ⚠️ 只证明本地配了 webBaseUrl;企业微信后台那侧有没有登记可信域名,
        // 只能由真实 OAuth 回跳验证(§0.5 第 5 条:可信域名是**上线门禁**,不是本接口能判的)
        redirectDomainConfigured: resolved.webBaseUrl !== null && resolved.webBaseUrl !== '',
        checkedAt: new Date(),
      };
    } catch (err) {
      throw this.toBizException(err, 'test-connection');
    }
  }

  /** 每次只读取一次 PostgreSQL settings,并返回绑定该 snapshot 的短生命周期 route。 */
  async resolveRoute(): Promise<WecomProvider> {
    const resolved = await this.settings.getActiveSettings();
    if (resolved === null) {
      throw new WecomChannelUnavailableError('wecom_settings 未配置');
    }
    return this.routeFor(resolved);
  }

  // fail-closed 闸门链(冻结稿 §5.1 规则 1;goal DoD「enabled=false 时一切 Effect fail-closed」)
  private routeFor(r: WecomSettingsResolved): WecomProvider {
    if (!r.enabled) {
      throw new WecomChannelUnavailableError('wecom_settings.enabled=false');
    }
    if (r.providerType === 'DEV_STUB') {
      if (isProductionLike(this.cfg.env)) {
        throw new WecomChannelUnavailableError('production-like 环境禁用 DEV_STUB 通道');
      }
      return this.devStub;
    }
    if (r.providerType === 'WECOM') {
      if (r.credentialStatus !== WecomCredentialStatus.CONFIGURED) {
        // missing / invalid 都 fail-closed(§5.1 规则 10:key 轮换导致 invalid 即停,不猜)
        throw new WecomChannelUnavailableError(`凭证不可用:${r.credentialStatus}`);
      }
      if (r.corpId === null) {
        throw new WecomChannelUnavailableError('corpId 缺失');
      }
      return this.real.prepare(r);
    }
    // 防御:providerType 是 String 列,DB 里可能出现闭集外的值(DTO @IsIn 只管写入口)
    throw new WecomChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }

  // 域错误 → BizCode。日志只记固定错误类,不记上游 URL / token / errmsg 原文(§6.1 末段)。
  private toBizException(err: unknown, scene: string): unknown {
    if (err instanceof WecomChannelUnavailableError) {
      this.logger.warn(`wecom ${scene}: channel unavailable`);
      return new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    if (err instanceof WecomApiError) {
      this.logger.warn(`wecom ${scene}: api failed errCode=${err.errCode}`);
      return new BizException(BizCode.WECOM_API_FAILED);
    }
    // WecomOAuthInvalidError 刻意**不在这里映射**:它的目标码 36010
    // (WECOM_LOGIN_CREDENTIAL_INVALID)属 T3(冻结稿 §11.2),本刀不提前占码。
    // T2 没有任何路径会产生它 —— exchangeOAuthCode 在 T2 无调用方;
    // 提前写一条指向不存在常量的映射只会是编译期谎言。T3 落 36010 时在此补一条分支。
    return err;
  }
}

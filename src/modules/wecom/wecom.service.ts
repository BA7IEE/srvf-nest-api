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
  WecomOAuthInvalidError,
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

  // ===== T3(2026-08-02):登录链路(冻结稿 §6.2 / §11.2)=====

  /**
   * 登录链路专用闸门:在 `resolveRoute` 的总闸之上再加**二级闸 `loginEnabled`**,
   * 并强制 `corpId` 存在。
   *
   * 为什么 corpId 对 DEV_STUB 也必须有:`corpId + wecomUserId` 是身份键的**两半**
   * (WecomIdentity 的两条 active partial unique 按 corpId 分域)。DEV_STUB 下放行 null corpId
   * 会写出一批 corpId 为空的身份行,等真配上 CorpID 之后它们既不互斥也匹配不上任何登录。
   *
   * 返回 route 与 corpId 成对 —— 让"用哪个 Provider 换的身份"和"这身份记在哪个企业名下"
   * 在类型上不可分离(分开取两次 = 中间 settings 变更就能让两者错配)。
   */
  async resolveLoginContext(): Promise<{ provider: WecomProvider; corpId: string }> {
    const resolved = await this.settings.getActiveSettings();
    if (resolved === null) {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    if (!resolved.loginEnabled) {
      // 二级闸关闭 → 与"通道没配"同码(36030)。D-WC-24 默认即关。
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    if (resolved.corpId === null || resolved.corpId === '') {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    try {
      return { provider: this.routeFor(resolved), corpId: resolved.corpId };
    } catch (err) {
      throw this.toBizException(err, 'login-context');
    }
  }

  /**
   * authorize URL 所需的配置三元组(冻结稿 §6.2)。
   *
   * `agentId` / `webBaseUrl` 缺任一即 36030:少了 agentid 的 authorize URL 换出来的
   * userid 归属不可控(D-WC-13);少了 webBaseUrl 就拼不出 redirect_uri。
   * 这里**不**调 `routeFor` —— 签发 authorize URL 不产生任何外部请求,
   * 因此不需要凭证可用(CorpSecret 只在随后 code 换身份时才用得上)。
   * 但总闸 / 二级闸仍要判:开关关着就不该把用户送去企业微信授权页再让他回来撞 36030。
   */
  async getAuthorizeContext(): Promise<{ corpId: string; agentId: number; webBaseUrl: string }> {
    const resolved = await this.settings.getActiveSettings();
    if (resolved === null || !resolved.enabled || !resolved.loginEnabled) {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    if (
      resolved.corpId === null ||
      resolved.corpId === '' ||
      resolved.agentId === null ||
      resolved.webBaseUrl === null ||
      resolved.webBaseUrl === ''
    ) {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    // production-like 下 DEV_STUB 仍要拒(第②重;签发 authorize URL 也算登录链路的一环)
    if (resolved.providerType === 'DEV_STUB' && isProductionLike(this.cfg.env)) {
      throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    }
    return { corpId: resolved.corpId, agentId: resolved.agentId, webBaseUrl: resolved.webBaseUrl };
  }

  /**
   * OAuth code → 本企业内部 `userid`(冻结稿 §6.2 规则 2/3)。
   *
   * ⚠️ code **不入日志、不入 Audit、不落库**(§5.5)—— 本方法既不打印它,
   * 也不把它放进任何抛出的异常 message。
   *
   * 失败归一(§11.2):
   * - `WecomOAuthInvalidError`(40029/42003/42022、无小写 userid、外部成员、跨企业形式)→ 36010
   * - 通道不可用 → 36030;上游 / 网络 / 畸形回执 → 36031
   *
   * 36010 与"这个人没绑定"同码同形是**刻意的**:分开就等于把登录接口做成
   * 账号存在性探测器(§11.2「不开」段第 2/3 条)。
   */
  async exchangeOAuthCode(provider: WecomProvider, code: string): Promise<{ wecomUserId: string }> {
    try {
      return await provider.exchangeOAuthCode({ code });
    } catch (err) {
      throw this.toBizException(err, 'oauth-exchange');
    }
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
    // T3(2026-08-02)补齐 §11.2 的第三条分支。errCode 只记归一化标签或 errcode 数字
    // (`40029` / `NO_INTERNAL_USERID`),**不记** code 原文、userid、上游 errmsg。
    if (err instanceof WecomOAuthInvalidError) {
      this.logger.warn(`wecom ${scene}: oauth invalid errCode=${err.errCode}`);
      return new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }
    if (err instanceof WecomApiError) {
      this.logger.warn(`wecom ${scene}: api failed errCode=${err.errCode}`);
      return new BizException(BizCode.WECOM_API_FAILED);
    }
    // BizException 原样冒泡(routeFor 之外的调用方可能已经抛的是终态码);
    // 其余未知错误同样原样冒泡,由全局过滤器兜底 500 —— 不吞、不改写成"通道不可用"。
    return err;
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { IntegrationAuthConfig as Cfg } from '../../config/integration-auth.config';
import type { IntegrationAuthConfig } from '../../config/integration-auth.config';

/**
 * Integration Feature Gate(规格书 §48):`INTEGRATION_API_ENABLED` 是唯一业务启用开关。
 *
 * - false:不签发 Service/Delegated Token,token 端点 503(37030);
 * - true:按身份、权限、委托、范围正常判定;
 * - 控制面(SP/凭证 CRUD)在 false 时照常可用(§48 明文:可预配置)。
 *
 * 本类是 gate 的唯一读法 —— 各处各读 env 正是 §16.2 反对的「拆成多个开关」的弱化版。
 */
@Injectable()
export class IntegrationAuthGate {
  private readonly config: IntegrationAuthConfig;

  constructor(config: ConfigService) {
    const cfg = config.get<Cfg>('integrationAuth');
    if (cfg === undefined) throw new Error('integrationAuth.config 未加载');
    this.config = cfg;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 关闸时 token 签发入口的统一拒绝。 */
  assertTokenIssuanceAllowed(): void {
    if (!this.config.enabled) {
      // BizCode 在 service 层抛;这里只做判定保持纯度(避免 gate 依赖 exceptions 层)。
      return;
    }
  }

  get jwtSecret(): string {
    return this.config.jwtSecret;
  }

  get issuer(): string {
    return this.config.issuer;
  }

  get audience(): string {
    return this.config.audience;
  }

  get serviceTokenTtlSeconds(): number {
    return this.config.serviceTokenTtlSeconds;
  }

  get delegatedTokenTtlSeconds(): number {
    return this.config.delegatedTokenTtlSeconds;
  }
}

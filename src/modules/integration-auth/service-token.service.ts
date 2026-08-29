import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { dummySecretHash } from '../../config/integration-auth.config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ServicePrincipalsService } from '../service-principals/service-principals.service';
import { IntegrationAuthGate } from './integration-auth.gate';

/**
 * Integration Foundation v1 PR3(规格书 §12/§13):Service Token 签发与验证。
 *
 * ## Client Credentials(§12.3 冻结接口)
 *
 * `POST /api/auth/v1/service-token`,Authorization: Basic base64(clientId:clientSecret)
 *
 * ## 失败归一(§12.4 —— 五场景同一码同一文案同一耗时档)
 *
 * clientId 不存在 / Secret 错 / SP SUSPENDED 或软删 / 凭证已撤销 / 已过期
 * ⇒ 统一 `37010 SERVICE_CREDENTIAL_INVALID`,不暴露失败原因;
 * clientId 不存在时用 dummySecretHash() 做同代价 SHA-256 比较(§12.1 常数时间)。
 *
 * ## Claims(§13;禁入 §13 列出的全部字段 —— 权限/角色/组织范围/Secret/完整对象)
 */
export interface ServiceTokenPayload {
  iss: string;
  aud: string;
  sub: string; // servicePrincipalId
  tokenUse: 'service';
  credentialId: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface ServiceTokenIssueOptions {
  auditMeta?: AuditMeta;
  onIssued?: (actor: { servicePrincipalId: string }) => void;
}

const INTERNAL_TOKEN_AUDIT_META: AuditMeta = {
  requestId: 'integration-token-internal',
  ip: null,
  ua: null,
};

@Injectable()
export class ServiceTokenService {
  /** 自有实例,绑定 integration secret —— 不走全局 JwtModule DI(全局注册互相覆盖,实测打挂 auth)。 */
  private readonly jwtService: JwtService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: IntegrationAuthGate,
    private readonly spService: ServicePrincipalsService,
    private readonly auditLogs: AuditLogsService,
  ) {
    this.jwtService = new JwtService({ secret: gate.jwtSecret });
  }

  // ===== 签发(§12.3)=====

  async issueToken(
    clientId: string,
    clientSecret: string,
    options: ServiceTokenIssueOptions = {},
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    if (!this.gate.isEnabled()) {
      throw new BizException(BizCode.INTEGRATION_API_DISABLED);
    }
    const principal = await this.authenticateClientCredentials(clientId, clientSecret);
    const credentialId = principal.credentialId;
    const expiresIn = this.gate.serviceTokenTtlSeconds;
    const jti = randomUUID();
    const token = this.jwtService.sign(
      {
        tokenUse: 'service',
        credentialId,
      },
      {
        algorithm: 'HS256',
        subject: principal.servicePrincipalId,
        issuer: this.gate.issuer,
        audience: this.gate.audience,
        jwtid: jti,
        expiresIn,
      },
    );

    // lastUsedAt 留痕(§27 模型字段;走属主导出,不直写他域模型)。
    await this.spService.markCredentialUsed(credentialId);
    await this.auditLogs.log({
      event: 'auth.service-token',
      actorUserId: null,
      actorRoleSnap: null,
      actorServicePrincipalId: principal.servicePrincipalId,
      actorCredentialId: credentialId,
      resourceType: 'service-principal',
      resourceId: principal.servicePrincipalId,
      meta: options.auditMeta ?? INTERNAL_TOKEN_AUDIT_META,
    });
    options.onIssued?.({ servicePrincipalId: principal.servicePrincipalId });

    return { accessToken: token, tokenType: 'Bearer', expiresIn };
  }

  // ===== 验证(§14 规则的前半:Token 本身;运行时对象状态是 Guard 每请求复查的,PR4 接线)=====

  verifyToken(token: string): ServiceTokenPayload {
    try {
      const payload = this.jwtService.verify<Record<string, unknown>>(token, {
        issuer: this.gate.issuer,
        audience: this.gate.audience,
      });
      if (payload.tokenUse !== 'service') {
        throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
      }
      const iss = requiredString(payload.iss);
      const aud = requiredString(payload.aud);
      const sub = requiredString(payload.sub);
      const credentialId = requiredString(payload.credentialId);
      const jti = requiredString(payload.jti);
      const iat = requiredNumber(payload.iat);
      const exp = requiredNumber(payload.exp);
      if (
        iss === null ||
        aud === null ||
        sub === null ||
        credentialId === null ||
        jti === null ||
        iat === null ||
        exp === null
      ) {
        throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
      }
      return {
        iss,
        aud,
        sub,
        tokenUse: 'service',
        credentialId,
        jti,
        iat,
        exp,
      };
    } catch (error) {
      if (error instanceof BizException) throw error;
      // 签名错 / 过期 / issuer/audience 不符 ⇒ 统一归一(§12.4 延伸:token 侧同样不暴露原因)。
      throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    }
  }

  // ===== 内部:Client Credentials 认证(§12.4 五场景归一)=====

  private async authenticateClientCredentials(
    clientId: string,
    clientSecret: string,
  ): Promise<{ servicePrincipalId: string; credentialId: string }> {
    const invalid = (): never => {
      throw new BizException(BizCode.SERVICE_CREDENTIAL_INVALID);
    };
    if (clientId === '' || clientSecret === '') invalid();

    const sp = await this.prisma.servicePrincipal.findFirst({
      where: { clientId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (sp === null) {
      // §12.4:不存在也做同代价比较(dummy hash),防 timing。
      ServicePrincipalsService.secretsMatch(clientSecret, dummySecretHash());
      invalid();
    }
    const activeSp = sp as { id: string; status: string };
    if (activeSp.status !== 'ACTIVE') invalid();

    const secretHash = ServicePrincipalsService.hashClientSecret(clientSecret);
    const credential = await this.prisma.servicePrincipalCredential.findFirst({
      where: {
        servicePrincipalId: activeSp.id,
        secretHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (credential === null) invalid();
    const activeCredential = credential as { id: string };

    return { servicePrincipalId: activeSp.id, credentialId: activeCredential.id };
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface DelegatedTokenPayload {
  iss: string;
  aud: string;
  sub: string; // subjectUserId(被代表的真人)
  tokenUse: 'delegated';
  credentialId: string;
  delegationGrantId: string;
  act: { sub: string }; // 真正调用的 SP
  jti: string;
  iat: number;
  exp: number;
}

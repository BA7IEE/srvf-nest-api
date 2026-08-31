import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthenticatedServiceClient } from '../../common/decorators/current-service-client.decorator';
import type { IntegrationPrincipalContext } from '../../common/decorators/current-integration-principal.decorator';
import { PrismaService } from '../../database/prisma.service';
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
 * ⇒ 统一 `37010 SERVICE_CREDENTIAL_INVALID`,不暴露失败原因。
 * 每一类都先计算输入 Secret 的 SHA-256,再走同一条凭据关联查询;不以早返回暴露
 * 我方可控的 hash / 查询形状差异。
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
    const principal = await this.authenticateClientCredentials(clientId, clientSecret);
    return this.issueTokenForAuthenticatedClient(principal, options);
  }

  async issueTokenForAuthenticatedClient(
    principal: AuthenticatedServiceClient,
    options: ServiceTokenIssueOptions = {},
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    if (!this.gate.isEnabled()) {
      throw new BizException(BizCode.INTEGRATION_API_DISABLED);
    }
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
        algorithms: ['HS256'],
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

  /** Bearer request entry:cryptographic verification plus current DB facts on every request. */
  async resolvePrincipal(
    token: string,
  ): Promise<Extract<IntegrationPrincipalContext, { kind: 'SERVICE' }>> {
    if (!this.gate.isEnabled()) {
      throw new BizException(BizCode.INTEGRATION_API_DISABLED);
    }
    const payload = this.verifyToken(token);
    const now = new Date();
    const servicePrincipal = await this.prisma.servicePrincipal.findFirst({
      where: { id: payload.sub, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (servicePrincipal === null) throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    const credential = await this.prisma.servicePrincipalCredential.findFirst({
      where: {
        id: payload.credentialId,
        servicePrincipalId: payload.sub,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (credential === null) throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    return {
      kind: 'SERVICE',
      servicePrincipalId: servicePrincipal.id,
      credentialId: credential.id,
    };
  }

  // ===== 内部:Client Credentials 认证(§12.4 五场景归一)=====

  async authenticateClientCredentials(
    clientId: string,
    clientSecret: string,
  ): Promise<AuthenticatedServiceClient> {
    if (!this.gate.isEnabled()) {
      throw new BizException(BizCode.INTEGRATION_API_DISABLED);
    }
    const invalid = (): never => {
      throw new BizException(BizCode.SERVICE_CREDENTIAL_INVALID);
    };
    // PR-B:五类 37010 失败均无条件 hash,再经同一条 Credential → ServicePrincipal
    // 关联查询收口。空 Basic 凭据同样落入这条路径,避免 parser 的空值形成可测早返回。
    const secretHash = ServicePrincipalsService.hashClientSecret(clientSecret);
    const now = new Date();
    const credential = await this.prisma.servicePrincipalCredential.findFirst({
      where: {
        secretHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        servicePrincipal: {
          is: { clientId, deletedAt: null, status: 'ACTIVE' },
        },
      },
      select: { id: true, servicePrincipalId: true },
    });
    if (credential === null) return invalid();

    return { servicePrincipalId: credential.servicePrincipalId, credentialId: credential.id };
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

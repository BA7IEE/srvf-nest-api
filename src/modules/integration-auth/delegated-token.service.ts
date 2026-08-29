import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { DelegationGrantRuntimeService } from '../delegation-grants/delegation-grant-runtime.service';
import { IntegrationAuthGate } from './integration-auth.gate';
import type { DelegatedTokenPayload } from './service-token.service';

export interface DelegatedTokenIssueOptions {
  auditMeta?: AuditMeta;
  onIssued?: (actor: { servicePrincipalId: string; onBehalfOfUserId: string }) => void;
}

const INTERNAL_TOKEN_AUDIT_META: AuditMeta = {
  requestId: 'integration-token-internal',
  ip: null,
  ua: null,
};

/**
 * Integration Foundation v1 PR5(规格书 §14;T0 冻结稿 §11):
 * Delegated Token 签发与验证。`POST auth/v1/delegated-token`(Bearer Service Token + grantId)。
 *
 * Body 永远不能指定 subjectUserId；subject 只能从已复查的 Grant 读出。
 */
@Injectable()
export class DelegatedTokenService {
  private readonly jwt: JwtService;

  constructor(
    private readonly gate: IntegrationAuthGate,
    private readonly grants: DelegationGrantRuntimeService,
    private readonly auditLogs: AuditLogsService,
  ) {
    this.jwt = new JwtService({ secret: gate.jwtSecret });
  }

  async issueToken(
    servicePrincipalId: string,
    credentialId: string,
    delegationGrantId: string,
    options: DelegatedTokenIssueOptions = {},
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    if (!this.gate.isEnabled()) {
      throw new BizException(BizCode.INTEGRATION_API_DISABLED);
    }
    const now = new Date();
    const grant = await this.grants.findIssuableGrant(
      { servicePrincipalId, credentialId, delegationGrantId },
      now,
    );
    if (grant === null) throw new BizException(BizCode.DELEGATION_GRANT_INVALID);

    const expiresIn = this.resolveExpiresIn(now, grant.credentialExpiresAt, grant.grantEndsAt);
    const jti = randomUUID();
    const token = this.jwt.sign(
      {
        tokenUse: 'delegated',
        credentialId,
        delegationGrantId,
        act: { sub: servicePrincipalId },
      },
      {
        algorithm: 'HS256',
        subject: grant.subjectUserId,
        issuer: this.gate.issuer,
        audience: this.gate.audience,
        jwtid: jti,
        expiresIn,
      },
    );
    await this.auditLogs.log({
      event: 'auth.delegated-token',
      actorUserId: null,
      actorRoleSnap: null,
      actorServicePrincipalId: servicePrincipalId,
      actorCredentialId: credentialId,
      onBehalfOfUserId: grant.subjectUserId,
      onBehalfOfRoleSnap: grant.subjectUserRole,
      resourceType: 'delegation-grant',
      resourceId: delegationGrantId,
      meta: options.auditMeta ?? INTERNAL_TOKEN_AUDIT_META,
    });
    options.onIssued?.({ servicePrincipalId, onBehalfOfUserId: grant.subjectUserId });
    return { accessToken: token, tokenType: 'Bearer', expiresIn };
  }

  verifyToken(token: string): DelegatedTokenPayload {
    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        issuer: this.gate.issuer,
        audience: this.gate.audience,
      });
      const act = payload.act;
      const iss = requiredString(payload.iss);
      const aud = requiredString(payload.aud);
      const sub = requiredString(payload.sub);
      const credentialId = requiredString(payload.credentialId);
      const delegationGrantId = requiredString(payload.delegationGrantId);
      const actSub =
        typeof act === 'object' && act !== null
          ? requiredString((act as Record<string, unknown>).sub)
          : null;
      const jti = requiredString(payload.jti);
      const iat = requiredNumber(payload.iat);
      const exp = requiredNumber(payload.exp);
      if (
        payload.tokenUse !== 'delegated' ||
        iss === null ||
        aud === null ||
        sub === null ||
        credentialId === null ||
        delegationGrantId === null ||
        actSub === null ||
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
        tokenUse: 'delegated',
        credentialId,
        delegationGrantId,
        act: { sub: actSub },
        jti,
        iat,
        exp,
      };
    } catch (error) {
      if (error instanceof BizException) throw error;
      throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    }
  }

  private resolveExpiresIn(
    now: Date,
    credentialExpiresAt: Date | null,
    grantEndsAt: Date | null,
  ): number {
    const candidates = [now.getTime() + this.gate.delegatedTokenTtlSeconds * 1000];
    if (credentialExpiresAt !== null) candidates.push(credentialExpiresAt.getTime());
    if (grantEndsAt !== null) candidates.push(grantEndsAt.getTime());
    const expiresIn = Math.floor((Math.min(...candidates) - now.getTime()) / 1000);
    if (expiresIn <= 0) throw new BizException(BizCode.DELEGATION_GRANT_INVALID);
    return expiresIn;
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

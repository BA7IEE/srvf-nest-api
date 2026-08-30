import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { setIntegrationLogPrincipal } from '../../bootstrap/request-id';
import { routePrincipalKinds } from '../../common/authz/route-principal-admission';
import type {
  IntegrationPrincipalContext,
  IntegrationPrincipalRequest,
} from '../../common/decorators/current-integration-principal.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { DelegatedTokenService } from './delegated-token.service';
import { ServiceTokenService } from './service-token.service';

/** Authenticates only routes explicitly admitted for SERVICE and/or DELEGATED bearer tokens. */
@Injectable()
export class IntegrationJwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly serviceTokens: ServiceTokenService,
    private readonly delegatedTokens: DelegatedTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = routePrincipalKinds(this.reflector, context);
    if (allowed === null || (!allowed.includes('SERVICE') && !allowed.includes('DELEGATED'))) {
      return true;
    }

    const request = context.switchToHttp().getRequest<IntegrationPrincipalRequest>();
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    }
    const token = header.slice('Bearer '.length);
    const principal = await this.resolvePrincipal(token);
    if (!allowed.includes(principal.kind)) {
      throw new BizException(BizCode.PRINCIPAL_KIND_FORBIDDEN);
    }

    request.integrationPrincipal = principal;
    setIntegrationLogPrincipal(request, {
      servicePrincipalId: principal.servicePrincipalId,
      ...(principal.kind === 'DELEGATED' ? { onBehalfOfUserId: principal.subjectUser.id } : {}),
    });
    return true;
  }

  private async resolvePrincipal(token: string): Promise<IntegrationPrincipalContext> {
    try {
      return await this.serviceTokens.resolvePrincipal(token);
    } catch (error) {
      if (!isIntegrationTokenInvalid(error)) throw error;
    }

    try {
      return await this.delegatedTokens.resolvePrincipal(token);
    } catch (error) {
      if (!isIntegrationTokenInvalid(error)) throw error;
      throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    }
  }
}

function isIntegrationTokenInvalid(error: unknown): boolean {
  return error instanceof BizException && error.biz === BizCode.INTEGRATION_TOKEN_INVALID;
}

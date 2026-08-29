import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { routePrincipalKinds } from '../../common/authz/route-principal-admission';
import type { ServiceClientRequest } from '../../common/decorators/current-service-client.decorator';
import { ServiceTokenService } from './service-token.service';

/** Authenticates only routes explicitly admitted as CLIENT_CREDENTIALS. */
@Injectable()
export class ServiceClientCredentialsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly serviceTokens: ServiceTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kinds = routePrincipalKinds(this.reflector, context);
    if (kinds?.includes('CLIENT_CREDENTIALS') !== true) return true;

    const request = context.switchToHttp().getRequest<ServiceClientRequest>();
    const [clientId, clientSecret] = parseBasicCredentials(request.headers.authorization);
    request.serviceClient = await this.serviceTokens.authenticateClientCredentials(
      clientId,
      clientSecret,
    );
    return true;
  }
}

function parseBasicCredentials(header: string | undefined): [string, string] {
  if (header === undefined || !header.startsWith('Basic ')) return ['', ''];
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return ['', ''];
    return [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return ['', ''];
  }
}

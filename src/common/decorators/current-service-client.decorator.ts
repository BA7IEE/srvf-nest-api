import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

export interface AuthenticatedServiceClient {
  servicePrincipalId: string;
  credentialId: string;
}

export type ServiceClientRequest = Request & {
  serviceClient?: AuthenticatedServiceClient;
};

/** Route-only Client Credentials context; never exposed as an Integration bearer principal. */
export const CurrentServiceClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedServiceClient => {
    const client = ctx.switchToHttp().getRequest<ServiceClientRequest>().serviceClient;
    if (client === undefined) throw new BizException(BizCode.SERVICE_CREDENTIAL_INVALID);
    return client;
  },
);

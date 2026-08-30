import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import type { CurrentUserPayload } from './current-user.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

export type IntegrationPrincipalContext =
  | {
      kind: 'SERVICE';
      servicePrincipalId: string;
      credentialId: string;
    }
  | {
      kind: 'DELEGATED';
      servicePrincipalId: string;
      credentialId: string;
      delegationGrantId: string;
      subjectUser: CurrentUserPayload;
    };

export type IntegrationPrincipalRequest = Request & {
  integrationPrincipal?: IntegrationPrincipalContext;
};

/**
 * Integration principal lives beside, never inside, Express `request.user`.
 * The latter remains exclusively owned by the Human JwtStrategy.
 */
export const CurrentIntegrationPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IntegrationPrincipalContext => {
    const principal = ctx
      .switchToHttp()
      .getRequest<IntegrationPrincipalRequest>().integrationPrincipal;
    if (principal === undefined) throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    return principal;
  },
);

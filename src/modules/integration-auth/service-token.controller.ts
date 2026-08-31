import { Controller, Post, Req } from '@nestjs/common';
import { ApiBasicAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentServiceClient,
  type AuthenticatedServiceClient,
} from '../../common/decorators/current-service-client.decorator';
import { LoginOnly } from '../../common/decorators/route-authz.decorator';
import { ServiceTokenThrottle } from '../../common/decorators/service-token-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { setIntegrationLogPrincipal } from '../../bootstrap/request-id';
import { auditMetaFromRequest } from '../audit-logs/audit-meta-from-request';
import { ServiceTokenService } from './service-token.service';

/**
 * Integration Foundation v1 PR3(规格书 §12.3):Client Credentials → Service Token。
 *
 * POST /api/auth/v1/service-token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   → { accessToken, tokenType: 'Bearer', expiresIn }(§12.3 冻结响应形;零 refresh)
 *
 * GET /api/integration/v1/me 已由 PR6 开放，且与本入口共享独立 Integration 信任域。
 */
@Controller('auth/v1/service-token')
@ApiTags('auth/service-token')
export class ServiceTokenController {
  constructor(private readonly serviceToken: ServiceTokenService) {}

  @LoginOnly({ allowedPrincipalKinds: ['CLIENT_CREDENTIALS'] })
  @Post()
  @ServiceTokenThrottle()
  @ApiBasicAuth('integrationClientCredentials')
  @ApiOperation({
    summary: 'Client Credentials 换 Service Token(Basic 认证;失败五场景归一 37010) [auth]',
  })
  @ApiWrappedCreatedResponse(Object)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_INVALID)
  @ApiBizErrorResponse(BizCode.INTEGRATION_API_DISABLED)
  async issue(
    @CurrentServiceClient() client: AuthenticatedServiceClient,
    @Req() req: Request,
  ): Promise<{
    accessToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
  }> {
    return this.serviceToken.issueTokenForAuthenticatedClient(client, {
      auditMeta: auditMetaFromRequest(req),
      onIssued: (actor) => setIntegrationLogPrincipal(req, actor),
    });
  }
}

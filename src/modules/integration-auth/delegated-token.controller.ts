import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { setIntegrationLogPrincipal } from '../../bootstrap/request-id';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentIntegrationPrincipal,
  type IntegrationPrincipalContext,
} from '../../common/decorators/current-integration-principal.decorator';
import { LoginOnly } from '../../common/decorators/route-authz.decorator';
import { ServiceTokenThrottle } from '../../common/decorators/service-token-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { auditMetaFromRequest } from '../audit-logs/audit-meta-from-request';
import { DelegatedTokenRequestDto, IntegrationTokenResponseDto } from './integration-auth.dto';
import { DelegatedTokenService } from './delegated-token.service';

// Integration Foundation v1 PR5(规格书 §14):Delegated Token 端点。
// POST auth/v1/delegated-token(Bearer Service Token + { delegationGrantId })。
// subject 只能由 Grant 决定——DTO 没有任何 userId 字段，ValidationPipe 会拒绝额外字段。
@Controller('auth/v1/delegated-token')
@ApiTags('auth/delegated-token')
export class DelegatedTokenController {
  constructor(private readonly delegatedToken: DelegatedTokenService) {}

  @LoginOnly({ allowedPrincipalKinds: ['SERVICE'] })
  @Post()
  @ServiceTokenThrottle()
  @ApiBearerAuth('integrationBearer')
  @ApiOperation({
    summary: 'Service Token 换 Delegated Token(Bearer 认证；subject 只能由 Grant 决定) [auth]',
  })
  @ApiWrappedCreatedResponse(IntegrationTokenResponseDto)
  @ApiBizErrorResponse(BizCode.INTEGRATION_TOKEN_INVALID)
  @ApiBizErrorResponse(BizCode.DELEGATION_GRANT_INVALID, BizCode.PRINCIPAL_KIND_FORBIDDEN)
  @ApiBizErrorResponse(BizCode.INTEGRATION_API_DISABLED)
  async issue(
    @Body() body: DelegatedTokenRequestDto,
    @CurrentIntegrationPrincipal()
    principal: Extract<IntegrationPrincipalContext, { kind: 'SERVICE' }>,
    @Req() req: Request,
  ): Promise<IntegrationTokenResponseDto> {
    return this.delegatedToken.issueToken(
      principal.servicePrincipalId,
      principal.credentialId,
      body.delegationGrantId,
      {
        auditMeta: auditMetaFromRequest(req),
        onIssued: (actor) => setIntegrationLogPrincipal(req, actor),
      },
    );
  }
}

import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { setIntegrationLogPrincipal } from '../../bootstrap/request-id';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../common/decorators/api-response.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ServiceTokenThrottle } from '../../common/decorators/service-token-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { DelegatedTokenRequestDto, IntegrationTokenResponseDto } from './integration-auth.dto';
import { DelegatedTokenService } from './delegated-token.service';
import { ServiceTokenService } from './service-token.service';

// Integration Foundation v1 PR5(规格书 §14):Delegated Token 端点。
// POST auth/v1/delegated-token(Bearer Service Token + { delegationGrantId })。
// subject 只能由 Grant 决定——DTO 没有任何 userId 字段，ValidationPipe 会拒绝额外字段。
@Controller('auth/v1/delegated-token')
@ApiTags('auth/delegated-token')
export class DelegatedTokenController {
  constructor(
    private readonly serviceToken: ServiceTokenService,
    private readonly delegatedToken: DelegatedTokenService,
  ) {}

  @Public()
  @Post()
  @ServiceTokenThrottle()
  @ApiOperation({
    summary: 'Service Token 换 Delegated Token(Bearer 认证；subject 只能由 Grant 决定) [public]',
  })
  @ApiWrappedCreatedResponse(IntegrationTokenResponseDto)
  @ApiBizErrorResponse(BizCode.INTEGRATION_TOKEN_INVALID)
  @ApiBizErrorResponse(BizCode.DELEGATION_GRANT_INVALID)
  @ApiBizErrorResponse(BizCode.INTEGRATION_API_DISABLED)
  async issue(
    @Body() body: DelegatedTokenRequestDto,
    @Req() req: Request,
  ): Promise<IntegrationTokenResponseDto> {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);
    }
    const payload = this.serviceToken.verifyToken(header.slice('Bearer '.length));
    // 有效 Service Token 已确定技术 Actor；若 Grant 随后被拒，HTTP 日志仍可关联该机器主体。
    setIntegrationLogPrincipal(req, { servicePrincipalId: payload.sub });
    return this.delegatedToken.issueToken(
      payload.sub,
      payload.credentialId,
      body.delegationGrantId,
      {
        auditMeta: auditMetaOf(req),
        onIssued: (actor) => setIntegrationLogPrincipal(req, actor),
      },
    );
  }
}

function auditMetaOf(req: Request): AuditMeta {
  return {
    requestId: typeof req.id === 'string' ? req.id : '',
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

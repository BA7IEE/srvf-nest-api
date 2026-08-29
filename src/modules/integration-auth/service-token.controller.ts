import { Controller, Post, Req } from '@nestjs/common';

// @Public:Client Credentials 的凭证是 Basic 头,不是 Bearer JWT —— JwtAuthGuard 必须跳过;
// 认证由 ServiceTokenService.authenticateClientCredentials 内部完成(§12.3/§12.4)。
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../common/decorators/api-response.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { Public } from '../../common/decorators/public.decorator';
import { ServiceTokenThrottle } from '../../common/decorators/service-token-throttle.decorator';
import { setIntegrationLogPrincipal } from '../../bootstrap/request-id';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ServiceTokenService } from './service-token.service';

/**
 * Integration Foundation v1 PR3(规格书 §12.3):Client Credentials → Service Token。
 *
 * POST /api/auth/v1/service-token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   → { accessToken, tokenType: 'Bearer', expiresIn }(§12.3 冻结响应形;零 refresh)
 *
 * GET /api/integration/v1/me —— PR6 才开 surface;本刀不建 Integration 路由。
 */
@Controller('auth/v1/service-token')
@ApiTags('auth/service-token')
export class ServiceTokenController {
  constructor(private readonly serviceToken: ServiceTokenService) {}

  @Public()
  @Post()
  @ServiceTokenThrottle()
  @ApiOperation({
    summary: 'Client Credentials 换 Service Token(Basic 认证;失败五场景归一 37010) [public]',
  })
  @ApiWrappedCreatedResponse(Object)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_INVALID)
  @ApiBizErrorResponse(BizCode.INTEGRATION_API_DISABLED)
  async issue(@Req() req: Request): Promise<{
    accessToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
  }> {
    // Basic 解析(clientId:clientSecret;缺失/畸形 = 与 Secret 错同码,§12.4 归一)。
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) {
      throw new BizException(BizCode.SERVICE_CREDENTIAL_INVALID);
    }
    let clientId = '';
    let clientSecret = '';
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      clientId = decoded.slice(0, idx);
      clientSecret = decoded.slice(idx + 1);
    } catch {
      // fall through to unified rejection
    }
    return this.serviceToken.issueToken(clientId, clientSecret, {
      auditMeta: auditMetaOf(req),
      onIssued: (actor) => setIntegrationLogPrincipal(req, actor),
    });
  }
}

function auditMetaOf(req: Request): AuditMeta {
  return {
    requestId: typeof req.id === 'string' ? req.id : '',
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

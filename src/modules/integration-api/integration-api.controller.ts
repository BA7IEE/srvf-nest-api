import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentIntegrationPrincipal,
  type IntegrationPrincipalContext,
} from '../../common/decorators/current-integration-principal.decorator';
import { LoginOnly } from '../../common/decorators/route-authz.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { IntegrationMeResponseDto } from './integration-api.dto';
import { IntegrationApiService } from './integration-api.service';

@Controller('integration/v1')
@ApiTags('Integration - Identity')
export class IntegrationApiController {
  constructor(private readonly integrationApi: IntegrationApiService) {}

  @Get('me')
  @LoginOnly({ allowedPrincipalKinds: ['SERVICE', 'DELEGATED'] })
  @ApiBearerAuth('integrationBearer')
  @ApiOperation({ summary: '查看当前 Integration 主体最小身份 [auth]' })
  @ApiWrappedOkResponse(IntegrationMeResponseDto)
  @ApiBizErrorResponse(BizCode.INTEGRATION_TOKEN_INVALID)
  @ApiBizErrorResponse(BizCode.PRINCIPAL_KIND_FORBIDDEN)
  @ApiBizErrorResponse(BizCode.INTEGRATION_API_DISABLED)
  getMe(
    @CurrentIntegrationPrincipal() principal: IntegrationPrincipalContext,
  ): Promise<IntegrationMeResponseDto> {
    return this.integrationApi.getMe(principal);
  }
}

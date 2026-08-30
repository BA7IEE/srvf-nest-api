import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentIntegrationPrincipal,
  type IntegrationPrincipalContext,
} from '../../common/decorators/current-integration-principal.decorator';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  IntegrationActivityTypeItemDto,
  ListIntegrationActivityTypesQueryDto,
} from './integration-activity-types.dto';
import { IntegrationActivityTypesFacade } from './integration-activity-types.facade';

@ApiTags('Integration - Reference')
@ApiBearerAuth('integrationBearer')
@Controller('integration/v1/reference/activity-types')
export class IntegrationActivityTypesController {
  constructor(private readonly activityTypes: IntegrationActivityTypesFacade) {}

  @Get()
  @RequiresPermission('dict.read.item', {
    engine: 'integration-direct',
    allowedPrincipalKinds: ['SERVICE'],
  })
  @ApiOperation({ summary: '分页读取活动类型参考数据（仅 Service 主体） [rbac: dict.read.item]' })
  @ApiWrappedPageResponse(IntegrationActivityTypeItemDto)
  @ApiBizErrorResponse(
    BizCode.INTEGRATION_TOKEN_INVALID,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.INTEGRATION_API_DISABLED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  list(
    @CurrentIntegrationPrincipal() principal: IntegrationPrincipalContext,
    @Query() query: ListIntegrationActivityTypesQueryDto,
  ): Promise<PageResultDto<IntegrationActivityTypeItemDto>> {
    return this.activityTypes.list(principal, query);
  }
}

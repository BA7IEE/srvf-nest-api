import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateDelegationGrantDto,
  DelegationGrantResponseDto,
  ListDelegationGrantsQueryDto,
  RevokeDelegationGrantDto,
} from './delegation-grants.dto';
import { DelegationGrantsService } from './delegation-grants.service';

function auditMetaOf(req: Request): AuditMeta {
  return {
    requestId: typeof req.id === 'string' ? req.id : '',
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

/** Integration Foundation v1 PR5(规格书 §36):DelegationGrant 控制面 4 路由。 */
@ApiTags('system/delegation-grants')
@ApiBearerAuth()
@Controller('system/v1/delegation-grants')
export class DelegationGrantsController {
  constructor(private readonly delegationGrants: DelegationGrantsService) {}

  @Post()
  @RequiresPermission('delegation-grant.create.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '创建委托(SP 代表固定 User；权限、范围、期限取交集) [rbac: delegation-grant.create.record]',
  })
  @ApiWrappedCreatedResponse(DelegationGrantResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SERVICE_PRINCIPAL_NOT_FOUND,
    BizCode.USER_NOT_FOUND,
  )
  create(
    @Body() dto: CreateDelegationGrantDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<DelegationGrantResponseDto> {
    return this.delegationGrants.create(currentUser, dto, auditMetaOf(req));
  }

  @Get()
  @RequiresPermission('delegation-grant.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '分页查看委托（默认含历史） [rbac: delegation-grant.read.record]' })
  @ApiWrappedPageResponse(DelegationGrantResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListDelegationGrantsQueryDto,
  ) {
    return this.delegationGrants.list(currentUser, query);
  }

  @Get(':id')
  @RequiresPermission('delegation-grant.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '查看单条委托 [rbac: delegation-grant.read.record]' })
  @ApiWrappedOkResponse(DelegationGrantResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DELEGATION_GRANT_INVALID,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<DelegationGrantResponseDto> {
    return this.delegationGrants.findOne(currentUser, params.id);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('delegation-grant.revoke.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '撤销委托，下一请求立即失效 [rbac: delegation-grant.revoke.record]' })
  @ApiWrappedOkResponse(DelegationGrantResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DELEGATION_GRANT_INVALID,
  )
  revoke(
    @Param() params: IdParamDto,
    @Body() dto: RevokeDelegationGrantDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<DelegationGrantResponseDto> {
    return this.delegationGrants.revoke(currentUser, params.id, dto, auditMetaOf(req));
  }
}

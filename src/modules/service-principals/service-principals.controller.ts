import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
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
import { auditMetaFromRequest } from '../audit-logs/audit-meta-from-request';
import {
  CreateServicePrincipalDto,
  ListServicePrincipalsQueryDto,
  ServicePrincipalCredentialCreatedDto,
  ServicePrincipalCredentialResponseDto,
  ServicePrincipalResponseDto,
  UpdateServicePrincipalDto,
  UpdateServicePrincipalStatusDto,
} from './service-principals.dto';
import { ServicePrincipalsService } from './service-principals.service';

// Integration Foundation v1 PR2(规格书 §35):ServicePrincipal 控制面 8 端点。
// 全部 system/v1;权限 6 码全绑 ops-admin;ServicePrincipal 自身永远不能持有这些码(§15.3)。
// Secret 只在 POST credentials 的 201 响应中出现一次 —— 其余端点零 secret 零 hash。

@ApiTags('system/service-principals')
@ApiBearerAuth()
@Controller('system/v1/service-principals')
export class ServicePrincipalsController {
  constructor(private readonly servicePrincipals: ServicePrincipalsService) {}

  @Post()
  @ApiOperation({
    summary: '创建服务主体(服务端生成 clientId) [rbac: service-principal.create.record]',
  })
  @RequiresPermission('service-principal.create.record')
  @ApiWrappedCreatedResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.ORGANIZATION_NOT_FOUND)
  async create(
    @Body() dto: CreateServicePrincipalDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.create(dto, currentUser, auditMetaFromRequest(req));
  }

  @Get()
  @ApiOperation({ summary: '服务主体分页列表 [rbac: service-principal.read.record]' })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedPageResponse(ServicePrincipalResponseDto)
  async list(@Query() query: ListServicePrincipalsQueryDto) {
    return this.servicePrincipals.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '服务主体详情(不存在 / 已软删统一返 37001) [rbac: service-principal.read.record]',
  })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedOkResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async findById(@Param() params: IdParamDto): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.findById(params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '修改服务主体名称/描述/属主组织 [rbac: service-principal.update.record]',
  })
  @RequiresPermission('service-principal.update.record')
  @ApiWrappedOkResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateServicePrincipalDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.update(params.id, dto, currentUser, auditMetaFromRequest(req));
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: '启用/停用服务主体(停用即止血开关) [rbac: service-principal.update.status]',
  })
  @RequiresPermission('service-principal.update.status')
  @ApiWrappedOkResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_ALREADY_SUSPENDED_OR_ACTIVE)
  async updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateServicePrincipalStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.updateStatus(
      params.id,
      dto.status,
      currentUser,
      auditMetaFromRequest(req),
    );
  }

  @Post(':id/credentials')
  @ApiOperation({
    summary:
      '为服务主体新建凭证(原始 Secret 只在本次响应出现一次) [rbac: service-principal.create.credential]',
  })
  @RequiresPermission('service-principal.create.credential')
  @ApiWrappedCreatedResponse(ServicePrincipalCredentialCreatedDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_LIMIT_EXCEEDED)
  async createCredential(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalCredentialCreatedDto> {
    return this.servicePrincipals.createCredential(
      params.id,
      currentUser,
      auditMetaFromRequest(req),
    );
  }

  @Get(':id/credentials')
  @ApiOperation({
    summary: '凭证元数据列表(永不返回 hash / 原始 Secret) [rbac: service-principal.read.record]',
  })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedOkResponse(ServicePrincipalCredentialResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async listCredentials(
    @Param() params: IdParamDto,
  ): Promise<ServicePrincipalCredentialResponseDto[]> {
    return this.servicePrincipals.listCredentials(params.id);
  }

  @Post(':id/credentials/:credentialId/revoke')
  @ApiOperation({
    summary:
      '撤销凭证(撤销后以其换的 Token 下一请求即失效) [rbac: service-principal.revoke.credential]',
  })
  @RequiresPermission('service-principal.revoke.credential')
  @ApiWrappedCreatedResponse(ServicePrincipalCredentialResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_NOT_FOUND)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_ALREADY_REVOKED)
  async revokeCredential(
    @Param() params: IdParamDto & { credentialId: string },
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalCredentialResponseDto> {
    return this.servicePrincipals.revokeCredential(
      params.id,
      params.credentialId,
      currentUser,
      auditMetaFromRequest(req),
    );
  }
}

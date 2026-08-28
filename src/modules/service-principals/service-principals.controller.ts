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
import type { AuditMeta } from '../audit-logs/audit-logs.types';
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
function auditMetaOf(req: Request): AuditMeta {
  return {
    requestId: String(req.headers['x-request-id'] ?? ''),
    ip: (req.headers['x-forwarded-for'] as string | undefined) ?? req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('system/service-principals')
@ApiBearerAuth()
@Controller('system/v1/service-principals')
export class ServicePrincipalsController {
  constructor(private readonly servicePrincipals: ServicePrincipalsService) {}

  @Post()
  @ApiOperation({ summary: '创建服务主体(服务端生成 clientId)' })
  @RequiresPermission('service-principal.create.record')
  @ApiWrappedCreatedResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.ORGANIZATION_NOT_FOUND)
  async create(
    @Body() dto: CreateServicePrincipalDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.create(dto, currentUser, auditMetaOf(req));
  }

  @Get()
  @ApiOperation({ summary: '分页列表' })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedPageResponse(ServicePrincipalResponseDto)
  async list(@Query() query: ListServicePrincipalsQueryDto) {
    return this.servicePrincipals.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '详情' })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedOkResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async findById(@Param() params: IdParamDto): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.findById(params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改名称/描述/属主组织' })
  @RequiresPermission('service-principal.update.record')
  @ApiWrappedOkResponse(ServicePrincipalResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateServicePrincipalDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalResponseDto> {
    return this.servicePrincipals.update(params.id, dto, currentUser, auditMetaOf(req));
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'ACTIVE/SUSPENDED' })
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
      auditMetaOf(req),
    );
  }

  @Post(':id/credentials')
  @ApiOperation({ summary: '新建凭证(原始 Secret 只返回一次)' })
  @RequiresPermission('service-principal.create.credential')
  @ApiWrappedCreatedResponse(ServicePrincipalCredentialCreatedDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  @ApiBizErrorResponse(BizCode.SERVICE_CREDENTIAL_LIMIT_EXCEEDED)
  async createCredential(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ServicePrincipalCredentialCreatedDto> {
    return this.servicePrincipals.createCredential(params.id, currentUser, auditMetaOf(req));
  }

  @Get(':id/credentials')
  @ApiOperation({ summary: '凭证元数据列表(不返 hash)' })
  @RequiresPermission('service-principal.read.record')
  @ApiWrappedOkResponse(ServicePrincipalCredentialResponseDto)
  @ApiBizErrorResponse(BizCode.SERVICE_PRINCIPAL_NOT_FOUND)
  async listCredentials(
    @Param() params: IdParamDto,
  ): Promise<ServicePrincipalCredentialResponseDto[]> {
    return this.servicePrincipals.listCredentials(params.id);
  }

  @Post(':id/credentials/:credentialId/revoke')
  @ApiOperation({ summary: '撤销凭证' })
  @RequiresPermission('service-principal.revoke.credential')
  @ApiWrappedOkResponse(ServicePrincipalCredentialResponseDto)
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
      auditMetaOf(req),
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiNoContentResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CertificateRecognitionPolicyListResponseDto,
  CertificateRecognitionPolicyResponseDto,
  CreateCertificateRecognitionPolicyDto,
  UpdateCertificateRecognitionPolicyDto,
  UpdateCertificateRecognitionPolicyStatusDto,
} from './certificate-recognition-policies.dto';
import { CertificateRecognitionPoliciesService } from './certificate-recognition-policies.service';
import { CertificateStandardIdParamDto } from './certificate-standards.dto';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';

// 证书标准库 PR-3(冻结稿 §13.2):队内认定规则管理面 controller(6 路由)。
//
// §13.2 把 6 条路由**刻意分在两个前缀**下:
//   - 集合操作挂在父资源下:`certificate-standards/:standardId/recognition-policies`
//     (list / create —— 版本永远属于某个 Standard,没有「全局新建一个 Policy」的语义)
//   - 单体操作挂扁平前缀:`certificate-recognition-policies/:id`
//     (get / patch / status / delete —— 有 id 就够定位,不必再带 standardId,
//      也避免出现 standardId 与 id 不匹配这种需要额外校验的伪参数)
// 本 controller 用 `@Controller('admin/v1')` 承载两组路径,而不是拆两个 controller ——
// 它们共用同一个 service 与同一套错误码,拆开只会让 api-surface 多一个条目。
@ApiTags('Admin - Certificate Recognition Policies')
@ApiBearerAuth()
@Controller('admin/v1')
export class CertificateRecognitionPoliciesController {
  constructor(private readonly service: CertificateRecognitionPoliciesService) {}

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get('certificate-standards/:standardId/recognition-policies')
  @RequiresPermission('certificate-recognition-policy.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '列出某证书标准的全部认定规则版本(version DESC;含 DRAFT / ACTIVE / RETIRED) [rbac: certificate-recognition-policy.read.record]',
  })
  @ApiWrappedOkResponse(CertificateRecognitionPolicyListResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
  )
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: CertificateStandardIdParamDto,
  ): Promise<CertificateRecognitionPolicyListResponseDto> {
    return this.service.list(currentUser, params.standardId);
  }

  @Post('certificate-standards/:standardId/recognition-policies')
  @RequiresPermission('certificate-recognition-policy.create.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '为某证书标准新建认定规则版本(恒 DRAFT;version 服务端在 Standard 行锁内分配) [rbac: certificate-recognition-policy.create.record]',
  })
  @ApiWrappedCreatedResponse(CertificateRecognitionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
    BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
    BizCode.CERTIFICATE_VALIDITY_INVALID,
    BizCode.CERTIFICATE_POLICY_VERSION_CONFLICT,
  )
  create(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: CertificateStandardIdParamDto,
    @Body() dto: CreateCertificateRecognitionPolicyDto,
    @Req() req: Request,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    return this.service.create(currentUser, params.standardId, dto, this.buildAuditMeta(req));
  }

  @Get('certificate-recognition-policies/:id')
  @RequiresPermission('certificate-recognition-policy.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary: '认定规则详情(含认可机构集合) [rbac: certificate-recognition-policy.read.record]',
  })
  @ApiWrappedOkResponse(CertificateRecognitionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_POLICY_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    return this.service.findOne(currentUser, params.id);
  }

  @Patch('certificate-recognition-policies/:id')
  @RequiresPermission('certificate-recognition-policy.update.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '修改 DRAFT 认定规则(传 issuers 即整体替换;ACTIVE / RETIRED 恒 18036) [rbac: certificate-recognition-policy.update.record]',
  })
  @ApiWrappedOkResponse(CertificateRecognitionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_POLICY_NOT_FOUND,
    BizCode.CERTIFICATE_POLICY_IMMUTABLE,
    BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
    BizCode.CERTIFICATE_VALIDITY_INVALID,
  )
  update(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateCertificateRecognitionPolicyDto,
    @Req() req: Request,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    return this.service.update(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Patch('certificate-recognition-policies/:id/status')
  @RequiresPermission('certificate-recognition-policy.update.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '激活 / 退役认定规则(ACTIVE 会原子退役该标准当前生效版;不接受 DRAFT) [rbac: certificate-recognition-policy.update.record]',
  })
  @ApiWrappedOkResponse(CertificateRecognitionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_POLICY_NOT_FOUND,
    BizCode.CERTIFICATE_POLICY_STATE_INVALID,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
    BizCode.CERTIFICATE_STANDARD_INACTIVE,
    BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
    BizCode.CERTIFICATE_VALIDITY_INVALID,
    BizCode.CERTIFICATE_POLICY_ACTIVE_CONFLICT,
  )
  updateStatus(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateCertificateRecognitionPolicyStatusDto,
    @Req() req: Request,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    return this.service.updateStatus(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Delete('certificate-recognition-policies/:id')
  @RequiresPermission('certificate-recognition-policy.delete.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '软删 DRAFT 认定规则(ACTIVE / RETIRED 恒 18036) [rbac: certificate-recognition-policy.delete.record]',
  })
  @ApiNoContentResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_POLICY_NOT_FOUND,
    BizCode.CERTIFICATE_POLICY_IMMUTABLE,
  )
  softDelete(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.softDelete(currentUser, params.id, this.buildAuditMeta(req));
  }
}

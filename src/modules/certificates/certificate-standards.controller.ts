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
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiNoContentResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CertificateStandardOptionsQueryDto,
  CertificateStandardOptionsResponseDto,
  CertificateStandardQueryDto,
  CertificateStandardResponseDto,
  CreateCertificateStandardDto,
  UpdateCertificateStandardDto,
  UpdateCertificateStandardStatusDto,
} from './certificate-standards.dto';
import { CertificateStandardsService } from './certificate-standards.service';

// 证书标准库 PR-3(冻结稿 §13.1):通用证书标准管理面 controller(7 路由)。
// 判权单轨 service 层 `rbac.can(certificate-standard.*.record)`;入口仅全局
// JwtAuthGuard,**不**挂 @Roles(沿 positions / memberships 现范式)。
@ApiTags('Admin - Certificate Standards')
@ApiBearerAuth()
@Controller('admin/v1/certificate-standards')
export class CertificateStandardsController {
  constructor(private readonly service: CertificateStandardsService) {}

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary:
      '列出证书标准(分页 + kind / category / level / status / parentId / q) [rbac: certificate-standard.read.record]',
  })
  @ApiWrappedPageResponse(CertificateStandardResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: CertificateStandardQueryDto,
  ): Promise<PageResultDto<CertificateStandardResponseDto>> {
    return this.service.list(currentUser, query);
  }

  // §13.1:**必须声明在 `:id` 之前**(specific-before-dynamic)。
  // 否则 `/certificate-standards/options` 会被 `:id` 吞掉,当成一个 id='options'
  // 的详情请求 → 恒 404,且不会有任何编译期报错。
  @Get('options')
  @ApiOperation({
    // 后缀只放**规范码**(`[rbac: <单码>]` 是 docs:rbacmap:check 的可解析形态);
    // §16.4 的三条替代入口码写在前面的说明里 —— 它们同样放行,但后缀语法不支持并列。
    summary:
      '证书标准选择器(只返 CREDENTIAL;带当前 ACTIVE 认定规则摘要与机构选项;recognizedOnly=true 只返可认定的;' +
      '§16.4 替代入口码:certificate.create.record / certificate.verify.record / recruitment-application.review.certificate 任一即可) ' +
      '[rbac: certificate-standard.read.record]',
  })
  @ApiWrappedOkResponse(CertificateStandardOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  options(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: CertificateStandardOptionsQueryDto,
  ): Promise<CertificateStandardOptionsResponseDto> {
    return this.service.options(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建证书标准(初始恒 DRAFT;code 唯一且不可复用) [rbac: certificate-standard.create.record]',
  })
  @ApiWrappedCreatedResponse(CertificateStandardResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_CODE_EXISTS,
    BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
    BizCode.CERTIFICATE_STANDARD_PARENT_INVALID,
    BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
    BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
  )
  create(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: CreateCertificateStandardDto,
    @Req() req: Request,
  ): Promise<CertificateStandardResponseDto> {
    return this.service.create(currentUser, dto, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({ summary: '证书标准详情(软删返 404) [rbac: certificate-standard.read.record]' })
  @ApiWrappedOkResponse(CertificateStandardResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<CertificateStandardResponseDto> {
    return this.service.findOne(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '修正证书标准文案与排序(只接受 name / description / sortOrder;身份字段永不可改) [rbac: certificate-standard.update.record]',
  })
  @ApiWrappedOkResponse(CertificateStandardResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
  )
  update(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateCertificateStandardDto,
    @Req() req: Request,
  ): Promise<CertificateStandardResponseDto> {
    return this.service.update(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      '证书标准状态迁移(DRAFT→ACTIVE / ACTIVE→INACTIVE / INACTIVE→ACTIVE;恢复 ACTIVE 前重校验字典与父级) [rbac: certificate-standard.update.record]',
  })
  @ApiWrappedOkResponse(CertificateStandardResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
    BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
    BizCode.CERTIFICATE_STANDARD_PARENT_INVALID,
    BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
  )
  updateStatus(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateCertificateStandardStatusDto,
    @Req() req: Request,
  ): Promise<CertificateStandardResponseDto> {
    return this.service.updateStatus(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '软删证书标准(被子节点 / 认定规则 / 申报 / 证书引用时禁删 → 18032) [rbac: certificate-standard.delete.record]',
  })
  @ApiNoContentResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_IN_USE,
  )
  softDelete(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.softDelete(currentUser, params.id, this.buildAuditMeta(req));
  }
}

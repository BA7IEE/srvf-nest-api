import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CertificateListItemDto,
  CertificateResponseDto,
  CreateCertificateDto,
  QualificationFlagQueryDto,
  QualificationFlagResponseDto,
  RejectCertificateDto,
  UpdateCertificateDto,
  VerifyCertificateDto,
} from './certificates.dto';
import { CertificatesService } from './certificates.service';

// V2 第一阶段批次 2 certificates controller。
// 路径嵌套在 members/:memberId/certificates 下,N:1 子资源 + 4 动作接口。
//
// 临时权限策略(API 前评审 §5.1):全部 ADMIN / SUPER_ADMIN 兜底,**不开放** USER 自助。
//
// 路由声明顺序(NestJS 优先级要求):
//   1. GET ''                      list
//   2. POST ''                     create
//   3. GET 'qualification-flag'    必须先于 :id(字面段优先于占位段)
//   4. GET ':id'                   findOne
//   5. PATCH ':id'                 update
//   6. DELETE ':id'                softDelete
//   7. PATCH ':id/verify'          verify(Q-A1:用 PATCH 而非 POST)
//   8. PATCH ':id/reject'          reject(Q-A1:用 PATCH 而非 POST)

@ApiTags('certificates')
@ApiBearerAuth()
@Controller('v2/members/:memberId/certificates')
export class CertificatesController {
  constructor(private readonly service: CertificatesService) {}

  // V2 批次 6 PR #2:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。仅供本 controller 写操作内部复用。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '列出队员证书(无分页;按 certStatusCode ASC, createdAt DESC 排序;软删过滤;精简字段)',
  })
  @ApiWrappedArrayResponse(CertificateListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<CertificateListItemDto[]> {
    return this.service.list(memberId, currentUser);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '新增一条证书(默认 certStatusCode=pending / isInternal=false)',
  })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
  )
  create(
    @Param('memberId') memberId: string,
    @Body() dto: CreateCertificateDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateResponseDto> {
    return this.service.create(memberId, dto, currentUser, this.buildAuditMeta(req));
  }

  // 必须先于 @Get(':id') 声明,否则 NestJS 将 'qualification-flag' 字面值视作 :id 占位。
  // 用 QualificationFlagQueryDto 走 ValidationPipe 强制 certTypeCode 必填(NestJS 默认 @Query
  // 不强制 query 参数存在);缺 certTypeCode → 400。
  @Get('qualification-flag')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '资质判定(已核验 + 未过期 + 未软删 = qualified=true;只返布尔 + 摘要)',
  })
  @ApiWrappedOkResponse(QualificationFlagResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_TYPE_CODE_INVALID,
  )
  qualificationFlag(
    @Param('memberId') memberId: string,
    @Query() query: QualificationFlagQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<QualificationFlagResponseDto> {
    return this.service.isQualified(memberId, query.certTypeCode, currentUser);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '查证书详情(含敏感字段;不返 deletedAt)' })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER,
  )
  findOne(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<CertificateResponseDto> {
    return this.service.findOne(memberId, id, currentUser);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '部分更新证书(全字段 optional;**禁止** id / memberId / certStatusCode / verifiedBy / verifiedAt / verifyNote / isInternal / supersededByCertId / attachmentKey / expireNotifyDueAt)',
  })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER,
    BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
  )
  update(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCertificateDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateResponseDto> {
    return this.service.update(memberId, id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '软删证书(写 deletedAt;不物理删除)' })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER,
  )
  softDelete(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateResponseDto> {
    return this.service.softDelete(memberId, id, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/verify')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '核验通过(pending → verified;不接收 issuedAt / expiredAt / certStatusCode / verifiedBy / verifiedAt)',
  })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER,
    BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
  )
  verify(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Body() dto: VerifyCertificateDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateResponseDto> {
    return this.service.verify(memberId, id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/reject')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '核验拒绝(pending → rejected;verifyNote 必填;不接收其他系统字段)',
  })
  @ApiWrappedOkResponse(CertificateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_FOUND,
    BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER,
    BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
  )
  reject(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Body() dto: RejectCertificateDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateResponseDto> {
    return this.service.reject(memberId, id, dto, currentUser, this.buildAuditMeta(req));
  }
}

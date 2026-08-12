import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ApplicationIdParamDto,
  ClaimIdParamDto,
  RecruitmentCertificateClaimAdminDto,
  RecruitmentCertificateClaimImageUrlsResponseDto,
  RecruitmentCertificateClaimListResponseDto,
  ReviewCertificateClaimDto,
  RevokeCertificateClaimReviewDto,
} from './recruitment-certificate-claims.dto';
import { RecruitmentCertificateClaimsService } from './recruitment-certificate-claims.service';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';

// 证书标准库 PR-4a-1(冻结稿 §13.4):招新证书申报管理端 controller(5 路由)。
//
// 路径按 §13.4 逐字:集合挂报名下,单体挂扁平前缀
// (claimId 足够定位;不再出现 `:category` —— category 不是证书实例 id,
//  无法支持同类别多张证书,也做不到单证重传与单证审核,这正是 §13.4 删旧端点的理由)。
//
// 判权沿招新域既有 GLOBAL 语义,service 层 `rbac.can`,0 `@Roles`。
@ApiTags('Admin - Recruitment Certificate Claims')
@ApiBearerAuth()
@Controller('admin/v1/recruitment')
export class RecruitmentCertificateClaimsAdminController {
  constructor(private readonly service: RecruitmentCertificateClaimsService) {}

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get('applications/:applicationId/certificate-claims')
  @RequiresPermission('recruitment-application.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '列出某报名的全部证书申报(一证一行;编号默认掩码、imageCount 代替 key;明文与审核人需敏感码) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateClaimListResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
  )
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: ApplicationIdParamDto,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateClaimListResponseDto> {
    return this.service.listByApplication(
      currentUser,
      params.applicationId,
      this.buildAuditMeta(req),
    );
  }

  @Get('certificate-claims/:id')
  @RequiresPermission('recruitment-application.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '证书申报详情(授权不只靠 claimId —— 连带校验其报名真实且未软删) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateClaimAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: ClaimIdParamDto,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    return this.service.findOne(currentUser, params.id, this.buildAuditMeta(req));
  }

  // §15.5:短 TTL(≤300s)+ `Cache-Control: no-store`。
  // no-store 不是装饰 —— 少了它,签名 URL 会进浏览器/代理缓存,
  // TTL 到期后缓存副本仍可能被取出,短 TTL 的意义就没了。
  @Get('certificate-claims/:id/image-urls')
  @RequiresPermission('recruitment-application.read.sensitive', {
    require: 'all',
    engine: 'rbac-global',
  })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      '取证书申报证据图短 TTL signed-URL(只返 URL 不返 key;no-store;URL 不入日志/审计/snapshot) [rbac: recruitment-application.read.sensitive]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateClaimImageUrlsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND,
  )
  imageUrls(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: ClaimIdParamDto,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateClaimImageUrlsResponseDto> {
    return this.service.getImageUrls(currentUser, params.id, this.buildAuditMeta(req));
  }

  @Post('certificate-claims/:id/review')
  @RequiresPermission('recruitment-application.review.certificate', {
    require: 'all',
    engine: 'rbac-global',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '审核单张证书申报(APPROVE 锁定 Standard/Policy/机构/编号/日期;REJECT 与 NEEDS_INFO 需 note;version 为 CAS) [rbac: recruitment-application.review.certificate]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateClaimAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT,
    BizCode.RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED,
    BizCode.RECRUITMENT_CERTIFICATE_POLICY_UNAVAILABLE,
    BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
    BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
    BizCode.CERTIFICATE_STANDARD_INACTIVE,
    BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
    BizCode.CERTIFICATE_ISSUER_NOT_ALLOWED,
    BizCode.CERTIFICATE_NUMBER_REQUIRED,
    BizCode.CERTIFICATE_NUMBER_NOT_ALLOWED,
    BizCode.CERTIFICATE_VALIDITY_INVALID,
    BizCode.CERTIFICATE_DATE_RANGE_INVALID,
    BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE,
  )
  review(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: ClaimIdParamDto,
    @Body() dto: ReviewCertificateClaimDto,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    return this.service.review(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Post('certificate-claims/:id/revoke-review')
  @RequiresPermission('recruitment-application.review.certificate', {
    require: 'all',
    engine: 'rbac-global',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '撤回已通过的审核结论(APPROVED → SUBMITTED;清空 Standard/Policy/机构与审核字段;note 必填,写高价值审计) [rbac: recruitment-application.review.certificate]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateClaimAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
    BizCode.RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT,
  )
  revokeReview(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: ClaimIdParamDto,
    @Body() dto: RevokeCertificateClaimReviewDto,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    return this.service.revokeReview(currentUser, params.id, dto, this.buildAuditMeta(req));
  }
}

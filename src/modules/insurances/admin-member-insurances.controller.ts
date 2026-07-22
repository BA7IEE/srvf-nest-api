import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MemberInsuranceAdminResponseDto, ReviewMemberInsuranceDto } from './insurances.dto';
import { MemberInsuranceOverviewResponseDto } from './member-insurance-overview.dto';
import { MemberInsuranceOverviewService } from './member-insurance-overview.service';
import { MemberInsurancesService } from './member-insurances.service';

// 保险模块 T2:admin 查队员自购保险 controller(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 14 / E-15。
// 路径嵌套在 members/:memberId 下(镜像 admin certificates N:1 子资源范式);
// 入口仅 JwtAuthGuard,判权下沉 service 层 rbac.can('member-insurance.read.other');
// 数组无分页(镜像 certificates list;每队员保险记录量小)。
@ApiTags('Admin - Member Insurances')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/insurances')
export class AdminMemberInsurancesController {
  constructor(
    private readonly service: MemberInsurancesService,
    private readonly overviewService: MemberInsuranceOverviewService,
  ) {}

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
      '列出队员自购保险(无分页;coverageEnd desc;软删过滤;本人侧走 app/v1/me/insurances) [rbac: member-insurance.read.other]',
  })
  @ApiWrappedArrayResponse(MemberInsuranceAdminResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberInsuranceAdminResponseDto[]> {
    return this.service.listForMember(memberId, currentUser, this.buildAuditMeta(req));
  }

  // 队员轴聚合只读模型；旧 GET 保持只返回个人自购保险。
  @Get('overview')
  @ApiOperation({
    summary:
      '获取队员统一保险概览（个人自购 + 队内统一覆盖安全投影） [rbac: member-insurance.read.other]',
  })
  @ApiWrappedOkResponse(MemberInsuranceOverviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  overview(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberInsuranceOverviewResponseDto> {
    return this.overviewService.getForMember(memberId, currentUser, this.buildAuditMeta(req));
  }

  @Post(':insuranceId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '记录队员自购保险审核结论(expectedVersion 必填;仅 pending 可审) [rbac: member-insurance.review.record]',
  })
  @ApiWrappedOkResponse(MemberInsuranceAdminResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_INSURANCE_NOT_FOUND,
    BizCode.MEMBER_INSURANCE_VERSION_CONFLICT,
    BizCode.MEMBER_INSURANCE_REVIEW_STATE_INVALID,
  )
  review(
    @Param('memberId') memberId: string,
    @Param('insuranceId') insuranceId: string,
    @Body() dto: ReviewMemberInsuranceDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberInsuranceAdminResponseDto> {
    return this.service.reviewForMember(
      memberId,
      insuranceId,
      dto,
      currentUser,
      this.buildAuditMeta(req),
    );
  }
}

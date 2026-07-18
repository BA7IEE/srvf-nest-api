import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MemberInsuranceAdminResponseDto } from './insurances.dto';
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
  constructor(private readonly service: MemberInsurancesService) {}

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
}

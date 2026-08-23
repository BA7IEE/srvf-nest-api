import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ListMemberInsuranceWorkbenchQueryDto,
  MemberInsuranceWorkbenchItemDto,
  MemberInsuranceWorkbenchMemberDto,
} from './member-insurances-workbench.dto';
import { MemberInsurancesWorkbenchService } from './member-insurances-workbench.service';

// 保险审核工作台 controller(2026-08-23)。
//
// 与 `/admin/v1/members/:memberId/insurances` 的分工:那个是**单人档案**面
// (memberId 在路径上);本 controller 是**跨队员**面 —— 它不属于任何一个队员,
// 所以路径挂在顶层 `admin/v1/member-insurances` 而不是嵌在 members 下
// (沿 `certificates-workbench` 挂 `admin/v1/certificates` 的同一条理由)。
//
// 判权入口码复用 `member-insurance.read.other`,零新增码。
// 出参保单号**恒掩码**;要明文请走单人面。
@ApiTags('Admin - Member Insurances Workbench')
@ApiBearerAuth()
@ApiExtraModels(MemberInsuranceWorkbenchMemberDto)
@Controller('admin/v1/member-insurances')
export class MemberInsurancesWorkbenchController {
  constructor(private readonly service: MemberInsurancesWorkbenchService) {}

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @RequiresPermission('member-insurance.read.other', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '保险审核工作列表(跨队员;按 reviewStatusCode 筛,**不传 = 不筛**;软删记录与软删队员均不出;createdAt desc)。出参保单号**恒掩码**,跨队员面永不返明文 —— 需要明文走 `GET /admin/v1/members/:memberId/insurances`。解锁 `INSURANCE_ENFORCEMENT_ENABLED` 的前置:开关前先把已录的保险审一遍 [rbac: member-insurance.read.other]',
  })
  @ApiWrappedPageResponse(MemberInsuranceWorkbenchItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListMemberInsuranceWorkbenchQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<PageResultDto<MemberInsuranceWorkbenchItemDto>> {
    return this.service.list(query, currentUser, this.buildAuditMeta(req));
  }
}

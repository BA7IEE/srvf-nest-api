import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CertificateWorkbenchFilterDto,
  CertificateWorkbenchItemDto,
  CertificateWorkbenchStatsDto,
  ListCertificateWorkbenchQueryDto,
  WorkbenchMemberSummaryDto,
  WorkbenchStandardSummaryDto,
} from './certificates-workbench.dto';
import { CertificatesWorkbenchService } from './certificates-workbench.service';

// 证书标准库 PR-5(冻结稿 §13.6 / §14):全局证书工作台(2 路由)。
//
// 与 `/admin/v1/members/:memberId/certificates` 的分工:那个是**单人档案**面
// (memberId 在路径上、按 member ref 走 scoped Authz);本 controller 是**跨人**面,
// 判权入口码复用 `certificate.read.record`(零新增码),但可见组织范围在 service 里
// 先下推到 SQL 再分页与计数(§15.7)。
//
// 路径刻意挂在 `admin/v1/certificates` 而不是嵌在 members 下 —— 它不属于任何一个队员。
@ApiTags('Admin - Certificates Workbench')
@ApiBearerAuth()
@ApiExtraModels(WorkbenchMemberSummaryDto, WorkbenchStandardSummaryDto)
@Controller('admin/v1/certificates')
export class CertificatesWorkbenchController {
  constructor(private readonly service: CertificatesWorkbenchService) {}

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
      '全局证书工作台列表(跨队员;可见组织范围先下推 SQL 再分页与计数;q 只搜队员编号/展示名/标准名称与 code/发证机构 —— **不搜完整证书编号**;出参恒不含完整编号/审核备注/审核人/图片 key;含 effectiveStatusCode 当前有效展示状态) [rbac: certificate.read.record]',
  })
  @ApiWrappedPageResponse(CertificateWorkbenchItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListCertificateWorkbenchQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<PageResultDto<CertificateWorkbenchItemDto>> {
    return this.service.list(query, currentUser, this.buildAuditMeta(req));
  }

  @Get('stats')
  @ApiOperation({
    summary:
      '全局证书工作台统计(六个计数器:pending/verified/expired/rejected/expiringWithin60Days/permanent;接受与列表**完全相同**的非分页过滤;按北京 today 计算且**不依赖到期 cron 已翻态**〔expired 含「verified 但 expiredAt<today」〕;scope 先下推再计数) [rbac: certificate.read.record]',
  })
  @ApiWrappedOkResponse(CertificateWorkbenchStatsDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  stats(
    @Query() query: CertificateWorkbenchFilterDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<CertificateWorkbenchStatsDto> {
    return this.service.stats(query, currentUser, this.buildAuditMeta(req));
  }
}

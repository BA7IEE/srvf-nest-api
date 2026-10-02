import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { ContributionShadowEvidenceService } from '../contribution-shadow-evidence.service';
import {
  ShadowWindowParamDto,
  ShadowCandidateParamDto,
  ShadowAttemptParamDto,
  ShadowEvidencePageQueryDto,
  ShadowWindowEvidenceDto,
  ShadowCandidateEvidenceDto,
  ShadowWindowSummaryDto,
  ShadowComparisonEvidenceDto,
} from '../dto/system/contribution-shadow-evidence.dto';

function meta(req: Request): AuditMeta {
  const requestId =
    typeof req.id === 'string' ? req.id : typeof req.id === 'number' ? req.id.toString() : '';
  return { requestId, ip: req.ip ?? null, ua: req.get('user-agent') ?? null };
}

@ApiTags('System - Contribution Shadow Evidence')
@ApiBearerAuth()
@Controller('system/v1/contribution-shadow')
export class SystemContributionShadowEvidenceController {
  constructor(private readonly service: ContributionShadowEvidenceService) {}

  @Get('windows')
  @RequiresPermission('contribution-shadow.read.evidence', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看贡献影子观察窗口 [rbac: contribution-shadow.read.evidence]' })
  @ApiWrappedPageResponse(ShadowWindowEvidenceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
  )
  windows(
    @Query() query: ShadowEvidencePageQueryDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.listWindows(query, user, meta(req));
  }

  @Get('windows/:windowId/summary')
  @RequiresPermission('contribution-shadow.read.evidence', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看贡献影子原始与净缺口 [rbac: contribution-shadow.read.evidence]' })
  @ApiWrappedOkResponse(ShadowWindowSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
  )
  summary(
    @Param() params: ShadowWindowParamDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.summary(params.windowId, user, meta(req));
  }

  @Get('windows/:windowId/candidates')
  @RequiresPermission('contribution-shadow.read.evidence', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查看贡献影子候选 [rbac: contribution-shadow.read.evidence]' })
  @ApiWrappedPageResponse(ShadowCandidateEvidenceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
  )
  candidates(
    @Param() params: ShadowWindowParamDto,
    @Query() query: ShadowEvidencePageQueryDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.listCandidates(params.windowId, query, user, meta(req));
  }

  @Get('windows/:windowId/candidates/:auditLogId')
  @RequiresPermission('contribution-shadow.read.evidence', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看单候选影子证据链 [rbac: contribution-shadow.read.evidence]' })
  @ApiWrappedOkResponse(ShadowCandidateEvidenceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
  )
  candidate(
    @Param() params: ShadowCandidateParamDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.candidate(params.windowId, params.auditLogId, user, meta(req));
  }

  @Get('windows/:windowId/attempts/:attemptId/comparisons')
  @RequiresPermission('contribution-shadow.read.evidence', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查看贡献影子比较结果 [rbac: contribution-shadow.read.evidence]' })
  @ApiWrappedPageResponse(ShadowComparisonEvidenceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
  )
  comparisons(
    @Param() params: ShadowAttemptParamDto,
    @Query() query: ShadowEvidencePageQueryDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.listComparisons(params.windowId, params.attemptId, query, user, meta(req));
  }
}

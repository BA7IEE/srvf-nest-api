import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  ActivityParticipationIdParamDto,
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
} from '../activity-participation.dto';
import { ActivityParticipationQueryService } from '../activity-participation-query.service';
import { AdminParticipationLedgerEntryDto } from '../dto/admin/admin-participation-ledger.dto';
import { LedgerQueryService } from '../ledger-query.service';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';

// 审计刀 5 F1/F2：活动级跨子表只读投影。独立 Controller + QueryService，保持
// ActivitiesService 零增长；两端点都在 service 逐一校验 attendance.read.sheet 与
// activity-registration.read.record，并带 activity ref。
@ApiTags('Admin - Activities')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId')
export class AdminActivityParticipationController {
  constructor(
    private readonly query: ActivityParticipationQueryService,
    private readonly ledgerQuery: LedgerQueryService,
  ) {}

  // 账本权限口径见 LedgerQueryService 的 LEDGER_READ_ACTION：合同 §6.11 空白，2026-08-06 显式接受复用考勤读码。
  @Get('participation-ledger')
  @RequiresPermission('attendance.read.sheet', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '活动已生效参与账本（分页） [rbac: attendance.read.sheet]' })
  @ApiWrappedPageResponse(AdminParticipationLedgerEntryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  participationLedger(
    @Param() params: ActivityParticipationIdParamDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminParticipationLedgerEntryDto>> {
    return this.ledgerQuery.listForAdminActivity(params.activityId, query, currentUser);
  }

  @Get('reconciliation')
  @RequiresPermission('activity-registration.read.record', 'attendance.read.sheet', {
    require: 'all',
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary:
      '活动报名×实到核对(completed only；pass 逐人 attended/no-show + 临时参加名单；需同时持 attendance.read.sheet 与 activity-registration.read.record，按活动资源范围判定) [auth]',
  })
  @ApiWrappedOkResponse(ActivityReconciliationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  reconciliation(
    @Param() params: ActivityParticipationIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityReconciliationDto> {
    return this.query.reconciliation(params.activityId, currentUser);
  }

  @Get('participation-summary')
  @RequiresPermission('activity-registration.read.record', 'attendance.read.sheet', {
    require: 'all',
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary:
      '活动参与合计(报名状态/实到/到场率/approved 时长与贡献/固定时长桶；需同时持 attendance.read.sheet 与 activity-registration.read.record，按活动资源范围判定) [auth]',
  })
  @ApiWrappedOkResponse(ActivityParticipationSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  participationSummary(
    @Param() params: ActivityParticipationIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityParticipationSummaryDto> {
    return this.query.participationSummary(params.activityId, currentUser);
  }
}

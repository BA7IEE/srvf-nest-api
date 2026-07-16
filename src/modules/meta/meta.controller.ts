import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  DashboardSummaryResponseDto,
  ResolveLabelsDto,
  ResolveLabelsResponseDto,
} from './meta.dto';
import { MetaService } from './meta.service';
import {
  ParticipationOverviewQueryDto,
  ParticipationOverviewResponseDto,
} from './participation-overview.dto';
import { ParticipationOverviewQueryService } from './participation-overview-query.service';

// F1/A7(路线图 §4 A7;net-new 模块):跨资源批量 id→label 解析,供前端选择器/详情页
// 回显用。POST 语义 = 批量查询(入参是结构体,复用 announcement-import/authz-explain
// 的既有惯例);判权单轨 service 层 per-type rbac.can(D5),入口仅全局 JwtAuthGuard,
// 不挂 @Roles。无权 type / 不存在 id 静默省略,不是错误 —— 不抛 BizException。

@ApiTags('Admin - Meta')
@ApiBearerAuth()
@Controller('admin/v1/meta')
export class MetaController {
  constructor(
    private readonly service: MetaService,
    private readonly participationOverview: ParticipationOverviewQueryService,
  ) {}

  @Post('resolve-labels')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量 id→label 解析(refs≤200;per-type 读权限过滤 + 无权/不存在静默省略) [rbac: meta.resolve.label]',
  })
  @ApiWrappedOkResponse(ResolveLabelsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resolveLabels(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ResolveLabelsDto,
  ): Promise<ResolveLabelsResponseDto> {
    return this.service.resolveLabels(user, dto);
  }

  // GAP-003(handoff/admin-web.md §4;goal「GAP-003 收口」):工作台/首页待办汇总,零 query
  // 参数。无入口 RBAC 码——三块各自块级裁剪(见 service),零权限时仍 200(只是块更少),
  // 故鉴权后缀为 [auth] 而非某个单一 [rbac: ...] 码(镜像 activities list 的 [auth] 用法,
  // 那也是"无单一码但内部另有过滤"的先例)。
  @Get('dashboard-summary')
  @ApiOperation({
    summary:
      '工作台/首页待办汇总(registrations/attendanceSheets 按对应读码的三源授权组织范围统计;activities 块无码同 list 现状;缺码的块静默省略,响应恒 200) [auth]',
  })
  @ApiWrappedOkResponse(DashboardSummaryResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  dashboardSummary(@CurrentUser() user: CurrentUserPayload): Promise<DashboardSummaryResponseDto> {
    return this.service.dashboardSummary(user);
  }

  @Get('participation-overview')
  @ApiOperation({
    summary:
      '参与度月度总览(活动日期/类型/组织筛选；两项读权限可见组织范围求交；无可见范围返空) [auth]',
  })
  @ApiWrappedOkResponse(ParticipationOverviewResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  participationOverviewSummary(
    @Query() query: ParticipationOverviewQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ParticipationOverviewResponseDto> {
    return this.participationOverview.getOverview(query, user);
  }
}

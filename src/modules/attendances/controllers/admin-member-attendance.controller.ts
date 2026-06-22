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
import { AdminMemberAttendanceRecordDto, MemberContributionSummaryDto } from '../attendances.dto';
import { AttendancesService } from '../attendances.service';

// 跨轴只读 admin controller(2026-06-23;队员/审批跨轴只读查询 goal · 队员 360 Tier3)。
//
// admin/v1/members/:memberId 轴下的两个 attendance 派生只读端点(队员 360「考勤记录」「贡献值」tab):
//   1. GET attendance-records:某队员跨 sheet 考勤记录(仅 approved;复用 attendance-presenter;
//      item 带 activity 上下文);
//   2. GET contribution-summary:某队员贡献值生涯累计 capped 总分(实时算,复用 team-join 封顶核 1.5)。
//
// 落 admin member 轴(贡献汇总是 attendance 派生读,非 contribution-rules 的 System surface 规则面;
// 沿 api-surface-policy §9.1)。入口仅全局 JwtAuthGuard,判权下沉 service 层 rbac.can('attendance.read.sheet')
// (复用现成 read 码,零新码);MEMBER_NOT_FOUND 守卫在 service 层(镜像 admin-member-insurances)。
// certificates / department / profile / emergency-contacts / insurances 5 子资源已现成,本 goal 不动。

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId')
export class AdminMemberAttendanceController {
  constructor(private readonly service: AttendancesService) {}

  @Get('attendance-records')
  @ApiOperation({
    summary:
      '某队员考勤记录(队员 360;分页;仅 approved Sheet 内 records;item 带 activity 上下文;不存在/软删 → MEMBER_NOT_FOUND) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AdminMemberAttendanceRecordDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  attendanceRecords(
    @Param('memberId') memberId: string,
    @Query() query: PaginationQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminMemberAttendanceRecordDto>> {
    return this.service.listRecordsForMemberAdmin(memberId, query, currentUser);
  }

  @Get('contribution-summary')
  @ApiOperation({
    summary:
      '某队员贡献值生涯累计 capped 总分(队员 360;实时算不落库;approved sheet + 北京日封顶 1.5;不存在/软删 → MEMBER_NOT_FOUND) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(MemberContributionSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  contributionSummary(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberContributionSummaryDto> {
    return this.service.getMemberContributionSummary(memberId, currentUser);
  }
}

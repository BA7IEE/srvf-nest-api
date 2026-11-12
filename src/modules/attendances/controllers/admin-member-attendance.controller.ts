import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { MemberContributionSummaryDto } from '../attendances.dto';
import { MemberParticipationSummaryDto } from '../participation-summary.dto';
import { ParticipationSummaryQueryService } from '../participation-summary-query.service';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';

// Member-axis summary endpoints retain the existing scoped authorization and member checks.
// Legacy attendance records are retired; the participation ledger remains a separate API.

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId')
export class AdminMemberAttendanceController {
  constructor(private readonly participationQuery: ParticipationSummaryQueryService) {}

  @Get('contribution-summary')
  @RequiresPermission('attendance.read.sheet', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '某队员生涯贡献汇总(队员 360；只取 committed 账本 credited 净额；不叠加、不再封顶；闸关返回 20153/503，无 cutoff；不存在/软删 → MEMBER_NOT_FOUND) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(MemberContributionSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  )
  contributionSummary(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberContributionSummaryDto> {
    return this.participationQuery.contributionForMemberAdmin(memberId, currentUser);
  }

  @Get('participation-summary')
  @RequiresPermission('attendance.read.sheet', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '某队员参与累计(时长/活动次数/记录数；生涯贡献：只取 committed 账本 credited 净额；不叠加、不再封顶；闸关返回 20153/503，无 cutoff；member ref 点判) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(MemberParticipationSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  )
  participationSummary(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberParticipationSummaryDto> {
    return this.participationQuery.forMemberAdmin(memberId, currentUser);
  }
}

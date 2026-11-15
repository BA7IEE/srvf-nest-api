import { Controller, Get } from '@nestjs/common';
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
import { AppMyParticipationSummaryDto } from '../dto/app/app-my-participation-summary.dto';
import { ParticipationSummaryQueryService } from '../participation-summary-query.service';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';

@ApiTags('Mobile - My Attendance')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyParticipationSummaryController {
  constructor(private readonly query: ParticipationSummaryQueryService) {}

  @Get('participation-summary')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary:
      '我的参与累计(时长/活动次数/记录数；生涯贡献：只取 committed 账本 credited 净额；不叠加、不再封顶；闸关返回 20153/503，无 cutoff；恒本人范围) [auth]',
  })
  @ApiWrappedOkResponse(AppMyParticipationSummaryDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  )
  participationSummary(
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppMyParticipationSummaryDto> {
    return this.query.forCurrentMember(currentUser);
  }
}

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

@ApiTags('Mobile - My Attendance')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyParticipationSummaryController {
  constructor(private readonly query: ParticipationSummaryQueryService) {}

  @Get('participation-summary')
  @ApiOperation({
    summary:
      '我的参与累计(approved 时长/活动次数/记录数/生涯封顶贡献；仅正向数据；恒本人范围) [auth]',
  })
  @ApiWrappedOkResponse(AppMyParticipationSummaryDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  participationSummary(
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppMyParticipationSummaryDto> {
    return this.query.forCurrentMember(currentUser);
  }
}

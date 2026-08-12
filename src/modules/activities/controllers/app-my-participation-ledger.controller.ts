import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  AppParticipationLedgerEntryDto,
  ListAppMyParticipationLedgerQueryDto,
} from '../dto/app/app-participation-ledger.dto';
import { LedgerQueryService } from '../ledger-query.service';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';

// App self surface: 不接收 memberId，LedgerQueryService 仅从 CurrentUser 解析 active member。
@ApiTags('Mobile - My Participation Ledger')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyParticipationLedgerController {
  constructor(private readonly ledgerQuery: LedgerQueryService) {}

  // 账本权限口径见 LedgerQueryService 的 LEDGER_READ_ACTION：2026-08-06 显式决定；本 App 面仍只读本人。
  @Get('participation-ledger')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '我的已生效参与账本（分页，可选 activityId） [auth]' })
  @ApiWrappedPageResponse(AppParticipationLedgerEntryDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyParticipationLedgerQueryDto,
  ): Promise<PageResultDto<AppParticipationLedgerEntryDto>> {
    return this.ledgerQuery.listForCurrentMember(query, currentUser);
  }
}

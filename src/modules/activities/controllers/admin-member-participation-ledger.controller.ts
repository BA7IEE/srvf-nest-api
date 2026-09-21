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
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AdminParticipationLedgerEntryDto } from '../dto/admin/admin-participation-ledger.dto';
import {
  AdminMemberParticipationLedgerParamsDto,
  ListAdminMemberParticipationLedgerQueryDto,
} from '../dto/admin/admin-settlement-read.dto';
import { LedgerQueryService } from '../ledger-query.service';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  AdminParticipationTimeProofQueryDto,
  AdminParticipationTimeProofResponseDto,
} from '../dto/admin/admin-participation-time-proof.dto';
import { ParticipationTimeProofQueryService } from '../participation-time-proof-query.service';

// 与既有 admin/v1/members/:memberId 跨轴读面并列；判权和防枚举在服务层完成。
@ApiTags('Admin - Participation Ledger')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId')
export class AdminMemberParticipationLedgerController {
  constructor(
    private readonly ledgerQuery: LedgerQueryService,
    private readonly timeProofQuery: ParticipationTimeProofQueryService,
  ) {}

  // 账本权限口径见 LedgerQueryService 的 LEDGER_READ_ACTION：合同 §6.11 空白，2026-08-06 显式接受复用考勤读码。
  @Get('participation-ledger')
  @RequiresPermission('attendance.read.sheet', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary: '某队员已生效参与账本（分页，可选 ledgerDate 区间） [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AdminParticipationLedgerEntryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @Param() params: AdminMemberParticipationLedgerParamsDto,
    @Query() query: ListAdminMemberParticipationLedgerQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminParticipationLedgerEntryDto>> {
    return this.ledgerQuery.listForAdminMember(params.memberId, query, currentUser);
  }

  @Get('participation-time-proof')
  @RequiresPermission('attendance.read.sheet', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary: '某队员正式参与时长证明（scoped/GLOBAL） [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AdminParticipationTimeProofResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_TIME_PROOF_UNAVAILABLE,
    BizCode.ACTIVITY_TIME_PROOF_INVALID,
    BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT,
    BizCode.ACTIVITY_TIME_PROOF_RANGE_INVALID,
  )
  proof(
    @Param() params: AdminMemberParticipationLedgerParamsDto,
    @Query() query: AdminParticipationTimeProofQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AdminParticipationTimeProofResponseDto> {
    return this.timeProofQuery.forAdminMember(params.memberId, query, currentUser);
  }
}

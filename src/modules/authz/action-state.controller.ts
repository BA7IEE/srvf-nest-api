import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActionStateService } from './action-state.service';
import { ActionStateBatchDto, ActionStateBatchResponseDto } from './authz.dto';

// F3/C3「action-state/batch」(路线图 §4 C3 / D8 拍板;2026-07-04):authz 模块第二个 controller ——
// 批量业务态闸(D8 推荐落位:独立 ActionStateController,authz 模块内)。判定对象 = 调用者本人;
// allowed = authz 判权 ∧ 已注册 action 的状态机只读校验。@Controller('admin/v1') + 完整子路径;
// 判权单轨 service 层 rbac.can('authz.action-state.decision'),入口仅全局 JwtAuthGuard,不挂 @Roles。
// POST 语义 = 诊断查询(入参是结构体),显式 @HttpCode(200):deny 是数据不是错误(沿 explain 决断②)。

@ApiTags('Admin - Authz')
@ApiBearerAuth()
@Controller('admin/v1')
export class ActionStateController {
  constructor(private readonly service: ActionStateService) {}

  @Post('authz/action-state/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量业务态闸(诊断读):调用者对一组 action×资源 的 allowed + reason(authz 11 值 ∪ state_forbidden);items 回显 action/resourceType/resourceId 且顺序 = 请求顺序;可选 key 逐 item 透传回显(仅请求携带时出现,不参与判定);deny 是 200 数据非错误 [rbac: authz.action-state.decision]',
  })
  @ApiWrappedOkResponse(ActionStateBatchResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  batch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ActionStateBatchDto,
  ): Promise<ActionStateBatchResponseDto> {
    return this.service.batch(user, dto);
  }
}

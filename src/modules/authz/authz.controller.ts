import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuthzExplainService } from './authz-explain.service';
import {
  ExplainAuthzBatchDto,
  ExplainAuthzBatchResponseDto,
  ExplainAuthzDto,
  ExplainAuthzResponseDto,
} from './authz.dto';

// 终态 scoped-authz PR10「authz/explain 端点」(2026-07-02;冻结稿 §7.6 + §9 行 20):
// authz 模块第一个 controller(1 路由)—— 可解释性出口:「谁,因哪个角色/职务/分管,在什么范围,
// 对什么资源,被允许或拒绝」。@Controller('admin/v1') + 完整子路径 authz/explain;
// 判权单轨 service 层 rbac.can('authz.explain.decision'),入口仅全局 JwtAuthGuard,不挂 @Roles。
// POST 语义 = 诊断查询(入参是结构体),显式 @HttpCode(200):deny 是数据不是错误(goal 决断②)。

@ApiTags('Admin - Authz')
@ApiBearerAuth()
@Controller('admin/v1')
export class AuthzController {
  constructor(private readonly service: AuthzExplainService) {}

  @Post('authz/explain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '权限解释(诊断读):目标用户对 action(+可选 resourceRef)的 allow/deny + reason + matchedGrant;deny 是 200 数据非错误 [rbac: authz.explain.decision]',
  })
  @ApiWrappedOkResponse(ExplainAuthzResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.USER_NOT_FOUND,
  )
  explain(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ExplainAuthzDto,
  ): Promise<ExplainAuthzResponseDto> {
    return this.service.explain(user, dto);
  }

  // F3/C2(路线图 §4 C2 / D8 拍板;2026-07-04):单条 explain 的批量壳(≤200)。
  // 同一套 AuthzReason 11 值枚举;deny 仍是 200 数据;任一 userId 不存在/已软删 → 整请求 10001(镜像单条输入错误语义)。
  @Post('authz/explain-batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量权限解释(诊断读):逐条返 allow/deny + reason(同单条 11 值枚举)+ matchedGrant;deny 是 200 数据非错误 [rbac: authz.explain-batch.decision]',
  })
  @ApiWrappedOkResponse(ExplainAuthzBatchResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.USER_NOT_FOUND,
  )
  explainBatch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ExplainAuthzBatchDto,
  ): Promise<ExplainAuthzBatchResponseDto> {
    return this.service.explainBatch(user, dto);
  }
}

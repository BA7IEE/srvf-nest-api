import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
import { ResolveLabelsDto, ResolveLabelsResponseDto } from './meta.dto';
import { MetaService } from './meta.service';

// F1/A7(路线图 §4 A7;net-new 模块):跨资源批量 id→label 解析,供前端选择器/详情页
// 回显用。POST 语义 = 批量查询(入参是结构体,复用 announcement-import/authz-explain
// 的既有惯例);判权单轨 service 层 per-type rbac.can(D5),入口仅全局 JwtAuthGuard,
// 不挂 @Roles。无权 type / 不存在 id 静默省略,不是错误 —— 不抛 BizException。

@ApiTags('Admin - Meta')
@ApiBearerAuth()
@Controller('admin/v1/meta')
export class MetaController {
  constructor(private readonly service: MetaService) {}

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
}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { SmsSendLogQueryDto, SmsSendLogResponseDto } from './sms.dto';
import { SmsSendLogsService } from './sms-send-logs.service';

// SMS 基础设施 T2(2026-06-10):SMS Send Logs 只读列表 Controller(评审稿 §3.2 ④ / E-20)
//
// - 分页只读;无 detail 端点;**响应 phone 一律掩码** 138****1234(E-21)
// - 入口仅 JwtAuthGuard;Service 内 rbac.can('sms-send-log.read.list'),失败 30100
//   (镜像 audit-logs R 模式范式;码绑 ops-admin,评审稿 E-3)

@ApiTags('Ops - SMS Send Logs')
@ApiBearerAuth()
@ApiExtraModels(SmsSendLogResponseDto, PageResultDto)
@Controller('system/v1/sms-send-logs')
export class SmsSendLogsController {
  constructor(private readonly service: SmsSendLogsService) {}

  @Get()
  @ApiOperation({
    summary:
      '分页查询短信发送日志(只读;响应手机号一律掩码 138****1234;可选 status / phone 精确过滤) [rbac: sms-send-log.read.list]',
  })
  @ApiWrappedPageResponse(SmsSendLogResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: SmsSendLogQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<SmsSendLogResponseDto>> {
    return this.service.list(query, user);
  }
}

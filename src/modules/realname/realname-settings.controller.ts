import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ResetRealnameCredentialsDto,
  RealnameSettingsResponseDto,
  UpdateRealnameSettingsDto,
} from './realname.dto';
import { RealnameSettingsService } from './realname-settings.service';

// 招新一期 · 实名核验通道 T2(2026-06-18):Realname Settings admin Controller(评审稿 §3.2 ①-③;
// 路径动词镜像 wechat/sms-settings 现状 = GET / PATCH / POST reset-credentials)
//
// **权限标注**(镜像 wechat/sms-settings 范式):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 Service 内 `rbac.can()`,
// 失败抛 RBAC_FORBIDDEN(30100)。seed(T1 已落)3 条权限点:
// realname-setting.read.singleton / .update.singleton / .reset.credentials。
// `realname-setting.reset.credentials` 不绑 ops-admin(评审稿 E-R-19,镜像 storage/sms/wechat D2=A):
// ADMIN+ops-admin 调 reset-credentials → 30100;仅 SUPER_ADMIN 短路通过。
//
// **凭证安全边界**(L3 红线):
//   - response **永不**包含 secretId / secretKey / *Encrypted / credentials
//   - RealnameVerificationSettings 变更不写 audit_logs(沿 L-3 挂起;pino 日志仅记 user.id + 动作)

@ApiTags('Ops - Realname Settings')
@ApiBearerAuth()
@ApiExtraModels(RealnameSettingsResponseDto)
@Controller('system/v1/realname-settings')
export class RealnameSettingsController {
  constructor(private readonly service: RealnameSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      '读 Realname Verification Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: realname-setting.read.singleton]',
  })
  @ApiWrappedOkResponse(RealnameSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<RealnameSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新实名核验设置(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;成功后 invalidate cache) [rbac: realname-setting.update.singleton]',
  })
  @ApiWrappedOkResponse(RealnameSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  update(
    @Body() dto: UpdateRealnameSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<RealnameSettingsResponseDto> {
    return this.service.updateSettings(dto, user);
  }

  @Post('reset-credentials')
  @ApiOperation({
    summary:
      '重置腾讯云实名核验 secretId/secretKey(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;两段 AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=TENCENT_CLOUD;成功后 invalidate cache) [rbac: realname-setting.reset.credentials]',
  })
  @ApiWrappedOkResponse(RealnameSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetRealnameCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<RealnameSettingsResponseDto> {
    return this.service.resetCredentials(dto, user);
  }
}

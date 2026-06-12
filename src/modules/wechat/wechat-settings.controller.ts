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
  ResetWechatCredentialsDto,
  UpdateWechatSettingsDto,
  WechatSettingsResponseDto,
} from './wechat.dto';
import { WechatSettingsService } from './wechat-settings.service';

// 微信小程序登录 T2(2026-06-12):Wechat Settings admin Controller(评审稿 §3.2 ①-③;
// 路径动词镜像 sms-settings 现状 = GET / PATCH / POST reset-credentials)
//
// **权限标注**(镜像 sms-settings 范式):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 Service 内 `rbac.can()`,
// 失败抛 RBAC_FORBIDDEN(30100)。seed 新增 3 条权限点:
// wechat-setting.read.singleton / .update.singleton / .reset.credentials。
// `wechat-setting.reset.credentials` 不绑 ops-admin(评审稿 §3.4,镜像 storage/sms D2=A):
// ADMIN+ops-admin 调 reset-credentials → 30100;仅 SUPER_ADMIN 短路通过。
//
// **凭证安全边界**(L3 红线):
//   - response **永不**包含 appSecret / appSecretEncrypted / credentials
//   - WechatSettings 变更不写 audit_logs(沿 L-3 挂起,评审稿 E-7);pino 日志仅记 user.id + 动作

@ApiTags('Ops - WeChat Settings')
@ApiBearerAuth()
@ApiExtraModels(WechatSettingsResponseDto)
@Controller('system/v1/wechat-settings')
export class WechatSettingsController {
  constructor(private readonly service: WechatSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      '读 WeChat Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: wechat-setting.read.singleton]',
  })
  @ApiWrappedOkResponse(WechatSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<WechatSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新 WeChat Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;成功后 invalidate cache) [rbac: wechat-setting.update.singleton]',
  })
  @ApiWrappedOkResponse(WechatSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  update(
    @Body() dto: UpdateWechatSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<WechatSettingsResponseDto> {
    return this.service.updateSettings(dto, user);
  }

  @Post('reset-credentials')
  @ApiOperation({
    summary:
      '重置微信小程序 AppSecret(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=WECHAT;成功后 invalidate cache) [rbac: wechat-setting.reset.credentials]',
  })
  @ApiWrappedOkResponse(WechatSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetWechatCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<WechatSettingsResponseDto> {
    return this.service.resetCredentials(dto, user);
  }
}

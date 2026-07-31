import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedNullableResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ResetWecomCredentialsDto,
  UpdateWecomSettingsDto,
  WecomSettingsResponseDto,
  WecomTestConnectionResponseDto,
} from './wecom.dto';
import { WecomService } from './wecom.service';
import { WecomSettingsService } from './wecom-settings.service';

// 企业微信接入 T2(2026-08-01):WeCom Settings admin Controller(冻结稿 §6.1;
// 路径动词镜像 wechat-settings / sms-settings 现状 = GET / PATCH / POST reset-credentials,
// 另加本批特有的 POST test-connection)
//
// **权限标注**(镜像 wechat-settings 范式):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 Service 内 `rbac.can()`,
// 失败抛 RBAC_FORBIDDEN(30100)。seed 新增 4 条权限点:
// wecom-setting.read.singleton / .update.singleton / .test.connection / .reset.credentials。
// `wecom-setting.reset.credentials` **不绑 ops-admin**(冻结稿 §11.1,镜像 storage/sms/wechat D2=A):
// ADMIN+ops-admin 调 reset-credentials → 30100;仅 SUPER_ADMIN 短路通过。
//
// **凭证安全边界**(§5.5 L3 红线):
//   - response **永不**包含 corpSecret / corpSecretEncrypted / access token / configurationGeneration
//   - corpId 只回显**掩码**(corpIdMasked)
//   - update 写 in-tx audit 且只记 changedFields;reset 的 audit 不含任何凭证字段名或值
//   - test-connection **不写 audit**(只读诊断)

@ApiTags('Ops - WeCom Settings')
@ApiBearerAuth()
@ApiExtraModels(WecomSettingsResponseDto, WecomTestConnectionResponseDto)
@Controller('system/v1/wecom-settings')
export class WecomSettingsController {
  constructor(
    private readonly service: WecomSettingsService,
    private readonly wecom: WecomService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      '读 WeCom Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证,corpId 仅掩码) [rbac: wecom-setting.read.singleton]',
  })
  @ApiWrappedNullableResponse(WecomSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<WecomSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新 WeCom Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;loginEnabled/messageEnabled=true 必须 enabled=true;webBaseUrl 仅 origin 且 production 必须 HTTPS;corpId 仅在 active identity=0 时可改否则 36020;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: wecom-setting.update.singleton]',
  })
  @ApiWrappedOkResponse(WecomSettingsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.WECOM_CORP_ID_IN_USE,
  )
  update(
    @Body() dto: UpdateWecomSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<WecomSettingsResponseDto> {
    return this.service.updateSettings(dto, user, this.buildAuditMeta(req));
  }

  @Post('reset-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '重置企业微信 CorpSecret(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库,独立 WECOM_ENCRYPTION_KEY 与小程序不共域;响应不回显;audit 不含任何凭证字段名或值;不存在则 upsert 创建 default providerType=WECOM) [rbac: wecom-setting.reset.credentials]',
  })
  @ApiWrappedOkResponse(WecomSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetWecomCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<WecomSettingsResponseDto> {
    return this.service.resetCredentials(dto, user, this.buildAuditMeta(req));
  }

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '企业微信连接诊断(强制跳过 token 缓存取新 access_token → agent/get 核对 agentid 与 close;**不发消息、不读完整通讯录、不改身份**;可见范围**只返计数不返任何成员/部门/标签 ID**;只读诊断不写 audit;失败 36030/36031 且不回显上游 URL/token/Secret/完整 errmsg) [rbac: wecom-setting.test.connection]',
  })
  @ApiWrappedOkResponse(WecomTestConnectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.WECOM_API_FAILED,
  )
  testConnection(@CurrentUser() user: CurrentUserPayload): Promise<WecomTestConnectionResponseDto> {
    return this.wecom.testConnection(user);
  }

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}

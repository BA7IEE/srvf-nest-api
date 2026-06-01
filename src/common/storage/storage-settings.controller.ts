import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiBizErrorResponse, ApiWrappedOkResponse } from '../decorators/api-response.decorator';
import { CurrentUser, type CurrentUserPayload } from '../decorators/current-user.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import {
  ResetStorageCredentialsDto,
  StorageSettingsResponseDto,
  UpdateStorageSettingsDto,
} from './storage-settings.dto';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #11:Storage Settings admin Controller(沿评审 §6.5 / §6.6 + Q-11 拍板)
//
// 3 个端点(沿 Q-11-1 / Q-11-13):
//   GET   /api/v2/storage-settings                    读 singleton row(不存在返 data=null)
//   PATCH /api/v2/storage-settings                    upsert(不存在则创建 default;沿 Q-11-17)
//   POST  /api/v2/storage-settings/reset-credentials  AES-256-GCM 加密 SecretId/SecretKey 落库
//
// **权限标注**(P0-F PR-2B,2026-05-18;撤销 PR #11 "不接 rbac.can()" 锁):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权迁移到 Service 内 `rbac.can()`,
// 失败抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-2A 范本。
// 映射 seed 新增 3 条权限点:storage-setting.read.singleton / .update.singleton / .reset.credentials。
// **D2=A**:`storage-setting.reset.credentials` 不绑 `ops-admin`;ADMIN+ops-admin 调 reset-credentials
// → 30100;仅 SUPER_ADMIN 短路通过(沿 readiness-plan §3.1 凭证 SA-only 暗示)。
//
// **凭证安全边界**(沿 §6.6.2 / §6.6.5):
//   - response **永不**包含 secretId / secretKey / secretIdEncrypted / secretKeyEncrypted / credentials
//   - 0 audit_logs(沿 §6.6.5);pino 日志仅记 user.id + reset 动作,不含 secret 明文 / 密文

@ApiTags('Ops - Storage Settings')
@ApiBearerAuth()
@ApiExtraModels(StorageSettingsResponseDto)
@Controller(['v2/storage-settings', 'system/v1/storage-settings'])
export class StorageSettingsController {
  constructor(private readonly service: StorageSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      '读 Storage Settings singleton row(沿 Q-11-1:不存在返 data=null;不抛 BizCode;不回显凭证)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<StorageSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新 Storage Settings(沿 Q-11-1 + Q-11-17:不存在则创建 default;providerType 缺省 LOCAL;**拒绝**任何凭证字段;成功后 invalidate cache)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  update(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.updateSettings(dto, user);
  }

  @Post('reset-credentials')
  @ApiOperation({
    summary:
      '重置 SecretId / SecretKey(沿 §6.6.2 / Q-11-1 / Q-11-5 + P0-F PR-2B D2=A:**仅 SUPER_ADMIN 短路通过**;ADMIN+ops-admin 调用 → 30100;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=COS;成功后 invalidate cache)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetStorageCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.resetCredentials(dto, user);
  }
}

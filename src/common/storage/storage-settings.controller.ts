import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';

import { ApiBizErrorResponse, ApiWrappedOkResponse } from '../decorators/api-response.decorator';
import { CurrentUser, type CurrentUserPayload } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
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
// **权限标注**(沿 Q-11 拍板;评审 §16.1 PR #11):
//   全部使用 @Roles(Role.SUPER_ADMIN, Role.ADMIN);**不接 rbac.can()**
//   (storage_settings 是系统级配置,不为其单设 rbac.config.* 权限点;沿 D7-attachments F4 范式)
//
// **凭证安全边界**(沿 §6.6.2 / §6.6.5):
//   - response **永不**包含 secretId / secretKey / secretIdEncrypted / secretKeyEncrypted / credentials
//   - 0 audit_logs(沿 §6.6.5);pino 日志仅记 user.id + reset 动作,不含 secret 明文 / 密文
//   - 0 新 BizCode(沿 Q-11-4);DTO 校验走 40000 / 未登录 40100 / 角色不足 40300

@ApiTags('storage-settings')
@ApiBearerAuth()
@ApiExtraModels(StorageSettingsResponseDto)
@Controller('v2/storage-settings')
export class StorageSettingsController {
  constructor(private readonly service: StorageSettingsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '读 Storage Settings singleton row(沿 Q-11-1:不存在返 data=null;不抛 BizCode;不回显凭证)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  get(): Promise<StorageSettingsResponseDto | null> {
    return this.service.getForAdmin();
  }

  @Patch()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      'upsert 更新 Storage Settings(沿 Q-11-1 + Q-11-17:不存在则创建 default;providerType 缺省 LOCAL;**拒绝**任何凭证字段;成功后 invalidate cache)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  update(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.updateSettings(dto, user);
  }

  @Post('reset-credentials')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '重置 SecretId / SecretKey(沿 §6.6.2 / Q-11-1 / Q-11-5:只允许 replace;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=COS;成功后 invalidate cache)',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetStorageCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.resetCredentials(dto, user);
  }
}

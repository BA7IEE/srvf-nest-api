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
  ResetStorageCredentialsDto,
  StorageSettingsResponseDto,
  UpdateStorageSettingsDto,
} from './storage-settings.dto';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #11:Storage Settings admin Controller(沿评审 §6.5 / §6.6 + Q-11 拍板)
//
// 3 个端点(沿 Q-11-1 / Q-11-13):
//   GET   /api/system/v1/storage-settings                    读 singleton row(不存在返 data=null)
//   PATCH /api/system/v1/storage-settings                    upsert(不存在则创建 default;沿 Q-11-17)
//   POST  /api/system/v1/storage-settings/reset-credentials  AES-256-GCM 加密 SecretId/SecretKey 落库
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
//   - update/reset 均写 in-tx audit;update 只记 changedFields,reset context 不含任何凭证字段或值

@ApiTags('Ops - Storage Settings')
@ApiBearerAuth()
@ApiExtraModels(StorageSettingsResponseDto)
@Controller('system/v1/storage-settings')
export class StorageSettingsController {
  constructor(private readonly service: StorageSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      '读 Storage Settings singleton row(沿 Q-11-1:不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: storage-setting.read.singleton]',
  })
  @ApiWrappedNullableResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<StorageSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新 Storage Settings(沿 Q-11-1 + Q-11-17:不存在则创建 default;providerType 缺省 LOCAL;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: storage-setting.update.singleton]',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  update(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.updateSettings(dto, user, this.buildAuditMeta(req));
  }

  @Post('reset-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '重置 SecretId / SecretKey(沿 §6.6.2 / Q-11-1 / Q-11-5 + P0-F PR-2B D2=A:**仅 SUPER_ADMIN 短路通过**;ADMIN+ops-admin 调用 → 30100;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=COS;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: storage-setting.reset.credentials]',
  })
  @ApiWrappedOkResponse(StorageSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetStorageCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<StorageSettingsResponseDto> {
    return this.service.resetCredentials(dto, user, this.buildAuditMeta(req));
  }

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}

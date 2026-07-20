import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ResetSmsCredentialsDto, SmsSettingsResponseDto, UpdateSmsSettingsDto } from './sms.dto';
import { SmsSettingsService } from './sms-settings.service';

// SMS 基础设施 T2(2026-06-10):SMS Settings admin Controller(评审稿 §3.2 ①-③ / E-1;
// 路径动词镜像 storage-settings 现状 = GET / PATCH / POST reset-credentials)
//
// **权限标注**(镜像 storage-settings P0-F PR-2B 范式):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 Service 内 `rbac.can()`,
// 失败抛 RBAC_FORBIDDEN(30100)。seed 新增 3 条权限点:
// sms-setting.read.singleton / .update.singleton / .reset.credentials。
// `sms-setting.reset.credentials` 不绑 ops-admin(评审稿 E-3,镜像 storage D2=A):
// ADMIN+ops-admin 调 reset-credentials → 30100;仅 SUPER_ADMIN 短路通过。
//
// **凭证安全边界**(L3 红线):
//   - response **永不**包含 secretId / secretKey / secretIdEncrypted / secretKeyEncrypted / credentials
//   - update/reset 均写 in-tx audit;update 只记 changedFields,reset context 不含任何凭证字段或值

@ApiTags('Ops - SMS Settings')
@ApiBearerAuth()
@ApiExtraModels(SmsSettingsResponseDto)
@Controller('system/v1/sms-settings')
export class SmsSettingsController {
  constructor(private readonly service: SmsSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      '读 SMS Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: sms-setting.read.singleton]',
  })
  @ApiWrappedOkResponse(SmsSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  get(@CurrentUser() user: CurrentUserPayload): Promise<SmsSettingsResponseDto | null> {
    return this.service.getForAdmin(user);
  }

  @Patch()
  @ApiOperation({
    summary:
      'upsert 更新 SMS Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: sms-setting.update.singleton]',
  })
  @ApiWrappedOkResponse(SmsSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  update(
    @Body() dto: UpdateSmsSettingsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<SmsSettingsResponseDto> {
    return this.service.updateSettings(dto, user, this.buildAuditMeta(req));
  }

  @Post('reset-credentials')
  @ApiOperation({
    summary:
      '重置腾讯云 SecretId / SecretKey(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=TENCENT_SMS;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: sms-setting.reset.credentials]',
  })
  @ApiWrappedOkResponse(SmsSettingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  resetCredentials(
    @Body() dto: ResetSmsCredentialsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<SmsSettingsResponseDto> {
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

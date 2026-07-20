import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type SmsSettings as SmsSettingsRow } from '@prisma/client';

import appConfig, { isProductionLike } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { SmsCryptoDecryptError, SmsCryptoService } from './sms-crypto.service';
import type {
  ResetSmsCredentialsDto,
  SmsSettingsResponseDto,
  UpdateSmsSettingsDto,
} from './sms.dto';
import { SmsCredentialStatus, type SmsSettingsResolved } from './sms.types';

// SMS 基础设施 T2(2026-06-10):sms_settings 读取层 + admin CRUD(评审稿 E-14/E-15;
// 镜像 storage-settings.service 范式,差异点如下)
//
// 与 StorageSettingsService 的**拍板差异**:
// - **无 onApplicationBootstrap fail-fast**:SMS 是可选基础设施,production 未配置合法
//   (发送路径运行时返 SMS_CHANNEL_NOT_CONFIGURED=24030);仅 SMS_ENCRYPTION_KEY env
//   在 app.config 做 production/smoke 启动 fail-fast(D-SMS-8)
// - **production-like 禁 DEV_STUB**(E-15 第①重):updateSettings 收到 providerType=DEV_STUB
//   且 isProductionLike → 抛 BAD_REQUEST;第②重在 SmsProviderRouter.resolve(运行时)
// - PATCH upsert 缺省 providerType=DEV_STUB(联调通道);reset-credentials upsert 缺省
//   TENCENT_SMS(录凭证即意味着真实通道;镜像 storage Q-11-2 语义)
//
// 第七刀 #13:singleton 由第 49 migration 的 unique index on constant((true)) 在 DB 层强制;
// 并发首配由 P2002 后重跑同一事务映射到既有单行,不新增 BizCode。
// 凭证安全(L3 红线):response / 日志 / audit 永不含明文或密文;第六刀已补 update/reset
// in-tx audit(update 只记 changedFields;reset 不记任何凭证字段或值)。

@Injectable()
export class SmsSettingsService {
  private readonly logger = new Logger(SmsSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SmsCryptoService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // RBAC 判权(镜像 storage-settings 范式):失败统一 RBAC_FORBIDDEN(30100)。
  // `sms-setting.reset.credentials` 不绑 ops-admin(评审稿 E-3,镜像 storage D2=A),
  // SUPER_ADMIN 经 RbacService.can 短路通过。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  /**
   * 读取 PostgreSQL 当前生效配置(singleton row;每次调用直读)
   * - DB 空 → null(发送路径由调用方映射 24030)
   * - 第 49 migration 后 DB 层保证至多一条
   */
  async getActiveSettings(): Promise<SmsSettingsResolved | null> {
    const row = await this.prisma.smsSettings.findFirst();
    return row === null ? null : this.toResolved(row);
  }

  // ============ admin 三端点(评审稿 §3.2 ①-③) ============

  // GET /api/system/v1/sms-settings:不存在返 null(不抛码);永不回显凭证
  async getForAdmin(user: CurrentUserPayload): Promise<SmsSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'sms-setting.read.singleton');
    const row = await this.prisma.smsSettings.findFirst();
    return row === null ? null : this.toResponseDto(row);
  }

  // PATCH /api/system/v1/sms-settings:upsert;不存在创建 default(providerType=DEV_STUB);
  // production-like 拒绝 DEV_STUB(E-15 第①重);拒绝凭证字段由 DTO 白名单兜底
  async updateSettings(
    dto: UpdateSmsSettingsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SmsSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'sms-setting.update.singleton');
    const data = this.buildUpdateData(dto);
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort();

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.smsSettings.findFirst({
        select: { id: true, providerType: true },
      });

      // E-15 第①重:production-like 禁 DEV_STUB(显式传入或"不存在则建 default"两条路径都拦)
      const effectiveProviderType = dto.providerType ?? existing?.providerType ?? 'DEV_STUB';
      if (isProductionLike(this.cfg.env) && effectiveProviderType === 'DEV_STUB') {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      let updated: SmsSettingsRow;
      if (existing) {
        updated = await tx.smsSettings.update({
          where: { id: existing.id },
          data: { ...data, updatedBy: user.id },
        });
      } else {
        updated = await tx.smsSettings.create({
          data: {
            ...(data as Prisma.SmsSettingsCreateInput),
            providerType: dto.providerType ?? 'DEV_STUB',
            updatedBy: user.id,
          },
        });
      }

      await this.auditLogs.log({
        event: 'sms-setting.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'sms_setting',
        resourceId: updated.id,
        meta: auditMeta,
        extra: { changedFields },
        tx,
      });
      return updated;
    });

    return this.toResponseDto(row);
  }

  // POST /api/system/v1/sms-settings/reset-credentials:仅 SUPER_ADMIN 短路(码不绑 ops-admin);
  // AES-256-GCM 加密落库;不存在则 upsert 创建 default providerType=TENCENT_SMS;响应不回显
  async resetCredentials(
    dto: ResetSmsCredentialsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SmsSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'sms-setting.reset.credentials');
    // SMS_ENCRYPTION_KEY 缺失(dev/test 留空)时抛 SmsCryptoUnavailableError → 全局过滤器 500
    const secretIdEncrypted = this.crypto.encrypt(dto.secretId);
    const secretKeyEncrypted = this.crypto.encrypt(dto.secretKey);

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.smsSettings.findFirst({
        select: { id: true },
      });

      let updated: SmsSettingsRow;
      if (existing) {
        updated = await tx.smsSettings.update({
          where: { id: existing.id },
          data: {
            secretIdEncrypted,
            secretKeyEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      } else {
        // 录凭证即意味着真实通道:default TENCENT_SMS(镜像 storage reset 默认 COS 语义)
        updated = await tx.smsSettings.create({
          data: {
            providerType: 'TENCENT_SMS',
            secretIdEncrypted,
            secretKeyEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      }

      // 最硬红线:reset audit 只保留 actor / row.id / AuditMeta;不传 before/after/extra。
      await this.auditLogs.log({
        event: 'sms-setting.reset-credentials',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'sms_setting',
        resourceId: updated.id,
        meta: auditMeta,
        tx,
      });
      return updated;
    });

    // 仅 pino 日志记动作 + actorUserId;不含 secret 明文 / 密文(L3 红线)
    this.logger.log(`sms_settings credentials reset by user.id=${user.id}; row.id=${row.id}`);

    return this.toResponseDto(row);
  }

  // === helpers ===

  private async runSingletonWriteWithUniqueRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const execute = () => this.prisma.$transaction(operation);
    try {
      return await execute();
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      return execute();
    }
  }

  private buildUpdateData(dto: UpdateSmsSettingsDto): Prisma.SmsSettingsUpdateInput {
    const data: Prisma.SmsSettingsUpdateInput = {};
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.sdkAppId !== undefined) data.sdkAppId = dto.sdkAppId;
    if (dto.signName !== undefined) data.signName = dto.signName;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.templateIdVerifyCode !== undefined)
      data.templateIdVerifyCode = dto.templateIdVerifyCode;
    if (dto.templateIdBirthday !== undefined) data.templateIdBirthday = dto.templateIdBirthday;
    if (dto.templateIdNotification !== undefined)
      data.templateIdNotification = dto.templateIdNotification;
    if (dto.remarks !== undefined) data.remarks = dto.remarks;
    return data;
  }

  private toResolved(row: SmsSettingsRow): SmsSettingsResolved {
    const { credentials, credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      sdkAppId: row.sdkAppId,
      signName: row.signName,
      region: row.region,
      templateIdVerifyCode: row.templateIdVerifyCode,
      templateIdBirthday: row.templateIdBirthday,
      templateIdNotification: row.templateIdNotification,
      credentials,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }

  // 三档状态合成(镜像 storage §6.6.3 语义)
  private resolveCredentials(row: SmsSettingsRow): {
    credentials: { secretId: string; secretKey: string } | null;
    credentialStatus: SmsCredentialStatus;
  } {
    if (!row.credentialConfigured) {
      return { credentials: null, credentialStatus: SmsCredentialStatus.MISSING };
    }
    if (row.secretIdEncrypted === null || row.secretKeyEncrypted === null) {
      this.logger.warn(
        `sms_settings.credentialConfigured=true but encrypted columns are null (id=${row.id}); treating as MISSING`,
      );
      return { credentials: null, credentialStatus: SmsCredentialStatus.MISSING };
    }
    try {
      const secretId = this.crypto.decrypt(row.secretIdEncrypted);
      const secretKey = this.crypto.decrypt(row.secretKeyEncrypted);
      return {
        credentials: { secretId, secretKey },
        credentialStatus: SmsCredentialStatus.CONFIGURED,
      };
    } catch (err) {
      if (err instanceof SmsCryptoDecryptError) {
        this.logger.warn(
          `sms_settings credentials decrypt failed (id=${row.id}): ${err.message}; key rotated or ciphertext tampered`,
        );
        return { credentials: null, credentialStatus: SmsCredentialStatus.INVALID };
      }
      // SmsCryptoUnavailableError 或其他 → 同样视作 INVALID(防御;不抛)
      this.logger.warn(
        `sms_settings credentials decrypt threw unexpected error (id=${row.id}): ${(err as Error).message}`,
      );
      return { credentials: null, credentialStatus: SmsCredentialStatus.INVALID };
    }
  }

  // Prisma row → ResponseDto(出参不含 secretIdEncrypted / secretKeyEncrypted / credentials)
  private toResponseDto(row: SmsSettingsRow): SmsSettingsResponseDto {
    const { credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      sdkAppId: row.sdkAppId,
      signName: row.signName,
      region: row.region,
      templateIdVerifyCode: row.templateIdVerifyCode,
      templateIdBirthday: row.templateIdBirthday,
      templateIdNotification: row.templateIdNotification,
      credentialStatus,
      credentialConfigured: row.credentialConfigured,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}

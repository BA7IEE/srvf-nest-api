import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type SmsSettings as SmsSettingsRow } from '@prisma/client';

import appConfig, { isProductionLike } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
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
// singleton 不在 DB 层强制(镜像 storage Q-87-2):>1 行 WARN + 取 createdAt 最早。
// 凭证安全(L3 红线):response / 日志 / audit 永不含明文或密文;SmsSettings 变更
// **不写 audit_logs**(沿 L-3 挂起,D-SMS-9)。

const CACHE_TTL_MS = 60_000;

@Injectable()
export class SmsSettingsService {
  private readonly logger = new Logger(SmsSettingsService.name);

  private cache: {
    resolved: SmsSettingsResolved | null;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SmsCryptoService,
    private readonly rbac: RbacService,
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
   * 读取当前生效配置(singleton row;60s 缓存)
   * - DB 空 → null(发送路径由调用方映射 24030)
   * - DB > 1 条 → WARN + 取 createdAt 最早
   */
  async getActiveSettings(): Promise<SmsSettingsResolved | null> {
    if (this.cache !== null && this.cache.expiresAt > Date.now()) {
      return this.cache.resolved;
    }

    const rows = await this.prisma.smsSettings.findMany({
      orderBy: { createdAt: 'asc' },
      take: 2, // 只取 2 条即可判断是否违反 singleton
    });

    if (rows.length === 0) {
      this.setCache(null);
      return null;
    }

    if (rows.length > 1) {
      this.logger.warn(
        `sms_settings singleton violated: found ${rows.length}+ rows; using earliest (createdAt=${rows[0].createdAt.toISOString()})`,
      );
    }

    const resolved = this.toResolved(rows[0]);
    this.setCache(resolved);
    return resolved;
  }

  /** 主动失效缓存(PATCH / reset-credentials 写后调用) */
  invalidate(): void {
    this.cache = null;
  }

  // ============ admin 三端点(评审稿 §3.2 ①-③) ============

  // GET /api/system/v1/sms-settings:不存在返 null(不抛码);永不回显凭证
  async getForAdmin(user: CurrentUserPayload): Promise<SmsSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'sms-setting.read.singleton');
    const rows = await this.prisma.smsSettings.findMany({
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      this.logger.warn(
        `sms_settings singleton violated: found ${rows.length}+ rows; returning earliest (id=${rows[0].id})`,
      );
    }
    return this.toResponseDto(rows[0]);
  }

  // PATCH /api/system/v1/sms-settings:upsert;不存在创建 default(providerType=DEV_STUB);
  // production-like 拒绝 DEV_STUB(E-15 第①重);拒绝凭证字段由 DTO 白名单兜底
  async updateSettings(
    dto: UpdateSmsSettingsDto,
    user: CurrentUserPayload,
  ): Promise<SmsSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'sms-setting.update.singleton');

    const existing = await this.prisma.smsSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerType: true },
    });

    // E-15 第①重:production-like 禁 DEV_STUB(显式传入或"不存在则建 default"两条路径都拦)
    const effectiveProviderType = dto.providerType ?? existing?.providerType ?? 'DEV_STUB';
    if (isProductionLike(this.cfg.env) && effectiveProviderType === 'DEV_STUB') {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    const data = this.buildUpdateData(dto);

    let row: SmsSettingsRow;
    if (existing) {
      row = await this.prisma.smsSettings.update({
        where: { id: existing.id },
        data: { ...data, updatedBy: user.id },
      });
    } else {
      row = await this.prisma.smsSettings.create({
        data: {
          ...(data as Prisma.SmsSettingsCreateInput),
          providerType: dto.providerType ?? 'DEV_STUB',
          updatedBy: user.id,
        },
      });
    }

    this.invalidate();
    return this.toResponseDto(row);
  }

  // POST /api/system/v1/sms-settings/reset-credentials:仅 SUPER_ADMIN 短路(码不绑 ops-admin);
  // AES-256-GCM 加密落库;不存在则 upsert 创建 default providerType=TENCENT_SMS;响应不回显
  async resetCredentials(
    dto: ResetSmsCredentialsDto,
    user: CurrentUserPayload,
  ): Promise<SmsSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'sms-setting.reset.credentials');
    // SMS_ENCRYPTION_KEY 缺失(dev/test 留空)时抛 SmsCryptoUnavailableError → 全局过滤器 500
    const secretIdEncrypted = this.crypto.encrypt(dto.secretId);
    const secretKeyEncrypted = this.crypto.encrypt(dto.secretKey);

    const existing = await this.prisma.smsSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    let row: SmsSettingsRow;
    if (existing) {
      row = await this.prisma.smsSettings.update({
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
      row = await this.prisma.smsSettings.create({
        data: {
          providerType: 'TENCENT_SMS',
          secretIdEncrypted,
          secretKeyEncrypted,
          credentialConfigured: true,
          updatedBy: user.id,
        },
      });
    }

    // 仅 pino 日志记动作 + actorUserId;不含 secret 明文 / 密文(L3 红线)
    this.logger.log(`sms_settings credentials reset by user.id=${user.id}; row.id=${row.id}`);

    this.invalidate();
    return this.toResponseDto(row);
  }

  // === helpers ===

  private setCache(resolved: SmsSettingsResolved | null): void {
    this.cache = { resolved, expiresAt: Date.now() + CACHE_TTL_MS };
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
      credentialStatus,
      credentialConfigured: row.credentialConfigured,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}

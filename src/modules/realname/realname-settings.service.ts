import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type RealnameVerificationSettings as RealnameSettingsRow } from '@prisma/client';

import appConfig, { isProductionLike } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { RbacService } from '../permissions/rbac.service';
import { RealnameCryptoDecryptError, RealnameCryptoService } from './realname-crypto.service';
import type {
  ResetRealnameCredentialsDto,
  RealnameSettingsResponseDto,
  UpdateRealnameSettingsDto,
} from './realname.dto';
import { RealnameCredentialStatus, type RealnameSettingsResolved } from './realname.types';

// 招新一期 · 实名核验通道 T2(2026-06-18):realname_verification_settings 读取层 + admin CRUD
// (评审稿 §3.2/E-R-2;镜像 wechat-settings.service / sms-settings.service 范式)
//
// 与 WechatSettingsService 的差异:
// - 凭证**两段** secretId + secretKey 加密(同 SMS;wechat 是单段 appSecret,E-R-3)
// - region 替 appId(腾讯云运行参数,非 secret)
// - reset-credentials upsert 缺省 TENCENT_CLOUD(录凭证即意味着真实通道;镜像 sms/wechat 语义)
//
// 共性(沿 wechat/sms):60s 内存缓存(单实例前提)+ singleton 不在 DB 层强制(>1 行 WARN + 取
// createdAt 最早)+ production-like 禁 DEV_STUB(写入口第①重,运行时第②重在 RealnameVerificationService)。
// 凭证安全(L3 红线):response / 日志 / audit 永不含 secretId / secretKey 明文或密文;
// RealnameVerificationSettings 变更**不写 audit_logs**(沿 L-3 挂起,镜像 wechat E-7)。

const CACHE_TTL_MS = 60_000;

@Injectable()
export class RealnameSettingsService {
  private readonly logger = new Logger(RealnameSettingsService.name);

  private cache: {
    resolved: RealnameSettingsResolved | null;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: RealnameCryptoService,
    private readonly rbac: RbacService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // RBAC 判权(镜像 wechat/sms-settings 范式):失败统一 RBAC_FORBIDDEN(30100)。
  // `realname-setting.reset.credentials` 不绑 ops-admin(评审稿 E-R-19,镜像 storage/sms/wechat D2=A),
  // SUPER_ADMIN 经 RbacService.can 短路通过。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  /**
   * 读取当前生效配置(singleton row;60s 缓存,单实例部署前提)
   * - DB 空 → null(调用路径由 RealnameVerificationService 映射 27030)
   * - DB > 1 条 → WARN + 取 createdAt 最早
   */
  async getActiveSettings(): Promise<RealnameSettingsResolved | null> {
    if (this.cache !== null && this.cache.expiresAt > Date.now()) {
      return this.cache.resolved;
    }

    const rows = await this.prisma.realnameVerificationSettings.findMany({
      orderBy: { createdAt: 'asc' },
      take: 2, // 只取 2 条即可判断是否违反 singleton
    });

    if (rows.length === 0) {
      this.setCache(null);
      return null;
    }

    if (rows.length > 1) {
      this.logger.warn(
        `realname_verification_settings singleton violated: found ${rows.length}+ rows; using earliest (createdAt=${rows[0].createdAt.toISOString()})`,
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

  // GET /api/system/v1/realname-settings:不存在返 null(不抛码);永不回显凭证
  async getForAdmin(user: CurrentUserPayload): Promise<RealnameSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'realname-setting.read.singleton');
    const rows = await this.prisma.realnameVerificationSettings.findMany({
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      this.logger.warn(
        `realname_verification_settings singleton violated: found ${rows.length}+ rows; returning earliest (id=${rows[0].id})`,
      );
    }
    return this.toResponseDto(rows[0]);
  }

  // PATCH /api/system/v1/realname-settings:upsert;不存在创建 default(providerType=DEV_STUB);
  // production-like 拒绝 DEV_STUB(镜像 wechat E-6 第①重);拒绝凭证字段由 DTO 白名单兜底
  async updateSettings(
    dto: UpdateRealnameSettingsDto,
    user: CurrentUserPayload,
  ): Promise<RealnameSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'realname-setting.update.singleton');

    const existing = await this.prisma.realnameVerificationSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerType: true },
    });

    // production-like 禁 DEV_STUB(显式传入或"不存在则建 default"两条路径都拦)
    const effectiveProviderType = dto.providerType ?? existing?.providerType ?? 'DEV_STUB';
    if (isProductionLike(this.cfg.env) && effectiveProviderType === 'DEV_STUB') {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    const data = this.buildUpdateData(dto);

    let row: RealnameSettingsRow;
    if (existing) {
      row = await this.prisma.realnameVerificationSettings.update({
        where: { id: existing.id },
        data: { ...data, updatedBy: user.id },
      });
    } else {
      row = await this.prisma.realnameVerificationSettings.create({
        data: {
          ...(data as Prisma.RealnameVerificationSettingsCreateInput),
          providerType: dto.providerType ?? 'DEV_STUB',
          updatedBy: user.id,
        },
      });
    }

    this.invalidate();
    return this.toResponseDto(row);
  }

  // POST /api/system/v1/realname-settings/reset-credentials:仅 SUPER_ADMIN 短路(码不绑 ops-admin);
  // secretId + secretKey 两段 AES-256-GCM 加密落库;不存在则 upsert 创建 default providerType=TENCENT_CLOUD;响应不回显
  async resetCredentials(
    dto: ResetRealnameCredentialsDto,
    user: CurrentUserPayload,
  ): Promise<RealnameSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'realname-setting.reset.credentials');
    // REALNAME_ENCRYPTION_KEY 缺失(dev/test 留空)时抛 RealnameCryptoUnavailableError → 全局过滤器 500
    const secretIdEncrypted = this.crypto.encrypt(dto.secretId);
    const secretKeyEncrypted = this.crypto.encrypt(dto.secretKey);

    const existing = await this.prisma.realnameVerificationSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    let row: RealnameSettingsRow;
    if (existing) {
      row = await this.prisma.realnameVerificationSettings.update({
        where: { id: existing.id },
        data: {
          secretIdEncrypted,
          secretKeyEncrypted,
          credentialConfigured: true,
          updatedBy: user.id,
        },
      });
    } else {
      // 录凭证即意味着真实通道:default TENCENT_CLOUD(镜像 wechat reset 默认 WECHAT 语义)
      row = await this.prisma.realnameVerificationSettings.create({
        data: {
          providerType: 'TENCENT_CLOUD',
          secretIdEncrypted,
          secretKeyEncrypted,
          credentialConfigured: true,
          updatedBy: user.id,
        },
      });
    }

    // 仅 pino 日志记动作 + actorUserId;不含 secretId / secretKey 明文 / 密文(L3 红线)
    this.logger.log(
      `realname_verification_settings credentials reset by user.id=${user.id}; row.id=${row.id}`,
    );

    this.invalidate();
    return this.toResponseDto(row);
  }

  // === helpers ===

  private setCache(resolved: RealnameSettingsResolved | null): void {
    this.cache = { resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  }

  private buildUpdateData(
    dto: UpdateRealnameSettingsDto,
  ): Prisma.RealnameVerificationSettingsUpdateInput {
    const data: Prisma.RealnameVerificationSettingsUpdateInput = {};
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.remarks !== undefined) data.remarks = dto.remarks;
    return data;
  }

  private toResolved(row: RealnameSettingsRow): RealnameSettingsResolved {
    const { credentials, credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      region: row.region,
      credentials,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }

  // 三档状态合成(镜像 wechat/sms resolveCredentials 语义;两段密文均须成功解密才 CONFIGURED)
  private resolveCredentials(row: RealnameSettingsRow): {
    credentials: { secretId: string; secretKey: string } | null;
    credentialStatus: RealnameCredentialStatus;
  } {
    if (!row.credentialConfigured) {
      return { credentials: null, credentialStatus: RealnameCredentialStatus.MISSING };
    }
    if (row.secretIdEncrypted === null || row.secretKeyEncrypted === null) {
      this.logger.warn(
        `realname_verification_settings.credentialConfigured=true but secretId/secretKey ciphertext is null (id=${row.id}); treating as MISSING`,
      );
      return { credentials: null, credentialStatus: RealnameCredentialStatus.MISSING };
    }
    try {
      const secretId = this.crypto.decrypt(row.secretIdEncrypted);
      const secretKey = this.crypto.decrypt(row.secretKeyEncrypted);
      return {
        credentials: { secretId, secretKey },
        credentialStatus: RealnameCredentialStatus.CONFIGURED,
      };
    } catch (err) {
      if (err instanceof RealnameCryptoDecryptError) {
        this.logger.warn(
          `realname_verification_settings credentials decrypt failed (id=${row.id}): ${err.message}; key rotated or ciphertext tampered`,
        );
        return { credentials: null, credentialStatus: RealnameCredentialStatus.INVALID };
      }
      // RealnameCryptoUnavailableError 或其他 → 同样视作 INVALID(防御;不抛)
      this.logger.warn(
        `realname_verification_settings credentials decrypt threw unexpected error (id=${row.id}): ${(err as Error).message}`,
      );
      return { credentials: null, credentialStatus: RealnameCredentialStatus.INVALID };
    }
  }

  // Prisma row → ResponseDto(出参不含 secretId/secretKey 密文 / credentials)
  private toResponseDto(row: RealnameSettingsRow): RealnameSettingsResponseDto {
    const { credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      region: row.region,
      credentialStatus,
      credentialConfigured: row.credentialConfigured,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}

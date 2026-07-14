import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type WechatSettings as WechatSettingsRow } from '@prisma/client';

import appConfig, { isProductionLike } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { WechatCryptoDecryptError, WechatCryptoService } from './wechat-crypto.service';
import type {
  ResetWechatCredentialsDto,
  UpdateWechatSettingsDto,
  WechatSettingsResponseDto,
} from './wechat.dto';
import { WechatCredentialStatus, type WechatSettingsResolved } from './wechat.types';

// 微信小程序登录 T2(2026-06-12):wechat_settings 读取层 + admin CRUD(评审稿 E-6/E-7/E-27;
// 镜像 sms-settings.service 范式,与 SmsSettingsService 的差异:
// - 凭证仅 appSecret **一段**加密(SMS 是 secretId + secretKey 两段,E-3)
// - 无 onApplicationBootstrap fail-fast(同 SMS:可选基础设施,production 未配置合法,
//   调用路径运行时返 WECHAT_CHANNEL_NOT_CONFIGURED=25030;仅 WECHAT_ENCRYPTION_KEY env
//   在 app.config 做 production/smoke 启动 fail-fast,E-5)
// - production-like 禁 DEV_STUB(镜像 E-15 第①重):updateSettings 收到 providerType=DEV_STUB
//   且 isProductionLike → 抛 BAD_REQUEST;第②重在 WechatService.resolve(运行时)
// - PATCH upsert 缺省 providerType=DEV_STUB(联调通道);reset-credentials upsert 缺省
//   WECHAT(录凭证即意味着真实通道;镜像 sms reset 默认 TENCENT_SMS 语义)
//
// 第七刀 #13:singleton 由第 49 migration 的 unique index on constant((true)) 在 DB 层强制;
// 并发首配由 P2002 后重跑同一事务映射到既有单行,不新增 BizCode。
// 凭证安全(L3 红线):response / 日志 / audit 永不含 appSecret 明文或密文;第六刀已补
// update/reset in-tx audit(update 只记 changedFields;reset 不记任何凭证字段或值)。

const CACHE_TTL_MS = 60_000;

@Injectable()
export class WechatSettingsService {
  private readonly logger = new Logger(WechatSettingsService.name);

  private cache: {
    resolved: WechatSettingsResolved | null;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: WechatCryptoService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // RBAC 判权(镜像 sms-settings 范式):失败统一 RBAC_FORBIDDEN(30100)。
  // `wechat-setting.reset.credentials` 不绑 ops-admin(评审稿 §3.4,镜像 storage/sms D2=A),
  // SUPER_ADMIN 经 RbacService.can 短路通过。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  /**
   * 读取当前生效配置(singleton row;60s 缓存,E-27 单实例部署前提)
   * - DB 空 → null(调用路径由 WechatService 映射 25030)
   * - 第 49 migration 后 DB 层保证至多一条
   */
  async getActiveSettings(): Promise<WechatSettingsResolved | null> {
    if (this.cache !== null && this.cache.expiresAt > Date.now()) {
      return this.cache.resolved;
    }

    const row = await this.prisma.wechatSettings.findFirst();

    if (row === null) {
      this.setCache(null);
      return null;
    }

    const resolved = this.toResolved(row);
    this.setCache(resolved);
    return resolved;
  }

  /** 主动失效缓存(PATCH / reset-credentials 写后调用) */
  invalidate(): void {
    this.cache = null;
  }

  // ============ admin 三端点(评审稿 §3.2 ①-③) ============

  // GET /api/system/v1/wechat-settings:不存在返 null(不抛码);永不回显凭证
  async getForAdmin(user: CurrentUserPayload): Promise<WechatSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'wechat-setting.read.singleton');
    const row = await this.prisma.wechatSettings.findFirst();
    return row === null ? null : this.toResponseDto(row);
  }

  // PATCH /api/system/v1/wechat-settings:upsert;不存在创建 default(providerType=DEV_STUB);
  // production-like 拒绝 DEV_STUB(镜像 E-15 第①重);拒绝凭证字段由 DTO 白名单兜底
  async updateSettings(
    dto: UpdateWechatSettingsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<WechatSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'wechat-setting.update.singleton');
    const data = this.buildUpdateData(dto);
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort();

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.wechatSettings.findFirst({
        select: { id: true, providerType: true },
      });

      // production-like 禁 DEV_STUB(显式传入或"不存在则建 default"两条路径都拦)
      const effectiveProviderType = dto.providerType ?? existing?.providerType ?? 'DEV_STUB';
      if (isProductionLike(this.cfg.env) && effectiveProviderType === 'DEV_STUB') {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      let updated: WechatSettingsRow;
      if (existing) {
        updated = await tx.wechatSettings.update({
          where: { id: existing.id },
          data: { ...data, updatedBy: user.id },
        });
      } else {
        updated = await tx.wechatSettings.create({
          data: {
            ...(data as Prisma.WechatSettingsCreateInput),
            providerType: dto.providerType ?? 'DEV_STUB',
            updatedBy: user.id,
          },
        });
      }

      await this.auditLogs.log({
        event: 'wechat-setting.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'wechat_setting',
        resourceId: updated.id,
        meta: auditMeta,
        extra: { changedFields },
        tx,
      });
      return updated;
    });

    this.invalidate();
    return this.toResponseDto(row);
  }

  // POST /api/system/v1/wechat-settings/reset-credentials:仅 SUPER_ADMIN 短路(码不绑 ops-admin);
  // appSecret AES-256-GCM 加密落库;不存在则 upsert 创建 default providerType=WECHAT;响应不回显
  async resetCredentials(
    dto: ResetWechatCredentialsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<WechatSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'wechat-setting.reset.credentials');
    // WECHAT_ENCRYPTION_KEY 缺失(dev/test 留空)时抛 WechatCryptoUnavailableError → 全局过滤器 500
    const appSecretEncrypted = this.crypto.encrypt(dto.appSecret);

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.wechatSettings.findFirst({
        select: { id: true },
      });

      let updated: WechatSettingsRow;
      if (existing) {
        updated = await tx.wechatSettings.update({
          where: { id: existing.id },
          data: {
            appSecretEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      } else {
        // 录凭证即意味着真实通道:default WECHAT(镜像 sms reset 默认 TENCENT_SMS 语义)
        updated = await tx.wechatSettings.create({
          data: {
            providerType: 'WECHAT',
            appSecretEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      }

      // 最硬红线:reset audit 只保留 actor / row.id / AuditMeta;不传 before/after/extra。
      await this.auditLogs.log({
        event: 'wechat-setting.reset-credentials',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'wechat_setting',
        resourceId: updated.id,
        meta: auditMeta,
        tx,
      });
      return updated;
    });

    // 仅 pino 日志记动作 + actorUserId;不含 appSecret 明文 / 密文(L3 红线)
    this.logger.log(`wechat_settings credentials reset by user.id=${user.id}; row.id=${row.id}`);

    this.invalidate();
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

  private setCache(resolved: WechatSettingsResolved | null): void {
    this.cache = { resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  }

  private buildUpdateData(dto: UpdateWechatSettingsDto): Prisma.WechatSettingsUpdateInput {
    const data: Prisma.WechatSettingsUpdateInput = {};
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.appId !== undefined) data.appId = dto.appId;
    if (dto.remarks !== undefined) data.remarks = dto.remarks;
    return data;
  }

  private toResolved(row: WechatSettingsRow): WechatSettingsResolved {
    const { credentials, credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      appId: row.appId,
      credentials,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }

  // 三档状态合成(镜像 sms resolveCredentials 语义;单段密文)
  private resolveCredentials(row: WechatSettingsRow): {
    credentials: { appSecret: string } | null;
    credentialStatus: WechatCredentialStatus;
  } {
    if (!row.credentialConfigured) {
      return { credentials: null, credentialStatus: WechatCredentialStatus.MISSING };
    }
    if (row.appSecretEncrypted === null) {
      this.logger.warn(
        `wechat_settings.credentialConfigured=true but appSecretEncrypted is null (id=${row.id}); treating as MISSING`,
      );
      return { credentials: null, credentialStatus: WechatCredentialStatus.MISSING };
    }
    try {
      const appSecret = this.crypto.decrypt(row.appSecretEncrypted);
      return {
        credentials: { appSecret },
        credentialStatus: WechatCredentialStatus.CONFIGURED,
      };
    } catch (err) {
      if (err instanceof WechatCryptoDecryptError) {
        this.logger.warn(
          `wechat_settings credentials decrypt failed (id=${row.id}): ${err.message}; key rotated or ciphertext tampered`,
        );
        return { credentials: null, credentialStatus: WechatCredentialStatus.INVALID };
      }
      // WechatCryptoUnavailableError 或其他 → 同样视作 INVALID(防御;不抛)
      this.logger.warn(
        `wechat_settings credentials decrypt threw unexpected error (id=${row.id}): ${(err as Error).message}`,
      );
      return { credentials: null, credentialStatus: WechatCredentialStatus.INVALID };
    }
  }

  // Prisma row → ResponseDto(出参不含 appSecretEncrypted / credentials)
  private toResponseDto(row: WechatSettingsRow): WechatSettingsResponseDto {
    const { credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      appId: row.appId,
      credentialStatus,
      credentialConfigured: row.credentialConfigured,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}

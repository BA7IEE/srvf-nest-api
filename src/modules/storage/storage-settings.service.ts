import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type StorageSettings as StorageSettingsRow } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { StorageCryptoDecryptError, StorageCryptoService } from './storage-crypto.service';
import type {
  ResetStorageCredentialsDto,
  StorageSettingsResponseDto,
  UpdateStorageSettingsDto,
} from './storage-settings.dto';
import { CredentialStatus, type StorageSettingsResolved } from './storage-settings.types';

// V2.x C-7.5 Provider 选型实施 PR #6:storage_settings 读取层(沿 §6.5.5 + Q24 / Q25)
//
// 范围(PR #6):
// - getActiveSettings():每次直读 DB + 解密 + 合成 credentialStatus(沿 §6.5.5)
// - DB 空 → 返 null(沿 Q-87-3 拍板 B;bootstrap fallback 留 PR #11)
//
// 不在 PR #6 范围(沿 §16.1 PR #11):
// - POST 首次创建 singleton row + count() 守护
// - PATCH 改非凭证字段(提交后下一次调用直接读取新事实)
// - POST /reset-credentials 接收明文 + 加密落库
// - bootstrap fallback 从 env 兜底创建首条记录(沿 Q23 / Q-87-3)
//
// 第七刀 #13:singleton 由第 49 migration 的 unique index on constant((true)) 在 DB 层强制。
// 并发首配由 P2002 后重跑同一事务映射到既有单行,不新增 BizCode。

@Injectable()
export class StorageSettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: StorageCryptoService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // P0-F PR-2B(2026-05-18):RBAC 判权(沿 PR-2A 范本)。
  // 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);RbacService.can 内部
  // 已实现 SUPER_ADMIN 短路 + ownership(.self);本模块无 .self 后缀。
  // 注:`storage-setting.reset.credentials` 不绑 ops-admin(沿 D2=A),
  //     SUPER_ADMIN 经 RbacService.can 短路通过;ADMIN+ops-admin → RBAC_FORBIDDEN。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  /**
   * V2.x production storage_settings fail-fast(2026-05-16):
   * production 启动期严格校验 storage_settings 必须真实初始化为可用 COS。
   *
   * **仅 production 触发**(沿用户拍板修正版第 4 项 + Q-pff-2 / Q-pff-3 / Q-pff-4):
   * - smoke / development / test 全部跳过(smoke 是 CI 专用,docker-smoke job 不预接真实 COS)
   * - 此处直接判 `env === 'production'`,**不**用 isProductionLike(smoke 必须跳过)
   *
   * **5 项严格校验**(缺一启动失败,沿评审 §6.5.4 + 修正版第 3 项):
   * 1. settings 存在(运维真实 PATCH 创建过 row)
   * 2. enabled === true
   * 3. providerType === 'COS'(production 拒绝 LOCAL;沿 F2)
   * 4. bucket / region 非空
   * 5. credentialStatus === CONFIGURED(凭证已录入 + 解密成功)
   *
   * 错误消息含修复指引(指向 ops SOP §7 / §8);
   * **永不**包含凭证 secret 明文 / 密文(沿 §6.6 信息泄漏防御)。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.env !== 'production') return;

    const r = await this.getActiveSettings();

    // 校验 1: settings 存在
    if (!r) {
      throw new Error(
        'production fail-fast: storage_settings 未初始化。' +
          '请按 docs/ops/cos-production-rollout-checklist.md §7 通过 ' +
          'PATCH /api/system/v1/storage-settings 创建 row。',
      );
    }

    // 校验 2: enabled=true
    if (!r.enabled) {
      throw new Error(
        'production fail-fast: storage_settings.enabled=false。' +
          '请通过 PATCH /api/system/v1/storage-settings 设 enabled=true。',
      );
    }

    // 校验 3: providerType=COS(production 拒绝 LOCAL;沿 F2)
    if (r.providerType !== 'COS') {
      throw new Error(
        `production fail-fast: providerType=${r.providerType},production 必须是 COS(沿 F2)。` +
          '请通过 PATCH /api/system/v1/storage-settings 设 providerType=COS。',
      );
    }

    // 校验 4: bucket / region 非空
    if (!r.bucket || !r.region) {
      throw new Error(
        'production fail-fast: storage_settings.bucket / region 不能为空。' +
          '请按 ops SOP §2 / §7 完整配置 bucket 与 region。',
      );
    }

    // 校验 5: credentialStatus=CONFIGURED
    if (r.credentialStatus !== CredentialStatus.CONFIGURED) {
      throw new Error(
        `production fail-fast: credentialStatus=${r.credentialStatus},必须是 ${CredentialStatus.CONFIGURED}。` +
          '请按 ops SOP §8 通过 POST /api/system/v1/storage-settings/reset-credentials 录入凭证;' +
          `若 ${CredentialStatus.INVALID},检查 STORAGE_ENCRYPTION_KEY 是否被轮换。`,
      );
    }

    // 全部通过(成功日志不含凭证 secret 字段)
    this.logger.log(
      `production fail-fast: storage_settings OK ` +
        `(providerType=${r.providerType}, bucket=${r.bucket}, region=${r.region}, ` +
        `credentialStatus=${r.credentialStatus})`,
    );
  }

  /**
   * 读取当前生效配置(单条 singleton row;沿 §6.5.4)
   * - DB 空 → 返 null
   * - DB 有 1 条 → 解密 + 返 resolved
   * - 第 49 migration 后 DB 层保证至多一条,不再保留“取最早 + WARN”分支
   * - 每次调用直读 PostgreSQL 当前已提交事实
   */
  async getActiveSettings(): Promise<StorageSettingsResolved | null> {
    const row = await this.prisma.storageSettings.findFirst();
    return row === null ? null : this.toResolved(row);
  }

  // 把 Prisma row 解码为运行时 resolved 对象(沿 §6.6.3 三档状态)
  private toResolved(row: StorageSettingsRow): StorageSettingsResolved {
    const { credentials, credentialStatus } = this.resolveCredentials(row);

    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      bucket: row.bucket,
      region: row.region,
      envPrefix: row.envPrefix,
      uploadUrlTtlSeconds: row.uploadUrlTtlSeconds,
      downloadUrlTtlSeconds: row.downloadUrlTtlSeconds,
      lifecycleDays: row.lifecycleDays,
      enableSignedUrl: row.enableSignedUrl,
      enableVersioning: row.enableVersioning,
      // Prisma 把 JSONB 映射为 JsonValue;首期只读 string[](沿 Q14)
      corsAllowedOrigins: parseCorsOrigins(row.corsAllowedOrigins),
      maxObjectSizeBytes: row.maxObjectSizeBytes,
      allowedMimePolicyMode: row.allowedMimePolicyMode,
      credentials,
      credentialStatus,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }

  // 沿 §6.6.3:三档状态合成
  // - credentialConfigured=false → MISSING
  // - credentialConfigured=true + 解密成功 → CONFIGURED
  // - credentialConfigured=true + 解密失败 → INVALID
  // 任何凭证字段为 null(数据不一致)也走 MISSING(防御性;不抛)
  private resolveCredentials(row: StorageSettingsRow): {
    credentials: { secretId: string; secretKey: string } | null;
    credentialStatus: CredentialStatus;
  } {
    if (!row.credentialConfigured) {
      return { credentials: null, credentialStatus: CredentialStatus.MISSING };
    }
    if (row.secretIdEncrypted === null || row.secretKeyEncrypted === null) {
      this.logger.warn(
        `storage_settings.credentialConfigured=true but encrypted columns are null (id=${row.id}); treating as MISSING`,
      );
      return { credentials: null, credentialStatus: CredentialStatus.MISSING };
    }
    try {
      const secretId = this.crypto.decrypt(row.secretIdEncrypted);
      const secretKey = this.crypto.decrypt(row.secretKeyEncrypted);
      return {
        credentials: { secretId, secretKey },
        credentialStatus: CredentialStatus.CONFIGURED,
      };
    } catch (err) {
      if (err instanceof StorageCryptoDecryptError) {
        this.logger.warn(
          `storage_settings credentials decrypt failed (id=${row.id}): ${err.message}; key rotated or ciphertext tampered`,
        );
        return { credentials: null, credentialStatus: CredentialStatus.INVALID };
      }
      // StorageCryptoUnavailableError 或其他 → 同样视作 INVALID
      // (production 启动校验保证不会走到这里;dev / test 留空时凭证列也不该被写入)
      this.logger.warn(
        `storage_settings credentials decrypt threw unexpected error (id=${row.id}): ${(err as Error).message}`,
      );
      return { credentials: null, credentialStatus: CredentialStatus.INVALID };
    }
  }

  // ============ V2.x C-7.5 PR #11:后台 Admin CRUD + reset-credentials ============
  //
  // 沿评审 §6.5 / §6.6 + Q-11 拍板:
  // - getForAdmin():singleton row 不存在返 null(沿 Q-11-1;不强行构造空 DTO)
  // - updateSettings(dto, user):upsert(不存在创建 default;沿 Q-11-1 + Q-11-17)
  // - resetCredentials(dto, user):AES-256-GCM 加密 SecretId/SecretKey 落库;不写日志凭证(沿 §6.6.2)
  // - 第六刀补齐 update/reset in-tx audit;update 只记 changedFields 字段名,reset 不记任何凭证字段或值
  // - 0 新 BizCode(沿 Q-11-4;复用 BAD_REQUEST / UNAUTHORIZED / FORBIDDEN / INTERNAL_ERROR)
  // - PATCH / reset 提交后下一次 getActiveSettings() 直接读取新事实

  // GET /api/system/v1/storage-settings(admin 视图)
  // 单 singleton row 不存在 → 返 null(沿 Q-11-1);不抛 BizCode
  async getForAdmin(user: CurrentUserPayload): Promise<StorageSettingsResponseDto | null> {
    await this.assertCanOrThrow(user, 'storage-setting.read.singleton');
    const row = await this.prisma.storageSettings.findFirst();
    return row === null ? null : this.toResponseDto(row);
  }

  // PATCH /api/system/v1/storage-settings(upsert;沿 Q-11-1 + Q-11-17)
  // 不存在 → create with default(providerType=LOCAL;沿 Q-11-2);
  // 存在 → update + updatedBy = user.id
  // 提交后任一实例的下一次 getActiveSettings() 直接读取新事实
  async updateSettings(
    dto: UpdateStorageSettingsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<StorageSettingsResponseDto> {
    await this.assertCanOrThrow(user, 'storage-setting.update.singleton');
    // 字段转换(maxObjectSizeBytes string → BigInt;沿 Q-11-10)
    const data = this.buildUpdateData(dto);
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort();

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.storageSettings.findFirst({
        select: { id: true },
      });

      let updated: StorageSettingsRow;
      if (existing) {
        updated = await tx.storageSettings.update({
          where: { id: existing.id },
          data: { ...data, updatedBy: user.id },
        });
      } else {
        // upsert 创建 default;providerType 缺省 LOCAL(沿 Q-11-2)
        // create input 类型严格;data 是 update input,字段子集兼容,as 转通用 record
        updated = await tx.storageSettings.create({
          data: {
            ...(data as Prisma.StorageSettingsCreateInput),
            providerType: dto.providerType ?? 'LOCAL',
            updatedBy: user.id,
          },
        });
      }

      await this.auditLogs.log({
        event: 'storage-setting.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'storage_setting',
        resourceId: updated.id,
        meta: auditMeta,
        extra: { changedFields },
        tx,
      });
      return updated;
    });

    return this.toResponseDto(row);
  }

  // POST /api/system/v1/storage-settings/reset-credentials(沿 §6.6.2 + Q-11-1 + Q-11-2)
  // 不存在 → upsert 创建 default;providerType=COS(沿 Q-11-2:reset 默认 COS)
  // 加密 SecretId / SecretKey + 写 credentialConfigured=true
  // **永不**在 response / 日志 / audit 中暴露明文 / 密文(沿 §6.6.2 / §6.6.5)
  async resetCredentials(
    dto: ResetStorageCredentialsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<StorageSettingsResponseDto> {
    // P0-F PR-2B D2=A:`storage-setting.reset.credentials` 不绑 ops-admin;
    // SUPER_ADMIN 经 RbacService.can 短路通过;ADMIN+ops-admin → RBAC_FORBIDDEN(30100)
    await this.assertCanOrThrow(user, 'storage-setting.reset.credentials');
    // 加密(沿 §6.6.1 AES-256-GCM;StorageCryptoService.encrypt 内部检查 isAvailable)
    // STORAGE_ENCRYPTION_KEY 缺失时 → 抛 StorageCryptoUnavailableError → 全局过滤器返 500 INTERNAL_ERROR
    const secretIdEncrypted = this.crypto.encrypt(dto.secretId);
    const secretKeyEncrypted = this.crypto.encrypt(dto.secretKey);

    const row = await this.runSingletonWriteWithUniqueRetry(async (tx) => {
      const existing = await tx.storageSettings.findFirst({
        select: { id: true },
      });

      let updated: StorageSettingsRow;
      if (existing) {
        updated = await tx.storageSettings.update({
          where: { id: existing.id },
          data: {
            secretIdEncrypted,
            secretKeyEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      } else {
        // upsert 创建 default;providerType=COS(沿 Q-11-2:reset 场景默认 COS)
        updated = await tx.storageSettings.create({
          data: {
            providerType: 'COS',
            secretIdEncrypted,
            secretKeyEncrypted,
            credentialConfigured: true,
            updatedBy: user.id,
          },
        });
      }

      // 最硬红线:reset audit 只保留 actor / row.id / AuditMeta;不传 before/after/extra。
      await this.auditLogs.log({
        event: 'storage-setting.reset-credentials',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'storage_setting',
        resourceId: updated.id,
        meta: auditMeta,
        tx,
      });
      return updated;
    });

    // 仅 pino 日志记 reset 动作 + actorUserId;不含 secret 明文 / 密文
    this.logger.log(`storage_settings credentials reset by user.id=${user.id}; row.id=${row.id}`);

    return this.toResponseDto(row);
  }

  // === helpers ===

  /**
   * 两个首配请求可同时读到空表；DB constant unique 令其中一个 create 以 P2002 失败。
   * 失败事务已整体回滚，重跑同一事务即可命中赢家创建的单行并走 update。
   */
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

  // DTO → Prisma data 字段转换(maxObjectSizeBytes string → BigInt;沿 Q-11-10)
  // 仅转换 dto 已提供字段(沿 PATCH 部分更新语义)
  private buildUpdateData(dto: UpdateStorageSettingsDto): Prisma.StorageSettingsUpdateInput {
    const data: Prisma.StorageSettingsUpdateInput = {};
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.bucket !== undefined) data.bucket = dto.bucket;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.envPrefix !== undefined) data.envPrefix = dto.envPrefix;
    if (dto.uploadUrlTtlSeconds !== undefined) data.uploadUrlTtlSeconds = dto.uploadUrlTtlSeconds;
    if (dto.downloadUrlTtlSeconds !== undefined)
      data.downloadUrlTtlSeconds = dto.downloadUrlTtlSeconds;
    if (dto.lifecycleDays !== undefined) data.lifecycleDays = dto.lifecycleDays;
    if (dto.enableSignedUrl !== undefined) data.enableSignedUrl = dto.enableSignedUrl;
    if (dto.enableVersioning !== undefined) data.enableVersioning = dto.enableVersioning;
    if (dto.corsAllowedOrigins !== undefined) {
      data.corsAllowedOrigins =
        dto.corsAllowedOrigins === null ? Prisma.JsonNull : dto.corsAllowedOrigins;
    }
    if (dto.maxObjectSizeBytes !== undefined) {
      data.maxObjectSizeBytes =
        dto.maxObjectSizeBytes === null ? null : BigInt(dto.maxObjectSizeBytes);
    }
    if (dto.allowedMimePolicyMode !== undefined)
      data.allowedMimePolicyMode = dto.allowedMimePolicyMode;
    if (dto.remarks !== undefined) data.remarks = dto.remarks;
    return data;
  }

  // Prisma row → ResponseDto(出参不含 secretIdEncrypted / secretKeyEncrypted / credentials;沿 §6.6.2)
  private toResponseDto(row: StorageSettingsRow): StorageSettingsResponseDto {
    // 复用 credentialStatus 合成(三态;不暴露 credentials 明文)
    const { credentialStatus } = this.resolveCredentials(row);
    return {
      id: row.id,
      providerType: row.providerType,
      enabled: row.enabled,
      bucket: row.bucket,
      region: row.region,
      envPrefix: row.envPrefix,
      uploadUrlTtlSeconds: row.uploadUrlTtlSeconds,
      downloadUrlTtlSeconds: row.downloadUrlTtlSeconds,
      lifecycleDays: row.lifecycleDays,
      enableSignedUrl: row.enableSignedUrl,
      enableVersioning: row.enableVersioning,
      corsAllowedOrigins: parseCorsOrigins(row.corsAllowedOrigins),
      // BigInt → string(沿 Q-11-10)
      maxObjectSizeBytes:
        row.maxObjectSizeBytes === null ? null : row.maxObjectSizeBytes.toString(),
      allowedMimePolicyMode: row.allowedMimePolicyMode,
      credentialStatus,
      credentialConfigured: row.credentialConfigured,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  }
}

// JSONB → string[] | null;非数组 / 元素非 string 时返 null(防御性;留 PR #11 在写入侧做 DTO 校验)
function parseCorsOrigins(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  if (!raw.every((x): x is string => typeof x === 'string')) return null;
  return raw;
}

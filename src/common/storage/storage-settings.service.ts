import { Injectable, Logger } from '@nestjs/common';
import type { StorageSettings as StorageSettingsRow } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { StorageCryptoDecryptError, StorageCryptoService } from './storage-crypto.service';
import { CredentialStatus, type StorageSettingsResolved } from './storage-settings.types';

// V2.x C-7.5 Provider 选型实施 PR #6:storage_settings 读取层(沿 §6.5.5 + Q24 / Q25)
//
// 范围(PR #6):
// - getActiveSettings():DB 读 + 60s 缓存 + 解密 + 合成 credentialStatus(沿 §6.5.5)
// - invalidate():主动失效缓存(留 PR #11 后台 PATCH 调用)
// - DB 空 → 返 null(沿 Q-87-3 拍板 B;bootstrap fallback 留 PR #11)
//
// 不在 PR #6 范围(沿 §16.1 PR #11):
// - POST 首次创建 singleton row + count() 守护
// - PATCH 改非凭证字段(invalidate 缓存)
// - POST /reset-credentials 接收明文 + 加密落库
// - bootstrap fallback 从 env 兜底创建首条记录(沿 Q23 / Q-87-3)
//
// singleton 不在 DB 层强制(沿 Q-87-2 / §6.5.4):
// - 本 Service 发现 > 1 条记录时打 WARN 日志 + 用 createdAt 最早的一条
// - 留 PR #11 后台 CRUD POST 做 count() 检 → 抛 422 兜底

const CACHE_TTL_MS = 60_000;

@Injectable()
export class StorageSettingsService {
  private readonly logger = new Logger(StorageSettingsService.name);

  private cache: {
    resolved: StorageSettingsResolved | null;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: StorageCryptoService,
  ) {}

  /**
   * 读取当前生效配置(单条 singleton row;沿 §6.5.4)
   * - DB 空 → 返 null
   * - DB 有 1 条 → 解密 + 返 resolved
   * - DB 有 > 1 条 → 打 WARN + 用 createdAt 最早的一条(防御性;singleton 违反由 PR #11 修)
   * - 缓存 60s
   */
  async getActiveSettings(): Promise<StorageSettingsResolved | null> {
    if (this.cache !== null && this.cache.expiresAt > Date.now()) {
      return this.cache.resolved;
    }

    const rows = await this.prisma.storageSettings.findMany({
      orderBy: { createdAt: 'asc' },
      take: 2, // 只取 2 条即可判断是否违反 singleton;沿 PG 范式
    });

    if (rows.length === 0) {
      this.setCache(null);
      return null;
    }

    if (rows.length > 1) {
      this.logger.warn(
        `storage_settings singleton violated: found ${rows.length}+ rows; using earliest (createdAt=${rows[0].createdAt.toISOString()}). Fix via PR #11 backstage CRUD.`,
      );
    }

    const resolved = this.toResolved(rows[0]);
    this.setCache(resolved);
    return resolved;
  }

  /**
   * 主动失效缓存(沿 RbacCacheService.invalidate() 范式)。
   * PR #11 后台 PATCH / reset-credentials 后调,保证下一次读到新值。
   */
  invalidate(): void {
    this.cache = null;
  }

  private setCache(resolved: StorageSettingsResolved | null): void {
    this.cache = { resolved, expiresAt: Date.now() + CACHE_TTL_MS };
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
}

// JSONB → string[] | null;非数组 / 元素非 string 时返 null(防御性;留 PR #11 在写入侧做 DTO 校验)
function parseCorsOrigins(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  if (!raw.every((x): x is string => typeof x === 'string')) return null;
  return raw;
}

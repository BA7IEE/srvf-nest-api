import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import appConfig from '../../config/app.config';

// V2.x C-7.5 Provider 选型实施 PR #6:对称加密 helper(沿 §6.6.1 + 立项记录 §四)
//
// 算法:AES-256-GCM(对称 + 认证加密)。
// Key 派生:scrypt(envKey, fixedSalt, 32);envKey ≥ 32 字符由 app.config 启动校验保证。
// 序列化:base64(iv:12B || authTag:16B || ciphertext) -> base64 单字符串。
//
// 失败模式:
// - encryptionKey 为空(dev / test) -> encrypt / decrypt 抛 STORAGE_CRYPTO_UNAVAILABLE
// - decrypt 收到非法格式 / 篡改 ciphertext / authTag 不匹配 -> 抛 STORAGE_CRYPTO_DECRYPT_FAILED
//
// 0 新依赖:仅用 Node 原生 `crypto`(createCipheriv / createDecipheriv / randomBytes / scryptSync)。

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 推荐 96-bit
const AUTH_TAG_BYTES = 16; // GCM 128-bit
// 固定 salt:加密 key 唯一性已由 STORAGE_ENCRYPTION_KEY env 保证;salt 仅用于 scrypt 派生确定性
// 避免每次 encrypt 重新 scrypt(scrypt 是 CPU 重操作);沿 v1 JWT_SECRET 单值派生范式
const KEY_DERIVATION_SALT = Buffer.from('srvf-storage-key-derivation-salt-v1', 'utf8');

export class StorageCryptoUnavailableError extends Error {
  constructor() {
    super('STORAGE_CRYPTO_UNAVAILABLE: STORAGE_ENCRYPTION_KEY 未配置(dev / test 留空时不可加解密)');
    this.name = 'StorageCryptoUnavailableError';
  }
}

export class StorageCryptoDecryptError extends Error {
  constructor(reason: string) {
    super(`STORAGE_CRYPTO_DECRYPT_FAILED: ${reason}`);
    this.name = 'StorageCryptoDecryptError';
  }
}

@Injectable()
export class StorageCryptoService {
  private readonly key: Buffer | null;

  constructor(
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {
    this.key = this.deriveKey(this.cfg.storage.encryptionKey);
  }

  /**
   * 是否可用(STORAGE_ENCRYPTION_KEY 已配置)
   * dev / test 留空时返 false;production 启动已 fail-fast,运行时恒为 true
   */
  isAvailable(): boolean {
    return this.key !== null;
  }

  /**
   * AES-256-GCM 加密;返回 base64(iv || authTag || ciphertext) 单字符串
   * key 未配置 -> 抛 StorageCryptoUnavailableError
   */
  encrypt(plaintext: string): string {
    if (this.key === null) {
      throw new StorageCryptoUnavailableError();
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  /**
   * AES-256-GCM 解密;入参为 encrypt() 输出的 base64 字符串
   * 失败一律抛 StorageCryptoDecryptError(调用方应映射为 CredentialStatus.INVALID)
   */
  decrypt(payload: string): string {
    if (this.key === null) {
      throw new StorageCryptoUnavailableError();
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch {
      throw new StorageCryptoDecryptError('base64 decode failed');
    }
    // 最短合法 payload = IV(12) + authTag(16) + 0 字节密文 = 28 字节(GCM 加密空字符串合法)
    if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new StorageCryptoDecryptError(`payload too short: ${buf.length} bytes`);
    }
    const iv = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
      // GCM authTag 不匹配 / ciphertext 被篡改 / key 错误均落入此分支
      throw new StorageCryptoDecryptError(
        err instanceof Error ? err.message : 'auth tag mismatch or ciphertext corrupted',
      );
    }
  }

  private deriveKey(raw: string): Buffer | null {
    if (!raw) return null;
    // scrypt(N=16384, r=8, p=1) 单次派生 32 字节 key
    // raw ≥ 32 字符由 app.config 启动校验保证;这里再 scrypt 一道,
    // 兼容三种常见输入(base64-44 / hex-64 / raw-32+),最终统一为 32 字节 Buffer
    return scryptSync(raw, KEY_DERIVATION_SALT, KEY_BYTES);
  }
}

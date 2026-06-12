import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import appConfig from '../../config/app.config';

// 微信小程序登录 T2(2026-06-12):凭证对称加密 helper(评审稿 E-4;逐行镜像 sms-crypto.service)
//
// 算法:AES-256-GCM(对称 + 认证加密)。
// Key 派生:scrypt(WECHAT_ENCRYPTION_KEY, 独立固定 salt, 32);envKey ≥ 32 字符由 app.config 启动校验保证。
// 序列化:base64(iv:12B || authTag:16B || ciphertext) -> base64 单字符串。
//
// 与 SmsCryptoService / StorageCryptoService 的关系:**独立 env key + 独立 salt,密文互不可解**;
// 刻意不抽公共基类(各模块各自演进,沿 AGENTS §2 禁 grab-bag 精神)。
//
// 失败模式:
// - encryptionKey 为空(dev / test) -> encrypt / decrypt 抛 WechatCryptoUnavailableError
// - decrypt 收到非法格式 / 篡改 ciphertext / authTag 不匹配 -> 抛 WechatCryptoDecryptError
//
// 0 新依赖:仅 Node 原生 `crypto`。

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 推荐 96-bit
const AUTH_TAG_BYTES = 16; // GCM 128-bit
// 固定 salt:key 唯一性已由 WECHAT_ENCRYPTION_KEY env 保证;salt 仅用于 scrypt 派生确定性
// (与 storage / sms 的 salt 字符串不同,保证三把 env key 即使误配同值也派生出不同密钥)
const KEY_DERIVATION_SALT = Buffer.from('srvf-wechat-key-derivation-salt-v1', 'utf8');

export class WechatCryptoUnavailableError extends Error {
  constructor() {
    super('WECHAT_CRYPTO_UNAVAILABLE: WECHAT_ENCRYPTION_KEY 未配置(dev / test 留空时不可加解密)');
    this.name = 'WechatCryptoUnavailableError';
  }
}

export class WechatCryptoDecryptError extends Error {
  constructor(reason: string) {
    super(`WECHAT_CRYPTO_DECRYPT_FAILED: ${reason}`);
    this.name = 'WechatCryptoDecryptError';
  }
}

@Injectable()
export class WechatCryptoService {
  private readonly key: Buffer | null;

  constructor(
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {
    this.key = this.deriveKey(this.cfg.wechat.encryptionKey);
  }

  /**
   * 是否可用(WECHAT_ENCRYPTION_KEY 已配置)
   * dev / test 留空时返 false;production / smoke 启动已 fail-fast,运行时恒为 true
   */
  isAvailable(): boolean {
    return this.key !== null;
  }

  /**
   * AES-256-GCM 加密;返回 base64(iv || authTag || ciphertext) 单字符串
   * key 未配置 -> 抛 WechatCryptoUnavailableError
   */
  encrypt(plaintext: string): string {
    if (this.key === null) {
      throw new WechatCryptoUnavailableError();
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  /**
   * AES-256-GCM 解密;入参为 encrypt() 输出的 base64 字符串
   * 失败一律抛 WechatCryptoDecryptError(调用方应映射为 WechatCredentialStatus.INVALID)
   */
  decrypt(payload: string): string {
    if (this.key === null) {
      throw new WechatCryptoUnavailableError();
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch {
      throw new WechatCryptoDecryptError('base64 decode failed');
    }
    // 最短合法 payload = IV(12) + authTag(16) + 0 字节密文 = 28 字节(GCM 加密空字符串合法)
    if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new WechatCryptoDecryptError(`payload too short: ${buf.length} bytes`);
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
      throw new WechatCryptoDecryptError(
        err instanceof Error ? err.message : 'auth tag mismatch or ciphertext corrupted',
      );
    }
  }

  private deriveKey(raw: string): Buffer | null {
    if (!raw) return null;
    // scrypt 单次派生 32 字节 key;raw ≥ 32 字符由 app.config 启动校验保证
    return scryptSync(raw, KEY_DERIVATION_SALT, KEY_BYTES);
  }
}

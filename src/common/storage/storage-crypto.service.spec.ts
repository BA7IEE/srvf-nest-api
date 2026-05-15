import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import {
  StorageCryptoDecryptError,
  StorageCryptoService,
  StorageCryptoUnavailableError,
} from './storage-crypto.service';

// V2.x C-7.5 PR #6:storage-crypto.service 单元测试(沿 Q-87-5 拍板 A 必须覆盖)
//
// 覆盖矩阵:
// 1. encrypt → decrypt 往返(明文 == 解密结果)
// 2. encrypt 同一明文两次 → 密文不同(IV 随机性)
// 3. decrypt 篡改 ciphertext → 抛 StorageCryptoDecryptError
// 4. decrypt 太短 payload → 抛 StorageCryptoDecryptError
// 5. encryptionKey 留空(dev / test 兜底)→ isAvailable=false / encrypt 抛 / decrypt 抛
// 6. 不同 encryptionKey 解不出对方密文 → StorageCryptoDecryptError

type AppCfg = ConfigType<typeof appConfig>;

function makeCfg(encryptionKey: string): AppCfg {
  // 单元测试只关心 storage.encryptionKey;其他字段填占位值(类型完整即可)
  return {
    env: 'test',
    port: 3000,
    corsOrigin: [],
    swaggerEnabled: false,
    logLevel: 'silent' as never,
    loginThrottle: { limit: 5, ttlSeconds: 60 },
    rbacCache: { ttlSeconds: 1800 },
    storage: { encryptionKey },
  } as unknown as AppCfg;
}

// 32 字符 base64-ish dummy key(单测无 production fail-fast 校验)
const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 44 字符
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('StorageCryptoService', () => {
  describe('encrypt + decrypt 往返', () => {
    it('明文 == 解密(单字节)', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const plain = 'x';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('明文 == 解密(典型 SecretKey 长度)', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const plain = 'AKIDeXampleSecretKey0123456789abcdefghijKL';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('明文 == 解密(UTF-8 多字节)', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const plain = '密钥-中文-🔑';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('明文 == 解密(空字符串)', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      expect(svc.decrypt(svc.encrypt(''))).toBe('');
    });
  });

  describe('IV 随机性', () => {
    it('同一明文加密两次 → 密文不同', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const plain = 'same-input';
      const c1 = svc.encrypt(plain);
      const c2 = svc.encrypt(plain);
      expect(c1).not.toBe(c2);
      // 解密结果仍相同
      expect(svc.decrypt(c1)).toBe(plain);
      expect(svc.decrypt(c2)).toBe(plain);
    });
  });

  describe('decrypt 失败路径', () => {
    it('篡改 ciphertext 任一字节 → StorageCryptoDecryptError', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const ciphertext = svc.encrypt('payload');
      const buf = Buffer.from(ciphertext, 'base64');
      // 翻转最后一个字节(数据段;authTag 仍校验失败)
      buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
      const tampered = buf.toString('base64');
      expect(() => svc.decrypt(tampered)).toThrow(StorageCryptoDecryptError);
    });

    it('篡改 authTag → StorageCryptoDecryptError', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const ciphertext = svc.encrypt('payload');
      const buf = Buffer.from(ciphertext, 'base64');
      // 翻转 authTag 区间(IV 12B + authTag 16B = bytes 12..27)中的一字节
      buf[15] = buf[15] ^ 0xff;
      const tampered = buf.toString('base64');
      expect(() => svc.decrypt(tampered)).toThrow(StorageCryptoDecryptError);
    });

    it('payload 太短 → StorageCryptoDecryptError', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      const tooShort = Buffer.from('abc').toString('base64'); // 3 bytes << 12+16+1=29
      expect(() => svc.decrypt(tooShort)).toThrow(StorageCryptoDecryptError);
    });

    it('用 KEY_B 解 KEY_A 密文 → StorageCryptoDecryptError(key 不匹配)', () => {
      const svcA = new StorageCryptoService(makeCfg(KEY_A));
      const svcB = new StorageCryptoService(makeCfg(KEY_B));
      const ciphertext = svcA.encrypt('cross-key-test');
      expect(() => svcB.decrypt(ciphertext)).toThrow(StorageCryptoDecryptError);
    });
  });

  describe('encryptionKey 留空(dev / test 兜底)', () => {
    let svc: StorageCryptoService;

    beforeEach(() => {
      svc = new StorageCryptoService(makeCfg(''));
    });

    it('isAvailable() === false', () => {
      expect(svc.isAvailable()).toBe(false);
    });

    it('encrypt() → StorageCryptoUnavailableError', () => {
      expect(() => svc.encrypt('x')).toThrow(StorageCryptoUnavailableError);
    });

    it('decrypt() → StorageCryptoUnavailableError', () => {
      expect(() => svc.decrypt('x')).toThrow(StorageCryptoUnavailableError);
    });
  });

  describe('encryptionKey 已配置', () => {
    it('isAvailable() === true', () => {
      const svc = new StorageCryptoService(makeCfg(KEY_A));
      expect(svc.isAvailable()).toBe(true);
    });
  });
});

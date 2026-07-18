import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import {
  SmsCryptoDecryptError,
  SmsCryptoService,
  SmsCryptoUnavailableError,
} from './sms-crypto.service';

// SMS 基础设施 T2:sms-crypto.service 单元测试(评审稿 §10;镜像 storage-crypto.service.spec 覆盖矩阵)
//
// 覆盖矩阵:
// 1. encrypt → decrypt 往返(明文 == 解密结果)
// 2. encrypt 同一明文两次 → 密文不同(IV 随机性)
// 3. decrypt 篡改 ciphertext → 抛 SmsCryptoDecryptError
// 4. decrypt 太短 payload → 抛 SmsCryptoDecryptError
// 5. encryptionKey 留空(dev / test 兜底)→ isAvailable=false / encrypt 抛 / decrypt 抛
// 6. 不同 encryptionKey 解不出对方密文 → SmsCryptoDecryptError
// 7. 与 StorageCryptoService 同 env key 值时密文互不可解(独立派生 salt;评审稿 E-13)

type AppCfg = ConfigType<typeof appConfig>;

function makeCfg(encryptionKey: string): AppCfg {
  // 单元测试只关心 sms.encryptionKey;其他字段填占位值(类型完整即可)
  return {
    env: 'test',
    port: 3000,
    corsOrigin: [],
    swaggerEnabled: false,
    logLevel: 'silent' as never,
    loginThrottle: { limit: 5, ttlSeconds: 60 },
    storage: { encryptionKey: '', localRoot: './tmp/storage' },
    sms: { encryptionKey },
  } as unknown as AppCfg;
}

const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 44 字符
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('SmsCryptoService', () => {
  describe('encrypt + decrypt 往返', () => {
    it('明文 == 解密(典型 SecretKey 长度)', () => {
      const svc = new SmsCryptoService(makeCfg(KEY_A));
      const plain = 'AKIDeXampleSecretKey0123456789abcdefghijKL';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('明文 == 解密(UTF-8 多字节)', () => {
      const svc = new SmsCryptoService(makeCfg(KEY_A));
      const plain = '密钥-中文-🔑';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('明文 == 解密(空字符串;GCM 空密文合法)', () => {
      const svc = new SmsCryptoService(makeCfg(KEY_A));
      expect(svc.decrypt(svc.encrypt(''))).toBe('');
    });
  });

  it('同一明文两次 encrypt → 密文不同(IV 随机性)', () => {
    const svc = new SmsCryptoService(makeCfg(KEY_A));
    const plain = 'same-plaintext';
    expect(svc.encrypt(plain)).not.toBe(svc.encrypt(plain));
  });

  describe('decrypt 失败路径', () => {
    it('篡改 ciphertext → SmsCryptoDecryptError', () => {
      const svc = new SmsCryptoService(makeCfg(KEY_A));
      const payload = svc.encrypt('secret');
      const buf = Buffer.from(payload, 'base64');
      buf[buf.length - 1] ^= 0xff; // 翻转最后一个字节
      expect(() => svc.decrypt(buf.toString('base64'))).toThrow(SmsCryptoDecryptError);
    });

    it('payload 太短 → SmsCryptoDecryptError', () => {
      const svc = new SmsCryptoService(makeCfg(KEY_A));
      expect(() => svc.decrypt(Buffer.alloc(10).toString('base64'))).toThrow(SmsCryptoDecryptError);
    });

    it('不同 key 解不出对方密文', () => {
      const a = new SmsCryptoService(makeCfg(KEY_A));
      const b = new SmsCryptoService(makeCfg(KEY_B));
      expect(() => b.decrypt(a.encrypt('cross-key'))).toThrow(SmsCryptoDecryptError);
    });
  });

  describe('encryptionKey 留空(dev / test)', () => {
    it('isAvailable=false;encrypt / decrypt 均抛 SmsCryptoUnavailableError', () => {
      const svc = new SmsCryptoService(makeCfg(''));
      expect(svc.isAvailable()).toBe(false);
      expect(() => svc.encrypt('x')).toThrow(SmsCryptoUnavailableError);
      expect(() => svc.decrypt('eA==')).toThrow(SmsCryptoUnavailableError);
    });
  });

  it('与 storage 同 env key 值时密文互不可解(独立派生 salt;评审稿 E-13)', async () => {
    // 动态 import 避免本 spec 与 storage 模块产生编译期依赖耦合
    const { StorageCryptoService } = await import('../storage/storage-crypto.service');
    const storageCfg = {
      ...makeCfg(KEY_A),
      storage: {
        encryptionKey: KEY_A,
        localRoot: './tmp/storage',
        consistencyMode: 'JIT' as const,
      },
    };
    const storageSvc = new StorageCryptoService(storageCfg);
    const smsSvc = new SmsCryptoService(makeCfg(KEY_A));
    const payload = storageSvc.encrypt('shared-env-key-value');
    expect(() => smsSvc.decrypt(payload)).toThrow(SmsCryptoDecryptError);
  });
});

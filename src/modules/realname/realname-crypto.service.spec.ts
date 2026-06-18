import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import { SmsCryptoService } from '../sms/sms-crypto.service';
import {
  RealnameCryptoDecryptError,
  RealnameCryptoService,
  RealnameCryptoUnavailableError,
} from './realname-crypto.service';

// 招新一期 · 实名核验通道 T2:realname-crypto.service 单元测试(评审稿 §8;镜像 wechat/sms-crypto.service.spec 覆盖矩阵)
//
// 覆盖矩阵:
// 1. encrypt → decrypt 往返(明文 == 解密结果)
// 2. encrypt 同一明文两次 → 密文不同(IV 随机性)
// 3. decrypt 篡改 ciphertext → 抛 RealnameCryptoDecryptError
// 4. decrypt 太短 payload → 抛 RealnameCryptoDecryptError
// 5. encryptionKey 留空(dev / test 兜底)→ isAvailable=false / encrypt 抛 / decrypt 抛
// 6. 不同 encryptionKey 解不出对方密文 → RealnameCryptoDecryptError
// 7. 与 SmsCryptoService 同 env key 值时密文互不可解(独立派生 salt;评审稿 E-R-2)

type AppCfg = ConfigType<typeof appConfig>;

function makeCfg(encryptionKey: string, smsKey = ''): AppCfg {
  // 单元测试只关心 realname.encryptionKey(7 号用例兼用 sms.encryptionKey);其他字段填占位值
  return {
    env: 'test',
    port: 3000,
    corsOrigin: [],
    swaggerEnabled: false,
    logLevel: 'silent' as never,
    loginThrottle: { limit: 5, ttlSeconds: 60 },
    rbacCache: { ttlSeconds: 1800 },
    storage: { encryptionKey: '', localRoot: './tmp/storage' },
    sms: { encryptionKey: smsKey },
    wechat: { encryptionKey: '' },
    realname: { encryptionKey },
  } as unknown as AppCfg;
}

const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 44 字符
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('RealnameCryptoService', () => {
  it('encrypt → decrypt 往返还原明文', () => {
    const svc = new RealnameCryptoService(makeCfg(KEY_A));
    const plaintext = 'AKIDtencent-secret-id-0123456789abcdef';
    expect(svc.decrypt(svc.encrypt(plaintext))).toBe(plaintext);
  });

  it('同一明文两次 encrypt 密文不同(IV 随机性)', () => {
    const svc = new RealnameCryptoService(makeCfg(KEY_A));
    const plaintext = 'same-plaintext';
    expect(svc.encrypt(plaintext)).not.toBe(svc.encrypt(plaintext));
  });

  it('篡改 ciphertext → RealnameCryptoDecryptError', () => {
    const svc = new RealnameCryptoService(makeCfg(KEY_A));
    const payload = svc.encrypt('secret');
    const buf = Buffer.from(payload, 'base64');
    buf[buf.length - 1] ^= 0xff; // 翻转最后一个密文字节
    const tampered = buf.toString('base64');
    let caught: unknown;
    try {
      svc.decrypt(tampered);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RealnameCryptoDecryptError);
  });

  it('payload 太短 → RealnameCryptoDecryptError', () => {
    const svc = new RealnameCryptoService(makeCfg(KEY_A));
    let caught: unknown;
    try {
      svc.decrypt(Buffer.from('short').toString('base64'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RealnameCryptoDecryptError);
  });

  it('encryptionKey 留空 → isAvailable=false,encrypt / decrypt 抛 RealnameCryptoUnavailableError', () => {
    const svc = new RealnameCryptoService(makeCfg(''));
    expect(svc.isAvailable()).toBe(false);
    let encryptErr: unknown;
    try {
      svc.encrypt('x');
    } catch (err) {
      encryptErr = err;
    }
    expect(encryptErr).toBeInstanceOf(RealnameCryptoUnavailableError);
    let decryptErr: unknown;
    try {
      svc.decrypt('eA==');
    } catch (err) {
      decryptErr = err;
    }
    expect(decryptErr).toBeInstanceOf(RealnameCryptoUnavailableError);
  });

  it('不同 encryptionKey 互不可解 → RealnameCryptoDecryptError', () => {
    const svcA = new RealnameCryptoService(makeCfg(KEY_A));
    const svcB = new RealnameCryptoService(makeCfg(KEY_B));
    const payload = svcA.encrypt('secret');
    let caught: unknown;
    try {
      svcB.decrypt(payload);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RealnameCryptoDecryptError);
  });

  it('与 SmsCryptoService 同 env key 值时密文互不可解(独立派生 salt,评审稿 E-R-2)', () => {
    const cfg = makeCfg(KEY_A, KEY_A); // realname 与 sms 故意同 key 值
    const realnameSvc = new RealnameCryptoService(cfg);
    const smsSvc = new SmsCryptoService(cfg);
    const payload = realnameSvc.encrypt('secret');
    let caught: unknown;
    try {
      smsSvc.decrypt(payload);
    } catch (err) {
      caught = err;
    }
    // sms salt ≠ realname salt → 派生密钥不同 → GCM authTag 校验失败
    expect(caught).toBeDefined();
  });
});

import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import { WechatCryptoService } from '../wechat/wechat-crypto.service';
import {
  WecomCryptoDecryptError,
  WecomCryptoService,
  WecomCryptoUnavailableError,
} from './wecom-crypto.service';

// 企业微信接入 T2(2026-08-01):CorpSecret 加密 helper 单测(冻结稿 §5.5 / D-WC-12)
//
// 本文件最重要的一条是「与小程序不共域」的**执行位** —— 见最后一个 describe。
// 光在注释里写「独立密钥」是文本;能拦住的是「同一份明文 + 同一把 env key,
// 两个模块产出的密文互相解不开」这条断言。

const KEY_A = 'wecom-test-encryption-key-0123456789abcdef';
const KEY_B = 'wecom-test-encryption-key-DIFFERENT-9876543210';

function makeService(encryptionKey: string): WecomCryptoService {
  return new WecomCryptoService({ wecom: { encryptionKey } } as ConfigType<typeof appConfig>);
}

describe('WecomCryptoService', () => {
  describe('可用性', () => {
    it('key 为空(dev / test 留空)→ isAvailable()=false', () => {
      expect(makeService('').isAvailable()).toBe(false);
    });

    it('key 已配置 → isAvailable()=true', () => {
      expect(makeService(KEY_A).isAvailable()).toBe(true);
    });

    it('key 为空时 encrypt / decrypt 抛 WecomCryptoUnavailableError', () => {
      const svc = makeService('');
      expect(() => svc.encrypt('x')).toThrow(WecomCryptoUnavailableError);
      expect(() => svc.decrypt('x')).toThrow(WecomCryptoUnavailableError);
    });
  });

  describe('往返与密文形状', () => {
    it('encrypt → decrypt 往返一致', () => {
      const svc = makeService(KEY_A);
      const plain = 'my-corp-secret-value';
      expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
    });

    it('密文既不等于也不包含明文', () => {
      const svc = makeService(KEY_A);
      const plain = 'my-corp-secret-value';
      const cipher = svc.encrypt(plain);
      expect(cipher).not.toBe(plain);
      expect(cipher).not.toContain(plain);
    });

    it('同一明文两次加密结果不同(IV 随机)', () => {
      const svc = makeService(KEY_A);
      expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
    });

    it('空字符串可加解密(GCM 合法;最短 payload = 12+16 字节)', () => {
      const svc = makeService(KEY_A);
      expect(svc.decrypt(svc.encrypt(''))).toBe('');
    });
  });

  describe('解密失败一律抛 WecomCryptoDecryptError(调用方映射为 credentialStatus=invalid)', () => {
    it('payload 过短', () => {
      expect(() => makeService(KEY_A).decrypt('AAAA')).toThrow(WecomCryptoDecryptError);
    });

    it('authTag 被篡改', () => {
      const svc = makeService(KEY_A);
      const buf = Buffer.from(svc.encrypt('x'), 'base64');
      buf[13] ^= 0xff; // 落在 authTag 区间内
      expect(() => svc.decrypt(buf.toString('base64'))).toThrow(WecomCryptoDecryptError);
    });

    // §5.1 规则 10:第一版不支持 key rotation —— 换 key 后旧密文解不开,
    // 结果必须是 invalid + fail-closed,而不是静默当成"没配凭证"放行。
    it('换一把 key 解旧密文 → 抛(而不是返回垃圾明文)', () => {
      const cipher = makeService(KEY_A).encrypt('secret');
      expect(() => makeService(KEY_B).decrypt(cipher)).toThrow(WecomCryptoDecryptError);
    });
  });

  // ===== D-WC-12 的执行位:企业微信与微信小程序**不共域** =====
  describe('与小程序不共域(D-WC-12)', () => {
    // 即使运维把两个 env 误配成同一个字符串,派生 salt 不同 ⇒ 实际密钥不同 ⇒ 密文互不可解。
    // 这条断言的价值:哪天有人"顺手"把两个 salt 改成同一个常量,它当场红。
    it('两模块用同一份 env key 值,密文仍互相解不开', () => {
      const sharedKeyValue = 'operator-mistakenly-used-same-key-0123456789';
      const wecom = makeService(sharedKeyValue);
      const wechat = new WechatCryptoService({
        wechat: { encryptionKey: sharedKeyValue },
      } as ConfigType<typeof appConfig>);

      const plain = 'cross-domain-probe';
      expect(() => wechat.decrypt(wecom.encrypt(plain))).toThrow();
      expect(() => wecom.decrypt(wechat.encrypt(plain))).toThrow();
    });
  });
});

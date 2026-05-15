import { createHmac as nodeHmac, scryptSync as nodeScrypt } from 'node:crypto';

import {
  signUploadToken,
  UploadTokenClaims,
  UploadTokenExpiredError,
  UploadTokenInvalidError,
  verifyUploadToken,
} from './upload-token.util';

// V2.x C-7.5 PR #10:upload-token unit 测试(沿 Q-10-14 拍板 A 必须覆盖)
//
// 覆盖矩阵:
// 1. sign + verify 往返(claims 字段全保留)
// 2. HMAC 篡改任一字节 → UploadTokenInvalidError
// 3. claims 篡改任一字节 → UploadTokenInvalidError(hmac 不匹配)
// 4. exp 过期 → UploadTokenExpiredError
// 5. malformed token(无 . / 多 . / 空段)
// 6. 不同 secret 解不出对方签发的 token
// 7. encryptionKey 为空 → UploadTokenInvalidError
// 8. claims schema 不完整(缺字段 / 类型错)→ UploadTokenInvalidError
// 9. exp = now 视为过期(严格 >)/ exp = now+1 通过

const KEY_A = 'a'.repeat(44); // 44 字符 base64-ish dummy key
const KEY_B = 'b'.repeat(44);

function makeClaims(overrides: Partial<UploadTokenClaims> = {}): UploadTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    key: 'attachments/test/2026/05/15/abc.jpg',
    ownerType: 'member',
    ownerId: 'cuid-member-1',
    originalName: 'photo.jpg',
    mime: 'image/jpeg',
    sizeBytes: 12345,
    uploadedByUserId: 'cuid-user-1',
    iat: now,
    exp: now + 600,
    ...overrides,
  };
}

describe('upload-token.util', () => {
  describe('sign + verify 往返', () => {
    it('claims 字段全保留', () => {
      const claims = makeClaims();
      const token = signUploadToken(claims, KEY_A);
      const decoded = verifyUploadToken(token, KEY_A);
      expect(decoded).toEqual(claims);
    });

    it('typical token 形态:含 1 个 . 分隔符 + 两段非空 base64url', () => {
      const token = signUploadToken(makeClaims(), KEY_A);
      const parts = token.split('.');
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
      // base64url 字符集
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it('同 claims 签发两次得到完全相同的 token(HMAC 确定性)', () => {
      const claims = makeClaims();
      const t1 = signUploadToken(claims, KEY_A);
      const t2 = signUploadToken(claims, KEY_A);
      expect(t1).toBe(t2);
    });
  });

  describe('HMAC 篡改', () => {
    it('篡改 HMAC 段(翻转一字节)→ UploadTokenInvalidError', () => {
      const token = signUploadToken(makeClaims(), KEY_A);
      const [claimsB64, hmacB64] = token.split('.');
      const buf = Buffer.from(hmacB64, 'base64url');
      buf[0] = buf[0] ^ 0xff;
      const tampered = `${claimsB64}.${buf.toString('base64url')}`;
      expect(() => verifyUploadToken(tampered, KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('篡改 claims 段(翻转一字节;hmac 不匹配)→ UploadTokenInvalidError', () => {
      const token = signUploadToken(makeClaims(), KEY_A);
      const [claimsB64, hmacB64] = token.split('.');
      const buf = Buffer.from(claimsB64, 'base64url');
      buf[0] = buf[0] ^ 0xff;
      const tampered = `${buf.toString('base64url')}.${hmacB64}`;
      expect(() => verifyUploadToken(tampered, KEY_A)).toThrow(UploadTokenInvalidError);
    });
  });

  describe('过期', () => {
    it('exp 已过期 → UploadTokenExpiredError', () => {
      const now = 1_000_000;
      const claims = makeClaims({ iat: now - 700, exp: now - 100 });
      const token = signUploadToken(claims, KEY_A);
      expect(() => verifyUploadToken(token, KEY_A, now)).toThrow(UploadTokenExpiredError);
    });

    it('exp === now 视为过期(严格 >)', () => {
      const now = 1_000_000;
      const claims = makeClaims({ iat: now - 600, exp: now });
      const token = signUploadToken(claims, KEY_A);
      expect(() => verifyUploadToken(token, KEY_A, now)).toThrow(UploadTokenExpiredError);
    });

    it('exp = now + 1 通过', () => {
      const now = 1_000_000;
      const claims = makeClaims({ iat: now, exp: now + 1 });
      const token = signUploadToken(claims, KEY_A);
      expect(() => verifyUploadToken(token, KEY_A, now)).not.toThrow();
    });
  });

  describe('malformed token', () => {
    it('空字符串 → UploadTokenInvalidError', () => {
      expect(() => verifyUploadToken('', KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('无 `.` 分隔符 → UploadTokenInvalidError', () => {
      expect(() => verifyUploadToken('xxxxxx', KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('多个 `.` 分隔符 → UploadTokenInvalidError', () => {
      expect(() => verifyUploadToken('a.b.c', KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('空段(`.xxxx` 或 `xxxx.`)→ UploadTokenInvalidError', () => {
      expect(() => verifyUploadToken('.xxxx', KEY_A)).toThrow(UploadTokenInvalidError);
      expect(() => verifyUploadToken('xxxx.', KEY_A)).toThrow(UploadTokenInvalidError);
    });
  });

  describe('跨 secret', () => {
    it('用 KEY_B 解 KEY_A 签的 token → UploadTokenInvalidError(hmac 不匹配)', () => {
      const token = signUploadToken(makeClaims(), KEY_A);
      expect(() => verifyUploadToken(token, KEY_B)).toThrow(UploadTokenInvalidError);
    });
  });

  describe('encryptionKey 为空', () => {
    it('sign 时 secret 空 → UploadTokenInvalidError', () => {
      expect(() => signUploadToken(makeClaims(), '')).toThrow(UploadTokenInvalidError);
    });

    it('verify 时 secret 空 → UploadTokenInvalidError', () => {
      const token = signUploadToken(makeClaims(), KEY_A);
      expect(() => verifyUploadToken(token, '')).toThrow(UploadTokenInvalidError);
    });
  });

  describe('claims schema 校验', () => {
    // 手工构造 raw claims token(模拟 secret 持有者签发非法 claims;验证客户端不能伪造结构)
    function makeTokenWithRawClaims(rawClaims: unknown, secret: string): string {
      const claimsJson = JSON.stringify(rawClaims);
      const claimsB64 = Buffer.from(claimsJson, 'utf8').toString('base64url');
      const salt = Buffer.from('srvf-upload-token-key-derivation-salt-v1', 'utf8');
      const key = nodeScrypt(secret, salt, 32);
      const hmac = nodeHmac('sha256', key).update(claimsB64).digest().toString('base64url');
      return `${claimsB64}.${hmac}`;
    }

    it('缺字段 → UploadTokenInvalidError', () => {
      const token = makeTokenWithRawClaims({ key: 'k' }, KEY_A);
      expect(() => verifyUploadToken(token, KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('sizeBytes 类型错(string 不是 number)→ UploadTokenInvalidError', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeTokenWithRawClaims(
        {
          key: 'k',
          ownerType: 'member',
          ownerId: 'm',
          originalName: 'n',
          mime: 'image/jpeg',
          sizeBytes: '12345', // wrong type
          uploadedByUserId: 'u',
          iat: now,
          exp: now + 600,
        },
        KEY_A,
      );
      expect(() => verifyUploadToken(token, KEY_A)).toThrow(UploadTokenInvalidError);
    });

    it('sizeBytes 负数 → UploadTokenInvalidError', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeTokenWithRawClaims(
        {
          key: 'k',
          ownerType: 'member',
          ownerId: 'm',
          originalName: 'n',
          mime: 'image/jpeg',
          sizeBytes: -1,
          uploadedByUserId: 'u',
          iat: now,
          exp: now + 600,
        },
        KEY_A,
      );
      expect(() => verifyUploadToken(token, KEY_A)).toThrow(UploadTokenInvalidError);
    });
  });
});

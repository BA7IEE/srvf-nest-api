import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

// V2.x C-7.5 Provider 选型实施 PR #10:uploadToken HMAC-SHA256 工具(沿 §8.3.4 + Q-10-1 拍板 A)
//
// 用途:
// - upload-url 端点生成 token,confirm-upload 端点验签
// - HMAC-SHA256 防篡改 + exp 过期检查
// - claims 内含 key/ownerType/ownerId/originalName/mime/sizeBytes/uploadedByUserId/iat/exp
//
// 设计要点:
// - 算法:HMAC-SHA256(Node `crypto.createHmac`)
// - 签名 key 来源:复用 `STORAGE_ENCRYPTION_KEY`(沿 §8.3.4 + Q-10-2;同 StorageCryptoService 范式)
// - key 派生:scrypt(envKey, fixedSalt, 32);避免明文 env 直接做 HMAC key
// - 编码:`<base64url(claims)>.<base64url(hmac)>`(类 JWT 紧凑格式;**不引入 jsonwebtoken** 依赖)
// - 验签:timingSafeEqual 防 timing attack
// - 失败模式:UploadTokenInvalidError / UploadTokenExpiredError;上层映射为 13001(沿信息泄漏防御)
//
// 0 新依赖:仅用 Node 原生 `crypto`。

export interface UploadTokenClaims {
  key: string;
  ownerType: string;
  ownerId: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  uploadedByUserId: string;
  iat: number; // unix seconds
  exp: number; // unix seconds
}

export class UploadTokenInvalidError extends Error {
  constructor(reason: string) {
    super(`UPLOAD_TOKEN_INVALID: ${reason}`);
    this.name = 'UploadTokenInvalidError';
  }
}

export class UploadTokenExpiredError extends Error {
  constructor() {
    super('UPLOAD_TOKEN_EXPIRED');
    this.name = 'UploadTokenExpiredError';
  }
}

// 沿 StorageCryptoService:scrypt 派生 32 字节 key;固定 salt(凭加密 key 唯一性保证签名 key 唯一)
const KEY_DERIVATION_SALT = Buffer.from('srvf-upload-token-key-derivation-salt-v1', 'utf8');
const HMAC_KEY_BYTES = 32;

function deriveHmacKey(encryptionKey: string): Buffer {
  if (!encryptionKey) {
    throw new UploadTokenInvalidError('STORAGE_ENCRYPTION_KEY 未配置(无法签发 / 验证 token)');
  }
  return scryptSync(encryptionKey, KEY_DERIVATION_SALT, HMAC_KEY_BYTES);
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * 签发 uploadToken。
 * - claims 序列化为 JSON → base64url
 * - HMAC-SHA256 签名 → base64url
 * - 返 `<claims>.<hmac>`
 */
export function signUploadToken(claims: UploadTokenClaims, encryptionKey: string): string {
  const key = deriveHmacKey(encryptionKey);
  const claimsJson = JSON.stringify(claims);
  const claimsB64 = base64urlEncode(Buffer.from(claimsJson, 'utf8'));
  const hmac = createHmac('sha256', key).update(claimsB64).digest();
  const hmacB64 = base64urlEncode(hmac);
  return `${claimsB64}.${hmacB64}`;
}

/**
 * 验证 uploadToken。
 * - 拆 `.` → claims/hmac 段
 * - 重算 HMAC → timingSafeEqual 严格比对
 * - 解 claims JSON;字段结构校验
 * - 检 exp > nowSeconds
 * - 失败抛 UploadTokenInvalidError / UploadTokenExpiredError;上层映射 13001 / 13001(信息泄漏防御)
 *
 * 注:`uploadedByUserId === currentUser.id` 由调用方(Service)校验,这里只负责签名 + 结构 + 过期
 */
export function verifyUploadToken(
  token: string,
  encryptionKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): UploadTokenClaims {
  if (typeof token !== 'string' || token.length === 0) {
    throw new UploadTokenInvalidError('empty token');
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new UploadTokenInvalidError('malformed token (expect <claims>.<hmac>)');
  }
  const [claimsB64, hmacB64] = parts;
  if (!claimsB64 || !hmacB64) {
    throw new UploadTokenInvalidError('malformed token (empty segment)');
  }

  // 重算 HMAC + timingSafeEqual(防 timing attack)
  const key = deriveHmacKey(encryptionKey);
  const expectedHmac = createHmac('sha256', key).update(claimsB64).digest();
  let providedHmac: Buffer;
  try {
    providedHmac = base64urlDecode(hmacB64);
  } catch {
    throw new UploadTokenInvalidError('hmac base64url decode failed');
  }
  if (providedHmac.length !== expectedHmac.length) {
    throw new UploadTokenInvalidError('hmac length mismatch');
  }
  if (!timingSafeEqual(providedHmac, expectedHmac)) {
    throw new UploadTokenInvalidError('hmac mismatch');
  }

  // 解 claims
  let claims: unknown;
  try {
    const json = base64urlDecode(claimsB64).toString('utf8');
    claims = JSON.parse(json);
  } catch {
    throw new UploadTokenInvalidError('claims base64url / json decode failed');
  }
  if (!isValidClaims(claims)) {
    throw new UploadTokenInvalidError('claims schema mismatch');
  }

  // 过期检查
  if (claims.exp <= nowSeconds) {
    throw new UploadTokenExpiredError();
  }
  return claims;
}

function isValidClaims(v: unknown): v is UploadTokenClaims {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.ownerType === 'string' &&
    typeof o.ownerId === 'string' &&
    typeof o.originalName === 'string' &&
    typeof o.mime === 'string' &&
    typeof o.sizeBytes === 'number' &&
    Number.isInteger(o.sizeBytes) &&
    o.sizeBytes >= 0 &&
    typeof o.uploadedByUserId === 'string' &&
    typeof o.iat === 'number' &&
    Number.isInteger(o.iat) &&
    typeof o.exp === 'number' &&
    Number.isInteger(o.exp)
  );
}

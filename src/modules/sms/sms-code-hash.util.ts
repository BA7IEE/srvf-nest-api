import { createHmac, scryptSync } from 'node:crypto';

// 第七刀 F2:短信验证码不再使用裸 sha256(code)。沿 SMS 模块边界复用
// SMS_ENCRYPTION_KEY 作为 env secret,但用独立固定 salt 派生验证码专用 pepper key,
// 避免与凭证 AES key 共用派生结果。pepper 及派生 key 永不落库、日志、响应或 audit。
const PEPPER_KEY_BYTES = 32;
const PEPPER_KEY_DERIVATION_SALT = Buffer.from('srvf-sms-code-hmac-key-derivation-salt-v1', 'utf8');

export class SmsCodePepperUnavailableError extends Error {
  constructor() {
    super('SMS_CODE_PEPPER_UNAVAILABLE: SMS code hashing key is not configured');
    this.name = 'SmsCodePepperUnavailableError';
  }
}

export function deriveSmsCodePepperKey(envSecret: string): Buffer {
  if (!envSecret) {
    throw new SmsCodePepperUnavailableError();
  }
  return scryptSync(envSecret, PEPPER_KEY_DERIVATION_SALT, PEPPER_KEY_BYTES);
}

export function hashSmsVerificationCode(
  input: { phone: string; purpose: string; code: string },
  pepperKey: Buffer,
): string {
  return createHmac('sha256', pepperKey)
    .update(`${input.phone}:${input.purpose}:${input.code}`, 'utf8')
    .digest('hex');
}

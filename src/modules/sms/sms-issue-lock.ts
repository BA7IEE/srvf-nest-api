import type { Prisma, SmsPurpose } from '@prisma/client';
import { createHash } from 'node:crypto';

import { MAINLAND_PHONE_PATTERN } from './sms.constants';

export const SMS_ISSUE_PHONE_LOCK_NAMESPACE = 'srvf:sms:issue:phone:v1';
export const SMS_ISSUE_PHONE_PURPOSE_LOCK_NAMESPACE = 'srvf:sms:issue:phone-purpose:v1';

type PrismaTx = Prisma.TransactionClient;

export interface SmsIssueLockKeys {
  phone: bigint;
  phonePurpose: bigint;
}

// D-SMS:固定 namespace + canonical phone/purpose 经 SHA-256 前 64 bit 派生 signed bigint。
// 只接受既有 DTO/User 存储链保证的大陆 11 位 canonical phone；不 trim、不改写 DB 查询口径。
export function deriveSmsIssueLockKeys(phone: string, purpose: SmsPurpose): SmsIssueLockKeys {
  if (!MAINLAND_PHONE_PATTERN.test(phone)) {
    throw new TypeError('SMS issue lock requires a canonical mainland phone');
  }
  return {
    phone: deriveStableSigned64(SMS_ISSUE_PHONE_LOCK_NAMESPACE, [phone]),
    phonePurpose: deriveStableSigned64(SMS_ISSUE_PHONE_PURPOSE_LOCK_NAMESPACE, [phone, purpose]),
  };
}

// 锁序是跨实例协议的一部分：phone 全局限额锁永远先于 phone+purpose 单活码锁。
// 只用 transaction-scoped lock，随 commit/rollback 自动释放；禁止改成 session lock。
export async function acquireSmsIssueLocks(
  tx: PrismaTx,
  phone: string,
  purpose: SmsPurpose,
): Promise<void> {
  const keys = deriveSmsIssueLockKeys(phone, purpose);
  await tx.$queryRaw<Array<{ locked: string }>>`
    SELECT pg_advisory_xact_lock(${keys.phone})::text AS locked
  `;
  await tx.$queryRaw<Array<{ locked: string }>>`
    SELECT pg_advisory_xact_lock(${keys.phonePurpose})::text AS locked
  `;
}

function deriveStableSigned64(namespace: string, normalizedParts: readonly string[]): bigint {
  const digest = createHash('sha256')
    .update(`${namespace}:${normalizedParts.join(':')}`, 'utf8')
    .digest();
  return digest.readBigInt64BE(0);
}

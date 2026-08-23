import request from 'supertest';

import { SMS_DEV_STUB_FIXED_CODE } from '../../src/modules/sms/sms.constants';
import { httpServer } from '../helpers/http-server';
import { type JourneyRuntime, journeyPrisma } from './journey-runtime';

// 招新实名入口(H5 手机身份链)的**真生产路径**,两条 journey 共用一份。
//
// 立项时(P2-12)这一步是直写 `recruitment_identity_sessions` 起步的 —— 于是
// 「手机号发码 → 验码 → 发一次性 phoneVerificationToken」这条链**在 CI 里一次都没跑过**:
// `recruitment-identity.service.ts` 的 sendCode / verifyCode 整个断掉,journey 照样全绿。
//
// 走真入口的钥匙不是绕过短信,而是 DEV_STUB 通道本身:`sms-code.service.ts` 在
// `providerType === 'DEV_STUB'` 时签发**固定码** `SMS_DEV_STUB_FIXED_CODE`,而
// `journey-runtime.ts` 的 `seedJourneyReferenceData` 已经把 smsSettings 置成 DEV_STUB。
// 因此这里既不手算验证码哈希、也不直插 codes 表 —— 全程真 HTTP。
//
// ⚠️ **只写一份**的理由:另写一份 = 两处对「验证码怎么来的」各自理解,而漂移时没有症状。
const IDENTITY_SEND_CODE = '/api/open/v1/recruitment/identity/send-code';
const IDENTITY_VERIFY_CODE = '/api/open/v1/recruitment/identity/verify-code';

/**
 * 走真入口拿到报名用的一次性 `phoneVerificationToken`。
 *
 * 前置:调用前必须已有**开放轮**(sendCode 的放行条件之一) —— 两条 journey 都先建轮再报名。
 *
 * ⚠️ send-code 是**防枚举**端点:闭轮 + 陌生手机会返回与成功路径逐字节同形的泛化 200
 * 却**不发码零留痕**。所以 200 本身不是「码发出去了」的证据,这里另外钉一次活码存在;
 * 否则前置塌掉时症状会漂到 verify-code 的 24010,读起来像「码错了」。
 */
export async function issuePhoneVerificationToken(
  runtime: JourneyRuntime,
  phone: string,
): Promise<string> {
  const prisma = journeyPrisma(runtime);

  const sent = await request(httpServer(runtime.app)).post(IDENTITY_SEND_CODE).send({ phone });
  if (sent.status !== 200) {
    throw new Error(
      `招新实名发码 expected HTTP 200, got ${sent.status}: ${JSON.stringify(sent.body)}`,
    );
  }

  // 两边非空①:真的落了一条未消费的 RECRUITMENT_BIND 活码(排除防枚举泛化 200)
  const issued = await prisma.smsVerificationCode.findFirst({
    where: { phone, purpose: 'RECRUITMENT_BIND', consumedAt: null, supersededAt: null },
    select: { id: true },
  });
  if (!issued) {
    throw new Error(
      `招新实名发码返回 200 但未落 RECRUITMENT_BIND 活码(phone=${phone})—— ` +
        '多半是调用时还没有开放轮,命中了防枚举泛化 200',
    );
  }

  const verified = await request(httpServer(runtime.app))
    .post(IDENTITY_VERIFY_CODE)
    .send({ phone, code: SMS_DEV_STUB_FIXED_CODE });
  if (verified.status !== 200) {
    throw new Error(
      `招新实名验码 expected HTTP 200, got ${verified.status}: ${JSON.stringify(verified.body)}`,
    );
  }
  const token = String(
    (verified.body.data as { phoneVerificationToken?: string } | undefined)
      ?.phoneVerificationToken ?? '',
  );
  if (!token) {
    throw new Error(`招新实名验码未返回 phoneVerificationToken: ${JSON.stringify(verified.body)}`);
  }

  // 两边非空②:那条活码真的被这次验码消费掉了(证明走的是验码链,不是别处发的 token)
  const consumed = await prisma.smsVerificationCode.findUnique({
    where: { id: issued.id },
    select: { consumedAt: true },
  });
  if (consumed?.consumedAt == null) {
    throw new Error(`招新实名验码成功但活码未被消费(codeId=${issued.id})`);
  }

  return token;
}

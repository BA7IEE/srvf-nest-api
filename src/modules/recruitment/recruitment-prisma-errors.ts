import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

const RECRUITMENT_IDCARD_ACTIVE_INDEX = 'recruitment_applications_cycle_idcard_active_unique';
const RECRUITMENT_OPENID_ACTIVE_INDEX = 'recruitment_applications_cycle_openid_active_unique';
const RECRUITMENT_PHONE_ACTIVE_INDEX = 'recruitment_applications_cycle_phone_active_unique';

/**
 * 招新三身份键 partial unique 的 P2002 → 对外专码。
 * Prisma 的 `meta.target` 按字段数组读取；手写 partial index 在不同 Prisma/PG 组合下也可能
 * 把索引名作为数组项返回，故同时识别字段名与本模块三条固定索引名。未知 P2002 不误吞。
 */
export function recruitmentDuplicateExceptionForP2002(err: unknown): BizException | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return null;
  }
  const target = (err.meta?.target as string[] | undefined) ?? [];
  if (target.includes('idCardNumber') || target.includes(RECRUITMENT_IDCARD_ACTIVE_INDEX)) {
    return new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
  }
  if (target.includes('openid') || target.includes(RECRUITMENT_OPENID_ACTIVE_INDEX)) {
    return new BizException(BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE);
  }
  if (target.includes('phone') || target.includes(RECRUITMENT_PHONE_ACTIVE_INDEX)) {
    return new BizException(BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE);
  }
  return null;
}

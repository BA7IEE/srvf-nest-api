import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { recruitmentDuplicateExceptionForP2002 } from './recruitment-prisma-errors';

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('recruitmentDuplicateExceptionForP2002', () => {
  it.each([
    [['idCardNumber'], BizCode.RECRUITMENT_DUPLICATE_APPLICATION],
    [
      ['recruitment_applications_cycle_openid_active_unique'],
      BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE,
    ],
    [['phone'], BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE],
  ])('按 meta.target 分流三身份键 %#', (target, expected) => {
    const mapped = recruitmentDuplicateExceptionForP2002(p2002(target));
    expect(mapped).not.toBeNull();
    expect(mapped?.biz).toEqual(expected);
  });

  it('未知 P2002 target 不误吞', () => {
    expect(recruitmentDuplicateExceptionForP2002(p2002(['tempNo']))).toBeNull();
  });
});

import { DictItemStatus, DictTypeStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { assertGradeCodeValid, normalizeMemberNo } from './members.policy';

// Phase 6-B 第三刀:Policy 纯判定 characterization spec。
// `assertGradeCodeValid` 的 client 是**入参**(不是 `this.prisma`)—— 本文件因此
// 完全不 import prisma.service,也不起 Nest。

describe('normalizeMemberNo', () => {
  it('去首尾空白', () => {
    expect(normalizeMemberNo('  m-001  ')).toBe('m-001');
  });

  // 编号即身份:与 v1 username 的 toLowerCase 不同,大小写必须保留
  it('保留原大小写(不 toLowerCase)', () => {
    expect(normalizeMemberNo('SRVF-001')).toBe('SRVF-001');
  });

  it('不动中间空白', () => {
    expect(normalizeMemberNo(' a b ')).toBe('a b');
  });
});

describe('assertGradeCodeValid', () => {
  function makeClient(found: { id: string } | null) {
    const findFirst = jest.fn().mockResolvedValue(found);
    return { client: { dictItem: { findFirst } } as never, findFirst };
  }

  it('命中 active dict item → 放行', async () => {
    const { client } = makeClient({ id: 'd1' });
    await expect(assertGradeCodeValid(client, 'level-1')).resolves.toBeUndefined();
  });

  it('未命中 → MEMBER_GRADE_CODE_INVALID', async () => {
    const { client } = makeClient(null);
    await expect(assertGradeCodeValid(client, 'nope')).rejects.toEqual(
      new BizException(BizCode.MEMBER_GRADE_CODE_INVALID),
    );
  });

  // 6 项 AND:item 三项 + type 三项,少一项都可能放行已停用/已软删的等级
  it('where 同时钉住 item 与 type 各三项(code/status/deletedAt)', async () => {
    const { client, findFirst } = makeClient({ id: 'd1' });
    await assertGradeCodeValid(client, 'level-2');
    const calls = findFirst.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>;
    const where = calls[0][0].where;
    expect(where).toEqual({
      code: 'level-2',
      status: DictItemStatus.ACTIVE,
      deletedAt: null,
      type: {
        code: 'member_grade',
        status: DictTypeStatus.ACTIVE,
        deletedAt: null,
      },
    });
  });

  it('用调用方传入的 client(事务内即 tx),不自取连接', async () => {
    const { client, findFirst } = makeClient({ id: 'd1' });
    await assertGradeCodeValid(client, 'level-1');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

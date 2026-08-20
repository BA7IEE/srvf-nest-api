import { MemberStatus, UserStatus } from '@prisma/client';
import { attachAccountInfo } from './members.presenter';
import type { SafeMember } from './members-query.service';
import { memberIdentityData } from '../../../test/helpers/member-identity.fixture';

// Phase 6-B 第三刀:Presenter 纯函数 characterization spec。
// 锁的是对外 DTO 的三个账号字段与「永不泄露 deletedAt」。

const MEMBER: SafeMember = {
  id: 'm1',
  memberNo: 'm-001',
  ...memberIdentityData('张三'),
  nickname: null,
  gradeCode: 'level-1',
  status: MemberStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('attachAccountInfo', () => {
  it('有关联账号 → hasAccount=true,带出 userId 与 accountStatus', () => {
    const dto = attachAccountInfo(MEMBER, { id: 'u1', status: UserStatus.ACTIVE });
    expect(dto).toEqual({
      ...MEMBER,
      // issue #1048 T1 DoD 6:统一展示标签由 presenter 拼(全仓唯一格式来源)。
      label: 'm-001 · 张三',
      hasAccount: true,
      accountStatus: UserStatus.ACTIVE,
      userId: 'u1',
    });
  });

  it('无关联账号 → hasAccount=false,两个字段落 null(不是 undefined / 不省略)', () => {
    const dto = attachAccountInfo(MEMBER, undefined);
    expect(dto.hasAccount).toBe(false);
    expect(dto.accountStatus).toBeNull();
    expect(dto.userId).toBeNull();
  });

  it('DISABLED 账号仍算 hasAccount=true(有号 ≠ 号可用)', () => {
    const dto = attachAccountInfo(MEMBER, { id: 'u1', status: UserStatus.DISABLED });
    expect(dto.hasAccount).toBe(true);
    expect(dto.accountStatus).toBe(UserStatus.DISABLED);
  });

  it('原样透传 member 字段,且不产出 deletedAt', () => {
    const dto = attachAccountInfo(MEMBER, undefined);
    expect(dto.memberNo).toBe('m-001');
    expect(dto.gradeCode).toBe('level-1');
    expect(dto).not.toHaveProperty('deletedAt');
  });

  // DoD 6 的两个分支各钉一条:外号为空**不出括号**、外号非空才出。
  it('label:无外号 → `编号 · 姓名`,不带空括号', () => {
    expect(attachAccountInfo(MEMBER, undefined).label).toBe('m-001 · 张三');
  });

  it('label:有外号 → `编号 · 姓名(外号)`', () => {
    const withNick = { ...MEMBER, nickname: '老张' };
    expect(attachAccountInfo(withNick, undefined).label).toBe('m-001 · 张三(老张)');
  });

  it('不改动入参(纯函数)', () => {
    const snapshot = { ...MEMBER };
    attachAccountInfo(MEMBER, { id: 'u1', status: UserStatus.ACTIVE });
    expect(MEMBER).toEqual(snapshot);
  });
});

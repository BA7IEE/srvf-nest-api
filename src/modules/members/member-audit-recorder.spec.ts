import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { MemberAuditRecorder, type MemberAuditContext } from './member-audit-recorder';

// Phase 6-B 第二刀:6 个 audit 事件的 payload characterization spec。
//
// 这里锁的是**逐字不变**:event 名、resourceType、actor 快照、meta、before/after 与
// extra 的**完整字段集**(用 toEqual 而非 objectContaining —— 后者放行多写的字段,
// 而「不许多写」正是 status-change 那条铁律的一半)。
// 端到端仍由 members-account-lifecycle / members-offboard / wecom-user-lifecycle /
// control-plane-audit-characterization 钉住。

const USER: CurrentUserPayload = {
  id: 'u-actor',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const META = { requestId: 'req-1', ip: '1.2.3.4', ua: 'jest' };
const CTX: MemberAuditContext = { memberId: 'm1', currentUser: USER, auditMeta: META };
const TX = { marker: 'tx' } as never;

/** 六个事件逐字相同的信封部分。 */
const ENVELOPE = {
  actorUserId: 'u-actor',
  actorRoleSnap: Role.ADMIN,
  resourceType: 'member',
  resourceId: 'm1',
  meta: META,
  tx: TX,
};

function makeRecorder() {
  const log = jest.fn().mockResolvedValue(undefined);
  const recorder = new MemberAuditRecorder({ log } as unknown as AuditLogsService);
  return { recorder, log };
}

function payloadOf(log: jest.Mock): Record<string, unknown> {
  const calls = log.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[0][0];
}

describe('MemberAuditRecorder — 事件 payload 逐字不变', () => {
  it('member.account-granted:extra = { memberId, userId, phone(掩码) }', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountGranted(TX, CTX, { userId: 'u-new', phone: '13800000001' });
    expect(payloadOf(log)).toEqual({
      event: 'member.account-granted',
      ...ENVELOPE,
      extra: { memberId: 'm1', userId: 'u-new', phone: '138****0001' },
    });
  });

  it('member.account-bound:extra = { memberId, userId }', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountBound(TX, CTX, { userId: 'u-bound' });
    expect(payloadOf(log)).toEqual({
      event: 'member.account-bound',
      ...ENVELOPE,
      extra: { memberId: 'm1', userId: 'u-bound' },
    });
  });

  it('member.account-unbound:extra = { memberId, userId }', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountUnbound(TX, CTX, { userId: 'u-unbound' });
    expect(payloadOf(log)).toEqual({
      event: 'member.account-unbound',
      ...ENVELOPE,
      extra: { memberId: 'm1', userId: 'u-unbound' },
    });
  });

  it('member.account-reopened:extra 含 oldUserId / newUserId / 掩码 phone / 撤销计数', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountReopened(TX, CTX, {
      oldUserId: 'u-old',
      newUserId: 'u-new',
      phone: '13900000002',
      wecomIdentitiesRevoked: 2,
    });
    expect(payloadOf(log)).toEqual({
      event: 'member.account-reopened',
      ...ENVELOPE,
      extra: {
        memberId: 'm1',
        oldUserId: 'u-old',
        newUserId: 'u-new',
        phone: '139****0002',
        wecomIdentitiesRevoked: 2,
      },
    });
  });

  // T4 / module CLAUDE.md 第 4 条:计数恒写,0 也必须出现在 extra 里
  // (缺字段 = 「这次没撤销」与「这条腿没跑」不可区分)。
  it('member.account-reopened:wecomIdentitiesRevoked=0 也必须落盘(不得省略)', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountReopened(TX, CTX, {
      oldUserId: 'u-old',
      newUserId: 'u-new',
      phone: '13900000002',
      wecomIdentitiesRevoked: 0,
    });
    const extra = payloadOf(log).extra as Record<string, unknown>;
    expect(extra).toHaveProperty('wecomIdentitiesRevoked', 0);
  });

  // module CLAUDE.md 第 6 条:before/after 只含 status;extra 只含
  // linkedUserId / refreshTokensRevoked —— 禁 phone / openid / secret。
  it('member.account.status-change:before/after 只含 status,extra 只含两个字段', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountStatusChanged(TX, CTX, {
      beforeStatus: UserStatus.ACTIVE,
      afterStatus: UserStatus.DISABLED,
      linkedUserId: 'u-linked',
      refreshTokensRevoked: 3,
    });
    expect(payloadOf(log)).toEqual({
      event: 'member.account.status-change',
      ...ENVELOPE,
      before: { status: UserStatus.ACTIVE },
      after: { status: UserStatus.DISABLED },
      extra: { linkedUserId: 'u-linked', refreshTokensRevoked: 3 },
    });
  });

  it('member.offboard:伞事件 extra 恰好 11 个计数腿', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.offboard(TX, CTX, {
      memberDeactivated: true,
      membershipsEnded: 1,
      accountDisabled: true,
      refreshTokensRevoked: 2,
      linkedUserId: 'u-linked',
      positionAssignmentsRevoked: 3,
      supervisionsRevoked: 4,
      activityResponsibilitiesEnded: 5,
      roleBindingsEnded: 6,
      residualActivePositionAssignments: 0,
      residualActiveSupervisions: 0,
    });
    expect(payloadOf(log)).toEqual({
      event: 'member.offboard',
      ...ENVELOPE,
      extra: {
        memberDeactivated: true,
        membershipsEnded: 1,
        accountDisabled: true,
        refreshTokensRevoked: 2,
        linkedUserId: 'u-linked',
        positionAssignmentsRevoked: 3,
        supervisionsRevoked: 4,
        activityResponsibilitiesEnded: 5,
        roleBindingsEnded: 6,
        residualActivePositionAssignments: 0,
        residualActiveSupervisions: 0,
      },
    });
  });

  it('offboard 未关联账号时 linkedUserId 落 null(不是省略)', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.offboard(TX, CTX, {
      memberDeactivated: true,
      membershipsEnded: 0,
      accountDisabled: false,
      refreshTokensRevoked: 0,
      linkedUserId: null,
      positionAssignmentsRevoked: 0,
      supervisionsRevoked: 0,
      activityResponsibilitiesEnded: 0,
      roleBindingsEnded: 0,
      residualActivePositionAssignments: 0,
      residualActiveSupervisions: 0,
    });
    const extra = payloadOf(log).extra as Record<string, unknown>;
    expect(extra).toHaveProperty('linkedUserId', null);
  });

  it('tx 原样透传给 auditLogs.log(事务边界仍归调用方)', async () => {
    const { recorder, log } = makeRecorder();
    await recorder.accountBound(TX, CTX, { userId: 'u' });
    expect(payloadOf(log).tx).toBe(TX);
  });
});

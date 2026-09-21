import { Role, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ParticipationTimeProofQueryService,
  validateParticipationTimeProofRange,
} from './participation-time-proof-query.service';

const user = {
  id: 'user',
  username: 'user',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const query = { dateFrom: '2099-01-01', dateTo: '2099-12-31', page: 1, pageSize: 20 };

function adminHarness(decision: { allow: boolean; reason: string }, globalAllowed = false) {
  const tx = {
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'target-member' }) },
  };
  const prisma = { $transaction: jest.fn((run: (client: object) => unknown) => run(tx)) };
  const authz = { explain: jest.fn().mockResolvedValue(decision) };
  const rbac = { can: jest.fn().mockResolvedValue(globalAllowed) };
  const truth = { readMemberTruthInTx: jest.fn().mockResolvedValue({ items: [] }) };
  const presenter = { present: jest.fn().mockReturnValue({ proofVersion: 1 }) };
  return {
    tx,
    authz,
    rbac,
    truth,
    presenter,
    service: new ParticipationTimeProofQueryService(
      prisma as never,
      authz as never,
      rbac as never,
      {} as never,
      truth as never,
      presenter,
    ),
  };
}

describe('D8-1 proof query orchestration', () => {
  it.each([
    { ...query, dateFrom: '2099-02-30' },
    { ...query, dateFrom: '2099-12-31', dateTo: '2099-01-01' },
    { ...query, dateFrom: '2024-12-31', dateTo: '2099-01-01' },
    { ...query, pageSize: 101 },
  ])('rejects an invalid bounded range %#', (value) => {
    expect(() => validateParticipationTimeProofRange(value)).toThrow();
  });

  it('resolves App self inside the same repeatable-read snapshot', async () => {
    const tx = {};
    const prisma = { $transaction: jest.fn((run: (client: object) => unknown) => run(tx)) };
    const identity = {
      resolve: jest
        .fn()
        .mockResolvedValue({ canUseApp: true, reason: null, member: { id: 'member' } }),
    };
    const truth = { readMemberTruthInTx: jest.fn().mockResolvedValue({ items: [] }) };
    const presenter = { present: jest.fn().mockReturnValue({ proofVersion: 1 }) };
    const service = new ParticipationTimeProofQueryService(
      prisma as never,
      {} as never,
      {} as never,
      identity as never,
      truth as never,
      presenter,
    );
    await expect(service.forCurrentMember(query, user)).resolves.toEqual({ proofVersion: 1 });
    expect(identity.resolve).toHaveBeenCalledWith(user, tx);
    expect(truth.readMemberTruthInTx).toHaveBeenCalledWith(tx, {
      memberId: 'member',
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  });

  it('denies an inactive or missing App member before reading truth', async () => {
    const prisma = { $transaction: jest.fn((run: (client: object) => unknown) => run({})) };
    const truth = { readMemberTruthInTx: jest.fn() };
    const service = new ParticipationTimeProofQueryService(
      prisma as never,
      {} as never,
      {} as never,
      { resolve: jest.fn().mockResolvedValue({ canUseApp: false, member: null }) } as never,
      truth as never,
      {} as never,
    );
    await expect(service.forCurrentMember(query, user)).rejects.toMatchObject({
      biz: BizCode.FORBIDDEN,
    });
    expect(truth.readMemberTruthInTx).not.toHaveBeenCalled();
  });

  it('authorizes the requested admin target through its exact member resource scope', async () => {
    const setup = adminHarness({ allow: true, reason: 'matched' });

    await expect(setup.service.forAdminMember('target-member', query, user)).resolves.toEqual({
      proofVersion: 1,
    });

    expect(setup.authz.explain).toHaveBeenCalledWith(
      user,
      'attendance.read.sheet',
      { type: 'member', id: 'target-member' },
      setup.tx,
    );
    expect(setup.rbac.can).not.toHaveBeenCalled();
    expect(setup.tx.member.findFirst).toHaveBeenCalledWith({
      where: { id: 'target-member', deletedAt: null },
      select: { id: true },
    });
    expect(setup.truth.readMemberTruthInTx).toHaveBeenCalledWith(setup.tx, {
      memberId: 'target-member',
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  });

  it('uses the existing GLOBAL permission only for a resource_not_found fallback', async () => {
    const setup = adminHarness({ allow: false, reason: 'resource_not_found' }, true);

    await expect(setup.service.forAdminMember('target-member', query, user)).resolves.toEqual({
      proofVersion: 1,
    });

    expect(setup.rbac.can).toHaveBeenCalledWith(user, 'attendance.read.sheet', undefined, setup.tx);
    expect(setup.truth.readMemberTruthInTx).toHaveBeenCalled();
  });

  it.each([
    { decision: { allow: false, reason: 'out_of_scope' }, globalAllowed: true },
    { decision: { allow: false, reason: 'resource_not_found' }, globalAllowed: false },
  ])('fails closed after scoped access is revoked %#', async ({ decision, globalAllowed }) => {
    const setup = adminHarness(decision, globalAllowed);

    await expect(setup.service.forAdminMember('target-member', query, user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });

    if (decision.reason === 'out_of_scope') expect(setup.rbac.can).not.toHaveBeenCalled();
    expect(setup.tx.member.findFirst).not.toHaveBeenCalled();
    expect(setup.truth.readMemberTruthInTx).not.toHaveBeenCalled();
  });

  it('returns member-not-found only after authorization and never reads proof truth', async () => {
    const setup = adminHarness({ allow: true, reason: 'matched' });
    setup.tx.member.findFirst.mockResolvedValue(null);

    await expect(setup.service.forAdminMember('missing-member', query, user)).rejects.toMatchObject(
      { biz: BizCode.MEMBER_NOT_FOUND },
    );

    expect(setup.authz.explain).toHaveBeenCalledWith(
      user,
      'attendance.read.sheet',
      { type: 'member', id: 'missing-member' },
      setup.tx,
    );
    expect(setup.truth.readMemberTruthInTx).not.toHaveBeenCalled();
  });
});

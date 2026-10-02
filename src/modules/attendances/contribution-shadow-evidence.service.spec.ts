import { Role, UserStatus, type Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import type { ContributionShadowEvidenceQueryService } from './contribution-shadow-evidence.query.service';
import type { ContributionShadowEvidencePresenter } from './contribution-shadow-evidence.presenter';
import type { ContributionShadowEvidenceAuditRecorder } from './contribution-shadow-evidence.audit-recorder';
import { ContributionShadowEvidenceService } from './contribution-shadow-evidence.service';

const actor = {
  id: 'human-fixture',
  username: 'fixture',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const meta = { requestId: 'fixture-read', ip: null, ua: null };
function fixture() {
  const user = { findFirst: jest.fn().mockResolvedValue(actor) };
  const raw = jest.fn().mockResolvedValue([{ id: 'attempt-fixture' }]);
  const tx = { user, $queryRaw: raw } as unknown as Prisma.TransactionClient;
  const transaction = jest
    .fn()
    .mockImplementation((run: (value: Prisma.TransactionClient) => unknown) => run(tx));
  const rbac = {
    can: jest.fn().mockResolvedValue(true),
    getUserPermissionCodes: jest
      .fn()
      .mockResolvedValue(new Set(['contribution-shadow.read.evidence'])),
  };
  const query = {
    findWindow: jest.fn().mockResolvedValue({ id: 'window-fixture' }),
    windows: jest.fn().mockResolvedValue({ items: [{ id: 'window-fixture' }], total: 1 }),
    summary: jest.fn().mockResolvedValue({ candidateCount: 0 }),
    candidates: jest.fn().mockResolvedValue({ items: [{ auditLogId: 'audit-fixture' }], total: 1 }),
    findAttempt: jest.fn().mockResolvedValue({ id: 'attempt-fixture' }),
    comparisons: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const presenter = {
    window: jest.fn((value: unknown) => value),
    summary: jest.fn((value: unknown) => value),
    candidate: jest.fn((value: unknown) => value),
    comparison: jest.fn((value: unknown) => value),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ContributionShadowEvidenceService(
    { $transaction: transaction } as unknown as PrismaService,
    rbac as unknown as RbacService,
    query as unknown as ContributionShadowEvidenceQueryService,
    presenter as unknown as ContributionShadowEvidencePresenter,
    audit as unknown as ContributionShadowEvidenceAuditRecorder,
  );
  return { service, tx, user, raw, transaction, rbac, query, presenter, audit };
}

describe('D3 evidence reads: current Human, owned transaction and fail-closed audit', () => {
  it.each(['windows', 'summary', 'candidates', 'candidate', 'comparisons'] as const)(
    'qualifies both sides of %s and audits in the same five-second transaction',
    async (operation) => {
      const f = fixture();
      if (operation === 'windows')
        await f.service.listWindows({ page: 2, pageSize: 20 }, actor, meta);
      if (operation === 'summary') await f.service.summary('window-fixture', actor, meta);
      if (operation === 'candidates')
        await f.service.listCandidates('window-fixture', { page: 2, pageSize: 20 }, actor, meta);
      if (operation === 'candidate')
        await f.service.candidate('window-fixture', 'audit-fixture', actor, meta);
      if (operation === 'comparisons')
        await f.service.listComparisons(
          'window-fixture',
          'attempt-fixture',
          { page: 1, pageSize: 20 },
          actor,
          meta,
        );
      expect((f.transaction.mock.calls as unknown[][])[0][1]).toEqual({
        isolationLevel: 'ReadCommitted',
        timeout: 5000,
      });
      expect(f.user.findFirst).toHaveBeenCalledTimes(2);
      expect(f.rbac.can).toHaveBeenCalledTimes(2);
      expect(f.audit.record).toHaveBeenCalledWith(
        f.tx,
        actor,
        meta,
        operation,
        expect.any(Object),
        expect.any(Number),
      );
      for (const call of f.rbac.can.mock.calls)
        expect(call).toEqual([actor, 'contribution-shadow.read.evidence', undefined, f.tx]);
    },
  );
  it.each([Role.SUPER_ADMIN, Role.ADMIN, Role.USER])(
    'rejects %s without an actual read grant before resource lookup',
    async (role) => {
      const f = fixture();
      f.user.findFirst.mockResolvedValue({ ...actor, role });
      f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
      await expect(f.service.summary('missing-window', actor, meta)).rejects.toEqual(
        new BizException(BizCode.FORBIDDEN),
      );
      expect(f.query.findWindow).not.toHaveBeenCalled();
      expect(f.audit.record).not.toHaveBeenCalled();
    },
  );
  it('window/sign grants do not confer evidence read access', async () => {
    const f = fixture();
    f.rbac.getUserPermissionCodes.mockResolvedValue(
      new Set(['contribution-shadow.register.window', 'contribution-shadow.sign.disposition']),
    );
    await expect(f.service.summary('window-fixture', actor, meta)).rejects.toEqual(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('rejects a missing current Human', async () => {
    const f = fixture();
    f.user.findFirst.mockResolvedValue(null);
    await expect(f.service.summary('window-fixture', actor, meta)).rejects.toEqual(
      new BizException(BizCode.UNAUTHORIZED),
    );
    expect(f.query.findWindow).not.toHaveBeenCalled();
  });
  it('does not return data if the final qualification fails', async () => {
    const f = fixture();
    f.rbac.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.service.summary('window-fixture', actor, meta)).rejects.toEqual(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(f.audit.record).not.toHaveBeenCalled();
  });
  it('an audit failure rejects the owned transaction, not a successful response', async () => {
    const f = fixture();
    f.audit.record.mockRejectedValue(new Error('fixture-audit-failure'));
    await expect(f.service.summary('window-fixture', actor, meta)).rejects.toThrow(
      'fixture-audit-failure',
    );
  });
  it('window absence and cross-window attempt use 404 only after qualification', async () => {
    const f = fixture();
    f.query.findWindow.mockResolvedValue(null);
    await expect(
      f.service.candidate('window-fixture', 'audit-fixture', actor, meta),
    ).rejects.toEqual(new BizException(BizCode.NOT_FOUND));
    expect(f.query.candidates).not.toHaveBeenCalled();
    f.query.findWindow.mockResolvedValue({ id: 'window-fixture' });
    f.raw.mockResolvedValue([]);
    await expect(
      f.service.listComparisons(
        'window-fixture',
        'foreign-attempt',
        { page: 1, pageSize: 20 },
        actor,
        meta,
      ),
    ).rejects.toEqual(new BizException(BizCode.NOT_FOUND));
    expect(f.query.comparisons).not.toHaveBeenCalled();
  });
});

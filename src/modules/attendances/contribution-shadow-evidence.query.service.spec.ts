import type { Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ContributionShadowEvidenceQueryService } from './contribution-shadow-evidence.query.service';
function fixture() {
  const audit = {
    readShadowReconciliationPageInTx: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    summarizeShadowReconciliationInTx: jest.fn().mockResolvedValue({ candidateCount: 0 }),
  };
  const windows = {
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const attempts = { findFirst: jest.fn().mockResolvedValue(null) };
  const comparisons = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const tx = {
    contributionShadowObservationWindow: windows,
    contributionShadowAttemptReceipt: attempts,
    contributionShadowComparisonReceipt: comparisons,
  } as unknown as Prisma.TransactionClient;
  return {
    audit,
    windows,
    attempts,
    comparisons,
    tx,
    service: new ContributionShadowEvidenceQueryService(audit as unknown as AuditLogsService),
  };
}
describe('D3 owner queries and bounded read projections', () => {
  it('candidate pagination and selected detail use the audit owner and caller transaction', async () => {
    const f = fixture();
    await f.service.candidates(f.tx, 'window-fixture', 20, 20);
    await f.service.candidates(f.tx, 'window-fixture', 0, 1, 'audit-fixture');
    expect(f.audit.readShadowReconciliationPageInTx.mock.calls).toEqual([
      [f.tx, 'window-fixture', 20, 20, null],
      [f.tx, 'window-fixture', 0, 1, 'audit-fixture'],
    ]);
  });
  it('summary delegates a single window snapshot without loading all candidates', async () => {
    const f = fixture();
    await f.service.summary(f.tx, 'window-fixture');
    expect(f.audit.summarizeShadowReconciliationInTx).toHaveBeenCalledWith(f.tx, 'window-fixture');
    expect(f.audit.readShadowReconciliationPageInTx).not.toHaveBeenCalled();
  });
  it('window projection omits registration authority and personal data', async () => {
    const f = fixture();
    await f.service.findWindow(f.tx, 'window-fixture');
    const input = (f.windows.findUnique.mock.calls as unknown[][])[0][0] as { select: object };
    expect(input.select).not.toHaveProperty('registeredByUserId');
    expect(input.select).not.toHaveProperty('registrationReceipt.select.authorityDigest');
  });
  it('comparison pages are tied to one attempt and omit source/proof bodies', async () => {
    const f = fixture();
    await f.service.comparisons(f.tx, 'attempt-fixture', 20, 20);
    const input = (f.comparisons.findMany.mock.calls as unknown[][])[0][0] as {
      where: object;
      select: object;
      skip: number;
      take: number;
    };
    expect(input.where).toEqual({ attemptId: 'attempt-fixture' });
    expect([input.skip, input.take]).toEqual([20, 20]);
    expect(input.select).not.toHaveProperty('candidateEvidence');
    expect(input.select).not.toHaveProperty('legacySource');
  });
  it('attempt identity includes its window', async () => {
    const f = fixture();
    await f.service.findAttempt(f.tx, 'window-fixture', 'attempt-fixture');
    expect(f.attempts.findFirst).toHaveBeenCalledWith({
      where: { id: 'attempt-fixture', windowId: 'window-fixture' },
      select: { id: true },
    });
  });
});

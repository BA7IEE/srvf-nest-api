import { Prisma } from '@prisma/client';
import { ContributionShadowEvidencePresenter } from './contribution-shadow-evidence.presenter';

const presenter = new ContributionShadowEvidencePresenter();
const window = {
  id: 'window-fixture',
  startsAt: new Date('2099-10-01T00:00:00Z'),
  endsAt: new Date('2099-10-02T00:00:00Z'),
  createdAt: new Date('2099-09-30T00:00:00Z'),
  deploymentDigest: 'a'.repeat(64),
  configDigest: 'b'.repeat(64),
  signedMappingVersion: 'fixture-v1',
  registrationReceipt: null,
};
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    auditLogId: 'audit-fixture',
    createdAt: '2099-10-01T00:00:00.000Z',
    event: 'attendance-sheet.edit',
    operation: 'resubmit',
    comparisonCount: 0,
    equalCount: 0,
    mismatchCount: 0,
    holdCount: 0,
    errorCount: 0,
    reasonCodes: ['missing_start'],
    primaryClassification: 'missing_start',
    rawUnresolved: true,
    netUnresolved: true,
    missingStart: true,
    missingTerminal: false,
    notApplicable: false,
    signatureStatus: 'unsigned',
    ...overrides,
  };
}
const summary = {
  candidateCount: 2,
  attemptCount: 1,
  terminalCount: 0,
  rawMissingStartCount: 1,
  rawMissingTerminalCount: 1,
  rawUnresolvedCount: 2,
  notApplicableCount: 1,
  netUnresolvedCount: 1,
  netMissingStartCount: 0,
  netMissingTerminalCount: 1,
  failedCount: 0,
  mismatchCount: 0,
  holdCount: 0,
  errorCount: 0,
  sourceOrChainAnomalyCount: 0,
  staleSignatureCount: 0,
  anomalousReceiptCount: 0,
};
describe('D3 privacy and raw/net presenter', () => {
  it('legacy windows remain unsigned, without invented registration', () =>
    expect(presenter.window(window)).toMatchObject({
      registrationStatus: 'legacy_unsigned',
      registrationReceiptId: null,
      manifestHash: null,
    }));
  it('exposes only official receipt id/hash, not actor material', () =>
    expect(
      presenter.window({
        ...window,
        registrationReceipt: { id: 'receipt-fixture', manifestHash: 'c'.repeat(64) },
      }),
    ).toMatchObject({
      registrationStatus: 'registered',
      registrationReceiptId: 'receipt-fixture',
    }));
  it('strips context, body, credentials and personal fields rather than spreading a source row', () => {
    const result = presenter.candidate(
      candidate({
        context: { privateBody: 'fixture' },
        candidateEvidence: { privateBody: 'fixture' },
        approvalManifest: {},
        passwordHash: 'private-fixture',
        realName: 'private-fixture',
        phone: 'private-fixture',
      }),
    );
    for (const key of [
      'context',
      'candidateEvidence',
      'approvalManifest',
      'passwordHash',
      'realName',
      'phone',
    ])
      expect(result).not.toHaveProperty(key);
    expect(result).toMatchObject({
      rawUnresolved: true,
      netUnresolved: true,
      candidateEvidenceHash: null,
    });
  });
  it.each(['current', 'stale_evidence', 'unsigned'])(
    'keeps the exact %s signature status',
    (status) =>
      expect(presenter.candidate(candidate({ signatureStatus: status })).signatureStatus).toBe(
        status,
      ),
  );
  it.each([
    { comparisonCount: -1 },
    { holdCount: 0.5 },
    { rawUnresolved: 1 },
    { signatureStatus: 'approved' },
    { reasonCodes: [{}] },
    { reasonCodes: ['arbitrary'] },
  ])('fails closed for malformed allowlisted projection %j', (value) =>
    expect(() => presenter.candidate(candidate(value))).toThrow(TypeError),
  );
  it('preserves raw gaps alongside the independently calculated net gaps', () =>
    expect(presenter.summary(summary, presenter.window(window))).toMatchObject({
      ...summary,
      observationStatus: 'evidence_visible',
    }));
  it.each(['candidateCount', 'attemptCount', 'netUnresolvedCount'] as const)(
    'rejects inconsistent %s arithmetic',
    (key) =>
      expect(() => presenter.summary({ ...summary, [key]: 8 }, presenter.window(window))).toThrow(
        'Inconsistent',
      ),
  );
  it('zero rows are visible as zero_visible_candidates, not success/equal', () => {
    const zero = Object.fromEntries(Object.keys(summary).map((key) => [key, 0]));
    expect(presenter.summary(zero, presenter.window(window)).observationStatus).toBe(
      'zero_visible_candidates',
    );
  });
  it('keeps decimal precision as strings without returning raw evidence', () => {
    const row = {
      id: 'comparison-fixture',
      attemptId: 'attempt-fixture',
      recordId: 'record-fixture',
      memberId: 'member-fixture',
      classificationCode: 'equal',
      comparable: true,
      factHash: 'a'.repeat(64),
      legacySourceHash: 'b'.repeat(64),
      policySourceHash: 'c'.repeat(64),
      legacyPoints: new Prisma.Decimal('0.10'),
      policyPoints: new Prisma.Decimal('0.10'),
      durationSeconds: 1,
      failureCode: null,
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
      createdAt: new Date('2099-10-01T00:00:00Z'),
    };
    expect(presenter.comparison(row)).toMatchObject({
      legacyPoints: '0.1',
      policyPoints: '0.1',
      createdAt: '2099-10-01T00:00:00.000Z',
    });
  });
});

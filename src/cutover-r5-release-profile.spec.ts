import { resolve } from 'node:path';

import {
  ACCEPTANCE_GUARD_TITLES,
  ACCEPTANCE_IDS,
  R5_DEFERRED_ACCEPTANCE_IDS,
  decodeAcceptanceEvidence,
  judgeAcceptanceSuite,
  judgeLimited500Acceptance,
  parseCutoverArgs,
  qualifyReleaseProfile,
} from '../scripts/cutover-check';

function reportFixture() {
  const deferred = new Set<string>(R5_DEFERRED_ACCEPTANCE_IDS);
  const rows = [
    ...ACCEPTANCE_IDS.map((id) => ({
      title: `${id} fixture`,
      status: deferred.has(id) ? 'todo' : 'passed',
    })),
    ...ACCEPTANCE_GUARD_TITLES.map((title) => ({ title, status: 'passed' })),
  ];
  return {
    success: true,
    wasInterrupted: false,
    numTotalTests: 112,
    numPassedTests: 108,
    numTodoTests: 4,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    testResults: [
      {
        name: resolve(
          process.cwd(),
          'src/modules/activities/activity-business-overhaul-acceptance.spec.ts',
        ),
        status: 'passed',
        assertionResults: rows,
      },
    ],
  };
}

type Report = ReturnType<typeof reportFixture>;
function recount(report: Report) {
  const rows = report.testResults[0].assertionResults;
  report.numTotalTests = rows.length;
  report.numPassedTests = rows.filter((r) => r.status === 'passed').length;
  report.numTodoTests = rows.filter((r) => r.status === 'todo').length;
  report.numFailedTests = rows.filter((r) => r.status === 'failed').length;
  report.numPendingTests = rows.filter((r) => r.status === 'pending').length;
  return report;
}
function row(report: Report, id: string) {
  const value = report.testResults[0].assertionResults.find((r) => r.title.startsWith(`${id} `));
  if (!value) throw new Error('Missing unit fixture row');
  return value;
}
const decode = (report: unknown) => decodeAcceptanceEvidence(report, { status: 0, signal: null });

describe('explicit R5 limited500 acceptance profile', () => {
  it('retains four real TODOs and a failing full9a while qualifying only the explicit limited machine profile', () => {
    expect(R5_DEFERRED_ACCEPTANCE_IDS).toEqual(['AC-013', 'AC-017', 'AC-020', 'AC-025']);
    expect(ACCEPTANCE_IDS).toHaveLength(95);
    expect(ACCEPTANCE_GUARD_TITLES).toHaveLength(17);
    const evidence = decode(reportFixture());
    expect(evidence.instrumentErrors).toEqual([]);
    expect(evidence.todo).toBe(4);
    expect(judgeAcceptanceSuite(evidence).ok).toBe(false);
    expect(judgeLimited500Acceptance(evidence).ok).toBe(true);
    const limited = qualifyReleaseProfile('r5-limited500', evidence, ['9a'], true);
    expect(limited.machineOk).toBe(true);
    expect(limited.fullAcceptanceOk).toBe(false);
    expect(limited.deferredIds).toEqual(['AC-013', 'AC-017', 'AC-020', 'AC-025']);
    expect(limited.productionDecision).toBe('NO_GO');
    expect(limited.realDatabaseEvidence).toBe('SEPARATE_SHA_BOUND_RECEIPTS_REQUIRED');
    expect(qualifyReleaseProfile('full', evidence, ['9a'], true).machineOk).toBe(false);
  });

  it.each(['ADV-010', 'AC-001'])(
    'new TODO %s is rejected even with internally consistent counters',
    (id) => {
      const report = reportFixture();
      row(report, id).status = 'todo';
      expect(judgeLimited500Acceptance(decode(recount(report))).ok).toBe(false);
    },
  );
  it.each(['pending', 'failed', 'disabled'])(
    'a deferred ID in state %s is not a legitimate TODO',
    (status) => {
      const report = reportFixture();
      row(report, 'AC-013').status = status;
      expect(judgeLimited500Acceptance(decode(recount(report))).ok).toBe(false);
    },
  );
  it('a guard TODO cannot be hidden among the four deferred acceptance IDs', () => {
    const report = reportFixture();
    report.testResults[0].assertionResults[95].status = 'todo';
    expect(judgeLimited500Acceptance(decode(recount(report))).ok).toBe(false);
  });
  it('unknown numbered ID is rejected', () => {
    const report = reportFixture();
    row(report, 'ADV-010').title = 'ADV-999 fixture';
    expect(decode(report).instrumentErrors.length).toBeGreaterThan(0);
  });
  it('duplicate ID is rejected after recounting', () => {
    const report = reportFixture();
    report.testResults[0].assertionResults.push({ ...row(report, 'ADV-010') });
    expect(decode(recount(report)).instrumentErrors.length).toBeGreaterThan(0);
  });
  it('missing ID is rejected after recounting', () => {
    const report = reportFixture();
    report.testResults[0].assertionResults = report.testResults[0].assertionResults.filter(
      (r) => !r.title.startsWith('ADV-010 '),
    );
    expect(decode(recount(report)).instrumentErrors.length).toBeGreaterThan(0);
  });
  it('missing and renamed guard identities are rejected, not merely counted', () => {
    const missing = reportFixture();
    missing.testResults[0].assertionResults.pop();
    expect(decode(recount(missing)).instrumentErrors.length).toBeGreaterThan(0);
    const renamed = reportFixture();
    renamed.testResults[0].assertionResults[95].title = 'renamed guard ADV-010';
    expect(decode(renamed).instrumentErrors.length).toBeGreaterThan(0);
  });
  it('duplicate guard is rejected even though all 95 acceptance IDs remain', () => {
    const report = reportFixture();
    report.testResults[0].assertionResults.push({ ...report.testResults[0].assertionResults[95] });
    expect(decode(recount(report)).instrumentErrors.length).toBeGreaterThan(0);
  });
  it('counter-only success and contradictory row/counter reports are rejected', () => {
    const report = reportFixture();
    report.testResults = [];
    expect(decode(report).instrumentErrors.length).toBeGreaterThan(0);
    const wrong = reportFixture();
    wrong.numPassedTests++;
    expect(decode(wrong).instrumentErrors.length).toBeGreaterThan(0);
  });
  it.each([undefined, null, {}, 'invalid report', { numTotalTests: 0 }])(
    'malformed/empty report is rejected (%#)',
    (value) => {
      expect(judgeLimited500Acceptance(decode(value)).ok).toBe(false);
    },
  );
  it.each([
    { status: 1, signal: null },
    { status: null, signal: 'SIGTERM' },
    { status: 0, signal: null, error: new Error('spawn failure') },
  ])('valid JSON cannot override abnormal child execution (%#)', (execution) => {
    expect(judgeLimited500Acceptance(decodeAcceptanceEvidence(reportFixture(), execution)).ok).toBe(
      false,
    );
  });
  it.each(['success', 'wasInterrupted', 'numRuntimeErrorTestSuites', 'numPendingTestSuites'])(
    'invalid Jest execution field %s blocks both profiles',
    (field) => {
      const report: Record<string, unknown> = reportFixture();
      report[field] = field === 'success' ? false : field === 'wasInterrupted' ? true : 1;
      const evidence = decode(report);
      expect(judgeAcceptanceSuite(evidence).ok).toBe(false);
      expect(judgeLimited500Acceptance(evidence).ok).toBe(false);
    },
  );
  it('an unrelated suite with identical counters/rows cannot qualify', () => {
    const report = reportFixture();
    report.testResults[0].name = resolve('unrelated.spec.ts');
    expect(judgeLimited500Acceptance(decode(report)).ok).toBe(false);
  });
  it('other machine blockers and invalid human-signoff registry remain hard blockers', () => {
    const evidence = decode(reportFixture());
    expect(qualifyReleaseProfile('r5-limited500', evidence, ['9a', '3a'], true).machineOk).toBe(
      false,
    );
    expect(qualifyReleaseProfile('r5-limited500', evidence, ['9a'], false).machineOk).toBe(false);
  });
});

describe('cutover profile CLI parsing', () => {
  it('defaults to the strict full contract', () => {
    expect(parseCutoverArgs([]).profile).toBe('full');
    expect(parseCutoverArgs(['--json', '--signoff'])).toMatchObject({
      json: true,
      signoff: true,
      profile: 'full',
    });
    expect(parseCutoverArgs(['--selftest']).selftest).toBe(true);
  });
  it('requires an explicit supported limited profile', () => {
    expect(parseCutoverArgs(['--profile', 'r5-limited500', '--json'])).toMatchObject({
      profile: 'r5-limited500',
      json: true,
    });
  });
  it.each(
    [
      ['--profile'],
      ['--profile', 'unknown'],
      ['--profile', 'full'],
      ['--unknown'],
      ['--profile', 'r5-limited500', '--profile', 'r5-limited500'],
      ['--json', '--json'],
      ['--profile', 'r5-limited500', '--signoff'],
      ['--profile', 'r5-limited500', '--selftest'],
      ['--signoff', '--selftest'],
    ].map((argv) => ({ argv })),
  )('rejects incomplete, ambiguous or incompatible arguments (%#)', ({ argv }) => {
    expect(() => parseCutoverArgs(argv)).toThrow();
  });
});

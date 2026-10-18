import {
  E4_DIAGNOSTIC_PLAN,
  requireDiagnosticEnvironment,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';
describe('E4 current one-round diagnostic protocol (offline)', () => {
  it('keeps a diagnostic COMPLETE separate from the existing formal30 failure', () => {
    expect(E4_DIAGNOSTIC_PLAN.acceptance).toBe('NOT_AN_ACCEPTANCE_RESULT');
    expect(E4_DIAGNOSTIC_PLAN.formal30).toBe('FAIL_UNCHANGED');
    expect(E4_DIAGNOSTIC_PLAN.productionTransactionMs).toBe(30000);
  });
  it('fixes one original maximum input,90s transaction and600s process', () => {
    expect(E4_DIAGNOSTIC_PLAN).toMatchObject({
      rounds: 1,
      identities: 2000,
      segments: 10000,
      slices: 50000,
      units: 8000,
      transactionMs: 90000,
      processMs: 600000,
    });
  });
  it('refuses an implicit purpose before registering a database lifecycle', () => {
    expect(() => requireDiagnosticEnvironment({}, 'a'.repeat(40))).toThrow();
  });
  it('does not schedule function statistics or a statistical acceptance judge', () => {
    expect(E4_DIAGNOSTIC_PLAN.guardFunctions).toBe('NOT_RUN');
    expect(Object.keys(E4_DIAGNOSTIC_PLAN)).not.toContain('pairedSamples');
  });
});

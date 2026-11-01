import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';
import {
  assertR5ComponentContinuation,
  R5_COMPONENT_ORIGIN,
  verifyR5ComponentOrigin,
  r5ContinuationClaimPath,
  type R5ComponentContinuation,
} from './r5-setmat-component-continuation';
import { writeR5DurableReceipt } from './r5-setmat-durable-receipt';
import {
  assertR5NativeOnly,
  R5_NATIVE_ONLY_SCOPE,
  r5NativeOnlyClaimPath,
  verifyR5NativeOnlyEvidence,
  type R5NativeOnly,
} from './r5-setmat-native-only';
import {
  assertR5SeparatedComponent,
  R5_SEPARATED_SCOPE,
  r5SeparatedClaimPath,
  verifyR5SeparatedFailure,
  type R5SeparatedComponent,
} from './r5-setmat-separated-policy';

export const R5_CAPACITY_PINS = Object.freeze({
  head: '63711eb714713f208729065aaff57de2800b968a',
  body: 'ccd5167cb30cd2ee587fcba5af63db8e0d44bde6a01b85922f66f1f74681070d',
  catalog: '4535fe4752c1087aae68a50436618ed346c1902fd72eb26c255f0ebf248d9772',
  query: '063ecd8b212bc592acf7f53008cf8769b12f1f0bf846b2f2e4ca8fb9ceb59542',
  manifest: '763ed265939d4a5e4e6e2ea218559f1458a8c25e265ca9d70b9bd3c5a97a1742',
  originalWindowStart: '2026-10-30T00:43:27.677137+00:00',
  originalDeadline: '2026-10-30T01:13:27.677152+00:00',
  handoff: 'libfile_800c2ff5b6788191b620d963e9e21342',
});

export interface CapacityWindow {
  id: string;
  startedAt: string;
  deadline: string;
  dispatchReference: string;
  previousWindow:
    | 'SIX_SAFETY_PASS_CAPACITY_NOT_RUN'
    | 'COMPONENT_COMPARISON_FAIL_ROLLBACK_PROVED'
    | 'DIAGNOSTIC_FACTS_COMPLETE_PHASE_FAIL_NATIVE_NOT_RUN'
    | 'COMPONENT_NOT_REACHED_FAIL_PREPARE_COMMITTED';
}
export interface CapacityConfig {
  schema: 'srvf-r5-capacity/v1';
  mode: 'component1000' | 'full10000';
  base: R5SetmatOwnedConfig;
  outputDirectory: string;
  dispatchFile: string;
  window: CapacityWindow;
  admissionPath?: string;
  componentResultPath?: string;
  continuation?: R5ComponentContinuation;
  separatedComponent?: R5SeparatedComponent;
  nativeOnly?: R5NativeOnly;
  safetyControl: {
    handoffLibraryId: string;
    actualCommitMaxMs: number;
    sourceReceiptSha256: string;
    actualCommitSamples: number;
    coverage: 'EARLY_OPEN_REJECT_NOT_LATE_PAUSE';
  };
}
export function capacityClock(config: CapacityConfig, now: number, reserveMs = 0) {
  assert(Number.isFinite(reserveMs) && reserveMs >= 0);
  const w = config.window;
  assert(w.id && w.dispatchReference, 'explicit coordinator phase dispatch required');
  assert.equal(
    w.previousWindow,
    config.nativeOnly
      ? 'DIAGNOSTIC_FACTS_COMPLETE_PHASE_FAIL_NATIVE_NOT_RUN'
      : config.separatedComponent
        ? 'COMPONENT_COMPARISON_FAIL_ROLLBACK_PROVED'
        : config.continuation
          ? 'COMPONENT_NOT_REACHED_FAIL_PREPARE_COMMITTED'
          : 'SIX_SAFETY_PASS_CAPACITY_NOT_RUN',
  );
  const start = Date.parse(w.startedAt),
    end = Date.parse(w.deadline);
  assert(Number.isFinite(start) && Number.isFinite(end));
  assert(end > start && end - start <= 1_800_000, 'total1800s is immutable');
  if (config.nativeOnly) {
    assert(!config.continuation && !config.separatedComponent);
    assertR5NativeOnly(config.nativeOnly);
    assert.equal(config.mode, 'component1000');
    assert(start >= Date.parse(R5_NATIVE_ONLY_SCOPE.previousCampaignDeadline));
  }
  if (config.separatedComponent) {
    assert(!config.continuation, 'old continuation is consumed');
    assertR5SeparatedComponent(config.separatedComponent);
    assert.equal(config.mode, 'component1000');
    assert(start >= Date.parse(R5_SEPARATED_SCOPE.failedCampaignDeadline));
  }
  if (config.continuation) {
    assertR5ComponentContinuation(config.continuation);
    assert.equal(config.mode, 'component1000');
    assert(
      start >= Date.parse(R5_COMPONENT_ORIGIN.originalCampaignDeadline),
      'closed failed campaign cannot be relabelled',
    );
  }
  assert(
    start >= Date.parse(R5_CAPACITY_PINS.originalDeadline),
    'new capacity phase must not relabel or reset the closed original window',
  );
  assert(
    now >= start &&
      now + reserveMs <
        (config.continuation || config.separatedComponent || config.nativeOnly
          ? Math.min(start + 600000, end)
          : end),
    'capacity window expired/insufficient; no next operation',
  );
}
export function capacityConfig(config: CapacityConfig, now = Date.now()) {
  assert.equal(config.schema, 'srvf-r5-capacity/v1');
  assert(['component1000', 'full10000'].includes(config.mode));
  assert(typeof config.dispatchFile === 'string' && isAbsolute(config.dispatchFile));
  assert.equal(config.base.databaseOid, 1998913);
  assert.equal(config.base.expectedCatalogSha256, R5_CAPACITY_PINS.catalog);
  assert.equal(config.base.catalogQuerySha256, R5_CAPACITY_PINS.query);
  assert.equal(config.base.boundPreflightBodySha256, R5_CAPACITY_PINS.body);
  assert.equal(config.safetyControl.handoffLibraryId, R5_CAPACITY_PINS.handoff);
  assert.equal(config.safetyControl.coverage, 'EARLY_OPEN_REJECT_NOT_LATE_PAUSE');
  assert.equal(config.safetyControl.actualCommitSamples, 3);
  assert.equal(config.safetyControl.actualCommitMaxMs, 36.51422900002217);
  assert.equal(
    config.safetyControl.sourceReceiptSha256,
    '58fb014ab799a72c3627547448a25faa5c57a539626f861157243b7a4052f14b',
  );
  assert(
    Number.isFinite(config.safetyControl.actualCommitMaxMs) &&
      config.safetyControl.actualCommitMaxMs > 0,
  );
  assert(/^[a-f0-9]{64}$/.test(config.safetyControl.sourceReceiptSha256));
  capacityClock(config, now);
  return config;
}
/** Local write-once journals, before opening DB connections. A new output
 * directory cannot consume the same dispatch/mode or full admission twice.
 */
export function claimCapacityAttempt(config: CapacityConfig) {
  const bytes = readFileSync(config.dispatchFile);
  assert.deepEqual(
    JSON.parse(bytes.toString()),
    config.window,
    'dispatch clock must equal the explicit external record',
  );
  const claim = {
    mode: config.mode,
    dispatchSha256: capacityHash(bytes),
    outputDirectory: config.outputDirectory,
    at: new Date().toISOString(),
    automaticRetry: false,
  };
  if (config.nativeOnly) {
    assertR5NativeOnly(config.nativeOnly);
    verifyR5ComponentOrigin(config.nativeOnly.originalEvidenceDirectory);
    verifyR5NativeOnlyEvidence(config.nativeOnly.evidenceDirectory);
    writeR5DurableReceipt(r5NativeOnlyClaimPath(), {
      ...claim,
      nativeOnly: config.nativeOnly,
      oldFailuresPreserved: true,
      diagnosticReplayForbidden: true,
    });
  }
  if (config.separatedComponent) {
    assertR5SeparatedComponent(config.separatedComponent);
    verifyR5ComponentOrigin(config.separatedComponent.originalEvidenceDirectory);
    verifyR5SeparatedFailure(config.separatedComponent.failedEvidenceDirectory);
    writeR5DurableReceipt(r5SeparatedClaimPath(), {
      ...claim,
      separatedComponent: config.separatedComponent,
      originalFailPreserved: true,
      oldClaimReused: false,
    });
  }
  if (config.continuation) {
    assertR5ComponentContinuation(config.continuation);
    verifyR5ComponentOrigin(config.continuation.retainedEvidenceDirectory);
    // Persistent application key, independent of output/dispatch names. A crash
    // consumes it too: inspect outcome; never remove/retry it automatically.
    writeR5DurableReceipt(r5ContinuationClaimPath(), {
      ...claim,
      origin: R5_COMPONENT_ORIGIN,
      originalFailPreserved: true,
      prepareReplayForbidden: true,
    });
  }
  writeFileSync(
    config.dispatchFile + '.' + config.mode + '.attempt.json',
    JSON.stringify(claim, null, 2) + '\n',
    { flag: 'wx' },
  );
  if (config.mode === 'full10000') {
    assert(config.componentResultPath);
    writeFileSync(
      config.componentResultPath + '.FULL10000.attempt.json',
      JSON.stringify(claim, null, 2) + '\n',
      { flag: 'wx' },
    );
  }
}
export const capacityHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export interface CapacityComponentResult {
  schema: 'srvf-r5-capacity-component/v1';
  outcome: 'PASS';
  pins: typeof R5_CAPACITY_PINS;
  runId: string;
  sourceCount: 10000;
  delta: 1000;
  bindingCount: 10000;
  referenceMs: number;
  candidateMs: number;
  ledgerAuditTailMs: number;
  callbackElapsedMs: number;
  databaseOutcome: 'ROLLED_BACK';
  fullManifestRollback: true;
  exactBagParity: true;
  includedLedgerAudit: true;
  includedDeferredTerminalChecks: false;
  includedRealCommit: false;
}
/** Admission is a coordinator decision to attempt one REAL full measurement.
 * No multiplication of component timings is a 10000 result or a budget proof.
 */
export function assertCapacityAdmission(
  component: CapacityComponentResult,
  admission: {
    schema: string;
    componentSha256: string;
    decision: string;
    rationale: string;
    unknownLargeCommitTailAcknowledged: boolean;
  },
  componentBytes: Buffer,
  safetyCommitMs: number,
) {
  assert.equal(component.schema, 'srvf-r5-capacity-component/v1');
  assert(typeof component.runId === 'string' && component.runId.length > 0);
  assert.equal(component.outcome, 'PASS');
  assert.deepEqual(component.pins, R5_CAPACITY_PINS);
  assert.equal(component.databaseOutcome, 'ROLLED_BACK');
  assert(component.fullManifestRollback && component.exactBagParity);
  assert.equal(component.includedLedgerAudit, true);
  assert.equal(component.includedDeferredTerminalChecks, false);
  assert.equal(component.includedRealCommit, false);
  assert(Number.isFinite(safetyCommitMs) && safetyCommitMs > 0);
  assert(Number.isFinite(component.callbackElapsedMs) && component.callbackElapsedMs > 0);
  assert.equal(component.sourceCount, 10000);
  assert.equal(component.delta, 1000);
  assert.equal(component.bindingCount, 10000);
  assert(component.referenceMs > 0 && component.candidateMs > 0 && component.ledgerAuditTailMs > 0);
  assert(
    component.candidateMs <= component.referenceMs * 0.8,
    'predeclared materialization benefit >=20% required',
  );
  assert(
    component.callbackElapsedMs + safetyCommitMs <= 12_000,
    'observed same-version1000 callback plus real small COMMIT needs >=3s headroom',
  );
  assert.equal(admission.schema, 'srvf-r5-capacity-admission/v1');
  assert.equal(admission.componentSha256, capacityHash(componentBytes));
  assert.equal(admission.decision, 'ONE_FRESH_FULL_REAL_MEASUREMENT');
  assert(
    admission.rationale.trim().length >= 20,
    'coordinator must assess unmeasured10000 costs; no automatic scale inference',
  );
  assert.equal(admission.unknownLargeCommitTailAcknowledged, true);
}

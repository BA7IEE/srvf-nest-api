import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import evidence from './r5-setmat-native-only-evidence.json';
import { R5_COMPONENT_ORIGIN, r5ContinuationClaimPath } from './r5-setmat-component-continuation';
import { r5SeparatedClaimPath } from './r5-setmat-separated-policy';
import { capacityTerminalReceipt } from './r5-setmat-capacity.measurement';
import { assertCapacityBags } from './r5-setmat-capacity-projection';
import { assertR5TableManifest } from './r5-setmat-manifest';

export const R5_NATIVE_ONLY_SCOPE = Object.freeze({
  purpose: 'ONE_UNSTARTED_NATIVE15_WITH_TAIL_PROFILE_NO_DIAGNOSTIC_REPLAY',
  applicationId: R5_COMPONENT_ORIGIN.applicationId,
  evidenceLibraryId: evidence.libraryId,
  evidenceZipSha256: evidence.zipSha256,
  historicalDiagnosticXid: '158936',
  historicalFullManifestHash: '92023d1d0c90996a6bb37b9a65dac253c3c27dca4887b722354e7377db27b540',
  previousCampaignDeadline: '2026-10-30T15:23:12.383565+00:00',
  guardPolicy: 'STRICT_ALL',
  newDiagnosticTransactions: 0,
  nativeCandidateTransactions: 1,
  nativeTransactionMs: 15000,
  candidateControlMs: 120000,
  readOnlyTransactionMs: 30000,
  boundaryObservationTransactionMs: 3000,
  normalRealLoginSetup: 3,
  phaseMs: 600000,
  campaignMs: 1800000,
  strictProtectedDatabases: true,
  unknownAndAllOtherBackendsBlock: true,
  oldFailuresPreserved: true,
  realCommitAllowed: false,
  prepareAllowed: false,
  full10000Admission: false,
});
export interface R5NativeOnly {
  schema: 'srvf-r5-native-only-dispatch/v1';
  scope: typeof R5_NATIVE_ONLY_SCOPE;
  authorization: { approved: true; reference: string };
  evidenceDirectory: string;
  originalEvidenceDirectory: string;
}
export function assertR5NativeOnly(v: R5NativeOnly) {
  assert.equal(v.schema, 'srvf-r5-native-only-dispatch/v1');
  assert.deepEqual(v.scope, R5_NATIVE_ONLY_SCOPE);
  assert.equal(
    v.authorization?.approved,
    true,
    'explicit new phase dispatch must cite existing unstarted native15 authorization',
  );
  assert(typeof v.authorization.reference === 'string' && v.authorization.reference.trim());
  assert(isAbsolute(v.evidenceDirectory) && isAbsolute(v.originalEvidenceDirectory));
}
export const r5NativeOnlyClaimPath = () =>
  join(
    R5_COMPONENT_ORIGIN.originalRuntimeDirectory,
    R5_COMPONENT_ORIGIN.applicationId + '.native15-after-f9e8fc88.attempt.json',
  );
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function read(directory: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, path), 'utf8')) as Record<string, unknown>;
}
/** Retains facts from the failed diagnostic, never re-labels its phase PASS. */
export function verifyR5NativeOnlyEvidence(directory: string, verifyClaims = true) {
  assert.deepEqual(read(directory, 'MANIFEST.json'), evidence.manifest);
  for (const f of evidence.manifest.files) {
    assert(!isAbsolute(f.path) && !f.path.split('/').includes('..'));
    const p = join(directory, f.path),
      st = lstatSync(p);
    assert(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.size, f.size);
    assert.equal(hash(readFileSync(p)), f.sha256, f.path);
  }
  if (verifyClaims) {
    assert.equal(
      hash(readFileSync(r5ContinuationClaimPath())),
      '1a1715c52eacf4094ded836994cf2d6f6654d3f84f4e4991324b962becb818ec',
    );
    assert.equal(
      hash(readFileSync(r5SeparatedClaimPath())),
      '74bfc3d0965678fe4cc8e321049bac3b8cfb30c5bc84620b80abab72c764343e',
    );
  }
  const result = read(directory, 'RESULT.json');
  assert.equal(result.state, 'SEPARATED_PHASE_FAIL_EXCLUSIVITY_COUNTER_NATIVE15_NOT_RUN');
  assert.deepEqual(result.executed, {
    businessCorrectnessTransactions: 1,
    nativeCandidate15Transactions: 0,
    newPrepareOrReplay: 0,
    actualHumanCommit: 0,
    full10000: 0,
    normalRealLoginSetup: 3,
    rollbackPolicy:
      'correctness diagnostic120s/control180s only; original requestedHuman15s recorded; source data unchanged; authentication writes included in newbeforeSnapshot',
  });
  const before = read(directory, 'separated/receipts/receipt-0032.json').snapshot;
  const after = read(directory, 'SNAPSHOT-AFTER.json');
  assert.deepEqual(before, after);
  assert.equal(after.hash, R5_NATIVE_ONLY_SCOPE.historicalFullManifestHash);
  assert(Array.isArray(after.tables) && after.tables.every((x) => typeof x === 'string'));
  assertR5TableManifest(after.tables);
  const reference = read(directory, 'separated/receipts/receipt-0040.json');
  const candidate = read(directory, 'separated/receipts/receipt-0041.json');
  assert.deepEqual(candidate.bag, reference.bag);
  assert.equal(candidate.phase, 'MATERIALIZED');
  assert(Array.isArray(candidate.bag));
  assertCapacityBags(candidate.bag, 1000);
  const receipt = read(directory, 'separated/receipts/receipt-0049.json');
  capacityTerminalReceipt(receipt, 'rollback');
  assert.equal(receipt.configuredTimeoutMs, 120000);
  assert.equal(receipt.databaseOutcome, 'ROLLED_BACK');
  assert.equal(receipt.observationComplete, true);
  assert(Array.isArray(receipt.server) && receipt.server.length === 1);
  assert.equal(receipt.server[0].identity.xid, '158936');
  assert.equal(receipt.server[0].identity.databaseOid, 1998913);
  const tail = read(directory, 'separated/receipts/receipt-0042.json');
  assert.equal(tail.actualCommitExecuted, false);
  return {
    diagnosticXid: '158936',
    historicalPhase: 'FAIL_PRESERVED',
    sourceLibraryId: evidence.libraryId,
    completedParityFactsReused: true,
    performanceEvidenceReused: false,
    priorNativeTransactions: 0,
  };
}

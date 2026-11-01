import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { R5_COMPONENT_ORIGIN, r5ContinuationClaimPath } from './r5-setmat-component-continuation';

export const R5_SEPARATED_SCOPE = Object.freeze({
  purpose: 'ONE_CORRECTNESS_DIAGNOSTIC_THEN_ONE_NATIVE_CANDIDATE_ROLLBACK',
  applicationId: R5_COMPONENT_ORIGIN.applicationId,
  failedLibraryId: 'libfile_b1270d880bac81918319d0e1bb43aa12',
  failedZipSha256: 'b2a5cf1e670ad1e427a556140271ac2469d40b6c7c864fffb961eb2e99ebed7a',
  failedXid: '158922',
  failedCampaignDeadline: '2026-10-30T14:25:16.063140+00:00',
  failedFullManifestHash: 'ddc2843d1643b9aac166fbeeffdf7134f2d01ee395ff9e6766857682ffef7cb2',
  writeTransactions: 2,
  diagnosticTransactionMs: 120000,
  diagnosticControlMs: 180000,
  candidateTransactionMs: 15000,
  candidateControlMs: 120000,
  readOnlyTransactionMs: 30000,
  phaseMs: 600000,
  campaignMs: 1800000,
  oldFailurePreserved: true,
  realCommitAllowed: false,
  prepareAllowed: false,
  full10000Admission: false,
});
export interface R5SeparatedComponent {
  schema: 'srvf-r5-separated-component-dispatch/v1';
  scope: typeof R5_SEPARATED_SCOPE;
  authorization: { approved: true; reference: string };
  originalEvidenceDirectory: string;
  failedEvidenceDirectory: string;
}
export function assertR5SeparatedComponent(value: R5SeparatedComponent) {
  assert.equal(value.schema, 'srvf-r5-separated-component-dispatch/v1');
  assert.deepEqual(value.scope, R5_SEPARATED_SCOPE);
  assert.equal(value.authorization?.approved, true, 'NEW diagnostic scope approval required');
  assert(
    typeof value.authorization.reference === 'string' &&
      value.authorization.reference.trim().length > 0,
  );
  assert(isAbsolute(value.originalEvidenceDirectory) && isAbsolute(value.failedEvidenceDirectory));
}
export type R5RollbackObservationPolicy = {
  kind: 'R5_SETMAT_CORRECTNESS_120S' | 'R5_SETMAT_CANDIDATE_15S';
  authorizationReference: string;
};
export function r5RollbackObservationOptions(options: object, policy: R5RollbackObservationPolicy) {
  assert(['R5_SETMAT_CORRECTNESS_120S', 'R5_SETMAT_CANDIDATE_15S'].includes(policy.kind));
  assert(
    typeof policy.authorizationReference === 'string' &&
      policy.authorizationReference.trim().length > 0,
  );
  assert.equal(Reflect.get(options, 'timeout'), 15000, 'exact original Human budget required');
  assert.equal(Reflect.get(options, 'isolationLevel'), 'ReadCommitted');
  // The timed path receives the original object unchanged. Only the explicitly
  // approved correctness diagnostic changes its test transaction ceiling.
  return policy.kind === 'R5_SETMAT_CORRECTNESS_120S' ? { ...options, timeout: 120000 } : options;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const R5_FAILED_FILES = Object.freeze({
  'RESULT.json': '2b26232b96d91188893752c19b17708b9d1e9bf1b1f5e281a76b87e41caee66c',
  'SINGLE-USE-CLAIM-PRESERVED.json':
    '1a1715c52eacf4094ded836994cf2d6f6654d3f84f4e4991324b962becb818ec',
  'SNAPSHOT-ROLLBACK-RESULT.json':
    '048417460df755197213e2e3f8c310fc62874c0cd8acb90891cbdd9d043fdac8',
});
export function verifyR5SeparatedFailure(directory: string) {
  for (const [p, digest] of Object.entries(R5_FAILED_FILES))
    assert.equal(sha(readFileSync(join(directory, p))), digest, p);
  assert.equal(
    sha(readFileSync(r5ContinuationClaimPath())),
    R5_FAILED_FILES['SINGLE-USE-CLAIM-PRESERVED.json'],
    'old consumed claim must remain byte-identical',
  );
}
export const r5SeparatedClaimPath = () =>
  join(
    R5_COMPONENT_ORIGIN.originalRuntimeDirectory,
    R5_COMPONENT_ORIGIN.applicationId + '.separated-component-b1270d88.attempt.json',
  );

import {
  contributionPolicyHash,
  contributionPolicyObject,
  contributionPolicyText,
} from '../activities/activity-contribution-policy-command';
import { computeActivityTemplateDefinitionHash } from '../activities/activity-template-definition';

export const SHADOW_RECONCILIATION_PERMISSIONS = {
  read: 'contribution-shadow.read.evidence',
  register_window: 'contribution-shadow.register.window',
  sign_disposition: 'contribution-shadow.sign.disposition',
} as const;

export const SHADOW_RECONCILIATION_OPERATIONS = [
  'submit',
  'edit',
  'edit-no-records',
  'resubmit',
] as const;

export type ShadowReconciliationDecision = 'unresolved' | 'not_applicable' | 'confirmed_gap';
export type ShadowReconciliationBasis =
  | 'withdraw_previous'
  | 'outside_comparison_contract'
  | 'observed_gap';

interface ShadowReconciliationManifestBase {
  schemaVersion: 1;
  commandKey: string;
  approvalReference: string;
  windowId: string;
}

export interface ShadowWindowRegistrationManifest extends ShadowReconciliationManifestBase {
  operation: 'register_window';
  startsAt: string;
  endsAt: string;
  deploymentDigest: string;
  configDigest: string;
  signedMappingVersion: string;
}

export interface ShadowDispositionRegistrationManifest extends ShadowReconciliationManifestBase {
  operation: 'sign_disposition';
  auditLogId: string;
  expectedPreviousDispositionId: string | null;
  expectedRevision: number;
  decisionCode: ShadowReconciliationDecision;
  basisCode: ShadowReconciliationBasis;
  expectedCandidateEvidenceHash: string;
}

export type ShadowReconciliationManifest =
  | ShadowWindowRegistrationManifest
  | ShadowDispositionRegistrationManifest;

const BASE_KEYS = ['schemaVersion', 'operation', 'commandKey', 'approvalReference', 'windowId'];

/** Identifiers and approval references are controlled codes, never free-form reasons or PII. */
function identifier(value: unknown): string {
  const text = contributionPolicyText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(text))
    throw new TypeError('Invalid reconciliation identifier');
  return text;
}

function instant(value: unknown): string {
  const text = contributionPolicyText(value, 24);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text)
    throw new TypeError('Invalid reconciliation instant');
  return text;
}

/** Pure parsing only. This does not verify approval, identity, deployment or database facts. */
export function parseShadowReconciliationManifest(value: unknown): ShadowReconciliationManifest {
  if (typeof value !== 'object' || value === null || !('operation' in value))
    throw new TypeError('Invalid reconciliation manifest');
  if (value.operation === 'register_window') {
    const root = contributionPolicyObject(value, [
      ...BASE_KEYS,
      'startsAt',
      'endsAt',
      'deploymentDigest',
      'configDigest',
      'signedMappingVersion',
    ]);
    if (root.schemaVersion !== 1) throw new TypeError('Unsupported reconciliation version');
    const startsAt = instant(root.startsAt);
    const endsAt = instant(root.endsAt);
    if (endsAt <= startsAt) throw new TypeError('Invalid reconciliation interval');
    return {
      schemaVersion: 1,
      operation: 'register_window',
      commandKey: identifier(root.commandKey),
      approvalReference: identifier(root.approvalReference),
      windowId: identifier(root.windowId),
      startsAt,
      endsAt,
      deploymentDigest: contributionPolicyHash(root.deploymentDigest),
      configDigest: contributionPolicyHash(root.configDigest),
      signedMappingVersion: identifier(root.signedMappingVersion),
    };
  }
  if (value.operation !== 'sign_disposition')
    throw new TypeError('Unsupported reconciliation operation');
  const root = contributionPolicyObject(value, [
    ...BASE_KEYS,
    'auditLogId',
    'expectedPreviousDispositionId',
    'expectedRevision',
    'decisionCode',
    'basisCode',
    'expectedCandidateEvidenceHash',
  ]);
  if (
    root.schemaVersion !== 1 ||
    typeof root.expectedRevision !== 'number' ||
    !Number.isSafeInteger(root.expectedRevision) ||
    root.expectedRevision < 1 ||
    root.expectedRevision > 2_147_483_647
  )
    throw new TypeError('Invalid reconciliation revision');
  const previous =
    root.expectedPreviousDispositionId === null
      ? null
      : identifier(root.expectedPreviousDispositionId);
  if ((root.expectedRevision === 1) !== (previous === null))
    throw new TypeError('Invalid reconciliation predecessor');
  const decision = root.decisionCode;
  const basis = root.basisCode;
  if (
    !(
      (decision === 'unresolved' && basis === 'withdraw_previous' && previous !== null) ||
      (decision === 'not_applicable' && basis === 'outside_comparison_contract') ||
      (decision === 'confirmed_gap' && basis === 'observed_gap')
    )
  )
    throw new TypeError('Invalid reconciliation decision basis');
  return {
    schemaVersion: 1,
    operation: 'sign_disposition',
    commandKey: identifier(root.commandKey),
    approvalReference: identifier(root.approvalReference),
    windowId: identifier(root.windowId),
    auditLogId: identifier(root.auditLogId),
    expectedPreviousDispositionId: previous,
    expectedRevision: root.expectedRevision,
    decisionCode: decision,
    basisCode: basis,
    expectedCandidateEvidenceHash: contributionPolicyHash(root.expectedCandidateEvidenceHash),
  };
}

export function shadowReconciliationManifestHash(manifest: ShadowReconciliationManifest): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: { domain: 'SRVF:E3-2:shadow-reconciliation:v1', manifest },
  });
}

export function prepareShadowReconciliationManifest(value: unknown, expectedHash: unknown) {
  const manifest = parseShadowReconciliationManifest(value);
  const manifestHash = shadowReconciliationManifestHash(manifest);
  if (manifestHash !== contributionPolicyHash(expectedHash))
    throw new TypeError('Reconciliation manifest digest mismatch');
  return { manifest, manifestHash };
}

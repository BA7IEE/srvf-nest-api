import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseShadowReconciliationManifest,
  prepareShadowReconciliationManifest,
  SHADOW_RECONCILIATION_PERMISSIONS,
  shadowReconciliationManifestHash,
} from './contribution-shadow-reconciliation-command';

const windowManifest = {
  schemaVersion: 1,
  operation: 'register_window',
  commandKey: 'window-command-1',
  approvalReference: 'APPROVAL-2026-001',
  windowId: 'window-d3-1',
  startsAt: '2099-10-03T00:00:00.000Z',
  endsAt: '2099-10-04T00:00:00.000Z',
  deploymentDigest: 'a'.repeat(64),
  configDigest: 'b'.repeat(64),
  signedMappingVersion: 'signed-fixture-v1',
};

const dispositionManifest = {
  schemaVersion: 1,
  operation: 'sign_disposition',
  commandKey: 'disposition-command-1',
  approvalReference: 'APPROVAL-2026-002',
  windowId: 'window-d3-1',
  auditLogId: 'audit-d3-1',
  expectedPreviousDispositionId: null,
  expectedRevision: 1,
  decisionCode: 'not_applicable',
  basisCode: 'outside_comparison_contract',
  expectedCandidateEvidenceHash: 'c'.repeat(64),
};

describe('D3 reconciliation command: pure parsing, not approval', () => {
  it('the actual CLI validates without a database or credentials and rejects private-input failures without leaking them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'srvf-d3-cli-'));
    const manifestPath = join(directory, 'manifest.json');
    const hash = shadowReconciliationManifestHash(
      parseShadowReconciliationManifest(windowManifest),
    );
    writeFileSync(manifestPath, JSON.stringify(windowManifest));
    const args = [
      require.resolve('tsx/cli'),
      'scripts/register-contribution-shadow-reconciliation.ts',
      '--manifest',
      manifestPath,
      '--expected-manifest-hash',
      hash,
    ];
    // Unreachable, deliberately unusable provider. Pure validation must not
    // attempt a connection, read piped credentials, authenticate or register.
    const env = { DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/unavailable' };
    try {
      const preview = spawnSync(process.execPath, args, {
        env,
        input: 'not-json-and-not-a-credential',
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(preview.status).toBe(0);
      expect(preview.stderr).toBe('');
      expect(JSON.parse(preview.stdout) as unknown).toEqual({
        status: 'manifest_validated_only',
        manifestHash: hash,
        operation: 'register_window',
        authenticated: false,
        registered: false,
      });
      for (const input of [
        'private-fixture-marker',
        JSON.stringify({
          registrarDatabaseUrl: env.DATABASE_URL,
          accessToken: 'private-fixture-marker',
          ownerRole: 'forbidden',
        }),
      ]) {
        const rejected = spawnSync(process.execPath, [...args, '--execute'], {
          env,
          input,
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toBe('');
        expect(rejected.stderr).toBe(
          'Reconciliation rejected; credentials and provider details withheld.\n',
        );
        expect(rejected.stderr).not.toContain('private-fixture-marker');
        expect(rejected.stderr).not.toContain(env.DATABASE_URL);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps three distinct permissions separate from the mapping registration permission', () => {
    expect(Object.values(SHADOW_RECONCILIATION_PERMISSIONS)).toEqual([
      'contribution-shadow.read.evidence',
      'contribution-shadow.register.window',
      'contribution-shadow.sign.disposition',
    ]);
  });

  it.each([windowManifest, dispositionManifest])(
    'parses an exact manifest without DB IO',
    (value) => {
      expect(parseShadowReconciliationManifest(value)).toEqual(value);
    },
  );

  it('uses the canonical domain-separated manifest hash independent of key insertion order', () => {
    const parsed = parseShadowReconciliationManifest(windowManifest);
    const reordered = Object.fromEntries(Object.entries(windowManifest).reverse());
    expect(shadowReconciliationManifestHash(parseShadowReconciliationManifest(reordered))).toBe(
      shadowReconciliationManifestHash(parsed),
    );
    expect(
      prepareShadowReconciliationManifest(parsed, shadowReconciliationManifestHash(parsed)),
    ).toEqual({ manifest: parsed, manifestHash: shadowReconciliationManifestHash(parsed) });
  });

  it('rejects a supplied digest belonging to different inputs', () => {
    expect(() => prepareShadowReconciliationManifest(windowManifest, '0'.repeat(64))).toThrow(
      'Reconciliation manifest digest mismatch',
    );
  });

  it.each([
    ['accessToken', 'not-a-real-credential'],
    ['actorUserId', 'untrusted-actor'],
    ['databaseUrl', 'forbidden-connection-input'],
    ['registeredAt', '2099-10-02T00:00:00.000Z'],
    ['candidateEvidence', {}],
    ['notes', 'free-text-not-permitted'],
  ])('rejects extra input field %s rather than silently discarding it', (key, value) => {
    expect(() => parseShadowReconciliationManifest({ ...windowManifest, [key]: value })).toThrow(
      TypeError,
    );
  });

  it.each([
    null,
    [],
    'window',
    { ...windowManifest, schemaVersion: 2 },
    { ...windowManifest, operation: 'bulk_sign' },
  ])('rejects malformed version or operation', (value) => {
    expect(() => parseShadowReconciliationManifest(value)).toThrow(TypeError);
  });

  it.each(['', ' ', 'APPROVAL\n001', '审批自由说明', 'x'.repeat(129)])(
    'rejects uncontrolled approval reference %s',
    (approvalReference) => {
      expect(() =>
        parseShadowReconciliationManifest({ ...windowManifest, approvalReference }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    '2099-10-03',
    '2099-10-03T00:00:00Z',
    '2099-10-03T08:00:00.000+08:00',
    '2099-02-30T00:00:00.000Z',
  ])('requires canonical UTC millisecond instant %s', (startsAt) => {
    expect(() => parseShadowReconciliationManifest({ ...windowManifest, startsAt })).toThrow(
      TypeError,
    );
  });

  it.each(['2099-10-03T00:00:00.000Z', '2099-10-02T23:59:59.999Z'])(
    'rejects empty or backwards observation interval',
    (endsAt) => {
      expect(() => parseShadowReconciliationManifest({ ...windowManifest, endsAt })).toThrow(
        TypeError,
      );
    },
  );

  it.each(['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])(
    'rejects invalid hash %s',
    (configDigest) => {
      expect(() => parseShadowReconciliationManifest({ ...windowManifest, configDigest })).toThrow(
        TypeError,
      );
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, 2_147_483_648, '1'])(
    'rejects invalid bounded revision %s',
    (expectedRevision) => {
      expect(() =>
        parseShadowReconciliationManifest({ ...dispositionManifest, expectedRevision }),
      ).toThrow(TypeError);
    },
  );

  it('rejects revision one with a predecessor', () => {
    expect(() =>
      parseShadowReconciliationManifest({
        ...dispositionManifest,
        expectedPreviousDispositionId: 'prior-d3-1',
      }),
    ).toThrow(TypeError);
  });

  it('rejects later revision without a predecessor', () => {
    expect(() =>
      parseShadowReconciliationManifest({ ...dispositionManifest, expectedRevision: 2 }),
    ).toThrow(TypeError);
  });

  it.each([
    ['not_applicable', 'observed_gap'],
    ['confirmed_gap', 'outside_comparison_contract'],
    ['unresolved', 'withdraw_previous'],
    ['equal', 'observed_gap'],
  ])('rejects invalid decision/basis pair %s / %s', (decisionCode, basisCode) => {
    expect(() =>
      parseShadowReconciliationManifest({ ...dispositionManifest, decisionCode, basisCode }),
    ).toThrow(TypeError);
  });

  it('accepts an explicit later withdrawal without changing or deleting its predecessor', () => {
    const manifest = {
      ...dispositionManifest,
      decisionCode: 'unresolved',
      basisCode: 'withdraw_previous',
      expectedPreviousDispositionId: 'prior-d3-1',
      expectedRevision: 2,
    };
    expect(parseShadowReconciliationManifest(manifest)).toEqual(manifest);
  });

  it('accepts a confirmed gap but cannot prove database eligibility in the parser', () => {
    const manifest = {
      ...dispositionManifest,
      decisionCode: 'confirmed_gap',
      basisCode: 'observed_gap',
    };
    expect(parseShadowReconciliationManifest(manifest)).toEqual(manifest);
  });
});

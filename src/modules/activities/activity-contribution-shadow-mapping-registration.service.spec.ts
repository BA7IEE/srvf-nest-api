import {
  ActivityContributionShadowMappingRegistrationService,
  parseShadowMappingRegistrationManifest,
} from './activity-contribution-shadow-mapping-registration.service';
import { computeActivityTemplateDefinitionHash } from './activity-template-definition';
import { Role, UserStatus, type Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthHumanCommandIdentityService } from '../auth/auth-human-command-identity.service';
import type { RbacService } from '../permissions/rbac.service';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegistrationArguments,
  parseRegistrarCredentialInput,
} from '../../../scripts/register-contribution-shadow-mapping';

function accessFixture() {
  const actor = {
    id: 'fixture-human',
    username: 'fixture-human',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const identity = { authenticate: jest.fn().mockResolvedValue(actor) };
  const rbac = {
    can: jest.fn().mockResolvedValue(true),
    getUserPermissionCodes: jest
      .fn()
      .mockResolvedValue(new Set(['contribution-shadow-mapping.register.approval'])),
  };
  const user = { findFirst: jest.fn().mockResolvedValue(actor) };
  const queryRaw = jest
    .fn<Promise<Array<{ receipt: unknown }>>, [TemplateStringsArray, ...string[]]>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ receipt: { id: 'fixture-receipt' } }]);
  const tx = { user, $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const service = new ActivityContributionShadowMappingRegistrationService(
    identity as unknown as AuthHumanCommandIdentityService,
    rbac as unknown as RbacService,
  );
  return { actor, identity, rbac, user, queryRaw, tx, service };
}

describe('shadow mapping registration manifest', () => {
  const item = () => ({
    approvalNumber: 'fixture-approval',
    mappingVersion: 'fixture-v1',
    activityId: 'fixture-activity',
    activityTypeCode: 'service',
    attendanceRoleCode: 'volunteer',
    sessionPositionId: 'fixture-position',
    policyRoleCode: 'volunteer',
    categoryCode: 'volunteer_service',
    policyVersionId: 'fixture-policy',
    policyDefinitionHash: 'a'.repeat(64),
    evaluatorVersion: 1,
    durationSourceCode: 'legacy_stored_hours_2',
    effectiveFrom: '2099-10-01T00:00:00.000Z',
    effectiveUntil: null,
    eventKindCode: 'approve',
    previousApprovalId: null,
  });
  const input = () => ({
    schemaVersion: 1,
    commandKey: 'fixture-command',
    approvalReference: 'isolated-fixture-only',
    approvals: [item()],
  });

  it('prepares a canonical manifest without treating it as actual approval', () => {
    const value = input();
    const manifest = parseShadowMappingRegistrationManifest(value);
    const expected = computeActivityTemplateDefinitionHash({
      schemaVersion: 1,
      definition: { domain: 'SRVF:E3-2:shadow-mapping-registration:v1', manifest },
    });
    expect(accessFixture().service.prepareManifest(value, expected)).toEqual({
      manifest,
      manifestHash: expected,
    });
    expect(value).toEqual(input());
  });
  it('rejects tampering with the expected digest', () => {
    expect(() => accessFixture().service.prepareManifest(input(), 'b'.repeat(64))).toThrow(
      'digest mismatch',
    );
  });
  it('rejects actor impersonation fields', () => {
    expect(() =>
      parseShadowMappingRegistrationManifest({ ...input(), approvedByUserId: 'forged' }),
    ).toThrow();
    expect(() =>
      parseShadowMappingRegistrationManifest({
        ...input(),
        approvals: [{ ...item(), approved: true }],
      }),
    ).toThrow();
  });
  it('rejects duplicate approval numbers', () => {
    expect(() =>
      parseShadowMappingRegistrationManifest({ ...input(), approvals: [item(), item()] }),
    ).toThrow('Duplicate');
  });
  it.each([
    { evaluatorVersion: 2 },
    { durationSourceCode: 'guessed_span' },
    { categoryCode: 'unknown' },
    { eventKindCode: 'hold' },
    { eventKindCode: ['replace'], previousApprovalId: 'fixture-predecessor' },
    { previousApprovalId: 'forged-predecessor' },
    { eventKindCode: 'revoke' },
    { effectiveFrom: '2026-02-30T00:00:00.000Z' },
    { effectiveUntil: '2099-10-01T00:00:00.000Z' },
    { policyDefinitionHash: 'A'.repeat(64) },
  ])('rejects an invalid item %p', (change) => {
    expect(() =>
      parseShadowMappingRegistrationManifest({ ...input(), approvals: [{ ...item(), ...change }] }),
    ).toThrow();
  });
  it('requires an explicit predecessor for append-only revocation', () => {
    const result = parseShadowMappingRegistrationManifest({
      ...input(),
      approvals: [{ ...item(), eventKindCode: 'revoke', previousApprovalId: 'fixture-prior' }],
    });
    expect(result.approvals[0].previousApprovalId).toBe('fixture-prior');
  });
});

describe('shadow registration authenticated access', () => {
  it('verifies credentials first and re-reads current identity in the caller transaction', async () => {
    const f = accessFixture();
    await expect(f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential')).resolves.toBe(
      f.actor,
    );
    expect(f.identity.authenticate).toHaveBeenCalledWith('synthetic-credential');
    expect(f.user.findFirst).toHaveBeenCalledWith({
      where: { id: f.actor.id, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    expect(f.identity.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      f.user.findFirst.mock.invocationCallOrder[0],
    );
    expect(f.rbac.can).toHaveBeenCalledWith(
      f.actor,
      'contribution-shadow-mapping.register.approval',
      undefined,
      f.tx,
    );
    expect(f.rbac.getUserPermissionCodes).toHaveBeenCalledWith(f.actor.id, undefined, f.tx);
  });

  it('does not read identity or permissions after failed token verification', async () => {
    const f = accessFixture();
    f.identity.authenticate.mockRejectedValue(new BizException(BizCode.UNAUTHORIZED));
    await expect(
      f.service.assertAuthenticatedAccess(f.tx, 'synthetic-invalid'),
    ).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
    expect(f.user.findFirst).not.toHaveBeenCalled();
    expect(f.rbac.can).not.toHaveBeenCalled();
    expect(f.rbac.getUserPermissionCodes).not.toHaveBeenCalled();
  });

  it('rejects a user that became inactive or deleted after authentication', async () => {
    const f = accessFixture();
    f.user.findFirst.mockResolvedValue(null);
    await expect(
      f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential'),
    ).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
    expect(f.rbac.can).not.toHaveBeenCalled();
  });

  it('does not accept SUPER_ADMIN short-circuit without a real GLOBAL grant', async () => {
    const f = accessFixture();
    f.user.findFirst.mockResolvedValue({ ...f.actor, role: Role.SUPER_ADMIN });
    f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
    await expect(
      f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential'),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
  });

  it('requires both service authorization and the explicit GLOBAL permission set', async () => {
    const f = accessFixture();
    f.rbac.can.mockResolvedValue(false);
    await expect(
      f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential'),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(f.rbac.getUserPermissionCodes).not.toHaveBeenCalled();
  });

  it('reverifies the credential and current grant on replay or after a lock wait', async () => {
    const f = accessFixture();
    await f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential');
    f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
    await expect(
      f.service.assertAuthenticatedAccess(f.tx, 'synthetic-credential'),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(f.identity.authenticate).toHaveBeenCalledTimes(2);
    expect(f.user.findFirst).toHaveBeenCalledTimes(2);
    expect(f.rbac.can).toHaveBeenCalledTimes(2);
    expect(f.rbac.getUserPermissionCodes).toHaveBeenCalledTimes(2);
  });
});

describe('shadow mapping registrar transaction orchestration', () => {
  const manifest = () => ({
    schemaVersion: 1,
    commandKey: 'fixture-command',
    approvalReference: 'isolated-fixture-only',
    approvals: [
      {
        approvalNumber: 'fixture-approval',
        mappingVersion: 'fixture-v1',
        activityId: 'fixture-activity',
        activityTypeCode: 'service',
        attendanceRoleCode: 'volunteer',
        sessionPositionId: 'fixture-position',
        policyRoleCode: 'volunteer',
        categoryCode: 'volunteer_service',
        policyVersionId: 'fixture-policy',
        policyDefinitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
        durationSourceCode: 'legacy_stored_hours_2',
        effectiveFrom: '2099-10-01T00:00:00.000Z',
        effectiveUntil: null,
        eventKindCode: 'approve',
        previousApprovalId: null,
      },
    ],
  });
  function input() {
    const value = manifest();
    const expectedHash = computeActivityTemplateDefinitionHash({
      schemaVersion: 1,
      definition: { domain: 'SRVF:E3-2:shadow-mapping-registration:v1', manifest: value },
    });
    return { value, expectedHash };
  }
  it('real CLI default validates only, without database or credential input', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-shadow-cli-'));
    const { value, expectedHash } = input();
    const path = join(temporary, 'manifest.json');
    try {
      writeFileSync(path, JSON.stringify(value));
      const output = execFileSync(
        'pnpm',
        [
          'exec',
          'tsx',
          'scripts/register-contribution-shadow-mapping.ts',
          '--manifest',
          path,
          '--expected-manifest-hash',
          expectedHash,
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const result: unknown = JSON.parse(output);
      expect(result).toEqual({
        status: 'manifest_validated_only',
        manifestHash: expectedHash,
        approvalCount: 1,
        authenticated: false,
        registered: false,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('requires explicit execute and never accepts credentials or actor identity as arguments', () => {
    const args = ['--manifest', 'fixture.json', '--expected-manifest-hash', 'a'.repeat(64)];
    expect(parseRegistrationArguments(args)).toMatchObject({ execute: false });
    expect(parseRegistrationArguments([...args, '--execute'])).toMatchObject({ execute: true });
    expect(() => parseRegistrationArguments([...args, '--access-token', 'synthetic'])).toThrow();
    expect(() => parseRegistrationArguments([...args, '--actor-user-id', 'forged'])).toThrow();
    expect(() => parseRegistrationArguments([...args, '--execute', '--execute'])).toThrow();
  });
  it.each([
    {},
    { registrarDatabaseUrl: 'https://invalid.example/test', accessToken: 'synthetic' },
    { registrarDatabaseUrl: 'postgresql://example.invalid/', accessToken: 'synthetic' },
    { registrarDatabaseUrl: 'postgresql://example.invalid/test', accessToken: ' synthetic ' },
    {
      registrarDatabaseUrl: 'postgresql://example.invalid/test',
      accessToken: 'synthetic',
      actorUserId: 'forged',
    },
  ])('refuses malformed or impersonating private credential input %p', (value) => {
    expect(() => parseRegistrarCredentialInput(value)).toThrow();
  });
  it('locks the command then reverifies Human access before and after the sole SQL registrar call', async () => {
    const f = accessFixture();
    const { value, expectedHash } = input();
    await expect(
      f.service.registerInTx(f.tx, 'synthetic-credential', value, expectedHash),
    ).resolves.toEqual({ id: 'fixture-receipt' });
    expect(f.queryRaw).toHaveBeenCalledTimes(2);
    expect(f.queryRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
    expect(f.queryRaw.mock.calls[0][1]).toBe('SRVF:E3-2:mapping-registration:fixture-command');
    expect(f.queryRaw.mock.calls[1][0].join('')).toContain('csm_register_mapping_fn');
    expect(JSON.parse(f.queryRaw.mock.calls[1][1])).toEqual(value);
    expect(f.queryRaw.mock.calls[1][2]).toBe(f.actor.id);
    expect(JSON.parse(f.queryRaw.mock.calls[1][5])).toHaveLength(1);
    expect(f.identity.authenticate).toHaveBeenCalledTimes(3);
    expect(f.rbac.getUserPermissionCodes).toHaveBeenCalledTimes(3);
    const calls = f.identity.authenticate.mock.invocationCallOrder;
    expect(calls[0]).toBeLessThan(f.queryRaw.mock.invocationCallOrder[0]);
    expect(calls[1]).toBeGreaterThan(f.queryRaw.mock.invocationCallOrder[0]);
    expect(calls[1]).toBeLessThan(f.queryRaw.mock.invocationCallOrder[1]);
    expect(calls[2]).toBeGreaterThan(f.queryRaw.mock.invocationCallOrder[1]);
    expect(f.queryRaw.mock.calls.flat()).not.toContain('synthetic-credential');
  });
  it('does not enter SQL after an invalid manifest digest', async () => {
    const f = accessFixture();
    await expect(
      f.service.registerInTx(f.tx, 'synthetic-credential', manifest(), 'b'.repeat(64)),
    ).rejects.toThrow('digest mismatch');
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(f.identity.authenticate).not.toHaveBeenCalled();
  });
  it('rejects revoked authorization after the command lock without entering the writer', async () => {
    const f = accessFixture();
    const { value, expectedHash } = input();
    f.rbac.getUserPermissionCodes
      .mockReset()
      .mockResolvedValueOnce(new Set(['contribution-shadow-mapping.register.approval']))
      .mockResolvedValueOnce(new Set());
    await expect(
      f.service.registerInTx(f.tx, 'synthetic-credential', value, expectedHash),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
  });
  it('throws within the caller transaction if the token expires while SQL waits for locks', async () => {
    const f = accessFixture();
    const { value, expectedHash } = input();
    f.identity.authenticate
      .mockReset()
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce(f.actor)
      .mockRejectedValueOnce(new BizException(BizCode.UNAUTHORIZED));
    await expect(
      f.service.registerInTx(f.tx, 'synthetic-credential', value, expectedHash),
    ).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
    expect(f.queryRaw).toHaveBeenCalledTimes(2);
  });
});

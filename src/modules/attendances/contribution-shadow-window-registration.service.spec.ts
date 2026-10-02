import { Role, UserStatus, type Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthHumanCommandIdentityService } from '../auth/auth-human-command-identity.service';
import type { RbacService } from '../permissions/rbac.service';
import {
  shadowReconciliationManifestHash,
  type ShadowWindowRegistrationManifest,
} from './contribution-shadow-reconciliation-command';
import { ContributionShadowWindowRegistrationService } from './contribution-shadow-window-registration.service';

const manifest: ShadowWindowRegistrationManifest = {
  schemaVersion: 1,
  operation: 'register_window',
  commandKey: 'fixture-command',
  approvalReference: 'FIXTURE-1',
  windowId: 'fixture-window',
  startsAt: '2099-10-01T00:00:00.000Z',
  endsAt: '2099-10-02T00:00:00.000Z',
  deploymentDigest: 'a'.repeat(64),
  configDigest: 'b'.repeat(64),
  signedMappingVersion: 'fixture-v1',
};

function fixture() {
  const actor = {
    id: 'fixture-human',
    username: 'fixture-human',
    role: Role.ADMIN as Role,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const identity = { authenticate: jest.fn().mockResolvedValue(actor) };
  const rbac = {
    can: jest.fn().mockResolvedValue(true),
    getUserPermissionCodes: jest
      .fn()
      .mockResolvedValue(new Set(['contribution-shadow.register.window'])),
  };
  const receipt = { receiptId: 'fixture-receipt', windowId: 'fixture-window', replayed: false };
  const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ receipt }]);
  const user = { findFirst: jest.fn().mockResolvedValue(actor) };
  const tx = { user, $queryRaw: query } as unknown as Prisma.TransactionClient;
  const service = new ContributionShadowWindowRegistrationService(
    identity as unknown as AuthHumanCommandIdentityService,
    rbac as unknown as RbacService,
  );
  return { actor, identity, rbac, receipt, query, user, tx, service };
}

describe('D3 window registration: current real Human and caller-owned transaction', () => {
  it('authenticates before the lock, after the lock and after SQL execution', async () => {
    const f = fixture();
    await expect(
      f.service.registerInTx(
        f.tx,
        'private-fixture-token',
        manifest,
        shadowReconciliationManifestHash(manifest),
      ),
    ).resolves.toEqual(f.receipt);
    expect(f.identity.authenticate).toHaveBeenCalledTimes(3);
    expect(f.rbac.can).toHaveBeenCalledTimes(3);
    for (const call of f.rbac.can.mock.calls)
      expect(call).toEqual([f.actor, 'contribution-shadow.register.window', undefined, f.tx]);
    for (const call of f.rbac.getUserPermissionCodes.mock.calls)
      expect(call).toEqual([f.actor.id, undefined, f.tx]);
    const statement = (f.query.mock.calls as unknown[][])[1][0] as TemplateStringsArray;
    expect(statement.join('')).toContain('csd3_register_fn');
    expect(f.query.mock.calls.flat()).not.toContain('private-fixture-token');
  });

  it.each([Role.ADMIN, Role.SUPER_ADMIN, Role.USER])(
    'rejects %s with can=true but no actual explicit grant',
    async (role) => {
      const f = fixture();
      f.actor.role = role;
      f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
      await expect(
        f.service.registerInTx(
          f.tx,
          'fixture-token',
          manifest,
          shadowReconciliationManifestHash(manifest),
        ),
      ).rejects.toEqual(new BizException(BizCode.FORBIDDEN));
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it('does not accept sign or read grants as window permission', async () => {
    const f = fixture();
    f.rbac.getUserPermissionCodes.mockResolvedValue(
      new Set(['contribution-shadow.sign.disposition', 'contribution-shadow.read.evidence']),
    );
    await expect(
      f.service.registerInTx(
        f.tx,
        'fixture-token',
        manifest,
        shadowReconciliationManifestHash(manifest),
      ),
    ).rejects.toEqual(new BizException(BizCode.FORBIDDEN));
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects current inactive or missing identity before resource access', async () => {
    const f = fixture();
    f.user.findFirst.mockResolvedValue(null);
    await expect(
      f.service.registerInTx(
        f.tx,
        'fixture-token',
        manifest,
        shadowReconciliationManifestHash(manifest),
      ),
    ).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each([2, 3])(
    'fails closed when qualification expires at authentication round %s',
    async (round) => {
      const f = fixture();
      f.identity.authenticate.mockReset();
      for (let i = 1; i < round; i++) f.identity.authenticate.mockResolvedValueOnce(f.actor);
      f.identity.authenticate.mockRejectedValueOnce(new BizException(BizCode.UNAUTHORIZED));
      await expect(
        f.service.registerInTx(
          f.tx,
          'fixture-token',
          manifest,
          shadowReconciliationManifestHash(manifest),
        ),
      ).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
      expect(f.query).toHaveBeenCalledTimes(round === 2 ? 1 : 2);
    },
  );

  it('rejects a changed actor after a lock wait', async () => {
    const f = fixture();
    f.user.findFirst
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce({ ...f.actor, id: 'other-human' });
    await expect(
      f.service.registerInTx(
        f.tx,
        'fixture-token',
        manifest,
        shadowReconciliationManifestHash(manifest),
      ),
    ).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed SQL results without returning arbitrary JSON', async () => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ receipt: { candidateEvidence: {} } }]);
    await expect(
      f.service.registerInTx(
        f.tx,
        'fixture-token',
        manifest,
        shadowReconciliationManifestHash(manifest),
      ),
    ).rejects.toThrow('no valid receipt');
  });
});

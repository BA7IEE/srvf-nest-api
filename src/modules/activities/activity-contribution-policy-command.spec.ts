import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ActivityContributionPolicyCommand,
  parseContributionPolicyReceipt,
  contributionPolicyRequestHash,
} from './activity-contribution-policy-command';

const result = {
  schemaVersion: 1,
  operationCode: 'create_policy',
  policyId: 'policy_id',
  versionId: null,
  definitionHash: null,
  evaluatorVersion: null,
  resultStatusCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
describe('D1-2 receipt and current access', () => {
  async function fixture() {
    const actor = {
      id: 'actor_id',
      username: 'actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const db = {
      user: { findFirst: jest.fn().mockResolvedValue(actor) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      contributionPolicyCommandReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      contributionPolicy: { findFirst: jest.fn().mockResolvedValue({ id: result.policyId }) },
      contributionPolicyVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version_id' }) },
    };
    const prisma = { $transaction: jest.fn((fn: (tx: typeof db) => unknown) => fn(db)) };
    const rbac = {
      can: jest.fn().mockResolvedValue(true),
      getUserPermissionCodes: jest
        .fn()
        .mockResolvedValue(new Set(['contribution-policy.manage.version'])),
    };
    const module = await Test.createTestingModule({
      providers: [
        ActivityContributionPolicyCommand,
        { provide: PrismaService, useValue: prisma },
        { provide: RbacService, useValue: rbac },
      ],
    }).compile();
    const commands = module.get(ActivityContributionPolicyCommand);
    const execute = jest.fn().mockResolvedValue(result);
    const run = () =>
      commands.run({
        user: actor,
        operation: 'create_policy',
        operationKey: 'key',
        policyId: null,
        versionId: null,
        input: { code: 'policy', name: 'Policy' },
        execute,
      });
    const prior = {
      actorUserId: actor.id,
      operationCode: 'create_policy',
      operationKey: 'key',
      policyId: result.policyId,
      versionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      resultJson: result,
      requestHash: contributionPolicyRequestHash('create_policy', null, null, {
        code: 'policy',
        name: 'Policy',
      }),
    };
    return {
      db,
      prisma,
      rbac,
      commands,
      actor,
      execute,
      run,
      prior,
      transactional: module.get(PrismaService),
    };
  }
  it('stores the exact eight-key receipt, with bounded RC transaction', async () => {
    const f = await fixture();
    expect(await f.run()).toEqual(result);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      maxWait: 2000,
      timeout: 5000,
    });
    expect(f.db.contributionPolicyCommandReceipt.create.mock.calls).toMatchObject([
      [
        {
          data: {
            actorUserId: f.actor.id,
            operationKey: 'key',
            evaluatorVersion: null,
            resultJson: result,
          },
        },
      ],
    ]);
    expect(f.rbac.getUserPermissionCodes).toHaveBeenCalledTimes(2);
    expect(f.rbac.getUserPermissionCodes).toHaveBeenLastCalledWith(f.actor.id, undefined, f.db);
  });
  it('does not let an SA bypass an absent explicit GLOBAL grant', async () => {
    const f = await fixture();
    f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
    await expect(f.run()).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rechecks current identity after waiting even when a receipt exists', async () => {
    const f = await fixture();
    f.db.contributionPolicyCommandReceipt.findUnique.mockResolvedValue(f.prior);
    f.db.user.findFirst.mockResolvedValueOnce(f.actor).mockResolvedValueOnce(null);
    await expect(f.run()).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
    expect(f.db.contributionPolicyCommandReceipt.findUnique).not.toHaveBeenCalled();
  });
  it('rechecks current explicit permission after the lock', async () => {
    const f = await fixture();
    f.rbac.getUserPermissionCodes
      .mockResolvedValueOnce(new Set(['contribution-policy.manage.version']))
      .mockResolvedValueOnce(new Set());
    await expect(f.run()).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('replays without executing or creating another receipt', async () => {
    const f = await fixture();
    f.db.contributionPolicyCommandReceipt.findUnique.mockResolvedValue(f.prior);
    expect(await f.run()).toEqual(result);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.db.contributionPolicyCommandReceipt.create).not.toHaveBeenCalled();
  });
  it('rejects same key with different payload', async () => {
    const f = await fixture();
    f.db.contributionPolicyCommandReceipt.findUnique.mockResolvedValue({
      ...f.prior,
      requestHash: 'x',
    });
    await expect(f.run()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    });
  });
  it('rejects a mismatched receipt anchor', async () => {
    const f = await fixture();
    f.db.contributionPolicyCommandReceipt.findUnique.mockResolvedValue({
      ...f.prior,
      policyId: 'other',
    });
    await expect(f.run()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
    });
  });
  it('write grant does not imply the catalogue read grant', async () => {
    const f = await fixture();
    await expect(
      f.transactional.$transaction((tx) =>
        f.commands.assertAccess(tx, f.actor, 'contribution-policy.read.catalog'),
      ),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
  });
  it.each([
    { ...result, actorUserId: 'leak' },
    { ...result, schemaVersion: 2 },
    { ...result, createdAt: '2026-01-01' },
    { ...result, versionId: 'unexpected' },
    { ...result, evaluatorVersion: 1 },
    { ...result, resultStatusCode: 'draft' },
    { ...result, operationCode: 'delete_policy' },
  ])('rejects non-contract receipt %#', (value) => {
    expect(() => parseContributionPolicyReceipt(value)).toThrow();
  });
  it('accepts only the full version anchor for non-policy receipts', () => {
    expect(
      parseContributionPolicyReceipt({
        ...result,
        operationCode: 'create_version',
        versionId: 'version_id',
        definitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
        resultStatusCode: 'draft',
      }),
    ).toEqual(
      expect.objectContaining({
        versionId: 'version_id',
        definitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
      }),
    );
    expect(() =>
      parseContributionPolicyReceipt({
        ...result,
        operationCode: 'create_version',
        versionId: 'version_id',
        definitionHash: 'a'.repeat(64),
        evaluatorVersion: 2,
        resultStatusCode: 'draft',
      }),
    ).toThrow();
  });
  it('canonical request hash is property-order independent and target bound', () => {
    expect(contributionPolicyRequestHash('create_policy', null, null, { b: 2, a: 1 })).toBe(
      contributionPolicyRequestHash('create_policy', null, null, { a: 1, b: 2 }),
    );
    expect(contributionPolicyRequestHash('create_version', 'one', null, {})).not.toBe(
      contributionPolicyRequestHash('create_version', 'two', null, {}),
    );
  });
});

describe('E2 transaction-bound policy owner primitive', () => {
  it('creates only a draft version on the caller transaction without opening another transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    const command = new ActivityContributionPolicyCommand(
      prisma as unknown as PrismaService,
      {} as RbacService,
    );
    const tx = {
      contributionPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'policy' }),
      },
      contributionPolicyVersion: {
        create: jest.fn().mockResolvedValue({ id: 'version', statusCode: 'draft' }),
      },
    };
    await expect(
      command.createDraftCandidateInTx(tx as never, { id: 'actor' } as never, {
        code: 'e2_fixture_policy',
        name: 'E2 fixture',
        definition: {
          defaultResult: { recognizedPoints: '0.00', explanationCode: 'fixture_no_rule' },
          roleRules: [],
        },
        effectiveFrom: '2026-09-25T00:00:00.000Z',
      }),
    ).resolves.toEqual({ policy: { id: 'policy' }, draft: { id: 'version', statusCode: 'draft' } });
    const createCalls = tx.contributionPolicyVersion.create.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(createCalls[0][0].data).toMatchObject({
      policyId: 'policy',
      version: 1,
      statusCode: 'draft',
      createdByUserId: 'actor',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

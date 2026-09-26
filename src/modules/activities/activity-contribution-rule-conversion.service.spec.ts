import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityContributionPolicyCommand } from './activity-contribution-policy-command';
import { ActivityContributionRuleConversionAuditRecorder } from './activity-contribution-rule-conversion-audit-recorder';
import {
  ActivityContributionRuleConversionService,
  type E2FixtureConversionInput,
} from './activity-contribution-rule-conversion.service';
import { buildLegacyContributionCandidate } from './activity-contribution-rule-conversion';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.SUPER_ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const meta = { requestId: 'fixture', ip: null, ua: null };
const source = {
  id: 'source',
  activityTypeCode: 'e2_fixture_example',
  attendanceRoleCode: 'volunteer',
  durationThreshold: '4.00',
  pointsBelow: '1.00',
  pointsAbove: null,
  status: 'ACTIVE' as const,
  deletedAt: null,
  updatedAt: '2026-09-25T00:00:00.000Z',
};
const mapping = {
  activityTypeCode: 'e2_fixture_example',
  timeCategoryCode: 'volunteer_service' as const,
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'fixture_no_rule' },
  roleMappings: [
    {
      sourceRoleCode: 'volunteer',
      targetRoleCode: 'volunteer',
      belowExplanationCode: 'fixture_below',
      aboveExplanationCode: 'fixture_above',
    },
  ],
};
const input: E2FixtureConversionInput = {
  activityTypeCode: source.activityTypeCode,
  policyCode: 'e2_fixture_policy',
  policyName: 'E2 fixture policy',
  effectiveFrom: '2026-09-25T00:00:00.000Z',
  mapping,
  expectedSourceFingerprint: buildLegacyContributionCandidate([source], mapping).sourceFingerprint,
};

function fixture() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ database: 'app_test_w98' }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    contributionRuleConversionReceipt: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contributionPolicyVersion: { findFirst: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((run: (db: unknown) => unknown) => run(tx)) };
  const commands = {
    assertAccess: jest.fn().mockResolvedValue(actor),
    createDraftCandidateInTx: jest.fn().mockResolvedValue({
      policy: { id: 'policy' },
      draft: { id: 'version', definitionHash: 'a'.repeat(64) },
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const sources = { readActiveSources: jest.fn().mockResolvedValue([source]) };
  const service = new ActivityContributionRuleConversionService(
    prisma as unknown as PrismaService,
    commands as unknown as ActivityContributionPolicyCommand,
    audit as unknown as ActivityContributionRuleConversionAuditRecorder,
    sources,
  );
  return { tx, prisma, commands, audit, sources, service };
}

describe('E2 fixture-only conversion transaction', () => {
  it('rejects every real type before any database call', async () => {
    const f = fixture();
    await expect(
      f.service.commitFixture(
        {
          ...input,
          activityTypeCode: 'rescue_mission',
          mapping: { ...mapping, activityTypeCode: 'rescue_mission' },
        },
        actor,
        meta,
      ),
    ).rejects.toThrow();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-w98 database before reading old rules or writing anything', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([{ database: 'app_test_w1' }]);
    await expect(f.service.commitFixture(input, actor, meta)).rejects.toThrow();
    expect(f.sources.readActiveSources).not.toHaveBeenCalled();
    expect(f.commands.createDraftCandidateInTx).not.toHaveBeenCalled();
  });

  it('rejects a stale source fingerprint and leaves policy, receipts and audit unwritten', async () => {
    const f = fixture();
    await expect(
      f.service.commitFixture({ ...input, expectedSourceFingerprint: 'b'.repeat(64) }, actor, meta),
    ).rejects.toThrow();
    expect(f.commands.createDraftCandidateInTx).not.toHaveBeenCalled();
    expect(f.tx.contributionRuleConversionReceipt.createMany).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it('creates one draft, source receipt and audit together for an isolated fixture', async () => {
    const f = fixture();
    await expect(f.service.commitFixture(input, actor, meta)).resolves.toEqual({
      policyId: 'policy',
      versionId: 'version',
      replayed: false,
    });
    expect(f.commands.assertAccess).toHaveBeenCalledTimes(2);
    expect(f.commands.createDraftCandidateInTx).toHaveBeenCalledTimes(1);
    expect(f.tx.contributionRuleConversionReceipt.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceRuleId: 'source',
          policyId: 'policy',
          versionId: 'version',
          converterVersion: 1,
        }),
      ],
    });
    expect(f.audit.log).toHaveBeenCalledTimes(1);
  });

  it('replays matching receipts without creating another version, receipt or audit', async () => {
    const f = fixture();
    await f.service.commitFixture(input, actor, meta);
    const createCalls = f.tx.contributionRuleConversionReceipt.createMany.mock
      .calls as unknown as Array<[{ data: Array<Record<string, unknown>> }]>;
    const created = createCalls[0][0].data[0];
    f.tx.contributionRuleConversionReceipt.findMany.mockResolvedValue([created]);
    f.tx.contributionPolicyVersion.findFirst.mockResolvedValue({
      id: 'version',
      policyId: 'policy',
      definitionHash: 'a'.repeat(64),
    });
    await expect(f.service.commitFixture(input, actor, meta)).resolves.toEqual({
      policyId: 'policy',
      versionId: 'version',
      replayed: true,
    });
    expect(f.commands.createDraftCandidateInTx).toHaveBeenCalledTimes(1);
    expect(f.tx.contributionRuleConversionReceipt.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.log).toHaveBeenCalledTimes(1);
  });

  it('rejects a partially written or differently mapped receipt instead of treating it as replay', async () => {
    const f = fixture();
    f.tx.contributionRuleConversionReceipt.findMany.mockResolvedValue([
      {
        sourceRuleId: 'source',
        sourceFingerprint: 'a'.repeat(64),
        mappingFingerprint: 'b'.repeat(64),
        batchFingerprint: 'c'.repeat(64),
        converterVersion: 1,
      },
    ]);
    await expect(f.service.commitFixture(input, actor, meta)).rejects.toThrow();
    expect(f.commands.createDraftCandidateInTx).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});

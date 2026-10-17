import { Prisma, type PrismaClient } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseContributionPolicyDefinition } from '../../src/modules/activities/activity-contribution-policy-definition';
import {
  assertNativeContributionLaunchJson as launchJson,
  assertNativeContributionLaunchPolicies as launchPolicies,
  assertNativeContributionLaunchSpans as launchSpans,
} from '../../src/modules/activities/activity-contribution-launch-policy';
import { ContributionSettlementPolicyError } from '../../src/modules/activities/activity-contribution-settlement-policy';
import {
  AppPrepareTimeSettlementDto,
  AppRecognizeTimeSettlementDto,
} from '../../src/modules/activities/dto/app/app-activity-time-settlement.dto';
import { nativeLaunchSlices } from '../helpers/activity-native-launch.fixture';
import {
  assertNativeLaunchFrozenOracle,
  nativeLaunchAdmissionPolicies,
  nativeLaunchPrepareRequest,
  type NativeLaunchStage,
} from '../helpers/native-launch-live.fixture';

// Offline counterexample inputs only; this suite does not prove a live admission or COMMIT.
describe('native launch minimal lawful counterexample inputs', () => {
  it('accepts the closed schema but rejects three bands with only one role/category', () => {
    const definition = nativeLaunchAdmissionPolicies().shape;
    expect(() => parseContributionPolicyDefinition(definition)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(definition), 'utf8')).toBe(439);
    expect(definition.roleRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules[0].durationBands).toHaveLength(3);
    expect(() => launchJson(definition, 'policyBytes')).not.toThrow();
    expect(() => launchPolicies([{ definitionJson: definition }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });

  it('accepts four categories with sixteen bands each under the old closed schema, but exceeds8192 bytes', () => {
    const definition = nativeLaunchAdmissionPolicies().bytes;
    expect(() => parseContributionPolicyDefinition(definition)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(definition), 'utf8')).toBe(9218);
    expect(definition.roleRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules).toHaveLength(4);
    expect(
      definition.roleRules[0].categoryRules.every((row) => row.durationBands.length === 16),
    ).toBe(true);
    expect(() => launchJson(definition, 'policyBytes')).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
    expect(() => launchPolicies([{ definitionJson: definition }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });

  it('admits short manual slices but rejects the complete three-Beijing-day source span', () => {
    const startsAt = new Date('2020-03-01T08:00:00.000Z');
    const shortStart = new Date('2020-03-03T08:00:00.000Z');
    const endsAt = new Date(shortStart.getTime() + 20_000);
    expect(() => launchSpans([{ startsAt: shortStart, endsAt }])).not.toThrow();
    expect(() => launchSpans([{ startsAt, endsAt }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });
});
describe('native launch request bodies against the actual strict HTTP DTOs', () => {
  const expectation = {
    expectedDraftVersion: 1,
    expectedEvidenceSealId: 'contract_seal',
    expectedEvidenceRevision: 0,
    expectedPopulationRevision: 0,
    expectedWorkflowRevision: 1,
  };
  const options = { whitelist: true, forbidNonWhitelisted: true };

  it('rejects the historical allocation spread at prepare with three whitelist errors', async () => {
    const dto = plainToInstance(AppPrepareTimeSettlementDto, {
      ...expectation,
      operationKey: 'contract_prepare',
      expectedTimeRevision: 0,
    });
    const errors = await validate(dto, options);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'expectedEvidenceRevision',
      'expectedPopulationRevision',
      'expectedWorkflowRevision',
    ]);
    expect(errors.every((error) => error.constraints?.whitelistValidation)).toBe(true);
  });

  it('builds a valid prepare body from the same complete allocation expectation', async () => {
    const body = nativeLaunchPrepareRequest(expectation, 'contract_prepare');
    expect(await validate(plainToInstance(AppPrepareTimeSettlementDto, body), options)).toEqual([]);
    expect(Object.keys(body).sort()).toEqual([
      'expectedDraftVersion',
      'expectedEvidenceSealId',
      'expectedTimeRevision',
      'operationKey',
    ]);
    expect(body.expectedDraftVersion).toBe(expectation.expectedDraftVersion);
    expect(body.expectedEvidenceSealId).toBe(expectation.expectedEvidenceSealId);
  });

  it('keeps those three revision fields valid for the distinct allocation contract', async () => {
    const startsAt = new Date('2020-03-01T08:00:00.000Z');
    const dto = plainToInstance(AppRecognizeTimeSettlementDto, {
      ...expectation,
      operationKey: 'contract_allocate',
      sourceSegmentId: 'contract_segment',
      expectedRevision: 0,
      recognitionModeCode: 'manual',
      manualReason: 'Isolated native launch complete four-category allocation',
      slices: nativeLaunchSlices(startsAt, new Date(startsAt.getTime() + 20_000)),
      evidenceAttachmentIds: [],
    });
    expect(await validate(dto, options)).toEqual([]);
  });
});

// Actual helper, pinned SQL and CI failure shape; every database operation is a local double.
describe('native launch frozen oracle dispatch for unchanged-time copied proofs', () => {
  function fixture(
    options: { documentsEqual?: boolean; predecessorStoredDifferences?: number } = {},
  ) {
    const current = {
      id: 'copied_root',
      sourceKindCode: 'unchanged_time',
      previousContributionRevisionId: 'previous_root',
      sourceSetHash: 's'.repeat(64),
      evaluationSetHash: 'e'.repeat(64),
      evaluationCount: 4,
      recognizedPointsTotal: new Prisma.Decimal('1.00'),
    };
    const previous = {
      ...current,
      id: 'previous_root',
      sourceKindCode: 'time_revision',
      previousContributionRevisionId: null,
    };
    const lookup = jest.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === current.id) return current;
      if (where.id === previous.id) return previous;
      throw new Error('Unexpected oracle root');
    });
    const raw = jest.fn(async (sql: string) => {
      if (sql.startsWith('WITH summary('))
        return [{ rootMatches: true, documentsEqual: options.documentsEqual ?? true }];
      const copied = sql.includes("e4_source_rows('copied_root')");
      return [
        {
          oracleCount: copied ? 0 : 4,
          storedCount: 4,
          expectedDifferences: 0,
          storedDifferences: copied ? 4 : (options.predecessorStoredDifferences ?? 0),
          rootMatches: true,
        },
      ];
    });
    const tx = {
      $executeRawUnsafe: jest.fn(async () => 0),
      $queryRawUnsafe: jest.fn(async () => [
        {
          evaluations: 4,
          functionDifferences: 0,
          storedDifferences: 0,
        },
      ]),
    };
    const db = {
      activitySettlementContributionRevision: { findUniqueOrThrow: lookup },
      $queryRawUnsafe: raw,
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const stage: NativeLaunchStage = async (_label, work) => work();
    return { current, previous, lookup, raw, tx, db: db as unknown as PrismaClient, stage };
  }

  it('checks copied documents and root, then evaluates the predecessor with the unchanged pinned oracle', async () => {
    const f = fixture();
    await assertNativeLaunchFrozenOracle(f.db, f.current, 4, f.stage);
    expect(f.lookup.mock.calls.map(([command]) => command.where.id)).toEqual([
      'copied_root',
      'previous_root',
    ]);
    const canonical = f.raw.mock.calls.filter(([sql]) => sql.startsWith('WITH oracle('));
    expect(canonical).toHaveLength(1);
    expect(canonical[0][0]).toContain("e4_source_rows('previous_root')");
    expect(f.raw.mock.calls.some(([sql]) => sql.startsWith('WITH summary('))).toBe(true);
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('rejects changed copy root fields before accepting the predecessor', async () => {
    const f = fixture();
    f.current.evaluationSetHash = 'changed';
    await expect(assertNativeLaunchFrozenOracle(f.db, f.current, 4, f.stage)).rejects.toThrow(
      'Unchanged-time root fields must equal predecessor',
    );
    expect(f.raw).not.toHaveBeenCalled();
  });

  it('rejects different copied evaluation documents without running the predecessor oracle', async () => {
    const f = fixture({ documentsEqual: false });
    await expect(assertNativeLaunchFrozenOracle(f.db, f.current, 4, f.stage)).rejects.toThrow(
      'Unchanged-time stored documents/root must equal predecessor',
    );
    expect(f.raw.mock.calls.filter(([sql]) => sql.startsWith('WITH oracle('))).toHaveLength(0);
    expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('still rejects a stored difference against the immutable predecessor oracle', async () => {
    const f = fixture({ predecessorStoredDifferences: 1 });
    await expect(assertNativeLaunchFrozenOracle(f.db, f.current, 4, f.stage)).rejects.toThrow();
    expect(f.raw.mock.calls.filter(([sql]) => sql.startsWith('WITH oracle('))).toHaveLength(1);
    expect(f.raw.mock.calls.at(-1)?.[0]).toContain("e4_source_rows('previous_root')");
  });
});

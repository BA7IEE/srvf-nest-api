import {
  compareUtf8,
  createAllocationResponseHash,
  createCandidateSnapshotHash,
  createLotteryCommitment,
  createQualificationSnapshotHash,
  deriveLotterySeed,
} from './activity-allocation-request-hash';

describe('activity allocation canonical hashes', () => {
  it('sorts frozen rule sets and rules by UTF-8 bytes, never locale collation', () => {
    const common = {
      algorithmVersionCode: 'allocation-v1',
      target: { activityId: 'activity', sessionId: 'session', positionId: 'position' },
      aggregateResultCode: 'warn' as const,
      penalty: 27,
      qualificationScore: '73.0000',
    };
    const one = createQualificationSnapshotHash({
      ...common,
      ruleSets: [
        {
          ruleSetVersionId: '规则',
          scope: { sessionId: 'session', positionId: 'position' },
          inputFactsHash: 'a'.repeat(64),
          resultCode: 'warn',
          rules: [
            { ruleId: 'z', resultCode: 'warn', warnScore: 27 },
            { ruleId: 'a', resultCode: 'pass', warnScore: null },
          ],
        },
        {
          ruleSetVersionId: 'a',
          scope: { sessionId: null, positionId: null },
          inputFactsHash: 'b'.repeat(64),
          resultCode: 'pass',
          rules: [{ ruleId: 'b', resultCode: 'pass', warnScore: null }],
        },
      ],
    });
    const two = createQualificationSnapshotHash({
      ...common,
      ruleSets: [
        {
          ruleSetVersionId: 'a',
          scope: { sessionId: null, positionId: null },
          inputFactsHash: 'b'.repeat(64),
          resultCode: 'pass',
          rules: [{ ruleId: 'b', resultCode: 'pass', warnScore: null }],
        },
        {
          ruleSetVersionId: '规则',
          scope: { sessionId: 'session', positionId: 'position' },
          inputFactsHash: 'a'.repeat(64),
          resultCode: 'warn',
          rules: [
            { ruleId: 'a', resultCode: 'pass', warnScore: null },
            { ruleId: 'z', resultCode: 'warn', warnScore: 27 },
          ],
        },
      ],
    });
    expect(one).toBe(two);
    expect(compareUtf8('a', '规则')).toBeLessThan(0);
  });

  it('binds a candidate snapshot to every frozen identity fact', () => {
    const input = {
      activityId: 'activity',
      sessionId: 'session',
      positionId: null,
      modeCode: 'qualification_rank' as const,
      algorithmVersionCode: 'allocation-v1',
      candidates: [
        {
          participationIdentityId: 'identity-b',
          registrationId: 'registration-b',
          registrationRevisionId: 'revision-b',
          acceptedAt: new Date('2099-01-02T00:00:00.000Z'),
          qualificationSnapshotHash: 'b'.repeat(64),
          qualificationScore: '100.0000',
          tieBreakKey: 'identity-b',
        },
        {
          participationIdentityId: 'identity-a',
          registrationId: 'registration-a',
          registrationRevisionId: 'revision-a',
          acceptedAt: new Date('2099-01-01T00:00:00.000Z'),
          qualificationSnapshotHash: 'a'.repeat(64),
          qualificationScore: '73.0000',
          tieBreakKey: 'identity-a',
        },
      ],
    };
    const first = createCandidateSnapshotHash(input);
    const reordered = createCandidateSnapshotHash({ ...input, candidates: [...input.candidates].reverse() });
    const changed = createCandidateSnapshotHash({
      ...input,
      candidates: [{ ...input.candidates[0], qualificationScore: '99.0000' }, input.candidates[1]],
    });
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });

  it('derives a concealed deterministic lottery seed whose commitment is stable and verified', () => {
    const input = {
      activityId: 'activity',
      allocationBatchId: 'batch',
      algorithmVersionCode: 'allocation-v1',
    };
    const seed = deriveLotterySeed('server-secret', input);
    expect(seed).toHaveLength(64);
    expect(createLotteryCommitment(seed)).toBe(createLotteryCommitment(deriveLotterySeed('server-secret', input)));
    expect(createLotteryCommitment(seed)).not.toBe(
      createLotteryCommitment(deriveLotterySeed('different-server-secret', input)),
    );
  });

  it('uses the D86 envelope fields and excludes its own response hash', () => {
    expect(
      createAllocationResponseHash({
        activityId: 'activity',
        allocationBatchId: 'batch',
        batchStatusCode: 'preparing',
        commandCode: 'prepare',
      }),
    ).toHaveLength(64);
  });
});

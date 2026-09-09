import { Prisma, Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityMetricCandidateQueryService } from './activity-metric-candidate-query.service';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';
import {
  fingerprintActivityMetricDefinition,
  fingerprintMetricEnvelope,
} from './activity-metric-definition';
import {
  evaluateActivityMetricRule,
  fingerprintMetricCandidateSources,
  normalizeMetricCandidateSources,
  resolveActivityMetricRuleBinding,
} from './activity-metric-rule';

describe('C3-1 retained candidate read', () => {
  function fixture() {
    const definition = {
      schemaVersion: 1,
      code: 'people',
      version: 1,
      name: '人数',
      configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 2000 },
    };
    const hash = fingerprintActivityMetricDefinition(definition).definitionHash;
    const binding = {
      id: 'binding',
      ...resolveActivityMetricRuleBinding(
        'definition',
        definition,
        hash,
        'actual_participant_count_v1',
        1,
      ),
      definition: {
        ...definition,
        configurationJson: definition.configuration,
        definitionHash: hash,
        statusCode: 'active',
      },
    };
    const inputs = normalizeMetricCandidateSources([
      {
        sourceRevisionId: 'source',
        identityId: 'identity',
        sessionId: 'session',
        memberId: 'private-member',
        checkInAt: new Date('2025-01-01T00:00:00.000Z'),
        checkOutAt: new Date('2025-01-01T01:00:00.000Z'),
        resultCode: 'valid',
      },
    ]);
    const digest = fingerprintMetricCandidateSources('activity', inputs);
    const value = evaluateActivityMetricRule(
      'definition',
      definition,
      hash,
      binding.ruleCode,
      1,
      inputs,
    );
    const candidate = {
      id: 'candidate',
      activityId: 'activity',
      candidateRevision: 1,
      metricSetVersionId: 'set',
      metricSetDefinitionHash: 'a'.repeat(64),
      expectedOutcomeRevision: 0,
      sourceMode: 'participation_segments',
      providerVersion: 1,
      sourceDigest: digest.sourceDigest,
      bindingsDigest: fingerprintMetricEnvelope('activity-metric-candidate-bindings-v1', [
        { id: binding.id, bindingHash: binding.bindingHash },
      ]).definitionHash,
      valueCount: 1,
      sourceCount: 1,
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
      metricSetVersion: { statusCode: 'active' },
      values: [
        {
          definitionId: 'definition',
          definitionHash: hash,
          bindingId: binding.id,
          binding,
          valueJson: value.valueJson,
          valueHash: value.valueHash,
        },
      ],
      sources: inputs.map((row, i) => ({
        ...row,
        checkInAt: new Date(row.checkInAt),
        checkOutAt: new Date(row.checkOutAt),
        sourceFingerprint: digest.sourceFingerprints[i],
      })),
    };
    const activity = {
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: 'set',
      selectedMetricSetDefinitionHash: candidate.metricSetDefinitionHash,
    };
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      activityMetricCandidate: { findFirst: jest.fn().mockResolvedValue(candidate) },
      activityOutcomeRevision: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const tx = db as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn((run: (tx: Prisma.TransactionClient) => unknown) => run(tx)),
    };
    const access = { authorize: jest.fn().mockResolvedValue({ activity }) };
    const source = { readTrusted: jest.fn().mockResolvedValue(digest) };
    const service = new ActivityMetricCandidateQueryService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityOutcomeAccessService,
      source as unknown as ActivityMetricCandidateSourceQuery,
    );
    const run = () =>
      service.get('activity', 'candidate', {
        id: 'actor',
        username: 'actor',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: 'member',
      });
    return { candidate, activity, db, tx, access, source, run };
  }
  it('replays historical inputs and projects only safe values', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.freshness).toBe('fresh');
    expect(result.reproducible).toBe(true);
    expect(result.values[0].value).toBe(1);
    expect(Object.keys(result.values[0]).sort()).toEqual([
      'definitionHash',
      'evaluatorVersion',
      'metricDefinitionId',
      'ruleCode',
      'scale',
      'unitCode',
      'value',
      'valueHash',
    ]);
    for (const text of [
      'private-member',
      'sourceRevisionId',
      'identityId',
      'checkInAt',
      'memberGroupOrdinal',
    ])
      expect(JSON.stringify(result)).not.toContain(text);
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
    expect(f.source.readTrusted).toHaveBeenCalledWith(f.tx, 'activity');
  });
  it('rejects revoked access after waiting for the activity lock', async () => {
    const f = fixture();
    f.access.authorize
      .mockResolvedValueOnce({ activity: f.activity })
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(f.run()).rejects.toBeInstanceOf(BizException);
    expect(f.db.activityMetricCandidate.findFirst).not.toHaveBeenCalled();
  });
  it('does not reveal another activity candidate', async () => {
    const f = fixture();
    f.db.activityMetricCandidate.findFirst.mockResolvedValue(null);
    await expect(f.run()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE,
    });
    expect(f.db.activityMetricCandidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'candidate', activityId: 'activity' } }),
    );
  });
  it.each(['set', 'definition', 'outcome', 'selection', 'source'])(
    'marks changed %s stale without altering history',
    async (change) => {
      const f = fixture();
      if (change === 'set') f.candidate.metricSetVersion.statusCode = 'retired';
      if (change === 'definition') f.candidate.values[0].binding.definition.statusCode = 'retired';
      if (change === 'outcome')
        f.db.activityOutcomeRevision.findFirst.mockResolvedValue({ revision: 1 });
      if (change === 'selection') f.activity.selectedMetricSetVersionId = 'other';
      if (change === 'source')
        f.source.readTrusted.mockResolvedValue({ sourceDigest: 'b'.repeat(64) });
      const result = await f.run();
      expect(result.freshness).toBe('stale');
      expect(result.reproducible).toBe(true);
      expect(result.values[0].value).toBe(1);
    },
  );
  it.each([
    BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE,
    BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED,
  ])('retains reproducible history when current source fails with $code', async (biz) => {
    const f = fixture();
    f.source.readTrusted.mockRejectedValue(new BizException(biz));
    const result = await f.run();
    expect(result.freshness).toBe('unavailable');
    expect(result.reproducible).toBe(true);
    expect(result.values[0].value).toBe(1);
  });
  it.each(['missing', 'sourceHash', 'bindingHash', 'valueHash'])(
    'never reports corrupt retained %s fresh',
    async (change) => {
      const f = fixture();
      if (change === 'missing') f.candidate.sources = [];
      if (change === 'sourceHash') f.candidate.sources[0].sourceFingerprint = 'b'.repeat(64);
      if (change === 'bindingHash') f.candidate.bindingsDigest = 'b'.repeat(64);
      if (change === 'valueHash') f.candidate.values[0].valueHash = 'b'.repeat(64);
      const result = await f.run();
      expect(result.freshness).toBe('unavailable');
      expect(result.reproducible).toBe(false);
      expect(result.values).toEqual([]);
      expect(f.source.readTrusted).not.toHaveBeenCalled();
    },
  );
  it('propagates unexpected infrastructure failures', async () => {
    const f = fixture();
    const error = new Error('database unavailable');
    f.source.readTrusted.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
  });
});

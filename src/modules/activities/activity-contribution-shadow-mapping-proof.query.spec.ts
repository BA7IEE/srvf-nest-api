import type { Prisma } from '@prisma/client';
import { ActivityContributionShadowMappingProofQuery } from './activity-contribution-shadow-mapping-proof.query';

function manifestFixture() {
  const item = {
    approvalNumber: 'fixture-one',
    mappingVersion: 'fixture-v1',
    activityId: 'activity-one',
    activityTypeCode: 'service',
    attendanceRoleCode: 'member',
    sessionPositionId: 'position-one',
    policyRoleCode: 'member',
    categoryCode: 'volunteer_service',
    policyVersionId: 'policy-one',
    policyDefinitionHash: 'a'.repeat(64),
    evaluatorVersion: 1,
    durationSourceCode: 'legacy_stored_hours_2',
    effectiveFrom: '2099-10-01T00:00:00.000Z',
    effectiveUntil: null,
    eventKindCode: 'approve',
    previousApprovalId: null as string | null,
  };
  return {
    schemaVersion: 1,
    commandKey: 'fixture-command',
    approvalReference: 'fixture-only',
    approvals: [item],
  };
}

function fixture() {
  const delegates = {
    activity: { findMany: jest.fn().mockResolvedValue([]) },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
    contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue([]) },
    contributionShadowMappingApproval: { findMany: jest.fn().mockResolvedValue([]) },
    activityContributionPolicySelectionRevision: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return {
    delegates,
    tx: delegates as unknown as Prisma.TransactionClient,
    query: new ActivityContributionShadowMappingProofQuery(),
  };
}

describe('activity-owned shadow mapping proof reads', () => {
  it('reads actual positions in one set with both position and session anchored to the activity', async () => {
    const f = fixture();
    const positions = [{ id: 'position-one', activityId: 'activity-one' }];
    f.delegates.activitySessionPosition.findMany.mockResolvedValue(positions);
    await expect(
      f.query.readComparisonPositions(f.tx, {
        activityId: 'activity-one',
        positionIds: Array.from({ length: 2000 }, () => 'position-one'),
      }),
    ).resolves.toBe(positions);
    expect(f.delegates.activitySessionPosition.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.activitySessionPosition.findMany).toHaveBeenCalledWith({
      where: {
        activityId: 'activity-one',
        id: { in: ['position-one'] },
        deletedAt: null,
        session: { activityId: 'activity-one', deletedAt: null },
      },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        attendanceRoleCode: true,
        session: { select: { id: true, activityId: true } },
      },
      orderBy: { id: 'asc' },
    });
  });

  it('keeps missing comparison positions missing, without registration or name fallback', async () => {
    const f = fixture();
    await expect(
      f.query.readComparisonPositions(f.tx, {
        activityId: 'activity-one',
        positionIds: ['absent-position'],
      }),
    ).resolves.toEqual([]);
    expect(f.delegates.activitySessionPosition.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.activity.findMany).not.toHaveBeenCalled();
  });

  it('does not query positions for an empty candidate set', async () => {
    const f = fixture();
    await expect(
      f.query.readComparisonPositions(f.tx, { activityId: 'activity-one', positionIds: [] }),
    ).resolves.toEqual([]);
    expect(f.delegates.activitySessionPosition.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { activityId: ' activity-one', positionIds: ['position-one'] },
    { activityId: 'activity-one', positionIds: [''] },
  ])('rejects malformed comparison position keys before reading: %j', async (input) => {
    const f = fixture();
    await expect(f.query.readComparisonPositions(f.tx, input)).rejects.toThrow();
    expect(f.delegates.activitySessionPosition.findMany).not.toHaveBeenCalled();
  });

  it('retains cross-version successors in complete source-time comparison history', async () => {
    const f = fixture();
    const sourceTime = new Date('2099-10-01T00:00:00.000Z');
    const events = [
      { mappingVersion: 'old', eventKindCode: 'approve' },
      { mappingVersion: 'new', eventKindCode: 'revoke' },
    ];
    f.delegates.contributionShadowMappingApproval.findMany.mockResolvedValue(events);
    await expect(
      f.query.readComparisonMappingHistory(f.tx, { activityId: 'activity-one', sourceTime }),
    ).resolves.toBe(events);
    expect(f.delegates.contributionShadowMappingApproval.findMany).toHaveBeenCalledWith({
      where: {
        activityId: 'activity-one',
        approvedAt: { lte: sourceTime },
        effectiveFrom: { lte: sourceTime },
      },
      orderBy: [{ approvedAt: 'asc' }, { approvalNumber: 'asc' }],
    });
  });

  it('reads only the latest revision existing at the exact source instant, retaining all item modes', async () => {
    const f = fixture();
    const sourceTime = new Date('2099-10-01T00:00:00.000Z');
    const revision = { id: 'historical', items: [{ mode: 'inherit' }] };
    f.delegates.activityContributionPolicySelectionRevision.findFirst.mockResolvedValue(revision);
    await expect(
      f.query.readSelectionAtSource(f.tx, { activityId: 'activity-one', sourceTime }),
    ).resolves.toBe(revision);
    expect(f.delegates.activityContributionPolicySelectionRevision.findFirst).toHaveBeenCalledWith({
      where: { activityId: 'activity-one', createdAt: { lte: sourceTime } },
      orderBy: { revision: 'desc' },
      select: {
        id: true,
        activityId: true,
        revision: true,
        schemaVersion: true,
        selectionHash: true,
        selectionJson: true,
        itemCount: true,
        createdAt: true,
        items: { where: { activityId: 'activity-one' }, orderBy: { id: 'asc' } },
      },
    });
  });

  it('leaves a missing source-time selection missing instead of querying the current activity pointer', async () => {
    const f = fixture();
    await expect(
      f.query.readSelectionAtSource(f.tx, {
        activityId: 'activity-one',
        sourceTime: new Date('2099-10-01T00:00:00.000Z'),
      }),
    ).resolves.toBeNull();
    expect(f.delegates.activity.findMany).not.toHaveBeenCalled();
    expect(f.delegates.activityContributionPolicySelectionRevision.findFirst).toHaveBeenCalledTimes(
      1,
    );
  });

  it.each([
    { activityId: ' padded' },
    { sourceTime: new Date('invalid') },
    { sourceTime: '2099-10-01T00:00:00.000Z' },
  ])('rejects invalid as-of selection input %p before database access', async (change) => {
    const f = fixture();
    await expect(
      f.query.readSelectionAtSource(f.tx, {
        activityId: 'activity-one',
        sourceTime: new Date('2099-10-01T00:00:00.000Z'),
        ...change,
      } as { activityId: string; sourceTime: Date }),
    ).rejects.toThrow();
    expect(
      f.delegates.activityContributionPolicySelectionRevision.findFirst,
    ).not.toHaveBeenCalled();
  });

  it('uses one exact set query for 2,000 repeated policy references and preserves distinct hashes', async () => {
    const f = fixture();
    const a = { id: 'policy-one', definitionHash: 'a'.repeat(64), evaluatorVersion: 1 };
    const b = { ...a, definitionHash: 'b'.repeat(64) };
    const rows = [{ id: 'policy-one', definitionHash: a.definitionHash }];
    f.delegates.contributionPolicyVersion.findMany.mockResolvedValue(rows);
    await expect(
      f.query.readComparisonPolicyVersions(f.tx, [...Array.from({ length: 2000 }, () => a), b]),
    ).resolves.toBe(rows);
    expect(f.delegates.contributionPolicyVersion.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.contributionPolicyVersion.findMany).toHaveBeenCalledWith({
      where: { OR: [a, b] },
      select: {
        id: true,
        policyId: true,
        definitionHash: true,
        evaluatorVersion: true,
        schemaVersion: true,
        definitionJson: true,
        effectiveFrom: true,
        effectiveUntil: true,
      },
      orderBy: { id: 'asc' },
    });
  });

  it('does not read policies for an empty reference set', async () => {
    const f = fixture();
    await expect(f.query.readComparisonPolicyVersions(f.tx, [])).resolves.toEqual([]);
    expect(f.delegates.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { id: ' padded' },
    { definitionHash: 'invalid' },
    { evaluatorVersion: 0 },
    { evaluatorVersion: 1.5 },
    { evaluatorVersion: Number.NaN },
    { evaluatorVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid policy reference %p before any read', async (change) => {
    const f = fixture();
    await expect(
      f.query.readComparisonPolicyVersions(f.tx, [
        { id: 'policy-one', definitionHash: 'a'.repeat(64), evaluatorVersion: 1, ...change },
      ]),
    ).rejects.toThrow();
    expect(f.delegates.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it('uses three set queries for repeated references, with exact same-activity/version anchors', async () => {
    const f = fixture();
    const manifest = manifestFixture();
    for (let i = 1; i <= 100; i++)
      manifest.approvals.push({ ...manifest.approvals[0], approvalNumber: `fixture-${i}` });
    await expect(f.query.readRegistrationReferences(f.tx, manifest)).resolves.toEqual({
      activities: [],
      sessionPositions: [],
      policies: [],
      previousApprovals: [],
    });
    expect(f.delegates.activity.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['activity-one'] }, deletedAt: null },
      }),
    );
    expect(f.delegates.activitySessionPosition.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.activitySessionPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ id: 'position-one', activityId: 'activity-one' }], deletedAt: null },
      }),
    );
    expect(f.delegates.contributionPolicyVersion.findMany).toHaveBeenCalledTimes(1);
    expect(f.delegates.contributionPolicyVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ id: 'policy-one', definitionHash: 'a'.repeat(64), evaluatorVersion: 1 }] },
      }),
    );
    expect(f.delegates.contributionShadowMappingApproval.findMany).not.toHaveBeenCalled();
  });

  it('reads explicit predecessors in one set query without dropping the same-activity anchor', async () => {
    const f = fixture();
    const manifest = manifestFixture();
    manifest.approvals[0].eventKindCode = 'replace';
    manifest.approvals[0].previousApprovalId = 'previous-one';
    await f.query.readRegistrationReferences(f.tx, manifest);
    expect(f.delegates.contributionShadowMappingApproval.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: 'previous-one', activityId: 'activity-one' }] },
      orderBy: { id: 'asc' },
    });
  });

  it('rejects invalid registration input before any read', async () => {
    const f = fixture();
    await expect(
      f.query.readRegistrationReferences(f.tx, { ...manifestFixture(), approved: true }),
    ).rejects.toThrow();
    for (const delegate of Object.values(f.delegates))
      expect(delegate.findMany).not.toHaveBeenCalled();
  });

  it('retains as-of revocations, replacements and expired history instead of filtering them away', async () => {
    const f = fixture();
    const sourceTime = new Date('2099-10-01T00:00:00.000Z');
    const events = [{ eventKindCode: 'revoke' }, { eventKindCode: 'replace' }];
    f.delegates.contributionShadowMappingApproval.findMany.mockResolvedValue(events);
    await expect(
      f.query.readMappingEvents(f.tx, {
        activityId: 'activity-one',
        mappingVersion: 'v1',
        sourceTime,
      }),
    ).resolves.toBe(events);
    expect(f.delegates.contributionShadowMappingApproval.findMany).toHaveBeenCalledWith({
      where: {
        activityId: 'activity-one',
        mappingVersion: 'v1',
        approvedAt: { lte: sourceTime },
        effectiveFrom: { lte: sourceTime },
      },
      orderBy: [{ approvedAt: 'asc' }, { approvalNumber: 'asc' }],
    });
  });

  it.each([
    { activityId: ' padded' },
    { mappingVersion: '' },
    { sourceTime: new Date('invalid') },
    { sourceTime: '2099-10-01T00:00:00.000Z' },
  ])('rejects invalid historical read input %p before database access', async (change) => {
    const f = fixture();
    await expect(
      f.query.readMappingEvents(f.tx, {
        activityId: 'activity-one',
        mappingVersion: 'v1',
        sourceTime: new Date('2099-10-01T00:00:00.000Z'),
        ...change,
      } as { activityId: string; mappingVersion: string; sourceTime: Date }),
    ).rejects.toThrow();
    expect(f.delegates.contributionShadowMappingApproval.findMany).not.toHaveBeenCalled();
  });
});

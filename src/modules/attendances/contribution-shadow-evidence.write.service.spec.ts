import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ContributionShadowEvidenceWriteService,
  hashLegacySource,
  matchLegacyRecords,
  shadowAttemptReplayKey,
  type ShadowAttemptInput,
  type LegacySourceAnchorInput,
  type ShadowComparisonAttempt,
  type ShadowComparisonInput,
  type ShadowMappingApplicationInput,
} from './contribution-shadow-evidence.write.service';

describe('E3-2 D2 failed terminal recovery writer', () => {
  const client = new PrismaClient();
  const service = new ContributionShadowEvidenceWriteService();
  const attempt = (): ShadowComparisonAttempt => ({
    id: 'attempt-1',
    windowId: 'window-1',
    auditLogId: 'audit-1',
    sheetId: 'sheet-1',
    activityId: 'activity-1',
    sheetVersion: 1,
    expectedRecordCount: 2,
  });
  const comparison = (classificationCode = 'equal', recordId = 'record-1') => ({
    id: `comparison-${recordId}`,
    attemptId: 'attempt-1',
    recordId,
    memberId: 'member-1',
    sheetId: 'sheet-1',
    activityId: 'activity-1',
    classificationCode,
    comparable: classificationCode === 'equal' || classificationCode === 'points_mismatch',
    factHash: 'a'.repeat(64),
    legacySourceHash: 'b'.repeat(64),
    policySourceHash: null,
    legacyRuleId: null,
    selectionRevisionId: null,
    selectionItemId: null,
    policyVersionId: null,
    policyId: null,
    definitionHash: null,
    evaluatorVersion: null,
    legacyServiceHours: null,
    durationSeconds: null,
    legacyPoints: null,
    policyPoints: null,
    failureCode: null,
    hashAlgorithmCode: 'sha256',
    canonicalVersion: 1,
    createdAt: new Date('2099-01-01T00:00:00Z'),
  });
  const terminal = () => ({
    id: 'terminal-1',
    attemptId: 'attempt-1',
    statusCode: 'failed',
    expectedRecordCount: 2,
    writtenRecordCount: 0,
    equalCount: 0,
    mismatchCount: 0,
    holdCount: 0,
    errorCount: 0,
    failureCode: 'shadow_comparison_failed',
    createdAt: new Date('2099-01-01T00:00:00Z'),
  });
  function setup(expectedRecordCount = 2) {
    const lock = jest
      .spyOn(client.contributionShadowAttemptReceipt, 'findUnique')
      .mockResolvedValue({
        ...attempt(),
        expectedRecordCount,
        replayKey: 'a'.repeat(64),
        committedFactHash: 'b'.repeat(64),
        signedMappingVersion: 'signed-v1',
        hashAlgorithmCode: 'sha256',
        canonicalVersion: 1,
        createdAt: new Date('2099-01-01T00:00:00Z'),
      });
    const existing = jest
      .spyOn(client.contributionShadowTerminalReceipt, 'findUnique')
      .mockResolvedValue(null);
    const read = jest
      .spyOn(client.contributionShadowComparisonReceipt, 'findMany')
      .mockResolvedValue([]);
    const write = jest
      .spyOn(client.contributionShadowTerminalReceipt, 'create')
      .mockResolvedValue(terminal());
    return { lock, existing, read, write };
  }
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => client.$disconnect());

  it('records zero written rows without inventing successful comparisons or exposing an exception', async () => {
    const f = setup();
    await expect(service.writeFailedTerminal(client, attempt())).resolves.toEqual({
      terminal: terminal(),
      replayed: false,
    });
    expect(f.write.mock.calls[0][0].data).toMatchObject({
      attemptId: 'attempt-1',
      statusCode: 'failed',
      expectedRecordCount: 2,
      writtenRecordCount: 0,
      equalCount: 0,
      mismatchCount: 0,
      holdCount: 0,
      errorCount: 0,
      failureCode: 'shadow_comparison_failed',
    });
    expect(f.write.mock.calls[0][0].data).not.toHaveProperty('createdAt');
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.existing.mock.invocationCallOrder[0]);
    expect(f.existing.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]);
    expect(f.read).toHaveBeenCalledWith({
      where: { attemptId: 'attempt-1' },
      select: { recordId: true, classificationCode: true, comparable: true },
    });
  });

  it('preserves and counts an already committed partial comparison set', async () => {
    const f = setup();
    f.read.mockResolvedValue([comparison('points_mismatch')]);
    await service.writeFailedTerminal(client, attempt());
    expect(f.write.mock.calls[0][0].data).toMatchObject({
      writtenRecordCount: 1,
      mismatchCount: 1,
      equalCount: 0,
      holdCount: 0,
      errorCount: 0,
      statusCode: 'failed',
    });
  });

  it('counts all four buckets independently, never putting hold or errors into the equal bucket', async () => {
    const f = setup(4);
    f.read.mockResolvedValue([
      comparison('equal', 'r1'),
      comparison('points_mismatch', 'r2'),
      comparison('mapping_hold', 'r3'),
      comparison('evaluation_error', 'r4'),
    ]);
    await service.writeFailedTerminal(client, { ...attempt(), expectedRecordCount: 4 });
    expect(f.write.mock.calls[0][0].data).toMatchObject({
      writtenRecordCount: 4,
      equalCount: 1,
      mismatchCount: 1,
      holdCount: 1,
      errorCount: 1,
    });
  });

  it.each(['complete', 'failed'])(
    'never overwrites an existing %s terminal or reads comparisons again',
    async (statusCode) => {
      const f = setup();
      const existing = { ...terminal(), statusCode };
      f.existing.mockResolvedValue(existing);
      await expect(service.writeFailedTerminal(client, attempt())).resolves.toEqual({
        terminal: existing,
        replayed: true,
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing or differently anchored attempt before reading its evidence', async () => {
    const f = setup();
    f.lock.mockResolvedValue(null);
    await expect(service.writeFailedTerminal(client, attempt())).rejects.toThrow(
      'shadow failed terminal attempt mismatch',
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(['duplicate', 'wrong-comparable', 'unknown-classification', 'excess-count'])(
    'refuses %s rather than guessing recovery counts',
    async (kind) => {
      const f = setup();
      let rows = [comparison('equal')];
      if (kind === 'duplicate') rows.push(comparison('equal'));
      if (kind === 'wrong-comparable') rows[0].comparable = false;
      if (kind === 'unknown-classification') rows = [comparison('unknown')];
      if (kind === 'excess-count')
        rows = [comparison('equal', 'r1'), comparison('equal', 'r2'), comparison('equal', 'r3')];
      f.read.mockResolvedValue(rows);
      await expect(service.writeFailedTerminal(client, attempt())).rejects.toThrow(
        'shadow failed terminal',
      );
      expect(f.write).not.toHaveBeenCalled();
    },
  );
});

describe('E3-2 D2 immutable attempt writer', () => {
  const client = new PrismaClient();
  const service = new ContributionShadowEvidenceWriteService();
  const input = (): ShadowAttemptInput => ({
    windowId: 'window-1',
    auditLogId: 'audit-1',
    sheetId: 'sheet-1',
    activityId: 'activity-1',
    sheetVersion: 2,
    committedFactHash: 'a'.repeat(64),
    signedMappingVersion: 'signed-v1',
    expectedRecordCount: 2,
  });
  const row = () => ({
    ...input(),
    id: 'attempt-1',
    createdAt: new Date('2026-09-30T00:00:00Z'),
    replayKey: shadowAttemptReplayKey(input()),
    hashAlgorithmCode: 'sha256',
    canonicalVersion: 1,
    terminal: null,
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => client.$disconnect());

  it('matches the independently calculated frozen D1 replay key', () => {
    expect(shadowAttemptReplayKey(input())).toBe(
      createHash('sha256').update('e3-2-d1:v1:window-1:audit-1:2', 'utf8').digest('hex'),
    );
  });

  it('creates immutable metadata itself in the caller transaction', async () => {
    const read = jest
      .spyOn(client.contributionShadowAttemptReceipt, 'findUnique')
      .mockResolvedValue(null);
    const write = jest
      .spyOn(client.contributionShadowAttemptReceipt, 'create')
      .mockResolvedValue(row());
    await expect(service.readOrCreateAttempt(client, input())).resolves.toEqual({
      attempt: row(),
      replayed: false,
    });
    expect(read).toHaveBeenCalledWith({
      where: { auditLogId: 'audit-1' },
      include: { terminal: true },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].data).toMatchObject({
      ...input(),
      replayKey: shadowAttemptReplayKey(input()),
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
    });
    expect(write.mock.calls[0][0].data.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(write.mock.calls[0][0].include).toEqual({ terminal: true });
    expect(write.mock.calls[0][0].data).not.toHaveProperty('createdAt');
  });

  it('returns an exact unfinished replay without writing or assigning new metadata', async () => {
    jest.spyOn(client.contributionShadowAttemptReceipt, 'findUnique').mockResolvedValue(row());
    const write = jest.spyOn(client.contributionShadowAttemptReceipt, 'create');
    await expect(service.readOrCreateAttempt(client, input())).resolves.toEqual({
      attempt: row(),
      replayed: true,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['complete', 'failed'])(
    'returns the existing %s terminal unchanged',
    async (statusCode) => {
      const existing = {
        ...row(),
        terminal: {
          id: 'terminal-1',
          attemptId: 'attempt-1',
          statusCode,
          expectedRecordCount: 2,
          writtenRecordCount: statusCode === 'complete' ? 2 : 0,
          equalCount: statusCode === 'complete' ? 2 : 0,
          mismatchCount: 0,
          holdCount: 0,
          errorCount: 0,
          failureCode: statusCode === 'failed' ? 'fixture_failure' : null,
          createdAt: row().createdAt,
        },
      };
      jest.spyOn(client.contributionShadowAttemptReceipt, 'findUnique').mockResolvedValue(existing);
      const write = jest.spyOn(client.contributionShadowAttemptReceipt, 'create');
      await expect(service.readOrCreateAttempt(client, input())).resolves.toEqual({
        attempt: existing,
        replayed: true,
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each([
    'windowId',
    'sheetId',
    'activityId',
    'committedFactHash',
    'signedMappingVersion',
    'replayKey',
    'hashAlgorithmCode',
  ])('refuses a replay with changed %s', async (field) => {
    jest
      .spyOn(client.contributionShadowAttemptReceipt, 'findUnique')
      .mockResolvedValue({ ...row(), [field]: 'changed' });
    const write = jest.spyOn(client.contributionShadowAttemptReceipt, 'create');
    await expect(service.readOrCreateAttempt(client, input())).rejects.toThrow(
      'shadow attempt evidence mismatch',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['sheetVersion', 'expectedRecordCount', 'canonicalVersion'])(
    'refuses changed %s',
    async (field) => {
      jest
        .spyOn(client.contributionShadowAttemptReceipt, 'findUnique')
        .mockResolvedValue({ ...row(), [field]: 99 });
      await expect(service.readOrCreateAttempt(client, input())).rejects.toThrow(
        'shadow attempt evidence mismatch',
      );
    },
  );

  it.each(['id', 'createdAt', 'replayKey', 'hashAlgorithmCode', 'canonicalVersion'])(
    'refuses caller-controlled %s before any read',
    async (field) => {
      const read = jest.spyOn(client.contributionShadowAttemptReceipt, 'findUnique');
      await expect(
        service.readOrCreateAttempt(client, { ...input(), [field]: 'forged' }),
      ).rejects.toThrow('shadow attempt evidence mismatch');
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('propagates a concurrent unique conflict without retry or upsert', async () => {
    jest.spyOn(client.contributionShadowAttemptReceipt, 'findUnique').mockResolvedValue(null);
    const conflict = new Prisma.PrismaClientKnownRequestError('fixture conflict', {
      code: 'P2002',
      clientVersion: 'fixture',
    });
    const write = jest
      .spyOn(client.contributionShadowAttemptReceipt, 'create')
      .mockRejectedValue(conflict);
    const upsert = jest.spyOn(client.contributionShadowAttemptReceipt, 'upsert');
    await expect(service.readOrCreateAttempt(client, input())).rejects.toBe(conflict);
    expect(write).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });
});

function matchedInput(): LegacySourceAnchorInput {
  return {
    windowId: 'window-1',
    auditLogId: 'audit-1',
    sheetId: 'sheet-1',
    sheetVersion: 2,
    activityId: 'activity-1',
    recordId: 'record-1',
    memberId: 'member-1',
    activityTypeCode: '救援',
    attendanceRoleCode: 'volunteer',
    legacyServiceHours: new Prisma.Decimal('1.50'),
    legacyPoints: new Prisma.Decimal('2.00'),
    source: {
      sourceKindCode: 'matched',
      legacyRuleId: 'rule-1',
      durationThreshold: new Prisma.Decimal('2.00'),
      pointsBelow: new Prisma.Decimal('2.00'),
      pointsAbove: new Prisma.Decimal('3.00'),
    },
  };
}

describe('E3-2 D2 legacy source evidence writer', () => {
  const prepared = () => ({
    memberId: 'member-1',
    roleCode: 'volunteer',
    checkInAt: new Date('2026-01-01T08:00:00.000Z'),
    checkOutAt: new Date('2026-01-01T10:00:00.000Z'),
    serviceHours: 2,
    contributionPoints: 1.5,
    attendanceStatusCode: 'present',
    registrationId: null,
    note: null,
  });
  const stored = (id = 'cuid-1') => ({
    ...prepared(),
    id,
    sheetId: 'sheet-1',
    serviceHours: new Prisma.Decimal(2),
    contributionPoints: new Prisma.Decimal(1.5),
  });

  it('matches actual IDs by business key even when database order is reversed', () => {
    const second = { ...prepared(), memberId: 'member-2' };
    const secondStored = { ...stored('cuid-2'), memberId: 'member-2' };
    expect(
      matchLegacyRecords('sheet-1', [prepared(), second], [secondStored, stored()]).map(
        (record) => record.id,
      ),
    ).toEqual(['cuid-1', 'cuid-2']);
  });

  it.each([
    'missing',
    'duplicate-input',
    'duplicate-stored',
    'extra',
    'wrong-sheet',
    'wrong-value',
    'duplicate-id',
  ])('refuses %s correspondence without guessing an ID', (kind) => {
    const inputs = [prepared(), { ...prepared(), memberId: 'member-2' }];
    const rows = [stored(), { ...stored('cuid-2'), memberId: 'member-2' }];
    if (kind === 'missing') rows.pop();
    if (kind === 'extra') rows.push({ ...stored('cuid-3'), memberId: 'member-3' });
    if (kind === 'duplicate-input') inputs[1] = prepared();
    if (kind === 'duplicate-stored') rows[1] = stored('cuid-2');
    if (kind === 'wrong-sheet') rows[1].sheetId = 'sheet-2';
    if (kind === 'wrong-value') rows[1].contributionPoints = new Prisma.Decimal(2);
    if (kind === 'duplicate-id') rows[1].id = rows[0].id;
    expect(() => matchLegacyRecords('sheet-1', inputs, rows)).toThrow('correspondence failed');
  });

  it('uses fixed decimal precision and UTF-8 byte lengths in a stable digest', () => {
    const input = matchedInput();
    const digest = hashLegacySource(input);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(hashLegacySource({ ...input, activityTypeCode: '救援x' })).not.toBe(digest);
    expect(hashLegacySource({ ...input, legacyPoints: new Prisma.Decimal('2') })).toBe(digest);
  });

  it('refuses lossy decimal rounding instead of disguising a different old fact', () => {
    expect(() =>
      hashLegacySource({ ...matchedInput(), legacyServiceHours: new Prisma.Decimal('1.501') }),
    ).toThrow('non-canonical decimal precision');
  });

  it('writes the exact source tuple in the existing transaction', async () => {
    const createMany = jest
      .fn<Promise<{ count: number }>, [unknown]>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      contributionShadowLegacySourceAnchor: { createMany },
    } as unknown as Prisma.TransactionClient;
    const input = matchedInput();
    await new ContributionShadowEvidenceWriteService().writeLegacySources(tx, [input]);
    const call = createMany.mock.calls[0][0] as {
      data: Array<{
        auditLogId: string;
        recordId: string;
        legacyRuleId: string | null;
        legacySourceHash: string;
      }>;
    };
    expect(call.data).toHaveLength(1);
    expect(call.data[0].auditLogId).toBe('audit-1');
    expect(call.data[0].recordId).toBe('record-1');
    expect(call.data[0].legacyRuleId).toBe('rule-1');
    expect(call.data[0].legacySourceHash).toBe(hashLegacySource(input));
  });

  it('refuses an empty set before it can create a proof-bearing audit gap', async () => {
    const createMany = jest.fn();
    const tx = {
      contributionShadowLegacySourceAnchor: { createMany },
    } as unknown as Prisma.TransactionClient;
    await expect(
      new ContributionShadowEvidenceWriteService().writeLegacySources(tx, []),
    ).rejects.toThrow('cannot be empty');
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('E3-2 D2 complete comparison evidence writer', () => {
  function attempt(expectedRecordCount = 1): ShadowComparisonAttempt {
    return {
      id: 'attempt-1',
      windowId: 'window-1',
      auditLogId: 'audit-1',
      sheetId: 'sheet-1',
      sheetVersion: 2,
      activityId: 'activity-1',
      expectedRecordCount,
    };
  }

  function comparison(recordId = 'record-1', classificationCode = 'equal'): ShadowComparisonInput {
    const comparable = classificationCode === 'equal' || classificationCode === 'points_mismatch';
    return {
      recordId,
      sheetId: 'sheet-1',
      memberId: `member-${recordId}`,
      activityId: 'activity-1',
      classificationCode,
      comparable,
      factHash: 'a'.repeat(64),
      legacySourceHash: 'b'.repeat(64),
      policySourceHash: comparable ? 'c'.repeat(64) : null,
      legacyRuleId: 'legacy-rule-1',
      selectionRevisionId: comparable ? 'selection-1' : null,
      selectionItemId: comparable ? 'item-1' : null,
      policyVersionId: comparable ? 'version-1' : null,
      policyId: comparable ? 'policy-1' : null,
      definitionHash: comparable ? 'd'.repeat(64) : null,
      evaluatorVersion: comparable ? 1 : null,
      legacyServiceHours: '1.00',
      durationSeconds: comparable ? 3600 : null,
      legacyPoints: classificationCode === 'equal' ? '10.00' : '2.00',
      policyPoints: comparable ? '10.00' : null,
      failureCode: classificationCode === 'evaluation_error' ? 'fixture_evaluation_error' : null,
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
    };
  }

  function application(recordId = 'record-1'): ShadowMappingApplicationInput {
    return {
      approvalId: 'approval-1',
      legacySourceAnchorId: `source-${recordId}`,
      windowId: 'window-1',
      auditLogId: 'audit-1',
      sheetId: 'sheet-1',
      sheetVersion: 2,
      recordId,
      memberId: `member-${recordId}`,
      activityId: 'activity-1',
      selectionItemId: 'item-1',
      policyVersionId: 'version-1',
      policyDefinitionHash: 'd'.repeat(64),
      evaluatorVersion: 1,
      durationSeconds: 3600,
      policyPoints: '10.00',
      explanationCode: 'hour',
    };
  }

  function writer() {
    const order: string[] = [];
    const applicationWrite = jest.fn((args: { data: unknown[] }) => {
      order.push('applications');
      return Promise.resolve({ count: args.data.length });
    });
    const comparisonWrite = jest.fn((args: { data: unknown[] }) => {
      order.push('comparisons');
      return Promise.resolve({ count: args.data.length });
    });
    const terminalWrite = jest.fn((args: unknown) => {
      void args;
      order.push('terminal');
      return Promise.resolve({ id: 'terminal-1' });
    });
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, payload: string) => {
        expect(strings.join('?')).not.toMatch(/ON CONFLICT|createdAt/);
        const parsed: unknown = JSON.parse(payload);
        if (!Array.isArray(parsed)) throw new Error('set write payload must be an array');
        const data: unknown[] = parsed;
        const write = strings
          .join('')
          .includes('INSERT INTO public."ContributionShadowMappingApplication"')
          ? applicationWrite
          : comparisonWrite;
        return (await write({ data })).count;
      }),
      contributionShadowTerminalReceipt: { create: terminalWrite },
    } as unknown as Prisma.TransactionClient;
    return {
      service: new ContributionShadowEvidenceWriteService(),
      tx,
      order,
      applicationWrite,
      comparisonWrite,
      terminalWrite,
    };
  }

  it('writes applications then comparisons then an independently counted terminal in the caller transaction', async () => {
    const w = writer();
    await expect(
      w.service.writeCompleteComparisonSet(
        w.tx,
        attempt(4),
        [application('r1'), application('r2')],
        [
          comparison('r1'),
          comparison('r2', 'points_mismatch'),
          comparison('r3', 'mapping_hold'),
          comparison('r4', 'evaluation_error'),
        ],
      ),
    ).resolves.toEqual({ id: 'terminal-1' });
    expect(w.order).toEqual(['applications', 'comparisons', 'terminal']);
    expect(w.terminalWrite.mock.calls[0][0]).toMatchObject({
      data: {
        attemptId: 'attempt-1',
        statusCode: 'complete',
        expectedRecordCount: 4,
        writtenRecordCount: 4,
        equalCount: 1,
        mismatchCount: 1,
        holdCount: 1,
        errorCount: 1,
        failureCode: null,
      },
    });
    expect(w.applicationWrite.mock.calls[0][0]).not.toHaveProperty('skipDuplicates');
    expect(w.comparisonWrite.mock.calls[0][0]).not.toHaveProperty('skipDuplicates');
    expect(w.comparisonWrite.mock.calls[0][0].data).toEqual(
      expect.arrayContaining([expect.objectContaining({ attemptId: 'attempt-1', recordId: 'r1' })]),
    );
  });

  it('writes 2,000 records as two set writes, not one query per record', async () => {
    const w = writer();
    const records = Array.from({ length: 2000 }, (_, index) => `record-${index}`);
    await w.service.writeCompleteComparisonSet(
      w.tx,
      attempt(2000),
      records.map(application),
      records.map((id) => comparison(id)),
    );
    expect(w.applicationWrite).toHaveBeenCalledTimes(1);
    expect(w.comparisonWrite).toHaveBeenCalledTimes(1);
    expect(w.applicationWrite.mock.calls[0][0].data).toHaveLength(2000);
    expect(w.comparisonWrite.mock.calls[0][0].data).toHaveLength(2000);
    expect(w.terminalWrite.mock.calls[0][0]).toMatchObject({
      data: { writtenRecordCount: 2000, equalCount: 2000 },
    });
  });

  it('keeps all-hold evidence out of the comparable denominator and does not invent an application', async () => {
    const w = writer();
    await w.service.writeCompleteComparisonSet(
      w.tx,
      attempt(),
      [],
      [comparison('record-1', 'mapping_hold')],
    );
    expect(w.applicationWrite).not.toHaveBeenCalled();
    expect(w.terminalWrite.mock.calls[0][0]).toMatchObject({
      data: { equalCount: 0, mismatchCount: 0, holdCount: 1 },
    });
  });

  it.each([
    'missing-record',
    'duplicate-record',
    'wrong-sheet',
    'wrong-activity',
    'missing-application',
    'duplicate-application',
    'hold-application',
    'unknown-classification',
    'false-comparability',
    'wrong-source-audit',
    'wrong-source-window',
    'wrong-source-version',
    'wrong-member',
    'wrong-policy',
    'wrong-selection',
    'wrong-duration',
    'application-timestamp',
    'comparison-timestamp',
    'application-unknown-field',
    'comparison-unknown-field',
    'zero-expected',
  ])('rejects %s before any evidence write', async (kind) => {
    const w = writer();
    const context = attempt();
    const apps = [application()];
    const comps = [comparison()];
    if (kind === 'missing-record') comps.pop();
    if (kind === 'duplicate-record') {
      context.expectedRecordCount = 2;
      comps.push(comparison());
    }
    if (kind === 'wrong-sheet') comps[0].sheetId = 'sheet-2';
    if (kind === 'wrong-activity') comps[0].activityId = 'activity-2';
    if (kind === 'missing-application') apps.pop();
    if (kind === 'duplicate-application') apps.push(application());
    if (kind === 'hold-application') comps[0] = comparison('record-1', 'mapping_hold');
    if (kind === 'unknown-classification') {
      comps[0].classificationCode = 'invented';
      comps[0].comparable = false;
    }
    if (kind === 'false-comparability') comps[0].comparable = false;
    if (kind === 'wrong-source-audit') apps[0].auditLogId = 'audit-2';
    if (kind === 'wrong-source-window') apps[0].windowId = 'window-2';
    if (kind === 'wrong-source-version') apps[0].sheetVersion = 3;
    if (kind === 'wrong-member') apps[0].memberId = 'member-2';
    if (kind === 'wrong-policy') apps[0].policyVersionId = 'version-2';
    if (kind === 'wrong-selection') apps[0].selectionItemId = 'item-2';
    if (kind === 'wrong-duration') apps[0].durationSeconds = 3601;
    if (kind === 'application-timestamp')
      apps[0] = { ...application(), ...{ createdAt: new Date() } };
    if (kind === 'comparison-timestamp')
      comps[0] = { ...comparison(), ...{ createdAt: new Date() } };
    if (kind === 'application-unknown-field')
      apps[0] = { ...application(), ...{ unknown: 'reject' } };
    if (kind === 'comparison-unknown-field')
      comps[0] = { ...comparison(), ...{ unknown: 'reject' } };
    if (kind === 'zero-expected') context.expectedRecordCount = 0;
    await expect(w.service.writeCompleteComparisonSet(w.tx, context, apps, comps)).rejects.toThrow(
      'evidence set mismatch',
    );
    expect(w.order).toEqual([]);
  });

  it('propagates database proof rejection without writing comparisons, terminal or retrying', async () => {
    const w = writer();
    const failure = new Error('database proof rejected');
    w.applicationWrite.mockRejectedValueOnce(failure);
    await expect(
      w.service.writeCompleteComparisonSet(w.tx, attempt(), [application()], [comparison()]),
    ).rejects.toBe(failure);
    expect(w.applicationWrite).toHaveBeenCalledTimes(1);
    expect(w.comparisonWrite).not.toHaveBeenCalled();
    expect(w.terminalWrite).not.toHaveBeenCalled();
  });

  it('does not conceal a short application count or proceed to a terminal', async () => {
    const w = writer();
    w.applicationWrite.mockResolvedValueOnce({ count: 0 });
    await expect(
      w.service.writeCompleteComparisonSet(w.tx, attempt(), [application()], [comparison()]),
    ).rejects.toThrow('evidence set mismatch');
    expect(w.comparisonWrite).not.toHaveBeenCalled();
    expect(w.terminalWrite).not.toHaveBeenCalled();
  });

  it('does not conceal a short comparison count or proceed to a terminal', async () => {
    const w = writer();
    w.comparisonWrite.mockResolvedValueOnce({ count: 0 });
    await expect(
      w.service.writeCompleteComparisonSet(w.tx, attempt(), [application()], [comparison()]),
    ).rejects.toThrow('evidence set mismatch');
    expect(w.terminalWrite).not.toHaveBeenCalled();
  });

  it('propagates terminal failure so the caller transaction cannot commit a false completion', async () => {
    const w = writer();
    const failure = new Error('terminal rejected');
    w.terminalWrite.mockImplementationOnce(() => {
      w.order.push('terminal');
      return Promise.reject(failure);
    });
    await expect(
      w.service.writeCompleteComparisonSet(w.tx, attempt(), [application()], [comparison()]),
    ).rejects.toBe(failure);
    expect(w.order).toEqual(['applications', 'comparisons', 'terminal']);
    expect(w.terminalWrite).toHaveBeenCalledTimes(1);
  });
});

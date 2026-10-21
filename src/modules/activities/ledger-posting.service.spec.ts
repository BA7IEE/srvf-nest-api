import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient, Role, UserStatus } from '@prisma/client';
import { LedgerPostingService } from './ledger-posting.service';
import { PrismaService } from '../../database/prisma.service';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';
import { ParticipationTimeCorrectionService } from './participation-time-correction.service';
import { ParticipationTimeLedgerAccessService } from './participation-time-ledger-access.service';
import { MEMBER_TX_TIMEOUT_MS } from '../../common/prisma/member-advisory-lock.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { CorrectionPostingShapeFacts } from './correction-posting-shape';

describe('ledger posting draft member query characterization', () => {
  const tx = new PrismaClient();
  const database = {
    ledgerPostingBatch: { findUnique: jest.fn() },
    $transaction: jest.fn((body: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      body(tx),
    ),
  };
  let service: LedgerPostingService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LedgerPostingService,
        ...[
          LedgerPostingAuditRecorder,
          SettlementNotificationProducer,
          ParticipationTimeLedgerService,
          ParticipationTimeCorrectionService,
          ParticipationTimeLedgerAccessService,
        ].map((provide) => ({ provide, useValue: {} })),
        { provide: PrismaService, useValue: database },
        { provide: ActivityWorkflowGate, useValue: { assertV11WriteAllowed: jest.fn() } },
      ],
    }).compile();
    service = module.get(LedgerPostingService);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => tx.$disconnect());

  const correctionBatch = {
    id: 'correction-batch',
    statusCode: 'ready',
    settlementRunId: 'run-one',
    settlementVersionId: 'replacement-version',
    totalCount: 2,
    preparedCount: 2,
    baselineJsonHash: null,
    committedAt: null,
  };
  const completeCorrection: CorrectionPostingShapeFacts = {
    creditEntryCount: 4,
    creditPairCount: 2,
    settlementDayCount: 2,
    reversalEntryCount: 4,
    reversalPairCount: 2,
    reversalClaimCount: 4,
    unreversedOriginalCount: 0,
    reversalOfUncommittedCount: 0,
    mismatchedReversalAmountCount: 0,
  };

  it('accepts a complete correction with one query and the original scalar anchors', async () => {
    const query = jest.spyOn(tx, '$queryRaw').mockResolvedValue([completeCorrection]);
    await expect(
      service['assertCorrectionSetConsistent'](tx, correctionBatch, 'replacement-version'),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0].slice(1)).toEqual([
      'replacement-version',
      'correction-batch',
      'replacement-version',
      'correction-batch',
      'correction-batch',
    ]);
  });

  it.each([
    ['creditEntryCount', 3, BizCode.CORRECTION_POSTING_REPLACEMENT_MISSING],
    ['creditPairCount', 1, BizCode.CORRECTION_POSTING_REPLACEMENT_MISSING],
    ['settlementDayCount', 1, BizCode.CORRECTION_POSTING_REPLACEMENT_MISSING],
    ['reversalEntryCount', 3, BizCode.CORRECTION_POSTING_REVERSAL_MISSING],
    ['reversalPairCount', 1, BizCode.CORRECTION_POSTING_REVERSAL_MISSING],
    ['reversalClaimCount', 3, BizCode.CORRECTION_POSTING_REVERSAL_MISSING],
    ['unreversedOriginalCount', 1, BizCode.CORRECTION_POSTING_REVERSAL_MISSING],
    ['reversalOfUncommittedCount', 1, BizCode.CORRECTION_POSTING_REVERSAL_MISSING],
    ['mismatchedReversalAmountCount', 1, BizCode.CORRECTION_POSTING_REVERSAL_AMOUNT_INVALID],
  ] as const)('keeps the correction rejection for %s', async (field, value, expected) => {
    const query = jest
      .spyOn(tx, '$queryRaw')
      .mockResolvedValue([{ ...completeCorrection, [field]: value }]);
    await expect(
      service['assertCorrectionSetConsistent'](tx, correctionBatch, 'replacement-version'),
    ).rejects.toMatchObject({ name: 'BizException', biz: expected });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects missing correction facts and preserves the native query failure', async () => {
    const query = jest.spyOn(tx, '$queryRaw').mockResolvedValueOnce([]);
    await expect(
      service['assertCorrectionSetConsistent'](tx, correctionBatch, 'replacement-version'),
    ).rejects.toMatchObject({
      name: 'BizException',
      biz: BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH,
    });
    const failure = new Error('synthetic correction shape query failure');
    query.mockRejectedValueOnce(failure);
    await expect(
      service['assertCorrectionSetConsistent'](tx, correctionBatch, 'replacement-version'),
    ).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    { rows: [] },
    { rows: [{ memberId: 'zero-entry-member' }] },
    { rows: [{ memberId: 'a' }, { memberId: 'b' }] },
  ])('preserves database member rows without filtering by ledger entries: %j', async ({ rows }) => {
    const query = jest.spyOn(tx, '$queryRaw').mockResolvedValue(rows);
    const members = await service['readDraftSegmentMemberIds'](tx, 'activity-one');
    expect(members).toEqual(rows.map((row) => row.memberId));
    expect(query).toHaveBeenCalledTimes(1);
    const [parts, ...values] = query.mock.calls[0];
    expect(Array.isArray(parts)).toBe(true);
    const sql = Array.isArray(parts) ? parts.join('?') : '';
    expect(values).toEqual(['activity-one']);
    expect(sql).toContain('DISTINCT i."memberId"');
    expect(sql).toContain('s."participationIdentityId"');
    expect(sql).toContain('i."activityId" =');
    expect(sql).toContain('s."statusCode" = \'draft\'');
    expect(sql).toContain("s.\"resultCode\" NOT IN ('voided', 'replaced')");
    expect(sql).toContain('s."checkOutAt" IS NOT NULL');
    expect(sql).toContain('ORDER BY i."memberId" ASC');
    expect(sql).not.toContain('ParticipationLedgerEntry');
  });

  it('propagates query failure without treating unknown members as an empty set', async () => {
    const error = new Error('synthetic query failure');
    jest.spyOn(tx, '$queryRaw').mockRejectedValue(error);
    await expect(service['readDraftSegmentMemberIds'](tx, 'activity-one')).rejects.toBe(error);
  });

  it('keeps two scalar bindings and all target qualifications in the final update', () => {
    // This is a structural tripwire, not a substitute for the real database
    // equivalence, empty-set and row-lock/EPQ tests in the scale E2E.
    const source = readFileSync(join(__dirname, 'ledger-posting.service.ts'), 'utf8');
    const matches = source.match(/`(\s*WITH target AS MATERIALIZED[\s\S]*?)`/g);
    expect(matches).toHaveLength(1);
    const sql = matches?.[0] ?? '';
    expect([...sql.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1])).toEqual([
      'activityId',
      'batch.id',
    ]);
    expect(sql).toContain('draft."participationIdentityId" = i.id');
    expect(sql).toContain('draft."statusCode" = \'draft\'');
    expect(sql).toContain('OFFSET 0');
    expect(sql).toContain('s.id = ANY (ARRAY(SELECT target.id FROM target))');
    expect(sql).toContain('CASE WHEN s."statusCode" = \'draft\' THEN TRUE ELSE FALSE END');
    expect(sql).not.toContain('FROM target\n        WHERE');
    expect(sql).not.toContain('resultCode');
    expect(sql).not.toContain('checkOutAt');
    expect(sql).not.toContain('ctid');
  });

  it.each([false, true])(
    'preserves the public transaction owner, arguments and failure propagation: fail=%s',
    async (fail) => {
      database.ledgerPostingBatch.findUnique.mockResolvedValue({
        settlementRun: { activityId: 'activity-one' },
      });
      database.$transaction.mockClear();
      const input = { postingBatchId: 'batch-one', operationKey: 'operation-one' };
      const actor = {
        id: 'actor-one',
        memberId: null,
        username: 'actor',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      };
      const meta = { requestId: 'unit-ledger-orchestration', ip: null, ua: null };
      const result = {
        postingBatchId: 'batch-one',
        activityId: 'activity-one',
        settlementRunId: 'run-one',
        settlementVersionId: 'version-one',
        settlementVersion: 1,
        batchStatus: 'committed',
        runStatus: 'posted',
        memberCount: 0,
        dayStateCount: 0,
        entryCount: 0,
        committedAt: null,
        replayed: false,
      };
      const failure = new Error('synthetic original protocol failure');
      const lockSetting = jest.spyOn(tx, '$executeRawUnsafe').mockResolvedValue(0);
      jest.spyOn(tx, '$executeRaw').mockImplementation(() => {
        throw new Error('unexpected database write in unit test');
      });
      jest.spyOn(tx, '$queryRawUnsafe').mockImplementation(() => {
        throw new Error('unexpected database read in unit test');
      });
      const protocol = jest.spyOn(service, 'commitBatchWithin');
      if (fail) protocol.mockRejectedValue(failure);
      else protocol.mockResolvedValue(result);
      const pending = service.commitBatch(input, actor, meta);
      if (fail) await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toBe(result);
      expect(protocol).toHaveBeenCalledTimes(1);
      expect(lockSetting).toHaveBeenCalledTimes(1);
      expect(lockSetting).toHaveBeenCalledWith('SET LOCAL lock_timeout = 4000');
      expect(protocol).toHaveBeenCalledWith(tx, 'activity-one', input, actor, meta);
      expect(database.$transaction).toHaveBeenCalledTimes(1);
      expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: MEMBER_TX_TIMEOUT_MS,
      });
      expect(database.ledgerPostingBatch.findUnique).toHaveBeenLastCalledWith({
        where: { id: input.postingBatchId },
        select: { settlementRun: { select: { activityId: true } } },
      });
    },
  );
});

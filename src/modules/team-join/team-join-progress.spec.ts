import { LedgerQueryService } from '../activities/ledger-query.service';
import { Prisma } from '@prisma/client';

import {
  computeCappedContribution,
  computeCappedContributionBatch,
  computeContribution,
  computeContributionBatch,
} from './team-join-progress';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { CONTRIBUTION_THRESHOLD, contributionCutoff } from './team-join.constants';

// The retired approved-attendance capping cases now exercise the committed ledger
// boundary. Daily caps belong to ledger writes; readers must not apply them again.
describe('computeCappedContribution(已入账贡献)', () => {
  it('cutoff=null reads the member’s committed ledger without a date bound', async () => {
    const { client, aggregate, findMany } = ledgerClient('1');

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      actualGate(true),
      LedgerQueryService,
    );

    expect(points.toString()).toBe('1');
    expect(aggregate).toHaveBeenCalledWith({
      where: { memberId: 'm1', postingBatch: { statusCode: 'committed' } },
      _sum: { creditedPointsDelta: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('translates the entry cutoff to the exclusive Beijing civil ledger date', async () => {
    const { client, aggregate, findMany } = ledgerClient('1');
    const cutoff = contributionCutoff(2026);

    await computeCappedContribution(client, 'm1', cutoff, actualGate(true), LedgerQueryService);

    expect(aggregate).toHaveBeenCalledWith({
      where: {
        memberId: 'm1',
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not impose another daily cap on already credited ledger totals', async () => {
    const { client, findMany } = ledgerClient('4');

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      actualGate(true),
      LedgerQueryService,
    );

    expect(points.toString()).toBe('4');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('preserves the net credited sum without recomputing legacy day caps', async () => {
    const { client, findMany } = ledgerClient('3.5');

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      actualGate(true),
      LedgerQueryService,
    );

    expect(points.toString()).toBe('3.5');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a null ledger aggregate gives zero without a legacy fallback', async () => {
    const { client, findMany } = ledgerClient(null);
    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      actualGate(true),
      LedgerQueryService,
    );
    expect(points.toString()).toBe('0');
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('computeContribution(账本净额 + 入队年 cutoff + ≥5 gate)', () => {
  it('uses the ledger cutoff and marks points ≥ 5 satisfied', async () => {
    const { client, aggregate, findMany } = ledgerClient('6');

    const result = await computeContribution(
      client,
      'm1',
      2026,
      actualGate(true),
      LedgerQueryService,
    );

    expect(result.points.toString()).toBe('6');
    expect(result.satisfied).toBe(true);
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        memberId: 'm1',
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('points < 阈值 → satisfied=false', async () => {
    const { client, findMany } = ledgerClient('1');
    const result = await computeContribution(
      client,
      'm1',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.points.lessThan(CONTRIBUTION_THRESHOLD)).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps a negative committed net below the threshold without a legacy fallback', async () => {
    const { client, findMany } = ledgerClient('-1.25');
    const result = await computeContribution(
      client,
      'm1',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.points.toString()).toBe('-1.25');
    expect(result.satisfied).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});

function actualGate(enabled: boolean, readonlyMaintenance = false) {
  return new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
}

function ledgerClient(total: string | null, rows: Array<{ memberId: string; total: string }> = []) {
  const aggregate = jest.fn().mockResolvedValue({
    _sum: { creditedPointsDelta: total === null ? null : new Prisma.Decimal(total) },
  });
  const groupBy = jest.fn().mockResolvedValue(
    rows.map((row) => ({
      memberId: row.memberId,
      _sum: { creditedPointsDelta: new Prisma.Decimal(row.total) },
    })),
  );
  const findMany = jest.fn().mockRejectedValue(new Error('legacy attendance must not be read'));
  const client = {
    attendanceRecord: { findMany },
    participationLedgerEntry: { aggregate, groupBy },
  } as unknown as Prisma.TransactionClient;
  return { client, aggregate, groupBy, findMany };
}

describe('R5 single contribution source', () => {
  it.each([false, true])(
    'enabled with readonly=%s uses committed credited only, without a second daily cap or legacy fallback',
    async (readonlyMaintenance) => {
      const { client, aggregate, findMany } = ledgerClient('5.25');
      const result = await computeCappedContribution(
        client,
        'member',
        null,
        actualGate(true, readonlyMaintenance),
        LedgerQueryService,
      );
      expect(result.toString()).toBe('5.25');
      expect(findMany).not.toHaveBeenCalled();
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate).toHaveBeenCalledWith({
        where: { memberId: 'member', postingBatch: { statusCode: 'committed' } },
        _sum: { creditedPointsDelta: true },
      });
    },
  );

  it.each([false, true])(
    'disabled with readonly=%s rejects instead of reading approved attendance',
    async (readonlyMaintenance) => {
      const { client, aggregate, findMany } = ledgerClient('99');
      await expect(
        computeCappedContribution(
          client,
          'member',
          null,
          actualGate(false, readonlyMaintenance),
          LedgerQueryService,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED });
      expect(findMany).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
    },
  );

  it('does not replace a null committed SUM with legacy points', async () => {
    const { client, findMany } = ledgerClient(null);
    expect(
      (
        await computeCappedContribution(
          client,
          'member',
          null,
          actualGate(true),
          LedgerQueryService,
        )
      ).toString(),
    ).toBe('0');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps correction/reversal deltas in the net total without filtering superseded result revisions', async () => {
    const { client, aggregate } = ledgerClient('4.50');
    const result = await computeContribution(
      client,
      'member',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.points.toString()).toBe('4.5');
    expect(result.satisfied).toBe(false);
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        memberId: 'member',
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
  });

  it('counts the Beijing March31 civil day, excluding April1 without comparing DATE to the UTC cutoff instant', async () => {
    const { client, aggregate } = ledgerClient('5');
    const result = await computeContribution(
      client,
      'member',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.satisfied).toBe(true);
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: 'member',
          postingBatch: { statusCode: 'committed' },
          ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
        },
      }),
    );
    expect(contributionCutoff(2026).toISOString()).toBe('2026-03-31T16:00:00.000Z');
  });

  it('batch deduplicates once, preserves absent members as zero, and uses the same cutoff and threshold', async () => {
    const { client, aggregate, groupBy, findMany } = ledgerClient(null, [
      { memberId: 'one', total: '5.25' },
      { memberId: 'two', total: '4.5' },
    ]);
    const result = await computeContributionBatch(
      client,
      ['one', 'two', 'one', 'absent'],
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect([...result.keys()]).toEqual(['one', 'two', 'absent']);
    expect([...result.values()].map((v) => [v.points.toString(), v.satisfied])).toEqual([
      ['5.25', true],
      ['4.5', false],
      ['0', false],
    ]);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['memberId'],
      where: {
        memberId: { in: ['one', 'two', 'absent'] },
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
    expect(aggregate).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('batch off rejects without reading legacy records or ledger entries', async () => {
    const { client, findMany, groupBy } = ledgerClient(null);
    await expect(
      computeCappedContributionBatch(
        client,
        ['one', 'two', 'absent'],
        null,
        actualGate(false),
        LedgerQueryService,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED });
    expect(findMany).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it.each([false, true])('empty batch with enabled=%s performs no query', async (enabled) => {
    const { client, aggregate, groupBy, findMany } = ledgerClient(null);
    const result = computeCappedContributionBatch(
      client,
      [],
      null,
      actualGate(enabled),
      LedgerQueryService,
    );
    if (enabled) await expect(result).resolves.toEqual(new Map());
    else
      await expect(result).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
    expect(aggregate).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

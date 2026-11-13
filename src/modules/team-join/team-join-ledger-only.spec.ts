import { Prisma } from '@prisma/client';

import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { LedgerQueryService } from '../activities/ledger-query.service';
import { computeCappedContribution, computeCappedContributionBatch } from './team-join-progress';

function disabledGate(readonlyMaintenance: boolean): ActivityWorkflowGate {
  return new ActivityWorkflowGate({
    activityV11Workflow: { enabled: false, readonlyMaintenance },
  } as AppConfig);
}

function client() {
  const legacyRead = jest.fn().mockRejectedValue(new Error('legacy attendance must not be read'));
  const aggregate = jest.fn();
  const groupBy = jest.fn();
  const tx = {
    attendanceRecord: { findMany: legacyRead },
    participationLedgerEntry: { aggregate, groupBy },
  } as unknown as Prisma.TransactionClient;
  return { tx, legacyRead, aggregate, groupBy };
}

describe('team-join contribution without the retired attendance fallback', () => {
  it.each([false, true])(
    'rejects single and batch reads while disabled in maintenance=%s before any query',
    async (readonlyMaintenance) => {
      const { tx, legacyRead, aggregate, groupBy } = client();
      const gate = disabledGate(readonlyMaintenance);
      await expect(
        computeCappedContribution(tx, 'member-1', null, gate, LedgerQueryService),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED });
      await expect(
        computeCappedContributionBatch(tx, ['member-1'], null, gate, LedgerQueryService),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(groupBy).not.toHaveBeenCalled();
    },
  );

  it('also rejects an empty disabled batch without treating it as an authorized zero result', async () => {
    const { tx, legacyRead, aggregate, groupBy } = client();
    await expect(
      computeCappedContributionBatch(tx, [], null, disabledGate(false), LedgerQueryService),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED });
    expect(legacyRead).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });
});

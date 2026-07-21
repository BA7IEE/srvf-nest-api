import { Prisma } from '@prisma/client';

import { BizCode } from '../exceptions/biz-code.constant';
import { claimAtStatus, type StatusClaimTarget } from './claim-at-status.util';

describe('claimAtStatus', () => {
  const targets: Array<{
    target: StatusClaimTarget;
    table: string;
    statusColumn: 'statusCode' | 'certStatusCode';
  }> = [
    { target: 'activity', table: 'Activity', statusColumn: 'statusCode' },
    {
      target: 'activityRegistration',
      table: 'ActivityRegistration',
      statusColumn: 'statusCode',
    },
    { target: 'attendanceSheet', table: 'AttendanceSheet', statusColumn: 'statusCode' },
    { target: 'certificate', table: 'Certificate', statusColumn: 'certStatusCode' },
    {
      target: 'recruitmentApplication',
      table: 'recruitment_applications',
      statusColumn: 'statusCode',
    },
    {
      target: 'teamJoinApplication',
      table: 'team_join_applications',
      statusColumn: 'statusCode',
    },
  ];

  function createTx(claimed: boolean) {
    const queryRaw = jest
      .fn<Promise<Array<{ id: string }>>, [Prisma.Sql]>()
      .mockResolvedValue(claimed ? [{ id: 'row-1' }] : []);
    return {
      tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      queryRaw,
    };
  }

  it.each(targets)('$target uses one conditional FOR NO KEY UPDATE', async (entry) => {
    const { tx, queryRaw } = createTx(true);

    await claimAtStatus(tx, {
      target: entry.target,
      id: 'row-1',
      expectedStatus: 'pending',
      invalidStatusBiz: BizCode.BAD_REQUEST,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const statement = queryRaw.mock.calls[0][0];
    expect(statement.sql).toContain(`FROM "${entry.table}"`);
    expect(statement.sql).toContain(`"${entry.statusColumn}" = ?`);
    expect(statement.sql).toContain('"deletedAt" IS NULL');
    expect(statement.sql).toContain('FOR NO KEY UPDATE');
    expect(statement.values).toEqual(['row-1', 'pending']);
  });

  it('rejects a lost claim with the caller-provided existing BizCode', async () => {
    const { tx } = createTx(false);

    await expect(
      claimAtStatus(tx, {
        target: 'certificate',
        id: 'row-1',
        expectedStatus: 'pending',
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      }),
    ).rejects.toMatchObject({ biz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION });
  });
});

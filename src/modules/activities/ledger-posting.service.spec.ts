import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { LedgerPostingService } from './ledger-posting.service';
import { PrismaService } from '../../database/prisma.service';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';
import { ParticipationTimeCorrectionService } from './participation-time-correction.service';
import { ParticipationTimeLedgerAccessService } from './participation-time-ledger-access.service';

describe('ledger posting draft member query characterization', () => {
  const tx = new PrismaClient();
  let service: LedgerPostingService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LedgerPostingService,
        ...[
          PrismaService,
          LedgerPostingAuditRecorder,
          SettlementNotificationProducer,
          ActivityWorkflowGate,
          ParticipationTimeLedgerService,
          ParticipationTimeCorrectionService,
          ParticipationTimeLedgerAccessService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    service = module.get(LedgerPostingService);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => tx.$disconnect());

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
});

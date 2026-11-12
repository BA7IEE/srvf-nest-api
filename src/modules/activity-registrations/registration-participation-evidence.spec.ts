import { ActivityRegistrationAccessService } from './activity-registration-access.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';

function fixture() {
  const punch = jest.fn().mockResolvedValue(null);
  const result = jest.fn().mockResolvedValue(null);
  const oldRecord = jest.fn(() => {
    throw new Error('legacy record must not be read');
  });
  const oldCheckIn = jest.fn(() => {
    throw new Error('legacy GPS must not be read');
  });
  const tx = {
    attendancePunchEvent: { findFirst: punch },
    participantSettlementResultRevision: { findFirst: result },
    attendanceRecord: { count: oldRecord },
    activityCheckIn: { count: oldCheckIn },
  };
  const service = new ActivityRegistrationAccessService({} as never, {} as never, {} as never);
  return { service, tx, punch, result, oldRecord, oldCheckIn };
}

describe('registration cancellation v1.1 participation evidence', () => {
  it('rejects any recorded punch event, including a void or replacement operation', async () => {
    const f = fixture();
    f.punch.mockResolvedValue({ id: 'void-event' });
    await expect(
      f.service.assertNoParticipationEvidence('registration-1', f.tx as never),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
    });
    expect(f.punch).toHaveBeenCalledWith({
      where: { participationIdentity: { registrationId: 'registration-1' } },
      select: { id: true },
    });
    expect(f.result).not.toHaveBeenCalled();
    expect(f.oldRecord).not.toHaveBeenCalled();
    expect(f.oldCheckIn).not.toHaveBeenCalled();
  });

  it('rejects an already committed result even without punches or positive value', async () => {
    const f = fixture();
    f.result.mockResolvedValue({ id: 'result-zero' });
    await expect(
      f.service.assertNoParticipationEvidence('registration-1', f.tx as never),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
    });
    expect(f.result).toHaveBeenCalledWith({
      where: { identity: { registrationId: 'registration-1' }, statusCode: 'committed' },
      select: { id: true },
    });
  });

  it('allows no evidence and propagates a failed query, without consulting legacy tables', async () => {
    const f = fixture();
    await expect(
      f.service.assertNoParticipationEvidence('registration-1', f.tx as never),
    ).resolves.toBeUndefined();
    f.punch.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      f.service.assertNoParticipationEvidence('registration-1', f.tx as never),
    ).rejects.toThrow('db unavailable');
    expect(f.oldRecord).not.toHaveBeenCalled();
    expect(f.oldCheckIn).not.toHaveBeenCalled();
  });
});

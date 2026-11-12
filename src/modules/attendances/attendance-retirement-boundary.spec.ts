import { Role, UserStatus } from '@prisma/client';

import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import { AdminMemberAttendanceController } from './controllers/admin-member-attendance.controller';

const actor = {
  id: 'user-1',
  username: 'member',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-1',
};

function setup(enabled: boolean, readonlyMaintenance: boolean) {
  const transaction = jest.fn();
  const verifyToken = jest.fn().mockImplementation(() => {
    throw new Error('bad fixture token');
  });
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
  const command = new AttendancePunchCommandService(
    { $transaction: transaction } as never,
    { verifyToken } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    gate,
  );
  const input = {
    activityId: 'activity-1',
    sessionId: 'session-1',
    actionCode: 'check_in',
    dto: { qrToken: 'test-token', eventKey: 'test-event' },
    currentUser: actor,
    auditMeta: { requestId: 'req', ip: null, ua: null },
  } as const;
  return { command, input, transaction, verifyToken };
}

describe('retired attendance entry boundaries', () => {
  it('disabled v1.1 rejects a new punch with 20153/503 before token or transaction', async () => {
    const { command, input, transaction, verifyToken } = setup(false, false);
    await expect(command.selfPunch(input)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
    });
    expect(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.httpStatus).toBe(503);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'readonly maintenance rejects a new punch before transaction when enabled=%s',
    async (enabled) => {
      const { command, input, transaction, verifyToken } = setup(enabled, true);
      await expect(command.selfPunch(input)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
      });
      expect(verifyToken).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('enabled v1.1 still reaches its normal token validation', async () => {
    const { command, input, transaction, verifyToken } = setup(true, false);
    await expect(command.selfPunch(input)).rejects.toMatchObject({
      biz: BizCode.ATTENDANCE_QR_NOT_FOUND,
    });
    expect(verifyToken).toHaveBeenCalledWith('test-token');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('the remaining member summary controller has no old attendance-records handler', () => {
    expect('attendanceRecords' in AdminMemberAttendanceController.prototype).toBe(false);
    expect(typeof AdminMemberAttendanceController.prototype.contributionSummary).toBe('function');
    expect(typeof AdminMemberAttendanceController.prototype.participationSummary).toBe('function');
  });
});

import { Prisma, Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';

describe('managed activity v1.1 settlement summary', () => {
  function setup(
    options: {
      allowed?: boolean;
      enabled?: boolean;
      readOnly?: boolean;
      exists?: boolean;
      role?: Role;
      initiatorId?: string;
    } = {},
  ) {
    const row = {
      id: 'activity-1',
      title: 'Activity',
      activityTypeCode: 'service',
      allocationModeCode: 'first_come',
      organizationId: 'org-1',
      startAt: new Date('2020-01-01T00:00:00Z'),
      endAt: new Date('2020-01-02T00:00:00Z'),
      location: 'place',
      description: null,
      capacity: null,
      statusCode: 'completed',
      workflowRevision: 1,
      requiresInsurance: false,
      isPublicRegistration: true,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultCheckInRadiusMeters: null,
      defaultLocationRequired: false,
      archiveWaitingDays: 0,
      coverImageKey: null,
      galleryImageKeys: [],
      createdAt: new Date('2020-01-01T00:00:00Z'),
      updatedAt: new Date('2020-01-02T00:00:00Z'),
      initiator: options.initiatorId
        ? {
            id: options.initiatorId,
            memberNo: 'M001',
            realName: 'Initiator',
            nickname: null,
            gradeCode: 'level-1',
          }
        : null,
      responsibilityAssignments: [],
      publishReviews: [],
      _count: { registrations: 3 },
    };
    const user = {
      id: 'user-1',
      username: 'user-1',
      status: UserStatus.ACTIVE,
      memberId: 'member-1',
      role: options.role ?? Role.USER,
    };
    const oldRead = jest.fn(() => {
      throw new Error('legacy sheet data was read');
    });
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue(user) },
      activity: { findFirst: jest.fn().mockResolvedValue(options.exists === false ? null : row) },
      activityRegistration: {
        groupBy: jest.fn().mockResolvedValue([
          { statusCode: 'pending', _count: { _all: 2 } },
          { statusCode: 'waitlisted', _count: { _all: 1 } },
        ]),
      },
      attendanceSheet: { groupBy: oldRead },
      attendanceSettlementRun: {
        findUnique: jest.fn().mockResolvedValue({
          statusCode: 'correction_open',
          currentSubmittedVersion: 2,
        }),
      },
      activitySettlementClosureRevision: {
        findFirst: jest.fn().mockResolvedValue({
          revision: 1,
          closedAt: new Date('2020-01-03T00:00:00Z'),
        }),
      },
    };
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const authz = { can: jest.fn().mockResolvedValue(options.allowed ?? true) };
    const gate = new ActivityWorkflowGate({
      activityV11Workflow: {
        enabled: options.enabled ?? true,
        readonlyMaintenance: options.readOnly ?? false,
      },
    } as AppConfig);
    const images = {
      signImages: jest.fn().mockResolvedValue({ coverImageUrl: null, galleryImageUrls: [] }),
    };
    const identities = {
      resolve: jest.fn().mockResolvedValue({ canUseApp: true, member: { id: 'member-1' } }),
    };
    const service = new ActivityWorkflowQueryService(
      { ...tx, $transaction: transaction } as never,
      authz as never,
      gate,
      images as never,
      identities as never,
    );
    return { service, user, tx, authz, transaction, oldRead, gate, row, identities };
  }

  it('reads scoped v1.1 run and active closure without mixing old sheets or assuming finality', async () => {
    const f = setup();
    const result = await f.service.detail('activity-1', 'member-1', f.user);

    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(f.tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1', status: UserStatus.ACTIVE, deletedAt: null },
      }),
    );
    expect(f.authz.can).toHaveBeenCalledWith(
      f.user,
      'activity.settlement-generate.record',
      { type: 'activity', id: 'activity-1' },
      f.tx,
    );
    expect(f.identities.resolve).toHaveBeenCalledWith(f.user, f.tx);
    expect(f.tx.attendanceSettlementRun.findUnique).toHaveBeenCalledWith({
      where: { activityId: 'activity-1' },
      select: { statusCode: true, currentSubmittedVersion: true },
    });
    expect(f.tx.activitySettlementClosureRevision.findFirst).toHaveBeenCalledWith({
      where: { activityId: 'activity-1', statusCode: 'active' },
      orderBy: { revision: 'desc' },
      select: { revision: true, closedAt: true },
    });
    expect(result.counts).toEqual({ pendingRegistrations: 2, waitlistedRegistrations: 1 });
    expect(result.workflow).toEqual({ status: 'completed', nextAction: null });
    expect(result.settlement).toEqual({
      availability: 'available',
      runStatus: 'correction_open',
      currentSubmittedVersion: 2,
      activeClosure: { revision: 1, closedAt: new Date('2020-01-03T00:00:00Z') },
      readOnly: false,
      workbenchPath: '/api/app/v1/my/managed-activities/activity-1/settlement',
    });
    expect(result).not.toHaveProperty('closure');
    expect(f.oldRead).not.toHaveBeenCalled();
  });

  it('treats an absent run and closure as missing facts, not an old-data fallback', async () => {
    const f = setup();
    f.tx.attendanceSettlementRun.findUnique.mockResolvedValue(null);
    f.tx.activitySettlementClosureRevision.findFirst.mockResolvedValue(null);
    const result = await f.service.detail('activity-1', 'member-1', f.user);
    expect(result.settlement).toEqual(
      expect.objectContaining({
        runStatus: null,
        currentSubmittedVersion: null,
      }),
    );
    expect(result.settlement).not.toHaveProperty('activeClosure');
    expect(f.oldRead).not.toHaveBeenCalled();
  });

  it.each([
    [false, true, false, 'forbidden'],
    [false, false, false, 'forbidden'],
    [true, false, false, 'workflow-disabled'],
    [true, false, true, 'workflow-disabled'],
  ] as const)(
    'preserves activity detail without exposing settlement facts (allowed=%s, enabled=%s, readonly=%s)',
    async (allowed, enabled, readOnly, availability) => {
      const f = setup({ allowed, enabled, readOnly });
      const readSource = jest.spyOn(f.gate, 'participationReadSource');
      const result = await f.service.detail('activity-1', 'member-1', f.user);
      expect(result.settlement).toEqual({ availability });
      expect(result.workflow).toEqual({ status: 'completed', nextAction: null });
      expect(result.counts).toEqual({ pendingRegistrations: 2, waitlistedRegistrations: 1 });
      if (!allowed) expect(readSource).not.toHaveBeenCalled();
      expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
      expect(f.tx.activitySettlementClosureRevision.findFirst).not.toHaveBeenCalled();
      expect(f.oldRead).not.toHaveBeenCalled();
    },
  );

  it('keeps v1.1 facts readable in readonly maintenance without suggesting a write', async () => {
    const f = setup({ readOnly: true });
    const result = await f.service.detail('activity-1', 'member-1', f.user);
    expect(result.settlement).toEqual(
      expect.objectContaining({ availability: 'available', readOnly: true }),
    );
    expect(result.workflow.nextAction).toBeNull();
    expect(result.settlement.workbenchPath).toBe(
      '/api/app/v1/my/managed-activities/activity-1/settlement',
    );
    expect(f.oldRead).not.toHaveBeenCalled();
  });

  it('does not turn navigation into a permanent task when the run is closed', async () => {
    const f = setup();
    f.tx.attendanceSettlementRun.findUnique.mockResolvedValue({
      statusCode: 'closed',
      currentSubmittedVersion: 2,
    });
    const result = await f.service.detail('activity-1', 'member-1', f.user);
    expect(result.workflow.nextAction).toBeNull();
    expect(result.settlement).toEqual(
      expect.objectContaining({
        runStatus: 'closed',
        workbenchPath: '/api/app/v1/my/managed-activities/activity-1/settlement',
      }),
    );
  });

  it('keeps the activity visibility check before settlement authorization', async () => {
    const f = setup({ exists: false });
    await expect(f.service.detail('other-activity', 'member-1', f.user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_NOT_FOUND,
    });
    expect(f.authz.can).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
    expect(f.tx.activity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'other-activity',
          deletedAt: null,
          OR: [
            { initiatorMemberId: 'member-1' },
            { responsibilityAssignments: { some: { memberId: 'member-1', status: 'active' } } },
          ],
        },
      }),
    );
  });

  it.each(['cancelled', 'archived'] as const)(
    'never presents a settlement task for a %s activity',
    async (statusCode) => {
      const f = setup();
      f.row.statusCode = statusCode;
      const result = await f.service.detail('activity-1', 'member-1', f.user);
      expect(result.workflow).toEqual({ status: statusCode, nextAction: null });
    },
  );

  it('treats a terminated activity as ended even if its planned end is in the future', async () => {
    const f = setup();
    f.row.statusCode = 'terminated';
    f.row.endAt = new Date('2099-01-01T00:00:00Z');
    const result = await f.service.detail('activity-1', 'member-1', f.user);
    expect(result.workflow).toEqual({ status: 'terminated', nextAction: null });
  });

  it.each([
    ['member-1', '提交发布审核'],
    ['other-member', null],
    [undefined, null],
  ] as const)(
    'only suggests initial publish review to the initiator (initiator=%s)',
    async (initiatorId, nextAction) => {
      const f = setup({ initiatorId });
      f.row.statusCode = 'draft';
      const result = await f.service.detail('activity-1', 'member-1', f.user);
      expect(result.workflow).toEqual({ status: 'draft', nextAction });
    },
  );

  it('preserves the existing super-admin detail visibility branch', async () => {
    const f = setup({ role: Role.SUPER_ADMIN });
    await f.service.detail('activity-1', 'member-1', f.user);
    expect(f.tx.activity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'activity-1', deletedAt: null } }),
    );
    expect(f.authz.can).toHaveBeenCalledTimes(1);
  });

  it('does not use stale member grants after the account was unbound', async () => {
    const f = setup();
    f.tx.user.findFirst.mockResolvedValue({ ...f.user, memberId: null });
    await expect(f.service.detail('activity-1', 'member-1', f.user)).rejects.toMatchObject({
      biz: BizCode.FORBIDDEN,
    });
    expect(f.identities.resolve).not.toHaveBeenCalled();
    expect(f.tx.activity.findFirst).not.toHaveBeenCalled();
    expect(f.authz.can).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
  });

  it('uses the current role instead of a stale super-admin role for settlement authorization', async () => {
    const f = setup({ role: Role.SUPER_ADMIN });
    const current = { ...f.user, role: Role.USER };
    f.tx.user.findFirst.mockResolvedValue(current);
    f.authz.can.mockResolvedValue(false);
    const result = await f.service.detail('activity-1', 'member-1', f.user);
    expect(result.settlement).toEqual({ availability: 'forbidden' });
    expect(f.authz.can).toHaveBeenCalledWith(
      current,
      'activity.settlement-generate.record',
      { type: 'activity', id: 'activity-1' },
      f.tx,
    );
    expect(f.tx.activity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'activity-1',
          deletedAt: null,
          OR: [
            { initiatorMemberId: 'member-1' },
            { responsibilityAssignments: { some: { memberId: 'member-1', status: 'active' } } },
          ],
        },
      }),
    );
    expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
  });

  it('does not expose settlement when the account or member is no longer active', async () => {
    const noUser = setup();
    noUser.tx.user.findFirst.mockResolvedValue(null);
    await expect(
      noUser.service.detail('activity-1', 'member-1', noUser.user),
    ).rejects.toMatchObject({
      biz: BizCode.UNAUTHORIZED,
    });
    expect(noUser.authz.can).not.toHaveBeenCalled();
    const noMember = setup();
    noMember.identities.resolve.mockResolvedValue({ canUseApp: false, member: null });
    await expect(
      noMember.service.detail('activity-1', 'member-1', noMember.user),
    ).rejects.toMatchObject({
      biz: BizCode.FORBIDDEN,
    });
    expect(noMember.authz.can).not.toHaveBeenCalled();
  });

  it('propagates authorization errors instead of returning a misleading summary', async () => {
    const f = setup();
    f.authz.can.mockRejectedValue(new Error('authorization unavailable'));
    await expect(f.service.detail('activity-1', 'member-1', f.user)).rejects.toThrow(
      'authorization unavailable',
    );
    expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
  });

  it('returns a base write response without starting settlement authorization or its transaction', async () => {
    const f = setup();
    f.authz.can.mockRejectedValue(new Error('settlement authorization unavailable'));
    f.transaction.mockImplementation(() => {
      throw new Error('extra settlement transaction must not start after a write');
    });
    const result = await f.service.detail('activity-1', 'member-1', f.user, false);
    expect(result.settlement).toEqual({ availability: 'not-requested' });
    expect(result.workflow).toEqual({ status: 'completed', nextAction: null });
    expect(f.authz.can).not.toHaveBeenCalled();
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
    expect(f.identities.resolve).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementRun.findUnique).not.toHaveBeenCalled();
    expect(f.oldRead).not.toHaveBeenCalled();
  });
});

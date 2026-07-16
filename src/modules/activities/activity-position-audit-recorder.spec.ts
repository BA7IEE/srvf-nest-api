import { Role } from '@prisma/client';
import type { AuditLogInput, AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityPositionAuditRecorder } from './activity-position-audit-recorder';

const META: AuditMeta = { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' };
const TX = {} as never;

function activityPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'activity-position-0001',
    activityId: 'activity-0001',
    name: '现场保障',
    attendanceRoleCode: 'support',
    capacity: 3,
    startAt: new Date('2026-08-01T09:00:00.000Z'),
    endAt: new Date('2026-08-01T11:00:00.000Z'),
    genderRequirementCode: null,
    description: null,
    sortOrder: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('ActivityPositionAuditRecorder', () => {
  const log = jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined);
  const recorder = new ActivityPositionAuditRecorder({ log } as unknown as AuditLogsService);

  beforeEach(() => log.mockClear());

  it('三类写操作均复用 activity.publish，并用 activityPosition.* operation 区分', async () => {
    const before = activityPosition();
    const after = activityPosition({ capacity: 5 });
    const deleted = activityPosition({ deletedAt: new Date('2026-07-16T01:00:00.000Z') });

    await recorder.logCreate({
      activityPosition: before,
      actorUserId: 'user-1',
      actorRoleSnap: Role.ADMIN,
      auditMeta: META,
      tx: TX,
    });
    await recorder.logUpdate({
      before,
      after,
      changedFields: ['capacity'],
      actorUserId: 'user-1',
      actorRoleSnap: Role.ADMIN,
      auditMeta: META,
      tx: TX,
    });
    await recorder.logSoftDelete({
      before,
      after: deleted,
      actorUserId: 'user-1',
      actorRoleSnap: Role.ADMIN,
      auditMeta: META,
      tx: TX,
    });

    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([payload]) => payload.event)).toEqual([
      'activity.publish',
      'activity.publish',
      'activity.publish',
    ]);
    expect(log.mock.calls.map(([payload]) => payload.extra?.operation)).toEqual([
      'activityPosition.create',
      'activityPosition.update',
      'activityPosition.softDelete',
    ]);
    for (const [payload] of log.mock.calls) {
      expect(payload).toMatchObject({
        resourceType: 'activity',
        resourceId: 'activity-0001',
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        meta: META,
        tx: TX,
      });
      expect(payload.extra?.activityPositionId).toBe('activity-position-0001');
    }
  });

  it('snapshot 仅含岗位业务字段，不含报名人或凭证字段', async () => {
    await recorder.logCreate({
      activityPosition: activityPosition(),
      actorUserId: 'user-1',
      actorRoleSnap: Role.ADMIN,
      auditMeta: META,
      tx: TX,
    });

    const snapshot = log.mock.calls[0][0].after as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'activityId',
        'activityPositionId',
        'attendanceRoleCode',
        'capacity',
        'deletedAt',
        'description',
        'endAt',
        'genderRequirementCode',
        'name',
        'sortOrder',
        'startAt',
      ].sort(),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/member|password|token|secret/i);
  });
});

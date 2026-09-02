import { Prisma, Role } from '@prisma/client';

import type { AuditLogInput, AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAuditRecorder } from './activity-audit-recorder';

const META: AuditMeta = { requestId: 'req-a6-1', ip: '127.0.0.1', ua: 'jest' };
const TX = {} as never;

function createdActivity() {
  return {
    id: 'activity-a6-1',
    title: '模板创建活动',
    activityTypeCode: 'rescue',
    allocationModeCode: 'first_come',
    organizationId: 'organization-a6-1',
    startAt: new Date('2099-09-10T08:00:00.000Z'),
    endAt: new Date('2099-09-10T12:00:00.000Z'),
    location: '集合点',
    description: null,
    capacity: 20,
    genderRequirementCode: null,
    registrationDeadline: null,
    registrationNotes: null,
    statusCode: 'draft',
    publishedBy: null,
    publishedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    isPublicRegistration: true,
    registrationSchema: null as Prisma.JsonValue | null,
    content: null as Prisma.JsonValue | null,
    locationLongitude: null as Prisma.Decimal | null,
    locationLatitude: null as Prisma.Decimal | null,
  };
}

describe('ActivityAuditRecorder logCreateFromTemplate', () => {
  const log = jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined);
  const recorder = new ActivityAuditRecorder({ log } as unknown as AuditLogsService);

  beforeEach(() => log.mockClear());

  it('复用 activity.publish，并只留下模板来源与 definition hash', async () => {
    await recorder.logCreateFromTemplate({
      created: createdActivity(),
      actorUserId: 'user-a6-1',
      actorRoleSnap: Role.ADMIN,
      templateVersionId: 'template-version-a6-1',
      definitionHash: 'a'.repeat(64),
      nextStatusCode: 'draft',
      auditMeta: META,
      tx: TX,
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'activity.publish',
        resourceType: 'activity',
        resourceId: 'activity-a6-1',
        actorUserId: 'user-a6-1',
        actorRoleSnap: Role.ADMIN,
        meta: META,
        tx: TX,
        extra: {
          operation: 'create_from_template',
          templateVersionId: 'template-version-a6-1',
          definitionHash: 'a'.repeat(64),
          nextStatusCode: 'draft',
        },
      }),
    );
  });

  it('不把 operationKey、原始 definition 或请求体写进审计', async () => {
    await recorder.logCreateFromTemplate({
      created: createdActivity(),
      actorUserId: 'user-a6-1',
      actorRoleSnap: Role.ADMIN,
      templateVersionId: 'template-version-a6-1',
      definitionHash: 'b'.repeat(64),
      nextStatusCode: 'draft',
      auditMeta: META,
      tx: TX,
    });

    const payload = log.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).not.toMatch(
      /operationkey|definitionjson|requesthash|token|secret/i,
    );
  });
});

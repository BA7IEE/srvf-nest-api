import { AttachmentAccessLevel, MembershipType, type Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { ResolvedResource } from './authz.types';
import { ResourceResolverService } from './resource-resolver.service';

const cases = [
  ['organization', 'organization', 'findFirst', { id: 'org', status: 'ACTIVE' }],
  [
    'activity',
    'activity',
    'findFirst',
    { id: 'activity', organizationId: 'org', statusCode: 'draft' },
  ],
  [
    'activity_publish_review',
    'activityPublishReview',
    'findUnique',
    {
      id: 'review',
      activityId: 'activity',
      status: 'pending',
      requestType: 'publish',
      submittedByUserId: 'submitter',
      directPublish: false,
      activity: { organizationId: 'org' },
    },
  ],
  [
    'attendance_sheet',
    'attendanceSheet',
    'findFirst',
    {
      id: 'sheet',
      activityId: 'activity',
      statusCode: 'draft',
      submitterUserId: 'submitter',
      lastSubmittedByUserId: 'last',
      reviewerUserId: 'reviewer',
      activity: { organizationId: 'org' },
    },
  ],
  [
    'attendance_settlement_version',
    'attendanceSettlementVersion',
    'findFirst',
    {
      id: 'settlement',
      statusCode: 'submitted',
      createdByUserId: 'submitter',
      settlementRun: { activityId: 'activity', activity: { organizationId: 'org' } },
      reviewActions: [{ actorUserId: 'reviewer' }],
    },
  ],
  [
    'attendance_record',
    'attendanceRecord',
    'findFirst',
    {
      id: 'record',
      memberId: 'member',
      attendanceStatusCode: 'present',
      sheet: { activityId: 'activity', activity: { organizationId: 'org' } },
    },
  ],
  [
    'activity_registration',
    'activityRegistration',
    'findFirst',
    {
      id: 'registration',
      memberId: 'member',
      activityId: 'activity',
      statusCode: 'confirmed',
      activity: { organizationId: 'org' },
    },
  ],
  ['member', 'member', 'findFirst', { id: 'member', status: 'ACTIVE', users: [{ id: 'owner' }] }],
  ['member_profile', 'memberProfile', 'findFirst', { id: 'profile', memberId: 'member' }],
  [
    'certificate',
    'certificate',
    'findFirst',
    { id: 'certificate', memberId: 'member', certStatusCode: 'valid' },
  ],
  [
    'team_join_application',
    'teamJoinApplication',
    'findFirst',
    {
      id: 'join',
      memberId: 'member',
      selectedOrganizationId: 'org',
      targetOrganizationIds: ['org', 'other'],
      statusCode: 'pending',
    },
  ],
  [
    'recruitment_application',
    'recruitmentApplication',
    'findFirst',
    { id: 'recruitment', statusCode: 'pending' },
  ],
  [
    'notification',
    'notification',
    'findFirst',
    {
      id: 'notification',
      statusCode: 'published',
      recipientMemberId: 'member',
      audienceType: 'directed',
      visibleOrganizationIds: [],
    },
  ],
  [
    'attachment',
    'attachment',
    'findUnique',
    {
      id: 'attachment',
      ownerType: 'activity',
      ownerId: 'activity',
      accessLevel: AttachmentAccessLevel.SENSITIVE,
    },
  ],
] as const;

function setup() {
  const tx: Record<string, Record<string, jest.Mock>> = {};
  for (const [, delegate, method, row] of cases)
    tx[delegate] = { [method]: jest.fn().mockResolvedValue(row) };
  tx.organizationClosure = {
    findMany: jest.fn().mockResolvedValue([{ ancestorId: 'root' }, { ancestorId: 'org' }]),
  };
  tx.memberOrganizationMembership = {
    findFirst: jest.fn().mockResolvedValue({ organizationId: 'org' }),
  };
  const forbidden = new Proxy(
    {},
    {
      get: () => {
        throw new Error('resource resolver escaped caller tx');
      },
    },
  );
  return {
    tx,
    client: tx as unknown as Prisma.TransactionClient,
    service: new ResourceResolverService(forbidden as PrismaService),
  };
}

const expected: Record<string, Partial<ResolvedResource>> = {
  organization: { statusCode: 'ACTIVE' },
  activity: { activityId: 'activity', statusCode: 'draft' },
  activity_publish_review: {
    activityId: 'activity',
    statusCode: 'pending',
    extra: { requestType: 'publish', submittedByUserId: 'submitter', directPublish: false },
  },
  attendance_sheet: {
    activityId: 'activity',
    statusCode: 'draft',
    extra: {
      submitterUserId: 'submitter',
      lastSubmittedByUserId: 'last',
      reviewerUserId: 'reviewer',
    },
  },
  attendance_settlement_version: {
    activityId: 'activity',
    statusCode: 'submitted',
    extra: { submitterUserId: 'submitter', reviewerUserId: 'reviewer' },
  },
  attendance_record: { activityId: 'activity', ownerMemberId: 'member', statusCode: 'present' },
  activity_registration: {
    activityId: 'activity',
    ownerMemberId: 'member',
    statusCode: 'confirmed',
  },
  member: { ownerMemberId: 'member', ownerUserId: 'owner', statusCode: 'ACTIVE' },
  member_profile: { ownerMemberId: 'member', sensitivityLevel: 'sensitive' },
  certificate: { ownerMemberId: 'member', statusCode: 'valid' },
  team_join_application: {
    ownerMemberId: 'member',
    statusCode: 'pending',
    extra: { targetOrganizationIds: ['org', 'other'] },
  },
  recruitment_application: {
    organizationId: null,
    organizationPath: null,
    statusCode: 'pending',
    sensitivityLevel: 'sensitive',
  },
  notification: {
    ownerMemberId: 'member',
    statusCode: 'published',
    extra: { audienceType: 'directed', visibleOrganizationIds: [] },
  },
  attachment: {
    activityId: 'activity',
    sensitivityLevel: 'sensitive',
    extra: { ownerType: 'activity', ownerId: 'activity' },
  },
};

describe('C1 D2b all resource resolution delegates stay inside caller tx', () => {
  it.each(cases)(
    '%s preserves the complete resource projection through caller delegates',
    async (type, delegate, method, row) => {
      const { service, tx, client } = setup();
      expect(await service.resolve({ type, id: row.id }, client)).toEqual({
        resourceType: type,
        resourceId: row.id,
        organizationId: 'org',
        organizationPath: ['root', 'org'],
        ownerMemberId: null,
        ownerUserId: null,
        activityId: null,
        statusCode: null,
        sensitivityLevel: null,
        ...expected[type],
      });
      expect(tx[delegate][method]).toHaveBeenCalledTimes(1);
      expect(tx[delegate][method]).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: row.id }) as unknown }),
      );
      if (type === 'recruitment_application')
        expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
      else
        expect(tx.organizationClosure.findMany).toHaveBeenCalledWith({
          where: { descendantId: 'org' },
          select: { ancestorId: true },
          orderBy: { depth: 'desc' },
        });
    },
  );
  it.each(cases)(
    '%s missing target fails closed without reading ancestors',
    async (type, delegate, method, row) => {
      const { service, tx, client } = setup();
      tx[delegate][method].mockResolvedValue(null);
      expect(await service.resolve({ type, id: row.id }, client)).toBeNull();
      expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
      expect(tx.memberOrganizationMembership.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each(['member', 'certificate', 'activity'] as const)(
    'attachment recursively delegates %s, including membership and ancestors, through the same tx',
    async (ownerType) => {
      const { service, tx, client } = setup();
      tx.attachment.findUnique.mockResolvedValue({
        id: 'attachment',
        ownerType,
        ownerId: ownerType,
        accessLevel: AttachmentAccessLevel.SENSITIVE,
      });
      const result = await service.resolve({ type: 'attachment', id: 'attachment' }, client);
      expect(result).toEqual({
        resourceType: 'attachment',
        resourceId: 'attachment',
        organizationId: 'org',
        organizationPath: ['root', 'org'],
        ownerMemberId: ownerType === 'activity' ? null : 'member',
        ownerUserId: ownerType === 'member' ? 'owner' : null,
        activityId: ownerType === 'activity' ? 'activity' : null,
        statusCode: null,
        sensitivityLevel: 'sensitive',
        extra: { ownerType, ownerId: ownerType },
      });
      expect(tx[ownerType].findFirst).toHaveBeenCalledTimes(1);
      if (ownerType !== 'activity')
        expect(tx.memberOrganizationMembership.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              memberId: 'member',
              membershipType: MembershipType.PRIMARY,
              deletedAt: null,
            }) as unknown,
          }),
        );
    },
  );
  it('broken attachment ownership remains null, with no default client fallback', async () => {
    const { service, tx, client } = setup();
    tx.activity.findFirst.mockResolvedValue(null);
    expect(await service.resolve({ type: 'attachment', id: 'attachment' }, client)).toBeNull();
    expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
  });
  it('no current PRIMARY membership leaves Member ownership intact but no organization scope', async () => {
    const { service, tx, client } = setup();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue(null);
    expect(await service.resolve({ type: 'member', id: 'member' }, client)).toEqual({
      resourceType: 'member',
      resourceId: 'member',
      organizationId: null,
      organizationPath: null,
      ownerMemberId: 'member',
      ownerUserId: 'owner',
      activityId: null,
      statusCode: 'ACTIVE',
      sensitivityLevel: null,
    });
    expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
  });
  it('omitting tx retains the existing default-client projection for every resource', async () => {
    const { service, tx, client } = setup();
    const original = new ResourceResolverService(tx as unknown as PrismaService);
    for (const [type, , , row] of cases)
      expect(await original.resolve({ type, id: row.id })).toEqual(
        await service.resolve({ type, id: row.id }, client),
      );
  });
  it('unknown resource type remains a fail-closed no-query result', async () => {
    const { service, tx, client } = setup();
    expect(await service.resolve({ type: 'unsupported', id: 'unknown' }, client)).toBeNull();
    for (const delegate of Object.values(tx))
      for (const query of Object.values(delegate)) expect(query).not.toHaveBeenCalled();
  });
});

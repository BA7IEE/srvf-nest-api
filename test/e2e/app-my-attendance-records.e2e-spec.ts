import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import appConfig from '../../src/config/app.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedParticipationReadState } from '../fixtures/contribution-ledger.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { conformingAttachmentKey } from '../helpers/attachment-key';
import { attachmentBytesForMime } from '../helpers/file-fixtures';

// Preserve the old self-read acceptance: exact public projection, D5 admission,
// identity isolation, visibility, filtering and stable pages. Formal visibility
// now means committed ledger entries. Old Sheets/soft deletions are not ledger
// facts, and the retired route remains absent even for authenticated callers.
const ROUTE = '/api/app/v1/my/participation-ledger';
const KEYS = [
  'entryKey',
  'activityId',
  'sessionId',
  'participationIdentityId',
  'ledgerDate',
  'entryTypeCode',
  'serviceHoursDelta',
  'recognizedPointsDelta',
  'creditedPointsDelta',
  'cappedOutPointsDelta',
].sort();
const FORBIDDEN_KEYS = [
  'id',
  'sheetId',
  'memberId',
  'member',
  'registrationId',
  'updatedAt',
  'postingBatchId',
  'resultRevisionId',
  'operationKey',
  'requestHash',
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'submitterUserId',
  'reviewerUserId',
  'reviewNote',
  'finalReviewerUserId',
  'finalReviewNote',
  'previousSnapshot',
  'version',
  'requestId',
  'ip',
  'ua',
  'description',
  'capacity',
  'deletedAt',
  'note',
  'adjustmentReason',
  'activityTitle',
  'activityStartAt',
  'activityEndAt',
  'activityCoverImageUrl',
  'coverImageKey',
];
interface Entry {
  entryKey: string;
  activityId: string;
  sessionId: string;
  participationIdentityId: string;
  ledgerDate: string;
  entryTypeCode: string;
  serviceHoursDelta: number;
  recognizedPointsDelta: number;
  creditedPointsDelta: number;
  cappedOutPointsDelta: number;
}
type Actor = { id: string; memberId: string | null; auth: string };

describe('App self participation ledger — migrated attendance read acceptance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: Actor, a: Actor, b: Actor, admin: Actor, emptyAdmin: Actor;
  let noMember: Actor, noMemberAdmin: Actor, inactive: Actor, deleted: Actor;
  let organizationId: string;
  let activity1Id: string, activity2Id: string, activity3Id: string;
  let preparingId: string, readyId: string, voidedId: string, legacyOnlyId: string;
  let expectedA: string[], expectedB: string[], expectedAdmin: string[];
  let historicalSheetId: string;
  let historicalRecordId: string;

  async function actor(
    name: string,
    role: Role,
    memberStatus: MemberStatus | null = MemberStatus.ACTIVE,
    softDeleted = false,
  ): Promise<Actor> {
    const user = await createTestUser(app, { username: `p26-${name}`, role });
    const member =
      memberStatus === null
        ? null
        : await prisma.member.create({
            data: {
              memberNo: `p26-${name}`,
              ...memberIdentityData(`P26 ${name}`),
              status: memberStatus,
              gradeCode: 'level-2',
              ...(softDeleted ? { deletedAt: new Date() } : {}),
            },
          });
    if (member) await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      id: user.id,
      memberId: member?.id ?? null,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function activity(day: number, statusCode = 'completed') {
    return prisma.activity.create({
      data: {
        title: `P26 activity ${day}`,
        activityTypeCode: 'p26-ledger',
        organizationId,
        startAt: new Date(`2020-06-${String(day).padStart(2, '0')}T08:00:00Z`),
        endAt: new Date(`2020-06-${String(day).padStart(2, '0')}T18:00:00Z`),
        location: 'P26',
        statusCode,
      },
    });
  }

  async function seed(
    activityId: string,
    people: Actor[],
    status: 'committed' | 'preparing' | 'ready' | 'voided' = 'committed',
  ) {
    await seedParticipationReadState(prisma, {
      activityId,
      actorUserId: owner.id,
      batchStatus: status === 'committed' ? 'committed' : 'preparing',
      participants: people.map((person) => ({
        memberId: person.memberId!,
        resultCode: 'present',
        serviceHours: '2',
        recognizedPoints: '2',
        creditedPoints: '1',
      })),
    });
    // Read fixtures represent existing upstream states. They do not claim to
    // exercise preparation/commit or reproduce their allocation algorithm.
    if (status === 'ready' || status === 'voided')
      await prisma.ledgerPostingBatch.updateMany({
        where: { settlementRun: { activityId } },
        data: { statusCode: status },
      });
  }

  async function keysFor(activityIds: string[], person: Actor) {
    return (
      await prisma.participationLedgerEntry.findMany({
        where: { activityId: { in: activityIds }, memberId: person.memberId! },
        select: { entryKey: true },
      })
    )
      .map((row) => row.entryKey)
      .sort();
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    owner = await actor('owner', Role.SUPER_ADMIN, null);
    a = await actor('a', Role.USER);
    b = await actor('b', Role.USER);
    admin = await actor('admin', Role.ADMIN);
    emptyAdmin = await actor('empty-admin', Role.ADMIN);
    noMember = await actor('no-member', Role.USER, null);
    noMemberAdmin = await actor('no-member-admin', Role.ADMIN, null);
    inactive = await actor('inactive', Role.USER, MemberStatus.INACTIVE);
    deleted = await actor('deleted', Role.USER, MemberStatus.ACTIVE, true);
    organizationId = (
      await prisma.organization.create({
        data: { name: 'P26 read org', nodeTypeCode: 'p26-node' },
      })
    ).id;
    const activity1 = await activity(1, 'draft');
    activity1Id = activity1.id;
    // Keep a real covered activity as well as an uncovered one. The new public
    // projection exposes their anchors, not attachment locators or old metadata.
    await prisma.attachmentTypeConfig.upsert({
      where: { code: 'activity' },
      update: {},
      create: {
        code: 'activity',
        displayName: '活动照片',
        ownerTable: 'activity',
        defaultMaxSizeBytes: 10 * 1024 * 1024,
        defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    const coverKey = conformingAttachmentKey();
    const coverPath = resolve(
      app.get<{ storage: { localRoot: string } }>(appConfig.KEY).storage.localRoot,
      coverKey,
    );
    mkdirSync(dirname(coverPath), { recursive: true });
    writeFileSync(coverPath, attachmentBytesForMime('image/jpeg', 256));
    const cover = await request(httpServer(app))
      .post('/api/admin/v1/attachments')
      .set('Authorization', owner.auth)
      .send({
        key: coverKey,
        originalName: 'p26-cover.jpg',
        mime: 'image/jpeg',
        size: 256,
        ownerType: 'activity',
        ownerId: activity1Id,
        expireAt: null,
      })
      .expect(201);
    await request(httpServer(app))
      .put(`/api/admin/v1/activities/${activity1Id}/cover`)
      .set('Authorization', owner.auth)
      .send({ attachmentId: cover.body.data.id })
      .expect(200);
    await prisma.activity.update({ where: { id: activity1Id }, data: { statusCode: 'completed' } });
    activity2Id = (await activity(2)).id;
    activity3Id = (await activity(3)).id;
    await seed(activity1Id, [a, a]);
    await seed(activity2Id, [a, b]);
    await seed(activity3Id, [a]);
    const adminActivity = await activity(4);
    await seed(adminActivity.id, [admin]);
    preparingId = (await activity(5)).id;
    readyId = (await activity(6)).id;
    voidedId = (await activity(7)).id;
    await seed(preparingId, [a], 'preparing');
    await seed(readyId, [a], 'ready');
    await seed(voidedId, [a], 'voided');
    // Expected visibility comes from the three explicitly committed fixtures,
    // rather than duplicating the production committed predicate in an oracle.
    expectedA = await keysFor([activity1Id, activity2Id, activity3Id], a);
    expectedB = await keysFor([activity2Id], b);
    expectedAdmin = await keysFor([adminActivity.id], admin);
    expect(expectedA).toHaveLength(8);
    expect(expectedB).toHaveLength(2);
    expect(expectedAdmin).toHaveLength(2);
    const record = {
      memberId: a.memberId!,
      roleCode: 'member',
      attendanceStatusCode: 'present',
      checkInAt: new Date('2020-06-01T08:00:00Z'),
      checkOutAt: new Date('2020-06-01T10:00:00Z'),
      serviceHours: 2,
      contributionPoints: 99,
    };
    const history = await prisma.attendanceSheet.create({
      data: {
        activityId: activity1Id,
        submitterUserId: owner.id,
        statusCode: 'approved',
        records: { create: record },
      },
      include: { records: true },
    });
    historicalSheetId = history.id;
    historicalRecordId = history.records[0].id;
    legacyOnlyId = (await activity(8)).id;
    for (const statusCode of [
      'approved',
      'pending',
      'rejected',
      'pending_final_review',
      'final_rejected',
    ]) {
      await prisma.attendanceSheet.create({
        data: {
          activityId: legacyOnlyId,
          submitterUserId: owner.id,
          statusCode,
          records: { create: record },
        },
      });
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(auth: string, query: Record<string, unknown> = {}) {
    return request(httpServer(app))
      .get(ROUTE)
      .set('Authorization', auth)
      .query({ page: 1, pageSize: 100, ...query });
  }
  function items(response: request.Response): Entry[] {
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    return response.body.data.items as Entry[];
  }
  const keys = (response: request.Response) =>
    items(response)
      .map((row) => row.entryKey)
      .sort();

  it('returns exactly the ten public ledger fields', async () => {
    const rows = items(await get(a.auth));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(KEYS);
  });

  it('never exposes subject, reviewer, batch, credential, audit or attachment internals', async () => {
    const rows = items(await get(a.auth));
    for (const row of rows) for (const key of FORBIDDEN_KEYS) expect(row).not.toHaveProperty(key);
  });

  it('activity/session/identity anchors resolve to the same source activity, including a real cover', async () => {
    const rows = items(await get(a.auth, { activityId: activity1Id }));
    expect(rows).toHaveLength(4);
    const covered = await prisma.activity.findUniqueOrThrow({ where: { id: activity1Id } });
    expect(covered.coverImageKey).not.toBeNull();
    for (const row of rows) {
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: row.participationIdentityId },
      });
      expect(identity).toMatchObject({
        activityId: activity1Id,
        sessionId: row.sessionId,
        memberId: a.memberId,
      });
      expect(row.activityId).toBe(covered.id);
    }
  });

  it('an activity without a cover still returns its public ledger entries', async () => {
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: activity2Id } })).coverImageKey,
    ).toBeNull();
    const rows = items(await get(a.auth, { activityId: activity2Id }));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.activityId === activity2Id)).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.entryTypeCode === 'contribution_credit' &&
          row.recognizedPointsDelta === 2 &&
          row.creditedPointsDelta === 1 &&
          row.cappedOutPointsDelta === 1,
      ),
    ).toBe(true);
  });

  it('returns exactly the committed self entries and count', async () => {
    const response = await get(a.auth);
    expect(keys(response)).toEqual(expectedA);
    expect(response.body.data.total).toBe(8);
  });

  it('preparing entries exist but remain invisible', async () => {
    expect(await keysFor([preparingId], a)).toHaveLength(2);
    const response = await get(a.auth, { activityId: preparingId });
    expect(items(response)).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });

  it('ready and voided entries exist but remain invisible', async () => {
    for (const activityId of [readyId, voidedId]) {
      expect(await keysFor([activityId], a)).toHaveLength(2);
      const response = await get(a.auth, { activityId });
      expect(items(response)).toEqual([]);
      expect(response.body.data.total).toBe(0);
    }
  });

  it('soft-deleting a legacy Sheet cannot hide or add committed native entries', async () => {
    await prisma.attendanceSheet.update({
      where: { id: historicalSheetId },
      data: { deletedAt: new Date() },
    });
    expect(keys(await get(a.auth))).toEqual(expectedA);
  });

  it('soft-deleting a legacy record cannot hide or add committed native entries', async () => {
    await prisma.attendanceSheet.update({
      where: { id: historicalSheetId },
      data: { deletedAt: null },
    });
    await prisma.attendanceRecord.update({
      where: { id: historicalRecordId },
      data: { deletedAt: new Date() },
    });
    expect(keys(await get(a.auth))).toEqual(expectedA);
  });

  it('activity filter returns only the requested self activity', async () => {
    expect(keys(await get(a.auth, { activityId: activity1Id }))).toEqual(
      await keysFor([activity1Id], a),
    );
  });
  it('unknown activity filter returns an empty page', async () => {
    const response = await get(a.auth, { activityId: 'p26-missing-activity' });
    expect(items(response)).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });

  it.each([
    ['oversized page', { pageSize: 101 }, 'pageSize must not be greater than 100'],
    ['zero page', { page: 0 }, 'page must not be less than 1'],
    ['old Sheet filter', { sheetId: 'p26-forbidden-sheet' }, 'property sheetId should not exist'],
    [
      'subject override',
      { memberId: 'p26-forbidden-member' },
      'property memberId should not exist',
    ],
  ])('rejects %s', async (_label, query, message) => {
    const response = await get(a.auth, query);
    expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(response.body.message).toBe(message);
  });

  it('A cannot see B entries', async () => {
    const own = keys(await get(a.auth));
    for (const key of expectedB) expect(own).not.toContain(key);
  });
  it('B sees only B entries, including on an activity shared with A', async () => {
    expect(keys(await get(b.auth))).toEqual(expectedB);
  });
  it('an ADMIN linked to an active member sees their own committed entries', async () => {
    expect(keys(await get(admin.auth))).toEqual(expectedAdmin);
  });
  it('ADMIN role does not expand self visibility to A or B', async () => {
    const own = keys(await get(admin.auth));
    for (const key of [...expectedA, ...expectedB]) expect(own).not.toContain(key);
  });

  it.each(['admin-without-member', 'user-without-member', 'inactive-member', 'deleted-member'])(
    '%s is forbidden by App admission',
    async (kind) => {
      const person = {
        'admin-without-member': noMemberAdmin,
        'user-without-member': noMember,
        'inactive-member': inactive,
        'deleted-member': deleted,
      }[kind]!;
      expectBizError(await get(person.auth), BizCode.FORBIDDEN);
    },
  );
  it('disabling a user invalidates their existing access token immediately', async () => {
    await prisma.user.update({ where: { id: b.id }, data: { status: UserStatus.DISABLED } });
    try {
      expectBizError(await get(b.auth), BizCode.UNAUTHORIZED);
    } finally {
      await prisma.user.update({ where: { id: b.id }, data: { status: UserStatus.ACTIVE } });
    }
  });

  it('an active ADMIN member without committed entries gets a valid empty page', async () => {
    const response = await get(emptyAdmin.auth);
    expect(items(response)).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });
  it('pagination preserves total and has no duplicates even at same-day ties', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 8; page++) {
      const response = await get(a.auth, { page, pageSize: 1 });
      const rows = items(response);
      expect(response.body.data).toMatchObject({ page, pageSize: 1, total: 8 });
      expect(rows).toHaveLength(1);
      seen.push(rows[0].entryKey);
    }
    expect(new Set(seen).size).toBe(8);
    expect(seen.sort()).toEqual(expectedA);
    const beyond = await get(a.auth, { page: 9, pageSize: 1 });
    expect(items(beyond)).toEqual([]);
    expect(beyond.body.data.total).toBe(8);
  });
  it('orders by Beijing ledger day then stable activity/type/key ties', async () => {
    const rows = items(await get(a.auth));
    expect(rows).toHaveLength(8);
    expect(rows[0].activityId).toBe(activity1Id);
    expect(rows.at(-1)?.activityId).toBe(activity3Id);
    const order = rows.map((row) =>
      [row.ledgerDate, row.activityId, row.entryTypeCode, row.entryKey].join('|'),
    );
    expect(order).toEqual([...order].sort());
  });
  it('requires authentication on the live self route', async () => {
    expectBizError(await request(httpServer(app)).get(ROUTE), BizCode.UNAUTHORIZED);
  });

  it('legacy history of every review status cannot become formal ledger truth', async () => {
    expect(await prisma.attendanceSheet.count({ where: { activityId: legacyOnlyId } })).toBe(5);
    const response = await get(a.auth, { activityId: legacyOnlyId });
    expect(items(response)).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });
  it('the retired attendance route is absent for anonymous, member and administrator callers', async () => {
    for (const auth of [null, a.auth, owner.auth]) {
      const operation = request(httpServer(app)).get('/api/app/v1/my/attendance-records');
      if (auth !== null) operation.set('Authorization', auth);
      await operation.expect(404);
    }
  });
  it('self reads and denied overrides do not write ledger facts, audit or notification intents', async () => {
    const snapshot = async () => ({
      entries: await prisma.participationLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
      sheets: await prisma.attendanceSheet.findMany({ orderBy: { id: 'asc' } }),
      records: await prisma.attendanceRecord.findMany({ orderBy: { id: 'asc' } }),
      audits: await prisma.auditLog.count(),
      intents: await prisma.notificationOutboxIntent.count(),
    });
    const before = await snapshot();
    expect(keys(await get(a.auth))).toEqual(expectedA);
    const override = await get(a.auth, { memberId: b.memberId });
    expectBizError(override, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(override.body.message).toBe('property memberId should not exist');
    expectBizError(await get(noMember.auth), BizCode.FORBIDDEN);
    await request(httpServer(app))
      .get('/api/app/v1/my/attendance-records')
      .set('Authorization', owner.auth)
      .expect(404);
    expect(await snapshot()).toEqual(before);
  });
});

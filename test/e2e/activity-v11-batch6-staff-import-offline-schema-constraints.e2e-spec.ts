import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const T = (iso: string) => `'${iso}'::timestamp`;
const SESSION_START = '2099-06-01T09:00:00.000Z';
const SESSION_END = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const UPLOAD_UNTIL = '2099-06-01T19:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('activity v1.1 batch6 staff/import/offline schema constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let activityId: string;
  let sessionId: string;
  let sessionId2: string;
  let userId: string;
  let memberId: string;
  let identityId: string;
  let participationRevisionId: string;
  let ruleSnapshotId: string;
  let offlinePackageId: string;
  let sequence = 0;

  const uniq = (label: string) => `b6-schema-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw error;
    }
  }

  async function expectAccepted(sql: string): Promise<void> {
    expect(await run(sql)).toBeNull();
  }

  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string; key?: string },
  ): Promise<void> {
    const error = await run(sql);
    expect(error).not.toBeNull();
    expect(error?.sqlState).toBe(expected.sqlState);
    if (expected.constraint !== undefined) expect(error?.constraint).toBe(expected.constraint);
    if (expected.key !== undefined) expect(error?.message).toContain(expected.key);
  }

  function packageSql(
    id: string,
    over: Partial<{
      sessionId: string;
      deviceId: string;
      packageVersion: number;
      statusCode: string;
      validFrom: string;
      validUntil: string;
      uploadUntil: string;
      tokenDigest: string;
      revokedByUserId: string | null;
      revokedAt: string | null;
      revokeReason: string | null;
      revokeOperationKey: string | null;
      revokeRequestHash: string | null;
    }> = {},
  ): string {
    const valueOr = <T>(value: T | undefined, fallback: T): T =>
      value === undefined ? fallback : value;
    const values = {
      sessionId,
      deviceId: `device-${id}`,
      packageVersion: 1,
      statusCode: 'active',
      validFrom: CHECKIN_OPEN,
      validUntil: CHECKOUT_CLOSE,
      uploadUntil: UPLOAD_UNTIL,
      tokenDigest: HASH_A,
      ...over,
    };
    const revokedByUserId = valueOr(
      over.revokedByUserId,
      values.statusCode === 'revoked' ? userId : null,
    );
    const revokedAt = valueOr(over.revokedAt, values.statusCode === 'revoked' ? SESSION_END : null);
    const revokeReason = valueOr(
      over.revokeReason,
      values.statusCode === 'revoked' ? 'schema revoke control' : null,
    );
    const revokeOperationKey = valueOr(
      over.revokeOperationKey,
      values.statusCode === 'revoked' ? `revoke-${id}` : null,
    );
    const revokeRequestHash = valueOr(
      over.revokeRequestHash,
      values.statusCode === 'revoked' ? HASH_B : null,
    );
    const s = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
    return `INSERT INTO "OfflinePackage"
      ("id","updatedAt","activityId","sessionId","operatorUserId","operatorMemberId","deviceId",
       "packageVersion","packageKeyVersion","statusCode","tokenDigest","ruleSnapshotId",
       "ruleSnapshotHash","workflowRevision","participantSnapshotHash","validFrom","validUntil",
       "uploadUntil","sequenceStart","nextExpectedSequence","chainAnchorHash","lastAcceptedHash",
       "lastAcceptedAt","issuedAt","issueOperationKey","issueRequestHash","revokedByUserId",
       "revokedAt","revokeReason","revokeOperationKey","revokeRequestHash")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${values.sessionId}', '${userId}', '${memberId}',
       '${values.deviceId}', ${values.packageVersion}, 0, '${values.statusCode}', '${values.tokenDigest}',
       '${ruleSnapshotId}', '${HASH_A}', 0, '${HASH_B}', ${T(values.validFrom)}, ${T(values.validUntil)},
       ${T(values.uploadUntil)}, 1, 1, '${HASH_C}', '${HASH_C}', NULL, ${T(CHECKIN_OPEN)},
       'issue-${id}', '${HASH_A}', ${s(revokedByUserId)},
       ${revokedAt === null ? 'NULL' : T(revokedAt)}, ${s(revokeReason)}, ${s(revokeOperationKey)},
       ${s(revokeRequestHash)})`;
  }

  function participantSql(over: Partial<{ sessionId: string }> = {}): string {
    const targetSessionId = over.sessionId ?? sessionId;
    return `INSERT INTO "OfflinePackageParticipant"
      ("offlinePackageId","activityId","sessionId","participationIdentityId","memberId",
       "participationRevisionId","positionId")
      VALUES ('${offlinePackageId}', '${activityId}', '${targetSessionId}', '${identityId}', '${memberId}',
       '${participationRevisionId}', NULL)`;
  }

  function reviewSql(
    id: string,
    over: Partial<{
      sequence: number;
      statusCode: string;
      anomalyCode: string;
      approvalPolicyCode: string;
    }> = {},
  ): string {
    const values = {
      sequence: 1,
      statusCode: 'pending',
      anomalyCode: 'future_time',
      approvalPolicyCode: 'approvable',
      ...over,
    };
    return `INSERT INTO "OfflinePunchReviewItem"
      ("id","updatedAt","offlinePackageId","activityId","sessionId","sequence","eventKey",
       "statusCode","anomalyCode","approvalPolicyCode","stagedByUserId","stagedByMemberId","stagedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${offlinePackageId}', '${activityId}', '${sessionId}',
       ${values.sequence}, 'event-${id}', '${values.statusCode}', '${values.anomalyCode}',
       '${values.approvalPolicyCode}', '${userId}', '${memberId}', ${T(SESSION_START)})`;
  }

  function offlinePunchSql(
    id: string,
    over: Partial<{
      sessionId: string;
      offlinePackageId: string | null;
      offlineSequence: number | null;
      offlinePriorHash: string | null;
      offlineEventPayloadHash: string | null;
    }> = {},
  ): string {
    const values = {
      sessionId,
      offlinePackageId,
      offlineSequence: 1,
      offlinePriorHash: HASH_A,
      offlineEventPayloadHash: HASH_B,
      ...over,
    };
    const s = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
    const n = (value: number | null) => (value === null ? 'NULL' : String(value));
    return `INSERT INTO "AttendancePunchEvent"
      ("id","activityId","sessionId","participationIdentityId","memberId","eventTypeCode",
       "sourceCode","occurredAt","receivedAt","operatorUserId","reason","supersedesEventId",
       "longitude","latitude","accuracy","eventKey","requestHash","evidenceRevision",
       "offlinePackageId","offlineSequence","offlinePriorHash","offlineEventPayloadHash")
      VALUES ('${id}', '${activityId}', '${values.sessionId}', '${identityId}', '${memberId}', 'check_in',
       'offline', ${T(SESSION_START)}, ${T(SESSION_START)}, '${userId}', NULL, NULL,
       NULL, NULL, NULL, 'event-key-${id}', 'request-hash', 0,
       ${s(values.offlinePackageId)}, ${n(values.offlineSequence)}, ${s(values.offlinePriorHash)},
       ${s(values.offlineEventPayloadHash)})`;
  }

  beforeEach(async () => {
    await resetDb(app);

    const organization = await prisma.organization.create({
      data: { name: uniq('organization'), nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityId = (
      await prisma.activity.create({
        data: {
          title: uniq('activity'),
          activityTypeCode: 'batch6-schema',
          organizationId: organization.id,
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          location: 'batch6 schema fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
    memberId = (
      await prisma.member.create({
        data: { memberNo: uniq('member'), ...memberIdentityData('Batch6 Schema Member') },
        select: { id: true },
      })
    ).id;
    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
        select: { id: true },
      })
    ).id;
    const review = await prisma.activityPublishReview.create({
      data: {
        activityId,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: userId,
        reviewedByUserId: userId,
        reviewedAt: new Date(SESSION_START),
      },
      select: { id: true },
    });
    ruleSnapshotId = (
      await prisma.activityRuleSnapshot.create({
        data: {
          activityId,
          workflowRevision: 0,
          resolvedConfig: {},
          snapshotHash: HASH_A,
          createdByReviewId: review.id,
        },
        select: { id: true },
      })
    ).id;
    sessionId = (
      await prisma.activitySession.create({
        data: {
          activityId,
          code: uniq('session'),
          name: uniq('session'),
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          locationText: 'batch6 schema fixture',
          checkInOpenAt: new Date(CHECKIN_OPEN),
          checkInCloseAt: new Date(CHECKIN_CLOSE),
          checkOutOpenAt: new Date(CHECKOUT_OPEN),
          checkOutCloseAt: new Date(CHECKOUT_CLOSE),
          locationRequired: false,
          locationPolicySourceCode: 'system',
          statusCode: 'scheduled',
        },
        select: { id: true },
      })
    ).id;
    sessionId2 = (
      await prisma.activitySession.create({
        data: {
          activityId,
          code: uniq('session-other'),
          name: uniq('session-other'),
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          locationText: 'batch6 schema other session',
          checkInOpenAt: new Date(CHECKIN_OPEN),
          checkInCloseAt: new Date(CHECKIN_CLOSE),
          checkOutOpenAt: new Date(CHECKOUT_OPEN),
          checkOutCloseAt: new Date(CHECKOUT_CLOSE),
          locationRequired: false,
          locationPolicySourceCode: 'system',
          statusCode: 'scheduled',
        },
        select: { id: true },
      })
    ).id;
    const registrationId = (
      await prisma.activityRegistration.create({
        data: { activityId, memberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;
    identityId = (
      await prisma.activityParticipationIdentity.create({
        data: { activityId, sessionId, registrationId, memberId, currentStatusCode: 'pass' },
        select: { id: true },
      })
    ).id;
    participationRevisionId = (
      await prisma.activityParticipationRevision.create({
        data: {
          identityId,
          revision: 0,
          statusCode: 'pass',
          effectiveAt: new Date(SESSION_START),
          sourceCode: 'onsite',
          createdByUserId: userId,
        },
        select: { id: true },
      })
    ).id;
    offlinePackageId = uniq('package');
    await expectAccepted(packageSql(offlinePackageId));
  });

  it('red-first: owns explicit offline package, frozen participant and review-item tables', async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        offlinePackage: string | null;
        offlinePackageParticipant: string | null;
        offlinePunchReviewItem: string | null;
      }>
    >`
      SELECT
        to_regclass('"OfflinePackage"')::text AS "offlinePackage",
        to_regclass('"OfflinePackageParticipant"')::text AS "offlinePackageParticipant",
        to_regclass('"OfflinePunchReviewItem"')::text AS "offlinePunchReviewItem"
    `;

    expect(rows).toEqual([
      {
        offlinePackage: '"OfflinePackage"',
        offlinePackageParticipant: '"OfflinePackageParticipant"',
        offlinePunchReviewItem: '"OfflinePunchReviewItem"',
      },
    ]);
  });

  it('OfflinePackage: 合法 active/revoked 放行，闭集、窗口、hash、撤销形状和 live-device 槽位拒绝漂移', async () => {
    await expectAccepted(packageSql('package-revoked-ok', { statusCode: 'revoked' }));
    await expectRejected(packageSql('package-bad-status', { statusCode: 'bogus' }), {
      sqlState: '23514',
      constraint: 'offline_package_status_code_check',
    });
    await expectRejected(
      packageSql('package-bad-window', { validUntil: CHECKIN_OPEN, uploadUntil: UPLOAD_UNTIL }),
      { sqlState: '23514', constraint: 'offline_package_window_check' },
    );
    await expectRejected(packageSql('package-bad-hash', { tokenDigest: 'not-a-sha256' }), {
      sqlState: '23514',
      constraint: 'offline_package_required_hashes_check',
    });
    await expectRejected(packageSql('package-active-with-revoke', { revokedByUserId: userId }), {
      sqlState: '23514',
      constraint: 'offline_package_revoke_shape_check',
    });

    await expectRejected(
      packageSql('package-live-device-conflict', {
        deviceId: `device-${offlinePackageId}`,
        packageVersion: 2,
      }),
      { sqlState: '23505', key: '"activityId", "sessionId", "deviceId"' },
    );
    // 终态 package 不占 live device 槽位；否则一次撤销会永久阻断重发。
    await expectAccepted(
      packageSql('package-revoked-same-device', {
        deviceId: `device-${offlinePackageId}`,
        packageVersion: 3,
        statusCode: 'revoked',
      }),
    );
  });

  it('OfflinePackageParticipant: roster 行必须与 package 的 activity/session 复合锚一致', async () => {
    await expectRejected(participantSql({ sessionId: sessionId2 }), {
      sqlState: '23503',
      constraint: 'OfflinePackageParticipant_package_anchor_fkey',
    });
    await expectAccepted(participantSql());
  });

  it('OfflinePunchReviewItem: pending 正对照，闭集、anomaly-policy、resolution shape 与 package sequence 唯一均由 DB 兜底', async () => {
    await expectAccepted(reviewSql('review-pending-ok'));
    const statusConstraint = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'offline_review_item_status_code_check'
    `;
    expect(statusConstraint).toHaveLength(1);
    expect(statusConstraint[0]?.definition).toContain("'pending'");
    expect(statusConstraint[0]?.definition).toContain("'approved'");
    expect(statusConstraint[0]?.definition).toContain("'rejected'");
    // 无效 status 同时不可能满足 resolution CASE；PostgreSQL 先命中哪个 CHECK 不影响
    // 闭集存在的结构证据，关键是非法行绝不落库。
    await expectRejected(reviewSql('review-bad-status', { sequence: 2, statusCode: 'bogus' }), {
      sqlState: '23514',
      constraint: 'offline_review_item_resolution_shape_check',
    });
    await expectRejected(
      reviewSql('review-bad-policy', {
        sequence: 3,
        anomalyCode: 'device_mismatch',
        approvalPolicyCode: 'approvable',
      }),
      { sqlState: '23514', constraint: 'offline_review_item_anomaly_policy_check' },
    );
    await expectRejected(
      reviewSql('review-approved-incomplete', { sequence: 4, statusCode: 'approved' }),
      {
        sqlState: '23514',
        constraint: 'offline_review_item_resolution_shape_check',
      },
    );
    await expectRejected(reviewSql('review-sequence-duplicate'), {
      sqlState: '23505',
      key: '"offlinePackageId", sequence',
    });
  });

  it('AttendancePunchEvent: 离线链要求四锚同在、同 package sequence 唯一，并通过 package+activity+session 复合 FK 锚定', async () => {
    await expectAccepted(offlinePunchSql('offline-punch-ok'));
    await expectRejected(offlinePunchSql('offline-punch-missing', { offlineSequence: null }), {
      sqlState: '23514',
      constraint: 'attendance_punch_event_offline_shape_check',
    });
    await expectRejected(
      offlinePunchSql('offline-punch-bad-hash', { offlinePriorHash: 'not-a-sha256' }),
      { sqlState: '23514', constraint: 'attendance_punch_event_offline_hashes_check' },
    );
    await expectRejected(offlinePunchSql('offline-punch-sequence-duplicate'), {
      sqlState: '23505',
      key: '"offlinePackageId", "offlineSequence"',
    });
    await expectRejected(
      offlinePunchSql('offline-punch-session-drift', {
        sessionId: sessionId2,
        offlineSequence: 2,
      }),
      { sqlState: '23503', constraint: 'AttendancePunchEvent_offline_package_anchor_fkey' },
    );
  });
});

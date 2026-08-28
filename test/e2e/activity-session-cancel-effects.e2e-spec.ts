import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * ADV-018 / AC-010:取消**单个**未来场次,只影响该场次的人员、二维码、通知与结算人口。
 *
 * 判据形状(goal §4):每一格都要**正向 + 反向**,而反向是「正面数出 B 场次纹丝不动」——
 * 不是「反正没影响别人」。因此每条反向都逐字段比对 B 场次那几行取消前后的**完整快照**
 * (含 `updatedAt` / `version` / 修订条数),而不是只断言「没变成 cancelled」。
 *
 * 反面样本在被测那一维上单独不同:同一个活动、同一批夹具、同一次审批 —— 只有 sessionId 不同。
 * 这是「上层边界遮蔽下层边界」的防线:换成两个活动,活动级隔离就会把场次级收窄整片遮住。
 */
describe('activity single-session cancellation effects (ADV-018 / AC-010)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let reviewerUserId: string;
  let organizationId: string;
  let activityTypeCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const creator = await createTestUser(app, {
      username: 'session-cancel-creator',
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: 'session-cancel-reviewer',
      role: Role.USER,
    });
    reviewerUserId = reviewer.id;
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: 'session-cancel-creator-member',
        ...memberIdentityData('场次取消发起人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: 'session-cancel-reviewer-member',
        ...memberIdentityData('场次取消审核人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: creator.id }, data: { memberId: creatorMember.id } });
    await prisma.user.update({ where: { id: reviewer.id }, data: { memberId: reviewerMember.id } });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);

    const root = await prisma.organization.create({
      data: { name: '场次取消根组织', nodeTypeCode: 'session-cancel-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '场次取消执行组织',
        nodeTypeCode: 'session-cancel-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId },
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'session-cancel-type';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '场次取消活动' },
    });

    await prisma.permission.createMany({
      data: [
        {
          code: 'activity-review.read.request',
          module: 'activity-review',
          action: 'read',
          resourceType: 'request',
        },
        {
          code: 'activity-review.return.request',
          module: 'activity-review',
          action: 'return',
          resourceType: 'request',
        },
      ],
      skipDuplicates: true,
    });
    const reviewerRole = await prisma.rbacRole.create({
      data: { code: 'session-cancel-reviewer', displayName: '场次取消审核人' },
      select: { id: true },
    });
    const reviewerPermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity-review.read.request',
            'activity-review.return.request',
            'activity.publish.record',
          ],
        },
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: reviewerPermissions.map((permission) => ({
        roleId: reviewerRole.id,
        permissionId: permission.id,
      })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: reviewer.id,
        roleId: reviewerRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
      },
    });

    creatorAuth = (await loginAs(app, creator.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createSession(activityId: string, suffix: string): Promise<string> {
    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `sc-${sequence}-${suffix}`,
        name: `场次 ${suffix}`,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        locationText: '深圳会场',
        capacity: 10,
        checkInOpenAt: '2099-08-01T00:30:00.000Z',
        checkInCloseAt: '2099-08-01T02:00:00.000Z',
        checkOutOpenAt: '2099-08-01T03:00:00.000Z',
        checkOutCloseAt: '2099-08-01T05:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    return session.body.data.sessionId as string;
  }

  function approveReview(reviewId: string, suffix: string) {
    return request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `session-cancel-approve-${suffix}`,
      });
  }

  async function submitCancelChange(
    activityId: string,
    suffix: string,
    sessionId: string,
  ): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: `session-cancel-change-${suffix}`,
        confirmation: true,
        activityPatch: {},
        sessions: { create: [], update: [], cancel: [{ sessionId }] },
        positions: { create: [], update: [], cancel: [] },
      })
      .expect(200);
    return submitted.body.data.id as string;
  }

  interface EnrolledMember {
    memberId: string;
    identityIdBySessionId: Map<string, string>;
  }

  /** 本次取消联动发出的 intent(按 eventKey 前缀筛,不与别的活动事件混在一起)。 */
  async function sessionCancelIntents(activityId: string) {
    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId },
      select: { eventKey: true, destinationRef: true, payload: true },
      orderBy: { eventKey: 'asc' },
    });
    return intents.filter((intent) => intent.eventKey.startsWith('activity-session-cancel:'));
  }

  /** 建一份**自洽的 canonical 报名**:头 + 头修订 + 身份 + 身份修订,四层齐全。 */
  async function enrol(input: {
    activityId: string;
    sessionIds: readonly string[];
    label: string;
  }): Promise<EnrolledMember> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `session-cancel-member-${sequence}`,
        ...memberIdentityData(`场次取消队员 ${input.label}`),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: input.activityId,
        memberId: member.id,
        // deriveRegistrationStatusSummary(['pending', ...]) 的投影,取消链会逐层对账。
        statusCode: 'pending',
        statusSummaryCode: 'active',
        currentRevision: 1,
      },
      select: { id: true },
    });
    await prisma.activityRegistrationRevision.create({
      data: {
        registrationId: registration.id,
        revision: 1,
        sourceCode: 'self',
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const identityIdBySessionId = new Map<string, string>();
    for (const sessionId of input.sessionIds) {
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: input.activityId,
          sessionId,
          registrationId: registration.id,
          memberId: member.id,
          currentRevision: 1,
          currentStatusCode: 'pending',
          // pending ⇒ 不占名额、不进人口(不变量,取消链会断言)。
          populationIncluded: false,
        },
        select: { id: true },
      });
      await prisma.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: 1,
          statusCode: 'pending',
          effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
          sourceCode: 'self',
        },
      });
      identityIdBySessionId.set(sessionId, identity.id);
    }
    return { memberId: member.id, identityIdBySessionId };
  }

  async function issueQrCredential(activityId: string, sessionId: string): Promise<string> {
    sequence += 1;
    const credential = await prisma.attendanceQrCredential.create({
      data: {
        activityId,
        sessionId,
        actionCode: 'check_in',
        credentialVersion: 1,
        statusCode: 'active',
        tokenDigest: `digest-${sequence}`.padEnd(64, '0'),
        signingKeyVersion: 0,
        validFrom: new Date('2099-08-01T00:30:00.000Z'),
        validUntil: new Date('2099-08-01T02:00:00.000Z'),
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    return credential.id;
  }

  const identitySelect = {
    id: true,
    sessionId: true,
    currentRevision: true,
    currentStatusCode: true,
    currentPositionId: true,
    capacityReservationId: true,
    populationIncluded: true,
    version: true,
    updatedAt: true,
  } as const;

  const credentialSelect = {
    id: true,
    sessionId: true,
    statusCode: true,
    revokedByUserId: true,
    revokedAt: true,
    revokeReason: true,
    updatedAt: true,
  } as const;

  /**
   * ⭐ 每一格**单独成 `it`**,共用一次夹具(`beforeAll` 里建 + 取消)。
   *
   * 这不是排版偏好:本刀第一版把七格塞在一个 `it` 里,变异对拍实测发现 M1(把身份查询从
   * 按场次改成按活动)**红在正向那一条**上 —— jest 在第一条失败就停,三条反向断言一条都没被
   * 执行到。也就是说「反向判据有判别力」这件事在那种排布下**根本观测不到**。
   * 拆开之后每条反向各自红绿独立,变异对拍才读得出精确红集。
   */
  describe('one activity, two sessions, three enrolments — cancel session A only', () => {
    let activityId: string;
    let sessionA: string;
    let sessionB: string;
    let onlyA: EnrolledMember;
    let onlyB: EnrolledMember;
    let both: EnrolledMember;
    let credentialA: string;
    let credentialB: string;
    let aIdentityIds: string[];
    let bIdentityIds: string[];
    let bIdentitiesBefore: unknown;
    let bCredentialBefore: unknown;
    let bRevisionCountBefore: number;
    let onlyBRegistrationBefore: unknown;
    let populationRevisionBefore: number;

    const registrationBeforeSelect = {
      id: true,
      statusCode: true,
      statusSummaryCode: true,
      currentRevision: true,
      cancelledAt: true,
      cancelledByUserId: true,
      cancelReason: true,
      updatedAt: true,
    } as const;

    beforeAll(async () => {
      sequence += 1;
      const suffix = `main-${sequence}`;
      const created = await request(httpServer(app))
        .post('/api/admin/v1/activities')
        .set('Authorization', creatorAuth)
        .send({
          title: `场次取消活动 ${sequence}`,
          activityTypeCode,
          organizationId,
          startAt: '2099-08-01T01:00:00.000Z',
          endAt: '2099-08-01T05:00:00.000Z',
          registrationDeadline: '2099-07-31T12:00:00.000Z',
          location: '深圳',
          allocationModeCode: 'first_come',
          capacity: 20,
        })
        .expect(201);
      activityId = created.body.data.id as string;
      sessionA = await createSession(activityId, `${suffix}-a`);
      sessionB = await createSession(activityId, `${suffix}-b`);

      const initial = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
        .set('Authorization', creatorAuth)
        .send({ operationKey: `session-cancel-initial-${suffix}`, confirmation: true })
        .expect(200);
      await approveReview(initial.body.data.id as string, `initial-${suffix}`).expect(200);

      // 反面样本只在 sessionId 这一维上不同:同活动、同批次、同一次审批。
      onlyA = await enrol({ activityId, sessionIds: [sessionA], label: `${suffix}-onlyA` });
      onlyB = await enrol({ activityId, sessionIds: [sessionB], label: `${suffix}-onlyB` });
      both = await enrol({
        activityId,
        sessionIds: [sessionA, sessionB],
        label: `${suffix}-both`,
      });
      credentialA = await issueQrCredential(activityId, sessionA);
      credentialB = await issueQrCredential(activityId, sessionB);

      aIdentityIds = [
        onlyA.identityIdBySessionId.get(sessionA),
        both.identityIdBySessionId.get(sessionA),
      ].filter((id): id is string => id !== undefined);
      bIdentityIds = [
        onlyB.identityIdBySessionId.get(sessionB),
        both.identityIdBySessionId.get(sessionB),
      ].filter((id): id is string => id !== undefined);
      if (aIdentityIds.length !== 2 || bIdentityIds.length !== 2) {
        throw new Error('fixture must enrol exactly two identities per session');
      }

      bIdentitiesBefore = await prisma.activityParticipationIdentity.findMany({
        where: { id: { in: bIdentityIds } },
        select: identitySelect,
        orderBy: { id: 'asc' },
      });
      bCredentialBefore = await prisma.attendanceQrCredential.findUniqueOrThrow({
        where: { id: credentialB },
        select: credentialSelect,
      });
      bRevisionCountBefore = await prisma.activityParticipationRevision.count({
        where: { identityId: { in: bIdentityIds } },
      });
      onlyBRegistrationBefore = await prisma.activityRegistration.findFirstOrThrow({
        where: { activityId, memberId: onlyB.memberId },
        select: registrationBeforeSelect,
      });
      populationRevisionBefore =
        (
          await prisma.activityEvidenceState.findUnique({
            where: { activityId },
            select: { populationRevision: true },
          })
        )?.populationRevision ?? 0;

      const reviewId = await submitCancelChange(activityId, `cancel-${suffix}`, sessionA);
      await approveReview(reviewId, `cancel-${suffix}`).expect(200);
    });

    it('flips only session A to cancelled and leaves session B scheduled', async () => {
      await expect(
        prisma.activitySession.findMany({
          where: { activityId },
          select: { id: true, statusCode: true },
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual(
        [
          { id: sessionA, statusCode: 'cancelled' },
          { id: sessionB, statusCode: 'scheduled' },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    });

    // ===== ① 人员 =====

    it('people · forward: every identity enrolled in session A is auto-cancelled', async () => {
      await expect(
        prisma.activityParticipationIdentity.findMany({
          where: { id: { in: aIdentityIds } },
          select: {
            currentRevision: true,
            currentStatusCode: true,
            capacityReservationId: true,
            populationIncluded: true,
            version: true,
          },
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual([
        {
          currentRevision: 2,
          currentStatusCode: 'cancelled',
          capacityReservationId: null,
          populationIncluded: false,
          version: 1,
        },
        {
          currentRevision: 2,
          currentStatusCode: 'cancelled',
          capacityReservationId: null,
          populationIncluded: false,
          version: 1,
        },
      ]);
      await expect(
        prisma.activityParticipationRevision.findMany({
          where: { identityId: { in: aIdentityIds }, revision: 2 },
          select: { statusCode: true, cancelledByUserId: true, cancelReason: true },
          orderBy: { identityId: 'asc' },
        }),
      ).resolves.toEqual([
        { statusCode: 'cancelled', cancelledByUserId: reviewerUserId, cancelReason: '场次已取消' },
        { statusCode: 'cancelled', cancelledByUserId: reviewerUserId, cancelReason: '场次已取消' },
      ]);
    });

    it('people · forward: the activity-level registration head follows the projection', async () => {
      // 只报了 A 的人 → 头变 cancelled;两场都报的人 → 头仍在册(B 还在)。
      await expect(
        prisma.activityRegistration.findFirstOrThrow({
          where: { activityId, memberId: onlyA.memberId },
          select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
        }),
      ).resolves.toEqual({
        statusCode: 'cancelled',
        statusSummaryCode: 'cancelled',
        currentRevision: 2,
      });
      await expect(
        prisma.activityRegistration.findFirstOrThrow({
          where: { activityId, memberId: both.memberId },
          select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
        }),
      ).resolves.toEqual({
        statusCode: 'pending',
        statusSummaryCode: 'active',
        currentRevision: 2,
      });
    });

    it('people · reverse: session B identities are byte-identical, field by field', async () => {
      await expect(
        prisma.activityParticipationIdentity.findMany({
          where: { id: { in: bIdentityIds } },
          select: identitySelect,
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual(bIdentitiesBefore);
    });

    it('people · reverse: session B identities gained no new revision row', async () => {
      // 「没被改成 cancelled」还不够 —— 一条新修订都不许多出来。
      await expect(
        prisma.activityParticipationRevision.count({
          where: { identityId: { in: bIdentityIds } },
        }),
      ).resolves.toBe(bRevisionCountBefore);
    });

    it('people · reverse: a B-only member’s registration head is untouched', async () => {
      await expect(
        prisma.activityRegistration.findFirstOrThrow({
          where: { activityId, memberId: onlyB.memberId },
          select: registrationBeforeSelect,
        }),
      ).resolves.toEqual(onlyBRegistrationBefore);
    });

    // ===== ② 二维码 =====

    it('qr · forward: session A credential is revoked with actor and reason', async () => {
      await expect(
        prisma.attendanceQrCredential.findUniqueOrThrow({
          where: { id: credentialA },
          select: { statusCode: true, revokedByUserId: true, revokeReason: true },
        }),
      ).resolves.toEqual({
        statusCode: 'revoked',
        revokedByUserId: reviewerUserId,
        revokeReason: '场次已取消',
      });
    });

    it('qr · reverse: session B credential row is unchanged, updatedAt included', async () => {
      await expect(
        prisma.attendanceQrCredential.findUniqueOrThrow({
          where: { id: credentialB },
          select: credentialSelect,
        }),
      ).resolves.toEqual(bCredentialBefore);
    });

    // ===== ③ 通知 =====

    it('notification · forward: exactly the two session-A enrolees are notified', async () => {
      const intents = await sessionCancelIntents(activityId);
      expect([...intents.map((intent) => intent.destinationRef)].sort()).toEqual(
        [onlyA.memberId, both.memberId].sort(),
      );
      expect(intents).toHaveLength(2);
      const stamp = (intents[0]?.payload as { recipientFreeze?: { basisRef?: string[] } })
        ?.recipientFreeze;
      expect(stamp?.basisRef).toEqual([`session:${sessionA}`]);
    });

    it('notification · reverse: the B-only member received zero session-cancel intents', async () => {
      // 正面数出 0,不靠上一条的集合相等顺带证明。
      const intents = await sessionCancelIntents(activityId);
      expect(intents.filter((intent) => intent.destinationRef === onlyB.memberId)).toHaveLength(0);
    });

    // ===== ④ 结算人口 =====

    it('settlement population · the activity-level revision pointer advanced by one', async () => {
      await expect(
        prisma.activityEvidenceState.findUniqueOrThrow({
          where: { activityId },
          select: { populationRevision: true },
        }),
      ).resolves.toEqual({ populationRevision: populationRevisionBefore + 1 });
    });
  });

  it('stays idempotent: re-approving the same review replays without touching anyone twice', async () => {
    sequence += 1;
    const suffix = `replay-${sequence}`;
    const created = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send({
        title: `场次取消重放活动 ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        registrationDeadline: '2099-07-31T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        capacity: 20,
      })
      .expect(201);
    const activityId = created.body.data.id as string;
    const sessionA = await createSession(activityId, `${suffix}-a`);
    await createSession(activityId, `${suffix}-b`);

    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `session-cancel-initial-${suffix}`, confirmation: true })
      .expect(200);
    await approveReview(initial.body.data.id as string, `initial-${suffix}`).expect(200);

    const enrolled = await enrol({ activityId, sessionIds: [sessionA], label: suffix });
    await issueQrCredential(activityId, sessionA);

    const reviewId = await submitCancelChange(activityId, `cancel-${suffix}`, sessionA);
    await approveReview(reviewId, `cancel-${suffix}`).expect(200);

    const identityId = enrolled.identityIdBySessionId.get(sessionA);
    if (identityId === undefined) throw new Error('fixture identity must exist');
    const afterFirst = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: identityId },
      select: identitySelect,
    });
    const revisionsAfterFirst = await prisma.activityParticipationRevision.count({
      where: { identityId },
    });
    const intentsAfterFirst = await prisma.notificationOutboxIntent.count({
      where: { aggregateType: 'activity', aggregateId: activityId },
    });
    const populationAfterFirst = await prisma.activityEvidenceState.findUniqueOrThrow({
      where: { activityId },
      select: { populationRevision: true },
    });

    // 同一个 operationKey 重放:审批入口的重放守卫应当在进 apply 之前就返回,零二次写。
    await approveReview(reviewId, `cancel-${suffix}`).expect(200);

    await expect(
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: identitySelect,
      }),
    ).resolves.toEqual(afterFirst);
    await expect(
      prisma.activityParticipationRevision.count({ where: { identityId } }),
    ).resolves.toBe(revisionsAfterFirst);
    await expect(
      prisma.notificationOutboxIntent.count({
        where: { aggregateType: 'activity', aggregateId: activityId },
      }),
    ).resolves.toBe(intentsAfterFirst);
    await expect(
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId },
        select: { populationRevision: true },
      }),
    ).resolves.toEqual(populationAfterFirst);
  });

  // ══════════════════════════════════════════════════════════════════════
  // AC-010 改期联动(P1-28 9a C 档;维护者 2026-08-28 拍板「作废旧二维码重签」)。
  // 与上面的取消联动共用全部夹具;改期 = sessions.update 变更审核通过后,
  // 该场次旧二维码作废、按新窗口重签,B 场次与名单/人口/容量全部纹丝不动。
  // ══════════════════════════════════════════════════════════════════════
  describe('one activity, two sessions — reschedule session A only (AC-010)', () => {
    let activityId: string;
    let sessionA: string;
    let sessionB: string;
    let credentialA: string;
    let credentialB: string;
    let bCredentialBefore: {
      id: string;
      statusCode: string;
      credentialVersion: number;
      validFrom: Date;
      validUntil: Date;
    };
    let bIdentityRevisionCountBefore: number;
    let populationRevisionBefore: number;
    const rescheduledCheckInOpen = '2099-08-01T01:00:00.000Z';
    const rescheduledCheckInClose = '2099-08-01T02:30:00.000Z';

    beforeAll(async () => {
      sequence += 1;
      const suffix = `reschedule-${sequence}`;
      const created = await request(httpServer(app))
        .post('/api/admin/v1/activities')
        .set('Authorization', creatorAuth)
        .send({
          title: `场次改期活动 ${sequence}`,
          activityTypeCode,
          organizationId,
          startAt: '2099-08-01T01:00:00.000Z',
          endAt: '2099-08-01T05:00:00.000Z',
          registrationDeadline: '2099-07-31T12:00:00.000Z',
          location: '深圳',
          allocationModeCode: 'first_come',
          capacity: 20,
        })
        .expect(201);
      activityId = created.body.data.id as string;
      sessionA = await createSession(activityId, `${suffix}-a`);
      sessionB = await createSession(activityId, `${suffix}-b`);

      const initial = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
        .set('Authorization', creatorAuth)
        .send({ operationKey: `reschedule-initial-${suffix}`, confirmation: true })
        .expect(200);
      await approveReview(initial.body.data.id as string, `initial-${suffix}`).expect(200);

      // 有人报名(名单格的反向锚)+ 两场都签了码。
      await enrol({ activityId, sessionIds: [sessionA], label: `${suffix}-onlyA` });
      await enrol({ activityId, sessionIds: [sessionB], label: `${suffix}-onlyB` });
      credentialA = await issueQrCredential(activityId, sessionA);
      credentialB = await issueQrCredential(activityId, sessionB);

      bCredentialBefore = await prisma.attendanceQrCredential.findUniqueOrThrow({
        where: { id: credentialB },
        select: {
          id: true,
          statusCode: true,
          credentialVersion: true,
          validFrom: true,
          validUntil: true,
        },
      });
      bIdentityRevisionCountBefore = await prisma.activityParticipationRevision.count({
        where: { identity: { activityId, sessionId: sessionB } },
      });
      populationRevisionBefore =
        (
          await prisma.activityEvidenceState.findUnique({
            where: { activityId },
            select: { populationRevision: true },
          })
        )?.populationRevision ?? 0;

      // 改期:只动 A 的四个时间窗(startAt/endAt 连带),其余一切不动。
      const submitted = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
        .set('Authorization', creatorAuth)
        .send({
          operationKey: `reschedule-change-${suffix}`,
          confirmation: true,
          activityPatch: {},
          sessions: {
            create: [],
            update: [
              {
                sessionId: sessionA,
                startAt: '2099-08-01T01:30:00.000Z',
                endAt: '2099-08-01T04:30:00.000Z',
                checkInOpenAt: rescheduledCheckInOpen,
                checkInCloseAt: rescheduledCheckInClose,
                checkOutOpenAt: '2099-08-01T03:30:00.000Z',
                checkOutCloseAt: '2099-08-01T04:30:00.000Z',
              },
            ],
            cancel: [],
          },
          positions: { create: [], update: [], cancel: [] },
        })
        .expect(200);
      await approveReview(submitted.body.data.id as string, `reschedule-${suffix}`).expect(200);
    });

    it('改期场次的时间窗落库(改期路径本身此前全仓零测试)', async () => {
      const session = await prisma.activitySession.findUniqueOrThrow({
        where: { id: sessionA },
        select: { startAt: true, checkInOpenAt: true, statusCode: true },
      });
      expect(session.startAt.toISOString()).toBe('2099-08-01T01:30:00.000Z');
      expect(session.checkInOpenAt.toISOString()).toBe(rescheduledCheckInOpen);
      expect(session.statusCode).toBe('scheduled');
    });

    it('旧二维码作废(revokeReason=场次改期)+ 按新窗口重签版本 +1(拍板:作废旧码重签)', async () => {
      const oldA = await prisma.attendanceQrCredential.findUniqueOrThrow({
        where: { id: credentialA },
        select: { statusCode: true, revokeReason: true },
      });
      expect(oldA.statusCode).toBe('revoked');
      expect(oldA.revokeReason).toBe('场次改期');
      const activeA = await prisma.attendanceQrCredential.findMany({
        where: { sessionId: sessionA, statusCode: 'active' },
        select: { actionCode: true, credentialVersion: true, validFrom: true, validUntil: true },
        orderBy: { actionCode: 'asc' },
      });
      expect(activeA).toHaveLength(2); // check_in / check_out 各一条
      const checkIn = activeA.find((row) => row.actionCode === 'check_in');
      expect(checkIn?.credentialVersion).toBe(2);
      expect(checkIn?.validFrom.toISOString()).toBe(rescheduledCheckInOpen);
      expect(checkIn?.validUntil.toISOString()).toBe(rescheduledCheckInClose);
    });

    it('「只影响该场次」:B 的二维码/时间窗/报名修订/结算人口全部纹丝不动(反向)', async () => {
      const bCredentialAfter = await prisma.attendanceQrCredential.findUniqueOrThrow({
        where: { id: credentialB },
        select: {
          id: true,
          statusCode: true,
          credentialVersion: true,
          validFrom: true,
          validUntil: true,
        },
      });
      expect(bCredentialAfter.statusCode).toBe(bCredentialBefore.statusCode);
      expect(bCredentialAfter.credentialVersion).toBe(bCredentialBefore.credentialVersion);
      expect(bCredentialAfter.validFrom.getTime()).toBe(bCredentialBefore.validFrom.getTime());
      expect(bCredentialAfter.validUntil.getTime()).toBe(bCredentialBefore.validUntil.getTime());

      const sessionBRow = await prisma.activitySession.findUniqueOrThrow({
        where: { id: sessionB },
        select: { startAt: true, endAt: true, statusCode: true },
      });
      expect(sessionBRow.startAt.getTime()).toBe(new Date('2099-08-01T01:00:00.000Z').getTime());
      expect(sessionBRow.statusCode).toBe('scheduled');

      const bRevisionCountAfter = await prisma.activityParticipationRevision.count({
        where: { identity: { activityId, sessionId: sessionB } },
      });
      expect(bRevisionCountAfter).toBe(bIdentityRevisionCountBefore);

      const populationRevisionAfter =
        (
          await prisma.activityEvidenceState.findUnique({
            where: { activityId },
            select: { populationRevision: true },
          })
        )?.populationRevision ?? 0;
      expect(populationRevisionAfter).toBe(populationRevisionBefore);
    });

    it('审计:一条聚合行(activity.publish 伞事件 + extra.operation=activity-session-reschedule)', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { event: 'activity.publish', resourceId: activityId },
        select: { context: true },
      });
      const auditRow = rows.find((row) =>
        JSON.stringify(row.context).includes('activity-session-reschedule'),
      );
      expect(auditRow).not.toBeNull();
      const extra = (auditRow?.context as { extra?: { sessionIds?: string[] } } | null)?.extra;
      expect(extra?.sessionIds).toEqual([sessionA]);
    });
  });
});

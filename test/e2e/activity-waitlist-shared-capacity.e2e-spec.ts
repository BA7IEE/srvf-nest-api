import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityPublishReviewService } from '../../src/modules/activities/activity-publish-review.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import type { AppActivityChangePositionDto } from '../../src/modules/activities/dto/app/app-managed-activity.dto';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { createTestUser } from '../fixtures/users.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 多岗位递补共享**事务内父预算**(2026-08-01 整批评审 P1)。
//
// 修复前的形状:`ActivityProposalApplier` 对每个被扩容的岗位各调一次单岗版
// `promoteActivityWaitlistWithinCapacity`,而递补写的是 `waitlisted → pending`
// **不是 `pass`** —— 父活动的 pass 基线在整个批次里一动不动,于是每一岗都把**同一份**
// 父剩余量重新算出来并完整领走。N 个岗位 = 父容量被花 N 次。
//
// 本 spec 精确复现评审给出的组合(缺一条都不会红):
//   ① 历史 **null-position PASS** —— 报名在先、建岗位在后,这些 pass 计进父 pass 却不属于
//      任何岗位,是「各岗 headroom 之和 > 父 headroom」唯一的合法造法(validator 强制
//      Σ岗位 capacity ≤ 活动 capacity,不靠 null 队列的 pass 拉不开差);
//   ② **同一份 proposal 同时扩容两个岗位**(单岗位事件只调一次,永远看不出问题);
//   ③ 两岗 headroom 之和(3+2=5)> 父 headroom(5−3=2)。
//
// 修复前:A 岗领 min(2,3)=2、B 岗**又**领 min(2,2)=2,合计递补 4,活动上 3 pass + 4 pending
// = 7 人占 5 个名额。修复后:合计恰好 2,且全部来自 A 岗(FIFO),B 岗与 null 队列原样候补。

const AUDIT_META: AuditMeta = {
  requestId: 'waitlist-shared-capacity-req-0001',
  ip: '127.0.0.1',
  ua: 'jest/activity-waitlist-shared-capacity',
};

const ACTIVITY_TYPE_CODE = 'waitlist-shared-capacity-type';
const ATTENDANCE_ROLE_CODE = 'waitlist-shared-capacity-role';

describe('activity waitlist promotion shares one parent capacity budget', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reviewService: ActivityPublishReviewService;
  let registrationsService: ActivityRegistrationsService;
  let reviewer: CurrentUserPayload;
  let owner: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    reviewService = app.get(ActivityPublishReviewService);
    registrationsService = app.get(ActivityRegistrationsService);
    await seedActivityResponsibilitySystemRoles(app);

    const reviewerUser = await createTestUser(app, {
      username: 'waitlist-shared-capacity-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewer = {
      id: reviewerUser.id,
      username: reviewerUser.username,
      role: reviewerUser.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const ownerUser = await createTestUser(app, {
      username: 'waitlist-shared-capacity-owner',
      role: Role.ADMIN,
    });
    const ownerMember = await prisma.member.create({
      data: {
        memberNo: 'waitlist-shared-capacity-owner',
        displayName: '共享预算发起人',
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: ownerUser.id }, data: { memberId: ownerMember.id } });
    owner = {
      id: ownerUser.id,
      username: ownerUser.username,
      role: ownerUser.role,
      status: UserStatus.ACTIVE,
      memberId: ownerMember.id,
    };

    const root = await prisma.organization.create({
      data: { name: '共享预算根组织', nodeTypeCode: 'waitlist-shared-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '共享预算执行组织',
        nodeTypeCode: 'waitlist-shared-team',
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

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: ACTIVITY_TYPE_CODE, label: '共享预算活动' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: ATTENDANCE_ROLE_CODE, label: '共享预算岗位角色' },
    });
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  /** 建活动 → submitInitial → approve，得到一个 published 活动。 */
  async function publishActivity(capacity: number | null): Promise<string> {
    sequence += 1;
    const activity = await prisma.activity.create({
      data: {
        title: `共享预算活动 ${sequence}`,
        activityTypeCode: ACTIVITY_TYPE_CODE,
        organizationId,
        initiatorMemberId: owner.memberId,
        startAt: new Date('2099-09-01T01:00:00.000Z'),
        endAt: new Date('2099-09-01T09:00:00.000Z'),
        location: '深圳',
        capacity,
        statusCode: 'draft',
      },
      select: { id: true },
    });
    const review = await reviewService.submitInitial(activity.id, owner, {
      ...AUDIT_META,
      requestId: `waitlist-shared-initial-${sequence}`,
    });
    await reviewService.approve(
      review.id,
      { requiresInsuranceConfirmed: true, reviewNote: '初始发布通过' },
      reviewer,
      { ...AUDIT_META, requestId: `waitlist-shared-initial-approve-${sequence}` },
    );
    return activity.id;
  }

  async function createPosition(
    activityId: string,
    name: string,
    capacity: number | null,
    sortOrder: number,
  ): Promise<string> {
    const position = await prisma.activityPosition.create({
      data: {
        activityId,
        name,
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        capacity,
        sortOrder,
      },
      select: { id: true },
    });
    return position.id;
  }

  /**
   * 直连 prisma 造报名行。候补队列的形状(某岗已满 / 历史无岗位 pass)在正常
   * HTTP 流程下要靠一长串前置事件才能到达，直接造行是本仓既有范式。
   */
  async function createRegistration(
    activityId: string,
    activityPositionId: string | null,
    statusCode: string,
    label: string,
    registeredAtMinute: number,
  ): Promise<{ registrationId: string; memberId: string }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `waitlist-shared-${sequence}`,
        displayName: label,
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId,
        activityPositionId,
        memberId: member.id,
        statusCode,
        registeredAt: new Date(Date.UTC(2026, 6, 15, 0, registeredAtMinute, 0)),
      },
      select: { id: true },
    });
    return { registrationId: registration.id, memberId: member.id };
  }

  async function statusOf(registrationId: string): Promise<string> {
    const row = await prisma.activityRegistration.findUniqueOrThrow({
      where: { id: registrationId },
      select: { statusCode: true },
    });
    return row.statusCode;
  }

  async function submitAndApproveChange(
    activityId: string,
    positions: AppActivityChangePositionDto[],
  ): Promise<void> {
    sequence += 1;
    const review = await reviewService.submitChange(activityId, {}, positions, owner, {
      ...AUDIT_META,
      requestId: `waitlist-shared-change-${sequence}`,
    });
    await reviewService.approve(
      review.id,
      { requiresInsuranceConfirmed: true, reviewNote: '扩容通过' },
      reviewer,
      { ...AUDIT_META, requestId: `waitlist-shared-change-approve-${sequence}` },
    );
  }

  it('one proposal expanding two positions never promotes past the parent活动 headroom', async () => {
    // 父容量 5;历史无岗位队列已占 3 个 pass ⇒ 父 headroom = 2。
    const activityId = await publishActivity(5);
    const positionA = await createPosition(activityId, 'A 岗', 1, 0);
    const positionB = await createPosition(activityId, 'B 岗', 1, 1);

    // ① 历史 null-position PASS:报名在先、建岗位在后(建岗位不回溯既有报名)。
    for (let i = 0; i < 3; i += 1) {
      await createRegistration(activityId, null, 'pass', `历史通过 ${i}`, i);
    }
    // 历史无岗位队列上还留着一名候补:它不属于任何被扩容的岗位,必须原样滞留。
    const legacyWaitlisted = await createRegistration(
      activityId,
      null,
      'waitlisted',
      '历史候补',
      10,
    );

    // FIFO 顺序 a1 → a2 → a3;B 岗 b1 → b2。
    const a1 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 1', 20);
    const a2 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 2', 21);
    const a3 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 3', 22);
    const b1 = await createRegistration(activityId, positionB, 'waitlisted', 'B 候补 1', 30);
    const b2 = await createRegistration(activityId, positionB, 'waitlisted', 'B 候补 2', 31);

    // ② 同一份 proposal 同时扩容两个岗位:A 1→3、B 1→2。
    // ③ 两岗 headroom 之和 = 3 + 2 = 5 > 父 headroom 2。
    await submitAndApproveChange(activityId, [
      {
        activityPositionId: positionA,
        name: 'A 岗',
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        capacity: 3,
        sortOrder: 0,
      },
      {
        activityPositionId: positionB,
        name: 'B 岗',
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        capacity: 2,
        sortOrder: 1,
      },
    ]);

    // 合计递补数 = 父剩余量,不是两岗各自领一份。修复前这里是 4。
    const promotedCount = await prisma.activityRegistration.count({
      where: { activityId, statusCode: 'pending', deletedAt: null },
    });
    expect(promotedCount).toBe(2);

    // 活动占位总数(pass + pending)不得超过父容量。
    const occupied = await prisma.activityRegistration.count({
      where: { activityId, statusCode: { in: ['pass', 'pending'] }, deletedAt: null },
    });
    expect(occupied).toBe(5);

    // FIFO 不变:A 岗按 registeredAt 升序吃掉预算。
    expect(await statusOf(a1.registrationId)).toBe('pending');
    expect(await statusOf(a2.registrationId)).toBe('pending');
    // 未获预算者仍 waitlisted —— 修复前 b1/b2 会被多递补。
    expect(await statusOf(a3.registrationId)).toBe('waitlisted');
    expect(await statusOf(b1.registrationId)).toBe('waitlisted');
    expect(await statusOf(b2.registrationId)).toBe('waitlisted');

    // 岗位隔离(B-D2):预算流动的是父容量额度,不是候选人 —— B 岗的人没有被 A 岗事件带走,
    // 历史无岗位队列同样不被岗位扩容顺手递补。
    expect(await statusOf(legacyWaitlisted.registrationId)).toBe('waitlisted');
    const promotedPositions = await prisma.activityRegistration.findMany({
      where: { activityId, statusCode: 'pending', deletedAt: null },
      select: { activityPositionId: true },
    });
    expect(promotedPositions.every((row) => row.activityPositionId === positionA)).toBe(true);
  });

  it('leftover budget from an empty queue flows to the next position in the same proposal', async () => {
    // 父 headroom 2;A 岗只有 1 名候补 ⇒ 用掉 1，剩下的 1 必须落到 B 岗(按实际 promoted 扣减，
    // 不是按发出去的额度扣)。
    const activityId = await publishActivity(4);
    const positionA = await createPosition(activityId, 'A 岗', 1, 0);
    const positionB = await createPosition(activityId, 'B 岗', 1, 1);
    for (let i = 0; i < 2; i += 1) {
      await createRegistration(activityId, null, 'pass', `历史通过 ${i}`, i);
    }
    const a1 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 1', 20);
    const b1 = await createRegistration(activityId, positionB, 'waitlisted', 'B 候补 1', 30);
    const b2 = await createRegistration(activityId, positionB, 'waitlisted', 'B 候补 2', 31);

    await submitAndApproveChange(activityId, [
      {
        activityPositionId: positionA,
        name: 'A 岗',
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        capacity: 2,
        sortOrder: 0,
      },
      {
        activityPositionId: positionB,
        name: 'B 岗',
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        capacity: 2,
        sortOrder: 1,
      },
    ]);

    expect(await statusOf(a1.registrationId)).toBe('pending');
    expect(await statusOf(b1.registrationId)).toBe('pending');
    expect(await statusOf(b2.registrationId)).toBe('waitlisted');
    await expect(
      prisma.activityRegistration.count({
        where: { activityId, statusCode: 'pending', deletedAt: null },
      }),
    ).resolves.toBe(2);
  });

  // 回归锁:**单岗位直改路径**(名额释放 → `promoteActivityWaitlistWithinCapacity`,
  // `maxPromotions: 1`)行为逐字不变。本刀只加批量入口、只把两处 min/max 收敛进
  // `intersectHeadroom`,不许顺手动单岗版的口径。
  //
  // 走的是取消 pass 报名这条真实生产路径 —— 责任闭环 gate=true 时 Admin 不能直改 published
  // 活动的岗位(20037 要求走变更评审),那条 surface 在本 spec 的配置下根本不可达。
  it('single-position release still promotes exactly one FIFO head from its own queue', async () => {
    const activityId = await publishActivity(4);
    const positionA = await createPosition(activityId, 'A 岗', 2, 0);
    const positionB = await createPosition(activityId, 'B 岗', 2, 1);
    const passOnA = await createRegistration(activityId, positionA, 'pass', 'A 已通过', 0);
    await createRegistration(activityId, positionA, 'pass', 'A 已通过 2', 1);
    const a1 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 1', 20);
    const a2 = await createRegistration(activityId, positionA, 'waitlisted', 'A 候补 2', 21);
    const b1 = await createRegistration(activityId, positionB, 'waitlisted', 'B 候补 1', 30);

    await registrationsService.cancelAdmin(
      activityId,
      passOnA.registrationId,
      { cancelReason: '临时有事' },
      reviewer,
      { ...AUDIT_META, requestId: 'waitlist-shared-single-release' },
    );

    // 恰好 1 人、来自本岗队首;B 岗不被带走(B-D2 隔离)。
    expect(await statusOf(a1.registrationId)).toBe('pending');
    expect(await statusOf(a2.registrationId)).toBe('waitlisted');
    expect(await statusOf(b1.registrationId)).toBe('waitlisted');
  });

  // 无 live 岗位的活动:父容量扩容仍递补历史无岗位队列,且受父剩余量钳制。
  it('parent capacity expansion on a position-less activity still promotes the legacy queue', async () => {
    const activityId = await publishActivity(2);
    await createRegistration(activityId, null, 'pass', '历史通过', 0);
    const n1 = await createRegistration(activityId, null, 'waitlisted', '历史候补 1', 20);
    const n2 = await createRegistration(activityId, null, 'waitlisted', '历史候补 2', 21);
    const n3 = await createRegistration(activityId, null, 'waitlisted', '历史候补 3', 22);

    sequence += 1;
    const review = await reviewService.submitChange(activityId, { capacity: 3 }, [], owner, {
      ...AUDIT_META,
      requestId: `waitlist-shared-parent-${sequence}`,
    });
    await reviewService.approve(
      review.id,
      { requiresInsuranceConfirmed: true, reviewNote: '父容量扩容' },
      reviewer,
      { ...AUDIT_META, requestId: `waitlist-shared-parent-approve-${sequence}` },
    );

    // 父容量 2→3,已 pass 1 ⇒ 剩余 2,队列里 3 人只能上 2 人(FIFO)。
    expect(await statusOf(n1.registrationId)).toBe('pending');
    expect(await statusOf(n2.registrationId)).toBe('pending');
    expect(await statusOf(n3.registrationId)).toBe('waitlisted');
  });
});

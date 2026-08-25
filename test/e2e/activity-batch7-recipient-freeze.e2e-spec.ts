import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { readRecipientFreezeStamp } from '../../src/modules/activities/activity-recipient-freeze';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * 第 7 批第一刀 —— 收件人快照冻结的**真数据**判据(goal D2 ②)。
 *
 * 单测已经把冻结函数的分支钉满了。这里要证的是另一件事:**穿过真的 HTTP + 真的库 +
 * 真的 outbox worker**之后,「改变现实再重试,收件人一个不多一个不少」仍然成立。
 *
 * 纪律(全部有本仓事故背书):
 *   · **比集合不比计数** —— 计数相等的两个不同集合会静默变绿;
 *   · **先钉两边非空** —— 空集 == 空集是本仓刚栽过的假绿形状;
 *   · 改变现实要**真改数据**,不是把断言写松。
 */
describe('第 7 批第一刀:收件人快照冻结(真 HTTP + 真 outbox)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let organizationId: string;
  let activityTypeCode: string;
  let audienceTagTypeId: string;
  let tagCode: string;
  /** 发布时持有标签的三个人 —— 这就是应当被冻结下来的那一批。 */
  let frozenMembers: string[];
  /** 发布**之后**才拿到标签的人 —— 任何时刻都不该收到这条通知。 */
  let latecomerMemberId: string;

  const previousHttpEnabled = process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;

  async function createMemberWithTag(memberNo: string, withTag: boolean): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo, ...memberIdentityData(memberNo) },
      select: { id: true },
    });
    if (withTag) await assignTag(member.id, [tagCode]);
    return member.id;
  }

  async function assignTag(memberId: string, tagCodes: string[]): Promise<void> {
    const response = await request(httpServer(app))
      .put(`/api/admin/v1/members/${memberId}/audience-tags`)
      .set('Authorization', auth)
      .send({ tagCodes });
    expect(response.status).toBe(200);
  }

  async function createDraftActivity(title: string): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', auth)
      .send({
        title,
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T08:00:00.000Z',
        endAt: '2099-08-01T12:00:00.000Z',
        location: '梧桐山',
        allocationModeCode: 'first_come',
        isPublicRegistration: true,
      });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  async function publishWithTags(activityId: string, tagCodes: string[]): Promise<string> {
    const response = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', auth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: tagCodes });
    expect(response.status).toBe(200);
    return response.body.data.publishedAt as string;
  }

  async function intentsFor(activityId: string) {
    return prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId, destinationType: 'member' },
      select: { eventKey: true, destinationRef: true, payload: true, status: true },
      orderBy: { destinationRef: 'asc' },
    });
  }

  /** 把 outbox 抽干:不是抽一轮 —— `drainOnce` 一轮只领 20 条,轮数不够就是没抽完。 */
  async function drainOutbox(): Promise<void> {
    const worker = app.get(NotificationOutboxWorker);
    for (let round = 0; round < 20; round += 1) {
      const result = await worker.drainOnce();
      if (result.claimed === 0) return;
    }
    throw new Error('outbox 未在 20 轮内抽干,判据前提不成立');
  }

  beforeAll(async () => {
    process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'true';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const superAdmin = await createTestUser(app, {
      username: 'b7-freeze-sa',
      role: Role.SUPER_ADMIN,
    });
    auth = (await loginAs(app, superAdmin.username)).authHeader;

    const root = await prisma.organization.create({
      data: { name: '冻结根组织', nodeTypeCode: 'freeze-root' },
      select: { id: true },
    });
    const org = await prisma.organization.create({
      data: { name: '冻结执行组织', nodeTypeCode: 'freeze-team', parentId: root.id },
      select: { id: true },
    });
    organizationId = org.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: org.id, depth: 1 },
        { ancestorId: org.id, descendantId: org.id, depth: 0 },
      ],
    });

    // 字典类型的 code 是**规范值**(`activity_type` / `member_audience_tag`),
    // 不是随手起的名字 —— 运行时按这两个 code 找类型。
    const activityType = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', auth)
      .send({ code: 'activity_type', label: '活动类型', sortOrder: 0 });
    expect(activityType.status).toBe(201);
    activityTypeCode = 'freeze-drill';
    const activityTypeItem = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', auth)
      .send({
        typeId: activityType.body.data.id,
        code: activityTypeCode,
        label: '冻结演练',
        sortOrder: 0,
      });
    expect(activityTypeItem.status).toBe(201);

    const tagType = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', auth)
      .send({ code: 'member_audience_tag', label: '会员受众标签', sortOrder: 0 });
    expect(tagType.status).toBe(201);
    audienceTagTypeId = tagType.body.data.id as string;
    tagCode = 'freeze-cohort';
    const tag = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', auth)
      .send({ typeId: audienceTagTypeId, code: tagCode, label: '冻结队列', sortOrder: 0 });
    expect(tag.status).toBe(201);

    frozenMembers = [
      await createMemberWithTag('freeze-member-a', true),
      await createMemberWithTag('freeze-member-b', true),
      await createMemberWithTag('freeze-member-c', true),
    ].sort();
    latecomerMemberId = await createMemberWithTag('freeze-member-latecomer', false);
  });

  afterAll(async () => {
    if (previousHttpEnabled === undefined) {
      delete process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;
    } else {
      process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = previousHttpEnabled;
    }
    await app?.close();
  });

  it('发布即冻结:每条 intent 都带齐依据/时刻/算法版本/基数,且基数与实际行数相等', async () => {
    const activityId = await createDraftActivity('冻结:盖章完整性');
    const publishedAt = await publishWithTags(activityId, [tagCode]);

    const intents = await intentsFor(activityId);
    // 先钉非空 —— 后面所有集合比较都建立在这一步上。
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.map((intent) => intent.destinationRef)).toEqual(frozenMembers);

    const stamps = intents.map((intent) => readRecipientFreezeStamp(intent.payload));
    for (const stamp of stamps) {
      expect(stamp).not.toBeNull();
      expect(stamp!.basisKind).toBe('audience-tags');
      expect(stamp!.basisRef).toEqual([tagCode]);
      expect(stamp!.algorithmVersion).toBe(1);
      expect(stamp!.computedAt).toBe(publishedAt);
      // 基数必须与真实落库行数相等 —— 少写一半时这条是唯一能看出来的判据。
      expect(stamp!.cohortSize).toBe(intents.length);
    }
    // 同一批次共用同一个 cohortKey:它就是「这一次发布」的身份。
    expect(new Set(stamps.map((stamp) => stamp!.cohortKey)).size).toBe(1);
    expect(stamps[0]!.cohortKey).toBe(`activity-publish-audience:${activityId}:${publishedAt}`);
  });

  it('改变现实后抽干 outbox:实际收到通知的人与快照**逐字相同**', async () => {
    const activityId = await createDraftActivity('冻结:改变现实后重试');
    await publishWithTags(activityId, [tagCode]);

    const frozen = (await intentsFor(activityId)).map((intent) => intent.destinationRef);
    expect(frozen.length).toBeGreaterThan(0);
    expect(frozen).toEqual(frozenMembers);

    // ── 真改数据,三个方向一起改 ──
    // ① 撤掉一个原收件人的标签;② 给一个新人赋标;③ 软删一个原收件人。
    const [revoked, , softDeleted] = frozen;
    await assignTag(revoked, []);
    await assignTag(latecomerMemberId, [tagCode]);
    await prisma.member.update({
      where: { id: softDeleted },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });

    // 现实确实变了 —— 先证明这一点,否则下面的"没变"什么都没证明。
    const liveTagged = await prisma.memberAudienceTagAssignment.findMany({
      where: { revokedAt: null, member: { status: 'ACTIVE', deletedAt: null } },
      select: { memberId: true },
    });
    const liveNow = [...new Set(liveTagged.map((row) => row.memberId))].sort();
    expect(liveNow.length).toBeGreaterThan(0);
    expect(liveNow).not.toEqual(frozen);
    expect(liveNow).toContain(latecomerMemberId);

    // ── 抽干 outbox(这就是"重试/投递"那一步)──
    await drainOutbox();

    const delivered = await prisma.notification.findMany({
      where: {
        notificationTypeCode: 'activity-published',
        recipientMemberId: { in: [...frozen, latecomerMemberId] },
      },
      select: { recipientMemberId: true },
    });
    const deliveredMembers = [...new Set(delivered.map((row) => row.recipientMemberId!))].sort();

    // 比集合,不比计数。
    expect(deliveredMembers.length).toBeGreaterThan(0);
    expect(deliveredMembers).toEqual(frozen);
    // 被撤标 / 被软删的人**仍然**收到:通知是当初那件事的记录,不是此刻名单的投影。
    expect(deliveredMembers).toContain(revoked);
    expect(deliveredMembers).toContain(softDeleted);
    // 后来才赋标的人一个都不许进来。
    expect(deliveredMembers).not.toContain(latecomerMemberId);

    // ⚠️ 把现实改回去。不还原的话,下一条用例发布时 latecomer **本来就**持有标签,
    //    于是他合法地进入那一批 —— 判据会红,但红的是夹具串味,不是实现。
    //    (本刀实测踩过这一脚。)
    await assignTag(latecomerMemberId, []);
    await assignTag(revoked, [tagCode]);
    await prisma.member.update({
      where: { id: softDeleted },
      data: { deletedAt: null, status: 'ACTIVE' },
    });
  });

  it('冻结之后再发布同一活动:不产生并集污染,快照集合原样不动', async () => {
    const activityId = await createDraftActivity('冻结:并集污染');
    const publishedAt = await publishWithTags(activityId, [tagCode]);
    const before = (await intentsFor(activityId)).map((intent) => intent.destinationRef);
    expect(before.length).toBeGreaterThan(0);

    // 给一个新人赋标 —— 如果冻结失效,重放会为他新插一条 intent(新 eventKey,
    // `skipDuplicates` 拦不住),于是实际收件人变成两次计算的并集。
    // 用本用例自己新建的人,不蹭上一条用例的 latecomer(夹具串味会把红点指错地方)。
    const newcomerId = await createMemberWithTag('freeze-member-newcomer', true);
    expect(before).not.toContain(newcomerId);

    // 同一活动重复发布必须被状态机拒(published 不可再 publish)——
    // 这本身也是冻结的第一道保护:没有第二次计算,就没有并集。
    const republish = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', auth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [tagCode] });
    expect(republish.status).toBeGreaterThanOrEqual(400);

    const after = await intentsFor(activityId);
    expect(after.map((intent) => intent.destinationRef)).toEqual(before);
    expect(after.map((intent) => intent.destinationRef)).not.toContain(newcomerId);
    // 盖章的基数也不许被后来的一批改写。
    for (const intent of after) {
      const stamp = readRecipientFreezeStamp(intent.payload);
      expect(stamp!.cohortSize).toBe(before.length);
      expect(stamp!.computedAt).toBe(publishedAt);
    }

    await assignTag(newcomerId, []);
  });

  it('ADV-016 取消通知:intent 形成后**报名名单**再变,原事件收件人仍逐字冻结', async () => {
    const activityId = await createDraftActivity('冻结:取消名册');
    await publishWithTags(activityId, [tagCode]);
    // 发布那批 intent 与取消那批共用 aggregateId,靠 cohortKey 分离 —— 先记下发布批,
    // 后面要证明取消批没把它算进去、也没被它污染。
    const publishCohort = (await intentsFor(activityId)).map((intent) => intent.destinationRef);
    expect(publishCohort.length).toBeGreaterThan(0);

    const registrants = await Promise.all(
      ['cancel-reg-a', 'cancel-reg-b', 'cancel-reg-c'].map((memberNo) =>
        prisma.member.create({
          data: { memberNo, ...memberIdentityData(memberNo) },
          select: { id: true },
        }),
      ),
    );
    await prisma.activityRegistration.createMany({
      data: [
        { activityId, memberId: registrants[0].id, statusCode: 'pending' },
        { activityId, memberId: registrants[1].id, statusCode: 'pass' },
        { activityId, memberId: registrants[2].id, statusCode: 'waitlisted' },
      ],
    });

    const cancelled = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/cancel`)
      .set('Authorization', auth)
      .send({ cancelReason: '暴雨' });
    expect(cancelled.status).toBe(200);

    const cancelIntents = await prisma.notificationOutboxIntent.findMany({
      where: {
        aggregateType: 'activity',
        aggregateId: activityId,
        eventType: 'notification.targeted',
      },
      select: { eventKey: true, destinationRef: true, payload: true },
    });
    const cancelCohort = cancelIntents
      .filter((intent) => intent.eventKey.startsWith('activity-cancel:'))
      .map((intent) => intent.destinationRef)
      .sort();
    const expectedRegistrants = registrants.map((member) => member.id).sort();
    // 先钉两边非空,再比集合。
    expect(cancelCohort.length).toBeGreaterThan(0);
    expect(cancelCohort).toEqual(expectedRegistrants);

    // ── intent 已经形成。现在**改报名名单** ──
    // ① 一个报名者退出(软删报名);② 新来一个报名者。
    await prisma.activityRegistration.updateMany({
      where: { activityId, memberId: registrants[0].id },
      data: { deletedAt: new Date(), statusCode: 'cancelled' },
    });
    const lateRegistrant = await prisma.member.create({
      data: { memberNo: 'cancel-reg-late', ...memberIdentityData('cancel-reg-late') },
      select: { id: true },
    });
    await prisma.activityRegistration.create({
      data: { activityId, memberId: lateRegistrant.id, statusCode: 'pending' },
    });

    // 名单确实变了 —— 先证明这一点。
    const liveRoster = await prisma.activityRegistration.findMany({
      where: {
        activityId,
        deletedAt: null,
        statusCode: { in: ['pending', 'pass', 'waitlisted'] },
      },
      select: { memberId: true },
    });
    const liveNow = [...new Set(liveRoster.map((row) => row.memberId))].sort();
    expect(liveNow.length).toBeGreaterThan(0);
    expect(liveNow).not.toEqual(cancelCohort);

    await drainOutbox();

    const delivered = await prisma.notification.findMany({
      where: {
        notificationTypeCode: 'activity-changed',
        recipientMemberId: { in: [...expectedRegistrants, lateRegistrant.id] },
      },
      select: { recipientMemberId: true },
    });
    const deliveredMembers = [...new Set(delivered.map((row) => row.recipientMemberId!))].sort();
    expect(deliveredMembers.length).toBeGreaterThan(0);
    expect(deliveredMembers).toEqual(expectedRegistrants);
    // 退出的人**仍然**收到取消通知(他当时确实报名了);后来才报名的人一个不许收到。
    expect(deliveredMembers).toContain(registrants[0].id);
    expect(deliveredMembers).not.toContain(lateRegistrant.id);

    // 取消批与发布批是两个 cohortKey,互不吞并。
    const cancelStamps = cancelIntents
      .filter((intent) => intent.eventKey.startsWith('activity-cancel:'))
      .map((intent) => readRecipientFreezeStamp(intent.payload));
    for (const stamp of cancelStamps) {
      expect(stamp!.basisKind).toBe('registration-roster');
      expect(stamp!.cohortSize).toBe(expectedRegistrants.length);
    }
    expect(new Set(cancelStamps.map((stamp) => stamp!.cohortKey)).size).toBe(1);
    expect(cancelStamps[0]!.cohortKey).not.toContain('activity-publish-audience');
  });

  it('legacy 广播(不带标签)拿到显式的 broadcast-visibility 盖章,而不是悄悄没有快照', async () => {
    const activityId = await createDraftActivity('冻结:legacy 广播');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', auth)
      .send({ requiresInsuranceConfirmed: true });
    expect(published.status).toBe(200);

    const broadcast = await prisma.notificationOutboxIntent.findFirstOrThrow({
      where: {
        aggregateType: 'activity',
        aggregateId: activityId,
        destinationType: 'visibility',
      },
      select: { payload: true },
    });
    const stamp = readRecipientFreezeStamp(broadcast.payload);
    expect(stamp).not.toBeNull();
    // 「这一条刻意不冻结」是冻结入口做出的决定,在数据里留了痕 ——
    // 与「某个 producer 漏了冻结」在库里长得完全不同。
    expect(stamp!.basisKind).toBe('broadcast-visibility');
    expect(stamp!.cohortSize).toBe(0);
  });

  // =========================================================================
  // AC-066 「改期」事件 —— 冻结收件人后异步展开(2026-08-26 补)
  //
  // 合同原句(AC-066,逐字):
  //   「发布通知可以选择目标组织、标签或明确不广播；取消、改期等事件冻结收件人后异步展开。」
  //
  // 前半句三个可选项各自已有判据:标签定向与「明确不广播」是本 spec 上面那几条,
  // 目标组织在 `src/modules/activities/activity-recipient-freeze.spec.ts` ⑥。
  // 后半句点名**两个**事件:取消由上面 ADV-016 那条钉住,而**改期**在本组之前
  // `test/` 下零绑定 —— 卡点原文写的就是这一格。
  //
  // 「改期」在 src 侧的准确定义(`activity-write.service.ts` 的 `scheduleChanged`):
  // 活动级 startAt / endAt / location 任一变化 ⇒ 以 `activity-change:<活动>:<updatedAt>`
  // 为 cohortKey 冻结**改期当刻的在册报名名册**,再逐人落 outbox intent,由 worker 异步展开。
  //
  // ⭐ 三格各自成 `it`(一个 `it` 内首个失败即停,塞一起会让后面的断言从未被执行):
  //   ① 冻结的**集合**对不对(正向 + 反向:改期前就退出的人不在内)
  //   ② 「**后**异步展开」这一半:intent 形成后名单再变,实收集合仍与快照逐字相同
  //   ③ 改期批的**盖章**自成一批,与发布批互不吞并(否则「当初发给了谁」会串批)
  // =========================================================================
  interface RescheduleFixture {
    activityId: string;
    /** 改期那一刻的在册报名者(升序)—— 应当被冻下来的正是这一批。 */
    roster: string[];
    /** 改期**之前**就已退出的人:任何时刻都不该收到这条改期通知。 */
    withdrawnBefore: string;
    /** 改期后活动的 `updatedAt` —— 它就是这一批冻结的身份(cohortKey / versionKey)。 */
    updatedAt: string;
  }

  /** 造一场已发布、有真实报名名册的活动,然后**真的改一次期**(改活动级起止时间)。 */
  async function publishThenReschedule(label: string): Promise<RescheduleFixture> {
    const activityId = await createDraftActivity(`冻结:改期 ${label}`);
    await publishWithTags(activityId, [tagCode]);

    const registrants = await Promise.all(
      ['a', 'b', 'c'].map((slot) =>
        prisma.member.create({
          data: {
            memberNo: `change-reg-${label}-${slot}`,
            ...memberIdentityData(`change-reg-${label}-${slot}`),
          },
          select: { id: true },
        }),
      ),
    );
    const withdrawn = await prisma.member.create({
      data: {
        memberNo: `change-reg-${label}-out`,
        ...memberIdentityData(`change-reg-${label}-out`),
      },
      select: { id: true },
    });
    await prisma.activityRegistration.createMany({
      data: [
        { activityId, memberId: registrants[0].id, statusCode: 'pending' },
        { activityId, memberId: registrants[1].id, statusCode: 'pass' },
        { activityId, memberId: registrants[2].id, statusCode: 'waitlisted' },
        // ⭐ 反面样本在**被测那一维上单独不同**:同一场活动、同样报过名,
        //    只有「已退出(cancelled + 软删)」这一点不同 —— 上层边界遮蔽不了它。
        {
          activityId,
          memberId: withdrawn.id,
          statusCode: 'cancelled',
          deletedAt: new Date(),
        },
      ],
    });

    const rescheduled = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}`)
      .set('Authorization', auth)
      .send({ startAt: '2099-09-15T08:00:00.000Z', endAt: '2099-09-15T12:00:00.000Z' });
    expect(rescheduled.status).toBe(200);
    // 先证明「改期真的发生了」—— 否则下面每一条断言都建立在一次空操作上。
    expect(rescheduled.body.data.startAt).toBe('2099-09-15T08:00:00.000Z');
    expect(rescheduled.body.data.endAt).toBe('2099-09-15T12:00:00.000Z');

    return {
      activityId,
      roster: registrants.map((member) => member.id).sort(),
      withdrawnBefore: withdrawn.id,
      updatedAt: rescheduled.body.data.updatedAt as string,
    };
  }

  /** 只取「改期」那一批 intent:发布批的 eventKey 前缀不同,取消批也一样。 */
  async function scheduleChangeIntents(activityId: string) {
    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId, destinationType: 'member' },
      select: { eventKey: true, destinationRef: true, payload: true },
      orderBy: { destinationRef: 'asc' },
    });
    return intents.filter((intent) => intent.eventKey.startsWith('activity-change:'));
  }

  it('AC-066 改期即冻结:收件人恰为改期那一刻的在册报名者,改期前已退出的不在内', async () => {
    const fixture = await publishThenReschedule('roster');

    const intents = await scheduleChangeIntents(fixture.activityId);
    // 先钉非空 —— 空集 == 空集是本仓栽过的假绿形状。
    expect(intents.length).toBeGreaterThan(0);
    // 比集合,不比计数。
    expect(intents.map((intent) => intent.destinationRef)).toEqual(fixture.roster);
    // 反向:改期前就退出的人一条都没有(正面数出 0,不是「没在集合里就算了」)。
    expect(
      intents.filter((intent) => intent.destinationRef === fixture.withdrawnBefore),
    ).toHaveLength(0);
    // eventKey 的粒度是「这一次改期 × 这个人」——版本键就是活动的 updatedAt。
    expect(intents.map((intent) => intent.eventKey).sort()).toEqual(
      fixture.roster
        .map((memberId) => `activity-change:${fixture.activityId}:${fixture.updatedAt}:${memberId}`)
        .sort(),
    );
  });

  it('AC-066 改期 intent 形成后名单再变:抽干 outbox 后实收集合与快照逐字相同', async () => {
    const fixture = await publishThenReschedule('async');
    const frozen = (await scheduleChangeIntents(fixture.activityId)).map(
      (intent) => intent.destinationRef,
    );
    expect(frozen.length).toBeGreaterThan(0);
    expect(frozen).toEqual(fixture.roster);

    // ── intent 已经形成。现在**真改名单**:一个人退出、一个人新报名 ──
    await prisma.activityRegistration.updateMany({
      where: { activityId: fixture.activityId, memberId: fixture.roster[0] },
      data: { deletedAt: new Date(), statusCode: 'cancelled' },
    });
    const lateRegistrant = await prisma.member.create({
      data: {
        memberNo: 'change-reg-async-late',
        ...memberIdentityData('change-reg-async-late'),
      },
      select: { id: true },
    });
    await prisma.activityRegistration.create({
      data: { activityId: fixture.activityId, memberId: lateRegistrant.id, statusCode: 'pending' },
    });

    // 名单确实变了 —— 先证明这一点,否则下面的「没变」什么都没证明。
    const liveRoster = await prisma.activityRegistration.findMany({
      where: {
        activityId: fixture.activityId,
        deletedAt: null,
        statusCode: { in: ['pending', 'pass', 'waitlisted'] },
      },
      select: { memberId: true },
    });
    const liveNow = [...new Set(liveRoster.map((row) => row.memberId))].sort();
    expect(liveNow.length).toBeGreaterThan(0);
    expect(liveNow).not.toEqual(frozen);
    expect(liveNow).toContain(lateRegistrant.id);

    // ── 「异步展开」那一步 ──
    await drainOutbox();

    const delivered = await prisma.notification.findMany({
      where: {
        notificationTypeCode: 'activity-changed',
        recipientMemberId: { in: [...fixture.roster, fixture.withdrawnBefore, lateRegistrant.id] },
      },
      select: { recipientMemberId: true },
    });
    const deliveredMembers = [...new Set(delivered.map((row) => row.recipientMemberId!))].sort();
    expect(deliveredMembers.length).toBeGreaterThan(0);
    expect(deliveredMembers).toEqual(frozen);
    // 展开之后才退出的人**仍然**收到(改期那一刻他确实在册);
    // 展开之后才报名的人一个都不许进来;改期之前就退出的人也一个都不许进来。
    expect(deliveredMembers).toContain(fixture.roster[0]);
    expect(deliveredMembers).not.toContain(lateRegistrant.id);
    expect(deliveredMembers).not.toContain(fixture.withdrawnBefore);
  });

  it('AC-066 改期批自带 registration-roster 盖章,且与发布批是两批 cohort 互不吞并', async () => {
    const fixture = await publishThenReschedule('stamp');

    const changeIntents = await scheduleChangeIntents(fixture.activityId);
    expect(changeIntents.length).toBeGreaterThan(0);
    const changeStamps = changeIntents.map((intent) => readRecipientFreezeStamp(intent.payload));
    for (const stamp of changeStamps) {
      expect(stamp).not.toBeNull();
      // 依据是**报名名册**,不是发布那批的受众标签 —— 两个事件取数源本来就不同。
      expect(stamp!.basisKind).toBe('registration-roster');
      expect(stamp!.basisRef).toEqual([`schedule:${fixture.updatedAt}`]);
      expect(stamp!.algorithmVersion).toBe(1);
      expect(stamp!.computedAt).toBe(fixture.updatedAt);
      // 基数与真实落库行数相等 —— 「只写进去一半」时这条是唯一能看出来的判据。
      expect(stamp!.cohortSize).toBe(changeIntents.length);
    }
    // 同一次改期共用一个 cohortKey:它就是「这一次改期」的身份。
    expect(new Set(changeStamps.map((stamp) => stamp!.cohortKey)).size).toBe(1);
    expect(changeStamps[0]!.cohortKey).toBe(
      `activity-change:${fixture.activityId}:${fixture.updatedAt}`,
    );

    // 反向:发布那一批还在原地,既没被改期批吞掉,也没把改期批算进自己。
    const publishIntents = (
      await prisma.notificationOutboxIntent.findMany({
        where: {
          aggregateType: 'activity',
          aggregateId: fixture.activityId,
          destinationType: 'member',
        },
        select: { eventKey: true, payload: true },
      })
    ).filter((intent) => intent.eventKey.startsWith('activity-publish-audience:'));
    expect(publishIntents.length).toBeGreaterThan(0);
    const publishCohortKeys = new Set(
      publishIntents.map((intent) => readRecipientFreezeStamp(intent.payload)!.cohortKey),
    );
    expect(publishCohortKeys.size).toBe(1);
    expect(publishCohortKeys.has(changeStamps[0]!.cohortKey)).toBe(false);
  });
});

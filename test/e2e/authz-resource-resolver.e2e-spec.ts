import type { INestApplication } from '@nestjs/common';
import { AttachmentAccessLevel, MembershipStatus, MembershipType, Role } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { ResourceResolverService } from '../../src/modules/authz/resource-resolver.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.1):ResourceResolver 11 类逐类 service 级测试。
// 沿 characterization 先例(createTestApp + resetDb + 真实 PrismaService,直调 service 绕过 HTTP)。
//
// 覆盖(goal DoD 4):
//   1. 11 类逐类正向解析:organizationId / organizationPath(root 在前含自身)/ ownerMemberId /
//      ownerUserId / activityId / statusCode / sensitivityLevel / extra 逐字段断言
//   2. attachment 按 ownerType 委派(member / certificate / activity;content-* 未映射 → null;
//      委派目标软删 → 整体 null)
//   3. fail-close:软删 → null(全部软删模型逐类)/ attachment 硬删 → null / 未知类型 → null / 不存在 id → null
//   4. 边界:member 无 active PRIMARY membership → organizationId null;
//      team_join_application 未定 selectedOrganizationId → org null(候选在 extra);
//      notification 广播 → org null(可见部门在 extra)、定向 → org 经收件人 PRIMARY membership
//
// 组织树 fixture(手写 closure,含 depth-0 自环行,镜像 PR1 闭包表口径):
//   root(RR-ROOT) → dept(RR-DEPT) → grp(RR-GRP)

describe('authz ResourceResolver(§5.1 11 类资源归属解析)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let resolver: ResourceResolverService;

  // 组织
  let rootId: string;
  let deptId: string;
  let grpId: string;
  // 人
  let ownerUserId: string;
  let ownerMemberId: string;
  let orphanMemberId: string;
  let submitterUserId: string;
  let reviewerUserId: string;
  // 资源
  let activityId: string;
  let sheetId: string;
  let recordId: string;
  let registrationId: string;
  let profileId: string;
  let certificateId: string;
  let tjaSelectedId: string;
  let tjaUnselectedId: string;
  let recruitmentAppId: string;
  let notifDirectedId: string;
  let notifBroadcastId: string;
  let attMemberId: string;
  let attCertificateId: string;
  let attActivityId: string;
  let attContentId: string;
  let attBrokenDelegateId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    resolver = app.get(ResourceResolverService);

    // ===== 组织树 + closure(自环 depth 0;链 root→dept→grp)=====
    const root = await prisma.organization.create({
      data: { name: 'RR 根', code: 'RR-ROOT', nodeTypeCode: 'headquarters' },
      select: { id: true },
    });
    const dept = await prisma.organization.create({
      data: { name: 'RR 队', code: 'RR-DEPT', nodeTypeCode: 'rescue-team', parentId: root.id },
      select: { id: true },
    });
    const grp = await prisma.organization.create({
      data: { name: 'RR 行动组', code: 'RR-GRP', nodeTypeCode: 'group', parentId: dept.id },
      select: { id: true },
    });
    rootId = root.id;
    deptId = dept.id;
    grpId = grp.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootId, descendantId: rootId, depth: 0 },
        { ancestorId: deptId, descendantId: deptId, depth: 0 },
        { ancestorId: grpId, descendantId: grpId, depth: 0 },
        { ancestorId: rootId, descendantId: deptId, depth: 1 },
        { ancestorId: deptId, descendantId: grpId, depth: 1 },
        { ancestorId: rootId, descendantId: grpId, depth: 2 },
      ],
    });

    // ===== 人:owner(user+member,PRIMARY→dept)/ orphan(无归属无 user)/ submitter / reviewer =====
    const ownerMember = await prisma.member.create({
      data: { memberNo: 'rr-m-001', displayName: 'RR Owner' },
      select: { id: true },
    });
    ownerMemberId = ownerMember.id;
    const ownerUser = await prisma.user.create({
      data: {
        username: 'rr-owner',
        passwordHash: '$2a$10$dummy',
        role: Role.USER,
        memberId: ownerMemberId,
      },
      select: { id: true },
    });
    ownerUserId = ownerUser.id;
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: ownerMemberId,
        organizationId: deptId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
      },
    });
    const orphanMember = await prisma.member.create({
      data: { memberNo: 'rr-m-002', displayName: 'RR Orphan' },
      select: { id: true },
    });
    orphanMemberId = orphanMember.id;
    const submitter = await prisma.user.create({
      data: { username: 'rr-submitter', passwordHash: '$2a$10$dummy', role: Role.ADMIN },
      select: { id: true },
    });
    submitterUserId = submitter.id;
    const reviewer = await prisma.user.create({
      data: { username: 'rr-reviewer', passwordHash: '$2a$10$dummy', role: Role.ADMIN },
      select: { id: true },
    });
    reviewerUserId = reviewer.id;

    // ===== participation 链:activity(挂 grp)→ sheet → record;registration =====
    const activity = await prisma.activity.create({
      data: {
        title: 'RR 演练',
        activityTypeCode: 'rr-demo',
        organizationId: grpId,
        startAt: new Date('2026-07-01T01:00:00.000Z'),
        endAt: new Date('2026-07-01T05:00:00.000Z'),
        location: 'RR 基地',
        statusCode: 'published',
      },
      select: { id: true },
    });
    activityId = activity.id;
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        reviewerUserId,
        statusCode: 'pending_final_review',
      },
      select: { id: true },
    });
    sheetId = sheet.id;
    const record = await prisma.attendanceRecord.create({
      data: {
        sheetId,
        memberId: ownerMemberId,
        roleCode: 'member',
        checkInAt: new Date('2026-07-01T01:00:00.000Z'),
        checkOutAt: new Date('2026-07-01T05:00:00.000Z'),
        serviceHours: '4.00',
        attendanceStatusCode: 'present',
      },
      select: { id: true },
    });
    recordId = record.id;
    const registration = await prisma.activityRegistration.create({
      data: { activityId, memberId: ownerMemberId, statusCode: 'approved' },
      select: { id: true },
    });
    registrationId = registration.id;

    // ===== member 扩展:profile(PII)/ certificate =====
    const profile = await prisma.memberProfile.create({
      data: {
        memberId: ownerMemberId,
        realName: 'RR 属主',
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'idcard',
        documentNumber: '110101199001010011',
        mobile: '13800000001',
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'recruit',
        privacyConsentSigned: true,
      },
      select: { id: true },
    });
    profileId = profile.id;
    const certificate = await prisma.certificate.create({
      data: {
        memberId: ownerMemberId,
        certTypeCode: 'rr-cert',
        issuingOrg: 'RR 发证机构',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'valid',
      },
      select: { id: true },
    });
    certificateId = certificate.id;

    // ===== 入队 / 招新 =====
    await prisma.teamJoinCycle.updateMany({
      where: { statusCode: 'open' },
      data: { statusCode: 'closed', closedAt: new Date() },
    }); // 刀B partial unique:至多一个 open 轮
    const tjCycle = await prisma.teamJoinCycle.create({
      data: { year: 2026, name: 'RR 入队轮', statusCode: 'open' },
      select: { id: true },
    });
    const tjaSelected = await prisma.teamJoinApplication.create({
      data: {
        cycleId: tjCycle.id,
        memberId: ownerMemberId,
        statusCode: 'approved',
        targetOrganizationIds: [deptId, grpId],
        selectedOrganizationId: deptId,
      },
      select: { id: true },
    });
    tjaSelectedId = tjaSelected.id;
    const tjaUnselected = await prisma.teamJoinApplication.create({
      data: {
        cycleId: tjCycle.id,
        memberId: orphanMemberId,
        statusCode: 'joining',
        targetOrganizationIds: [grpId],
      },
      select: { id: true },
    });
    tjaUnselectedId = tjaUnselected.id;
    const recCycle = await prisma.recruitmentCycle.create({
      data: { year: 2026, name: 'RR 招新轮', statusCode: 'open' },
      select: { id: true },
    });
    const recApp = await prisma.recruitmentApplication.create({
      data: {
        cycleId: recCycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'idcard',
      },
      select: { id: true },
    });
    recruitmentAppId = recApp.id;

    // ===== 通知:定向(经收件人 PRIMARY membership)/ department 广播(org=null,数组进 extra)=====
    const notifDirected = await prisma.notification.create({
      data: {
        title: 'RR 定向',
        body: '定向站内信',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'member',
        audienceType: 'directed',
        sourceType: 'system',
        recipientMemberId: ownerMemberId,
      },
      select: { id: true },
    });
    notifDirectedId = notifDirected.id;
    const notifBroadcast = await prisma.notification.create({
      data: {
        title: 'RR 广播',
        body: '部门广播',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'department',
        visibleOrganizationIds: [deptId],
      },
      select: { id: true },
    });
    notifBroadcastId = notifBroadcast.id;

    // ===== attachment 多态(委派 member / certificate / activity;content-* 未映射;委派断裂)=====
    const brokenMember = await prisma.member.create({
      data: { memberNo: 'rr-m-003', displayName: 'RR Broken', deletedAt: new Date() },
      select: { id: true },
    });
    const mkAtt = (
      key: string,
      ownerType: string,
      ownerId: string,
      accessLevel?: AttachmentAccessLevel,
    ) =>
      prisma.attachment.create({
        data: {
          key,
          originalName: `${key}.jpg`,
          mime: 'image/jpeg',
          size: 1024,
          uploadedBy: submitterUserId,
          ownerType,
          ownerId,
          accessLevel,
        },
        select: { id: true },
      });
    attMemberId = (
      await mkAtt('rr-att-member', 'member', ownerMemberId, AttachmentAccessLevel.SENSITIVE)
    ).id;
    attCertificateId = (await mkAtt('rr-att-cert', 'certificate', certificateId)).id;
    attActivityId = (
      await mkAtt('rr-att-act', 'activity', activityId, AttachmentAccessLevel.INTERNAL)
    ).id;
    attContentId = (await mkAtt('rr-att-content', 'content-image', 'content-x')).id;
    attBrokenDelegateId = (await mkAtt('rr-att-broken', 'member', brokenMember.id)).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ============ 1-4. participation 链 ============

  it('activity:org=挂靠组织,path=root→dept→grp,activityId=自身', async () => {
    const r = await resolver.resolve({ type: 'activity', id: activityId });
    expect(r).toMatchObject({
      resourceType: 'activity',
      resourceId: activityId,
      organizationId: grpId,
      organizationPath: [rootId, deptId, grpId],
      ownerMemberId: null,
      ownerUserId: null,
      activityId,
      statusCode: 'published',
      sensitivityLevel: null,
    });
  });

  it('attendance_sheet:org 经 activity;extra 携 submitter/reviewer(自审约束事实源)', async () => {
    const r = await resolver.resolve({ type: 'attendance_sheet', id: sheetId });
    expect(r).toMatchObject({
      resourceType: 'attendance_sheet',
      resourceId: sheetId,
      organizationId: grpId,
      organizationPath: [rootId, deptId, grpId],
      ownerMemberId: null,
      activityId,
      statusCode: 'pending_final_review',
      extra: { submitterUserId, reviewerUserId },
    });
  });

  it('attendance_record:org 经 sheet→activity;owner=record.memberId', async () => {
    const r = await resolver.resolve({ type: 'attendance_record', id: recordId });
    expect(r).toMatchObject({
      resourceType: 'attendance_record',
      resourceId: recordId,
      organizationId: grpId,
      ownerMemberId: ownerMemberId,
      activityId,
      statusCode: 'present',
    });
  });

  it('activity_registration:org 经 activity;owner=reg.memberId', async () => {
    const r = await resolver.resolve({ type: 'activity_registration', id: registrationId });
    expect(r).toMatchObject({
      resourceType: 'activity_registration',
      resourceId: registrationId,
      organizationId: grpId,
      ownerMemberId: ownerMemberId,
      activityId,
      statusCode: 'approved',
    });
  });

  // ============ 5-7. member 族 ============

  it('member:org=active PRIMARY membership;ownerUserId=member.user?.id;无归属 → org null', async () => {
    const r = await resolver.resolve({ type: 'member', id: ownerMemberId });
    expect(r).toMatchObject({
      resourceType: 'member',
      resourceId: ownerMemberId,
      organizationId: deptId,
      organizationPath: [rootId, deptId],
      ownerMemberId: ownerMemberId,
      ownerUserId: ownerUserId,
      activityId: null,
      statusCode: 'ACTIVE',
    });

    const orphan = await resolver.resolve({ type: 'member', id: orphanMemberId });
    expect(orphan).toMatchObject({
      organizationId: null,
      organizationPath: null,
      ownerMemberId: orphanMemberId,
      ownerUserId: null,
    });
  });

  it('member_profile:org 经 member;sensitivityLevel=sensitive(PII)', async () => {
    const r = await resolver.resolve({ type: 'member_profile', id: profileId });
    expect(r).toMatchObject({
      resourceType: 'member_profile',
      resourceId: profileId,
      organizationId: deptId,
      ownerMemberId: ownerMemberId,
      sensitivityLevel: 'sensitive',
    });
  });

  it('certificate:org 经 member;owner=cert.memberId', async () => {
    const r = await resolver.resolve({ type: 'certificate', id: certificateId });
    expect(r).toMatchObject({
      resourceType: 'certificate',
      resourceId: certificateId,
      organizationId: deptId,
      ownerMemberId: ownerMemberId,
      statusCode: 'valid',
    });
  });

  // ============ 8-10. 入队 / 招新 / 通知 ============

  it('team_join_application:org=selectedOrganizationId ?? null;候选数组在 extra', async () => {
    const selected = await resolver.resolve({ type: 'team_join_application', id: tjaSelectedId });
    expect(selected).toMatchObject({
      resourceType: 'team_join_application',
      organizationId: deptId,
      organizationPath: [rootId, deptId],
      ownerMemberId: ownerMemberId,
      statusCode: 'approved',
      extra: { targetOrganizationIds: [deptId, grpId] },
    });

    const unselected = await resolver.resolve({
      type: 'team_join_application',
      id: tjaUnselectedId,
    });
    expect(unselected).toMatchObject({
      organizationId: null,
      organizationPath: null,
      ownerMemberId: orphanMemberId,
      extra: { targetOrganizationIds: [grpId] },
    });
  });

  it('recruitment_application:org=null / owner=null(D-R-1);sensitive', async () => {
    const r = await resolver.resolve({ type: 'recruitment_application', id: recruitmentAppId });
    expect(r).toMatchObject({
      resourceType: 'recruitment_application',
      resourceId: recruitmentAppId,
      organizationId: null,
      organizationPath: null,
      ownerMemberId: null,
      ownerUserId: null,
      statusCode: 'pending_verification',
      sensitivityLevel: 'sensitive',
    });
  });

  it('notification:定向 → org 经收件人 PRIMARY membership + owner=收件人;广播 → org null + 数组在 extra', async () => {
    const directed = await resolver.resolve({ type: 'notification', id: notifDirectedId });
    expect(directed).toMatchObject({
      resourceType: 'notification',
      organizationId: deptId,
      ownerMemberId: ownerMemberId,
      statusCode: 'published',
      extra: { audienceType: 'directed', visibleOrganizationIds: [] },
    });

    const broadcast = await resolver.resolve({ type: 'notification', id: notifBroadcastId });
    expect(broadcast).toMatchObject({
      organizationId: null,
      organizationPath: null,
      ownerMemberId: null,
      extra: { audienceType: 'broadcast', visibleOrganizationIds: [deptId] },
    });
  });

  // ============ 11. attachment 委派 ============

  it('attachment:按 ownerType 委派 member / certificate / activity;sensitivityLevel ← accessLevel', async () => {
    const attMember = await resolver.resolve({ type: 'attachment', id: attMemberId });
    expect(attMember).toMatchObject({
      resourceType: 'attachment',
      resourceId: attMemberId,
      organizationId: deptId,
      organizationPath: [rootId, deptId],
      ownerMemberId: ownerMemberId,
      ownerUserId: ownerUserId,
      activityId: null,
      statusCode: null,
      sensitivityLevel: 'sensitive',
      extra: { ownerType: 'member', ownerId: ownerMemberId },
    });

    const attCert = await resolver.resolve({ type: 'attachment', id: attCertificateId });
    expect(attCert).toMatchObject({
      organizationId: deptId,
      ownerMemberId: ownerMemberId,
      sensitivityLevel: null,
      extra: { ownerType: 'certificate', ownerId: certificateId },
    });

    const attAct = await resolver.resolve({ type: 'attachment', id: attActivityId });
    expect(attAct).toMatchObject({
      organizationId: grpId,
      organizationPath: [rootId, deptId, grpId],
      ownerMemberId: null,
      activityId,
      sensitivityLevel: 'internal',
    });
  });

  it('attachment fail-close:未映射 ownerType(content-*)→ null;委派目标已软删 → null', async () => {
    expect(await resolver.resolve({ type: 'attachment', id: attContentId })).toBeNull();
    expect(await resolver.resolve({ type: 'attachment', id: attBrokenDelegateId })).toBeNull();
  });

  // ============ fail-close 族 ============

  it('未知 resourceType / 不存在 id → null', async () => {
    expect(await resolver.resolve({ type: 'unknown_type', id: activityId })).toBeNull();
    expect(await resolver.resolve({ type: 'activity', id: 'no-such-id' })).toBeNull();
    expect(await resolver.resolve({ type: 'member', id: 'no-such-id' })).toBeNull();
  });

  it('软删 → null(10 个软删模型逐类)+ attachment 硬删 → null', async () => {
    const deletedAt = new Date();
    await prisma.activity.update({ where: { id: activityId }, data: { deletedAt } });
    await prisma.attendanceSheet.update({ where: { id: sheetId }, data: { deletedAt } });
    await prisma.attendanceRecord.update({ where: { id: recordId }, data: { deletedAt } });
    await prisma.activityRegistration.update({
      where: { id: registrationId },
      data: { deletedAt },
    });
    await prisma.member.update({ where: { id: ownerMemberId }, data: { deletedAt } });
    await prisma.memberProfile.update({ where: { id: profileId }, data: { deletedAt } });
    await prisma.certificate.update({ where: { id: certificateId }, data: { deletedAt } });
    await prisma.teamJoinApplication.update({ where: { id: tjaSelectedId }, data: { deletedAt } });
    await prisma.recruitmentApplication.update({
      where: { id: recruitmentAppId },
      data: { deletedAt },
    });
    await prisma.notification.update({ where: { id: notifDirectedId }, data: { deletedAt } });
    await prisma.attachment.delete({ where: { id: attActivityId } });

    expect(await resolver.resolve({ type: 'activity', id: activityId })).toBeNull();
    expect(await resolver.resolve({ type: 'attendance_sheet', id: sheetId })).toBeNull();
    expect(await resolver.resolve({ type: 'attendance_record', id: recordId })).toBeNull();
    expect(
      await resolver.resolve({ type: 'activity_registration', id: registrationId }),
    ).toBeNull();
    expect(await resolver.resolve({ type: 'member', id: ownerMemberId })).toBeNull();
    expect(await resolver.resolve({ type: 'member_profile', id: profileId })).toBeNull();
    expect(await resolver.resolve({ type: 'certificate', id: certificateId })).toBeNull();
    expect(await resolver.resolve({ type: 'team_join_application', id: tjaSelectedId })).toBeNull();
    expect(
      await resolver.resolve({ type: 'recruitment_application', id: recruitmentAppId }),
    ).toBeNull();
    expect(await resolver.resolve({ type: 'notification', id: notifDirectedId })).toBeNull();
    expect(await resolver.resolve({ type: 'attachment', id: attActivityId })).toBeNull();
  });
});

import type { INestApplication } from '@nestjs/common';
import { MembershipType, type Notification, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationReadService } from '../../src/modules/notifications/notification-read.service';
import { NotificationSmsDispatchService } from '../../src/modules/notifications/notification-sms-dispatch.service';
import { NotificationWechatDispatchService } from '../../src/modules/notifications/notification-wechat-dispatch.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ============================================================================
// T5A / PR-F0 —— 通知「受众判定」characterization(**现状**行为矩阵,零 src 改动)
// ============================================================================
//
// 目的(冻结稿 wecom-integration-t0-terminal-review.md §10.4 / §10.5 + D-WC-19):
// T5A 要把今天散在四处的**渠道无关**受众资格判定抽成一个服务。抽之前必须先把现状钉死 ——
// 本 spec 就是那把尺子:**测出来什么钉什么,不写应然**(所以下面有几条断言钉的是
// 「四个站点并不一致」,而不是「它们应该一致」)。
//
// 判定落点(本 spec 的四个「站点」,全部按 service 层真接缝调用,不经 HTTP;
// HTTP 层已由 notifications-app / notifications-wechat / notifications-sms e2e 覆盖):
//
//   | 站点          | 生产入口                                                              | 语义              |
//   |---------------|-----------------------------------------------------------------------|-------------------|
//   | `app`         | `NotificationReadService.appList`                                     | 站内信读侧 feed   |
//   | `wechatRoot`  | `NotificationWechatDispatchService.resolveDurableBroadcastMemberIds`   | 微信广播根候选    |
//   | `wechatFinal` | `NotificationWechatDispatchService.authorizeDurableBroadcastRecipient` | Provider 前最终闸 |
//   | `sms`         | `NotificationSmsDispatchService.resolveRecipientMemberIds`             | 短信可计费受众    |
//
// 断言形状:同一份人群 + 同一条通知 → 四个站点各自「授权集合」的**全表**比对。
// 用全集合(而不是逐条 toBe)是刻意的:F1 重构后若某站点多放行或少放行一个人,矩阵直接红。
//
// 人群覆盖受众维度与边界(见 `POPULATION`):正式等级 / 四类有效任职 / 组织灭活 / 任期已结束 /
// GLOBAL RBAC 授权 / 裸 ADMIN / SUPER_ADMIN / member 灭活 / member 软删 / User 停用 / 无 User。
// **每个人都预先配足 quota 与手机号** —— 任何一格的落空都只能归因于受众判定本身,
// 而不是渠道侧的 quota / phone 前置过滤。
//
// 与既有 spec 的分工(不重复造轮子,也不放宽既有断言):
// - 渠道侧机制(quota 原子扣 / 43101 回补 / 显式 confirmed 计费闸 / 24030 通道未配 /
//   publishGeneration fence / lease):notifications-wechat、notifications-sms、
//   notification-publish-generation、notification-outbox e2e 已覆盖,本 spec 不复制。
// - `authorizeDurableBroadcastRecipient` 的**锁序**与 in-tx RBAC 链:
//   notification-outbox.handlers.spec.ts 已用 mock tx 精确钉住,本 spec 只补「真库下判定结果」。
//
// ⚠️ 本 spec 是 T5A F1 的行为基线:F1 重构 PR 内**本文件必须零改动**。

// 通知类型码与模板 id 都取本 spec 专属值。原因:`wechat_subscribe_templates` 没有指向
// TRUNCATE 列表里任何表的外键,**不会**被 `resetDb` 的 CASCADE 清掉(Member / quota 会),
// 用 'general' 会与 notifications-wechat.e2e-spec 在同一 worker 库里撞唯一键。
const TYPE_CODE = 't5a-recipient-authz';
const TEMPLATE_ID = 'tmpl-recipient-authz-001';
const MANAGEMENT_PERMISSION = 'notification.read.record';
const MANAGEMENT_ROLE_CODE = 'e2e-notification-record-reader';

// ---- 三个人群分组(下面所有期望集合都由它们拼出,不散落硬编码)----
//
// LINKED = ACTIVE Member + ACTIVE User(唯一能持会话、有 openid/phone 的一组)。
const LINKED = [
  'deptDeadOrg',
  'deptEndedTerm',
  'deptOther',
  'deptPrimary',
  'deptSupport',
  'formal',
  'mgmtGranted',
  'plain',
  'plainAdmin',
  'superAdmin',
];
// NO_ACTIVE_USER = ACTIVE Member,但没有 ACTIVE User(无账号 / 账号停用)。
// 现状:**只有微信广播根候选**把这组算进受众(随后由最终闸 / no-openid 兜住)。
const NO_ACTIVE_USER = ['noUser', 'userDisabled'];
// NO_ACTIVE_MEMBER = Member 已灭活 / 已软删 —— 四个站点一致排除。
const NO_ACTIVE_MEMBER = ['memberInactive', 'memberDeleted'];

const sorted = (keys: readonly string[]): string[] => [...keys].sort();
// member / public 档下,微信广播根的受众 = LINKED ∪ NO_ACTIVE_USER。
const ROOT_ALL_MEMBERS = sorted([...LINKED, ...NO_ACTIVE_USER]);

// 人群定义。key 用于断言可读性;`grade` 为 null 或非 level-* 即非正式队员。
interface PersonSpec {
  key: string;
  grade: string | null;
  role?: Role;
  memberStatus?: 'ACTIVE' | 'INACTIVE';
  memberDeleted?: boolean;
  userStatus?: UserStatus;
  withUser?: boolean;
  memberships?: Array<{ org: 'A' | 'B' | 'DEAD'; type: MembershipType; ended?: boolean }>;
  managementGrant?: boolean;
}

const POPULATION: readonly PersonSpec[] = [
  // ---- 可见档维度 ----
  { key: 'plain', grade: 'volunteer' },
  { key: 'formal', grade: 'level-3' },
  {
    key: 'deptPrimary',
    grade: 'volunteer',
    memberships: [{ org: 'A', type: MembershipType.PRIMARY }],
  },
  {
    key: 'deptSupport',
    grade: 'volunteer',
    memberships: [{ org: 'A', type: MembershipType.SUPPORT }],
  },
  {
    key: 'deptOther',
    grade: 'volunteer',
    memberships: [{ org: 'B', type: MembershipType.PRIMARY }],
  },
  { key: 'mgmtGranted', grade: 'volunteer', managementGrant: true },
  { key: 'superAdmin', grade: 'volunteer', role: Role.SUPER_ADMIN },
  { key: 'plainAdmin', grade: 'volunteer', role: Role.ADMIN },
  // ---- 边界:看似命中 department 但现状不放行 ----
  {
    key: 'deptDeadOrg',
    grade: 'volunteer',
    memberships: [{ org: 'DEAD', type: MembershipType.PRIMARY }],
  },
  {
    key: 'deptEndedTerm',
    grade: 'volunteer',
    memberships: [{ org: 'A', type: MembershipType.PRIMARY, ended: true }],
  },
  // ---- 边界:候选资格本身失效(四种形态;grade 一律给正式等级,排除只能来自资格闸)----
  { key: 'memberInactive', grade: 'level-3', memberStatus: 'INACTIVE' },
  { key: 'memberDeleted', grade: 'level-3', memberDeleted: true },
  { key: 'userDisabled', grade: 'level-3', userStatus: UserStatus.DISABLED },
  { key: 'noUser', grade: 'level-3', withUser: false },
];

interface Person {
  key: string;
  memberId: string;
  userId: string | null;
  // 只有 ACTIVE User 才可能持有会话(JwtStrategy 每请求校验 status===ACTIVE);
  // 读侧站点只对这组求值,避免用生产不可达的会话污染矩阵。
  payload: CurrentUserPayload | null;
}

interface AuthorizedSets {
  app: string[];
  wechatRoot: string[];
  wechatFinal: string[];
  sms: string[];
}

describe('T5A F0 —— 通知受众判定 characterization(现状行为矩阵)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let readService: NotificationReadService;
  let wechatDispatch: NotificationWechatDispatchService;
  let smsDispatch: NotificationSmsDispatchService;

  const people = new Map<string, Person>();
  const orgIds: Record<'A' | 'B' | 'DEAD', string> = { A: '', B: '', DEAD: '' };
  const disabledUserPayloads = new Map<string, CurrentUserPayload>();
  let seq = 0;

  function keysOf(memberIds: readonly string[]): string[] {
    const byMember = new Map([...people.values()].map((p) => [p.memberId, p.key] as const));
    return memberIds.map((id) => byMember.get(id) ?? `<unknown:${id}>`).sort();
  }

  async function createPerson(spec: PersonSpec): Promise<void> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `T5A${String(seq).padStart(4, '0')}`,
        displayName: spec.key,
        status: spec.memberStatus ?? 'ACTIVE',
        gradeCode: spec.grade,
        deletedAt: spec.memberDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    let userId: string | null = null;
    let payload: CurrentUserPayload | null = null;
    if (spec.withUser !== false) {
      const status = spec.userStatus ?? UserStatus.ACTIVE;
      const user = await createTestUser(app, {
        username: `t5a_${spec.key.toLowerCase()}`,
        role: spec.role ?? Role.USER,
        status,
      });
      await prisma.user.update({
        where: { id: user.id },
        data: {
          memberId: member.id,
          openid: `openid-${spec.key}`,
          phone: `1390000${String(1000 + seq)}`,
        },
      });
      userId = user.id;
      const built: CurrentUserPayload = {
        id: user.id,
        username: user.username,
        role: spec.role ?? Role.USER,
        status,
        memberId: member.id,
      };
      if (status === UserStatus.ACTIVE) payload = built;
      else disabledUserPayloads.set(spec.key, built);
    }

    for (const m of spec.memberships ?? []) {
      // DB check constraint `member_org_membership_status_time_check`:
      // `status='ENDED'` ⟺ `endedAt IS NOT NULL` —— 「已结束任期」只有这一种合法形态。
      await prisma.memberOrganizationMembership.create({
        data: {
          memberId: member.id,
          organizationId: orgIds[m.org],
          membershipType: m.type,
          status: m.ended ? 'ENDED' : 'ACTIVE',
          startedAt: new Date(Date.now() - 86_400_000),
          endedAt: m.ended ? new Date(Date.now() - 3_600_000) : null,
        },
      });
    }

    if (spec.managementGrant && userId) {
      const permission = await prisma.permission.upsert({
        where: { code: MANAGEMENT_PERMISSION },
        update: {},
        create: {
          code: MANAGEMENT_PERMISSION,
          module: 'notification',
          action: 'read',
          resourceType: 'record',
        },
        select: { id: true },
      });
      const role = await prisma.rbacRole.upsert({
        where: { code: MANAGEMENT_ROLE_CODE },
        update: {},
        create: { code: MANAGEMENT_ROLE_CODE, displayName: 'E2E 通知管理层读码' },
        select: { id: true },
      });
      await prisma.rolePermission.createMany({
        data: [{ roleId: role.id, permissionId: permission.id }],
        skipDuplicates: true,
      });
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: userId,
          roleId: role.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
    }

    // 每个人都配足 quota:任一格落空只能归因受众判定,不能归因渠道侧 quota 前置过滤。
    await prisma.wechatSubscriptionQuota.create({
      data: { memberId: member.id, templateId: TEMPLATE_ID, availableCount: 5 },
    });

    people.set(spec.key, { key: spec.key, memberId: member.id, userId, payload });
  }

  // 直接建通知行(绕开 admin CRUD:本 spec 的被测面是受众判定,不是发布状态机)。
  async function makeNotification(over: Record<string, unknown> = {}): Promise<Notification> {
    return prisma.notification.create({
      data: {
        title: 'T5A 受众判定',
        body: '正文',
        notificationTypeCode: TYPE_CODE,
        statusCode: 'published',
        publishedAt: new Date(),
        visibilityCode: 'member',
        visibleOrganizationIds: [],
        audienceType: 'broadcast',
        sourceType: 'admin',
        channels: ['in-app', 'wechat', 'sms'],
        publishGeneration: 1,
        ...over,
      },
    });
  }

  // 四站点同时求值,返回各自「授权集合」(人群 key,已排序)。
  async function authorizedSets(notification: Notification): Promise<AuthorizedSets> {
    const wechatRoot = await wechatDispatch.resolveDurableBroadcastMemberIds(notification);
    const sms = await smsDispatch.resolveRecipientMemberIds(notification, prisma);

    const wechatFinal: string[] = [];
    for (const person of people.values()) {
      const authorization = await prisma.$transaction((tx) =>
        wechatDispatch.authorizeDurableBroadcastRecipient(tx, notification, person.memberId),
      );
      if (authorization) wechatFinal.push(person.memberId);
    }

    const appVisible: string[] = [];
    for (const person of people.values()) {
      if (!person.payload) continue; // 无 ACTIVE User = 生产上拿不到会话,读侧不参与求值
      let page;
      try {
        page = await readService.appList(person.payload, { page: 1, pageSize: 100 });
      } catch {
        continue; // canUseApp=false → 403(见专用用例)
      }
      if (page.items.some((item) => item.id === notification.id)) appVisible.push(person.memberId);
    }

    return {
      app: keysOf(appVisible),
      wechatRoot: keysOf(wechatRoot),
      wechatFinal: keysOf(wechatFinal),
      sms: keysOf(sms),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    readService = app.get(NotificationReadService);
    wechatDispatch = app.get(NotificationWechatDispatchService);
    smsDispatch = app.get(NotificationSmsDispatchService);
    await resetDb(app);

    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: dictType.id, code: TYPE_CODE, label: 'T5A 受众判定', status: 'ACTIVE' },
    });
    // upsert 而非 create:该表不被 resetDb 清除,worker 重跑同一 spec 时行仍在。
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode: TYPE_CODE },
      update: { templateId: TEMPLATE_ID, enabled: true },
      create: { notificationTypeCode: TYPE_CODE, templateId: TEMPLATE_ID, enabled: true },
    });

    for (const [key, status] of [
      ['A', 'ACTIVE'],
      ['B', 'ACTIVE'],
      ['DEAD', 'INACTIVE'],
    ] as const) {
      const org = await prisma.organization.create({
        data: { name: `T5A-部门-${key}`, nodeTypeCode: 'demo-node', status },
        select: { id: true },
      });
      orgIds[key] = org.id;
    }

    for (const spec of POPULATION) await createPerson(spec);
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  // ==========================================================================
  // 矩阵 1:四档可见性 × 四站点(核心表)
  // ==========================================================================

  it('member 档:读侧/最终闸/短信 = LINKED;微信广播根另含「无 ACTIVE User」两人', async () => {
    const notification = await makeNotification({ visibilityCode: 'member' });
    expect(await authorizedSets(notification)).toEqual({
      app: sorted(LINKED),
      // 现状:根候选按 Member 解析,User 缺失只让 openid 为 null(child intent 仍建),
      // 不在此处淘汰 —— 与最终闸的差集恰是 NO_ACTIVE_USER。
      wechatRoot: ROOT_ALL_MEMBERS,
      wechatFinal: sorted(LINKED),
      sms: sorted(LINKED),
    });
  });

  it('formal_member 档:只认 gradeCode ∈ level-1..7(根候选同样多出无 ACTIVE User 两人)', async () => {
    const notification = await makeNotification({ visibilityCode: 'formal_member' });
    // noUser / userDisabled 的 gradeCode 也是 level-3,故在根候选里命中 formal 档。
    expect(await authorizedSets(notification)).toEqual({
      app: ['formal'],
      wechatRoot: sorted(['formal', ...NO_ACTIVE_USER]),
      wechatFinal: ['formal'],
      sms: ['formal'],
    });
  });

  it('department 档:命中 orgA 的四类有效任职;灭活组织与已结束任期均不放行,四站点一致', async () => {
    const notification = await makeNotification({
      visibilityCode: 'department',
      visibleOrganizationIds: [orgIds.A],
    });
    const expected = ['deptPrimary', 'deptSupport'];
    expect(await authorizedSets(notification)).toEqual({
      app: expected,
      wechatRoot: expected,
      wechatFinal: expected,
      sms: expected,
    });
  });

  it('management 档:SUPER_ADMIN 或明确 GLOBAL read 码;裸 ADMIN 不放行(Decision 15.1=B),四站点一致', async () => {
    const notification = await makeNotification({ visibilityCode: 'management' });
    const expected = ['mgmtGranted', 'superAdmin'];
    expect(await authorizedSets(notification)).toEqual({
      app: expected,
      wechatRoot: expected,
      wechatFinal: expected,
      sms: expected,
    });
  });

  // ==========================================================================
  // 矩阵 2:状态 / 可见档取值边界
  // ==========================================================================

  it.each(['draft', 'archived'])('非 published(%s):四站点全空', async (statusCode) => {
    const notification = await makeNotification({ statusCode, publishedAt: null });
    expect(await authorizedSets(notification)).toEqual({
      app: [],
      wechatRoot: [],
      wechatFinal: [],
      sms: [],
    });
  });

  it('未知可见档:四站点全空(fail-closed)', async () => {
    const notification = await makeNotification({ visibilityCode: 'bogus-tier' });
    expect(await authorizedSets(notification)).toEqual({
      app: [],
      wechatRoot: [],
      wechatFinal: [],
      sms: [],
    });
  });

  // 现状留痕 ①(**不是应然,也不修**):软删闸不在受众判定里。
  // 读侧靠 `buildVisibilityWhere` 的 `deletedAt: null`;推送侧靠 outbox 的
  // `authorizeAdminNotificationEffect`(它逐字检查 `notification.deletedAt !== null`)。
  // 受众解析器本身**只看 statusCode**,直接喂一条软删通知进去会解析出完整受众。
  // ⇒ T5B 新增渠道若绕过 outbox permission gate 直调受众解析器,软删通知会外发。
  it('现状留痕:软删通知在读侧为空,但三个推送侧受众解析器照常解析出全量受众', async () => {
    const notification = await makeNotification({ deletedAt: new Date() });
    expect(await authorizedSets(notification)).toEqual({
      app: [],
      wechatRoot: ROOT_ALL_MEMBERS,
      wechatFinal: sorted(LINKED),
      sms: sorted(LINKED),
    });
  });

  // 现状留痕 ②:可见性判定复用 content.visibility,其 `public` 分支恒 true。
  // 通知模块靠 DTO 白名单保证永不写 public —— 防线在**入口**,不在判定函数里。
  it('现状留痕:若通知行被写成 public 档,复用的判定函数会放行全部候选', async () => {
    const notification = await makeNotification({ visibilityCode: 'public' });
    expect(await authorizedSets(notification)).toEqual({
      app: sorted(LINKED),
      wechatRoot: ROOT_ALL_MEMBERS,
      wechatFinal: sorted(LINKED),
      sms: sorted(LINKED),
    });
  });

  // ==========================================================================
  // 矩阵 3:定向(directed)—— 渠道间语义不一致的现状留痕
  // ==========================================================================

  it('定向通知:读侧仅本人;短信绕过可见档只认 recipientMemberId;微信广播根按广播口径 fan-out', async () => {
    const recipient = people.get('plain')!;
    const notification = await makeNotification({
      audienceType: 'directed',
      sourceType: 'system',
      visibilityCode: 'member',
      recipientMemberId: recipient.memberId,
      channels: ['in-app', 'sms'],
    });

    const sets = await authorizedSets(notification);
    // 读侧:定向分支只认 recipientMemberId=本人(广播可见档被 audienceType 收窄,防越权)。
    expect(sets.app).toEqual(['plain']);
    // 短信:directed 分支**跳过 canSeeContent**,候选锁定 recipientMemberId,有手机即收件人。
    expect(sets.sms).toEqual(['plain']);
    // 微信广播根:生产上定向由 dispatchDirected 单收件人处理,不经该入口;
    // 直接喂定向行进来,现状按广播口径 fan-out —— 钉住事实,不做修正。
    expect(sets.wechatRoot).toEqual(ROOT_ALL_MEMBERS);
  });

  // ==========================================================================
  // 矩阵 4:候选资格失效的四种形态(逐条钉住「为什么不在受众里」)
  // ==========================================================================

  it.each(NO_ACTIVE_MEMBER)('Member 资格失效(%s):member 档下四站点均不放行', async (key) => {
    const notification = await makeNotification({ visibilityCode: 'member' });
    const sets = await authorizedSets(notification);
    expect(sets.app).not.toContain(key);
    expect(sets.wechatRoot).not.toContain(key);
    expect(sets.wechatFinal).not.toContain(key);
    expect(sets.sms).not.toContain(key);
  });

  it.each(NO_ACTIVE_USER)(
    'User 资格失效(%s):最终闸 / 短信 / 读侧都不放行,**只有微信广播根**放行',
    async (key) => {
      const notification = await makeNotification({ visibilityCode: 'member' });
      const sets = await authorizedSets(notification);
      expect(sets.wechatRoot).toContain(key);
      expect(sets.wechatFinal).not.toContain(key);
      expect(sets.sms).not.toContain(key);
      expect(sets.app).not.toContain(key);
    },
  );

  it('Member 灭活 / 软删者在读侧是 403(canUseApp=false),不是「可见但空列表」', async () => {
    for (const key of NO_ACTIVE_MEMBER) {
      const person = people.get(key)!;
      await expect(
        readService.appList(person.payload!, { page: 1, pageSize: 100 }),
      ).rejects.toThrow();
    }
  });

  // 现状留痕 ③:读侧的 `User.status` 闸在 **JwtStrategy**(每请求查库校验 status===ACTIVE),
  // `AppIdentityResolver` 明确不重复该判定。故直调 service 喂一个 DISABLED 用户的 payload
  // 仍会放行 —— 生产不可达(拿不到会话),但 T5B 若新建「不经 JwtStrategy 的读入口」就会踩到。
  it('现状留痕:读侧不自查 User.status —— 直调 service 喂停用用户 payload 仍返回可见通知', async () => {
    const notification = await makeNotification({ visibilityCode: 'member' });
    const payload = disabledUserPayloads.get('userDisabled')!;
    const page = await readService.appList(payload, { page: 1, pageSize: 100 });
    expect(page.items.some((item) => item.id === notification.id)).toBe(true);
  });

  // ==========================================================================
  // 矩阵 5:跨站点零漂移的**确切**范围(T5B 的受众语义基线)
  // ==========================================================================

  it('四档可见性下:读侧 / 最终闸 / 短信侧三集合逐字相等;根候选恰多出「无 ACTIVE User」者', async () => {
    for (const visibilityCode of ['member', 'formal_member', 'department', 'management']) {
      const notification = await makeNotification({
        visibilityCode,
        visibleOrganizationIds: visibilityCode === 'department' ? [orgIds.A] : [],
      });
      const sets = await authorizedSets(notification);

      // D-WC-19 要保住的核心不变量:三个「最终会不会送到这个人」的站点判定一致。
      expect(sets.wechatFinal).toEqual(sets.app);
      expect(sets.wechatFinal).toEqual(sets.sms);

      // 根候选是超集,且差集**只能**是无 ACTIVE User 的人(两阶段裁决的第一阶段)。
      expect(sets.wechatRoot).toEqual(expect.arrayContaining(sets.wechatFinal));
      const extra = sets.wechatRoot.filter((key) => !sets.wechatFinal.includes(key));
      expect(extra.every((key) => NO_ACTIVE_USER.includes(key))).toBe(true);
    }
  });
});

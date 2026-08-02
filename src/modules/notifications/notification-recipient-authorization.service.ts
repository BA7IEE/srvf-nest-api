import { MemberStatus, OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { PrismaService } from '../../database/prisma.service';
// 可见性判定**复用** content.visibility 纯函数(canSeeContent);通知去 public,4 档天然适用(零第二套)。
import {
  canSeeContent,
  type CallerVisibilityContext,
  DEPARTMENT_VISIBILITY_MEMBERSHIP_TYPES,
} from '../content/content.visibility';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { isFormalMemberGradeCode } from '../members/member-grade';
import { lockMemberLifecycle } from '../members/member-lifecycle-lock';
import { ORGANIZATION_TOPOLOGY_LOCK_KEY } from '../organizations/organization-topology-transaction';
import type { RbacService } from '../permissions/rbac.service';
import { NOTIFICATION_VISIBILITY_MANAGEMENT } from './notification.constants';

// ============================================================================
// 通知「受众资格」判定 —— 渠道无关的唯一真相
// (需求真相源:企业微信整合 T0 冻结评审稿 §10.4 / §10.5,决策 D-WC-19;
//  冻结稿在 docs/archive/reviews/ 下,按 D-WC-19 可定位。此处刻意不写文件名 ——
//  本模块的「零外部通道死代码」探针是对目录做字面 grep,注释里出现该通道名会让探针失去信号。)
// ============================================================================
//
// **为什么存在**:此前「谁是这条通知的合法受众」在四处各写一遍(App 读侧 / 微信广播根候选 /
// 微信 Provider 前最终闸 / 短信可计费受众)。四份实现同义但独立 —— 任何一处改动都可能悄悄
// 造出两套可见性与 RBAC 口径。T5B(企业微信通道)必须消费**同一份**判定,不许再抄第五份。
//
// **两个入口**:
//   1. `authorizeBroadcastRecipients` —— 渠道无关批量受众判定(广播候选过滤)
//   2. `authorizeRecipientForEffect`  —— Provider 前最终闸(事务内,固定锁序,返回锁内快照)
//
// **不负责**(冻结稿 §10.5 原文):微信小程序 quota/template/openid · 企业微信 identity/token/
// 消息格式 · 短信手机号/资费/日限 · Provider HTTP · Notification 状态机 · Outbox lease/ack/nack。
//
// **形态说明**:本文件导出**函数**而非 `@Injectable()` 类。三个消费方
// (NotificationWechatDispatchService / NotificationSmsDispatchService / NotificationReadService)
// 在既有 spec 里全部是手搓 `new` 构造,加构造依赖会让那些 spec 拿到 undefined;而本刀是
// 行为零变更重构,不得改既有 spec。依赖(client / tx / rbac)因此一律显式传参。
// 仓内同类边界文件同样如此:`users.policy.ts`、`content.visibility.ts`、`member-lifecycle-lock.ts`。
//
// ⚠️ **软删不在本文件的判定范围内**:`canSeeContent` 只看 `statusCode`。读侧靠
// `buildVisibilityWhere` 的 `deletedAt: null`,推送侧靠 outbox 的
// `authorizeAdminNotificationEffect`(逐字检查 `notification.deletedAt !== null`)。
// 新增渠道**必须**复用其中之一,不能只调本文件 —— 该边界由
// `test/e2e/notification-recipient-authorization.e2e-spec.ts` 钉住。

export type RecipientAuthorizationClient = PrismaService | Prisma.TransactionClient;

// 判定只消费这三列(与 Notification 行同形),不要求传整行。
export interface NotificationVisibilityRow {
  statusCode: string;
  visibilityCode: string;
  visibleOrganizationIds: readonly string[];
}

// 批量入口对 User 快照的最小要求;各渠道自行在 loader 里追加地址列(openid / phone),
// 本文件不认识任何渠道地址。
export interface AudienceUserSnapshot {
  id: string;
  memberId: string | null;
  role: Role;
}

// 批量判定结果。`user` 可能为 undefined:member 活跃但没有活跃 User。
// **保留而非丢弃**是现状语义——微信据此落 `skipped/no-openid`,短信据此丢弃(无手机不可计费)。
export interface AuthorizedBroadcastRecipient<TUser extends AudienceUserSnapshot> {
  memberId: string;
  user: TUser | undefined;
}

// 最终闸在事务内锁到的 User 快照(冻结稿 §10.5「返回安全的内部 User snapshot」)。
// 渠道从这份快照里取自己的投递地址;Provider 恒在事务外且不得回读 destination。
export interface LockedRecipientUser {
  id: string;
  memberId: string | null;
  openid: string | null;
  role: Role;
  status: UserStatus;
}

export interface LockedRecipientSnapshot {
  member: { id: string; gradeCode: string | null };
  user: LockedRecipientUser;
}

// management 可见档的判定权限码。此前在三处各写一遍字面量,这里收成一处。
export const NOTIFICATION_MANAGEMENT_READ_PERMISSION = 'notification.read.record';

// department 可见档的任职口径(Decision 15.2=B):四类当前有效 Membership + 组织 ACTIVE 未软删。
// 三个读取点共用同一份 where,杜绝「某一处漏了 organization.status」这类静默漂移。
function effectiveDepartmentMembershipWhere(
  now: Date,
): Prisma.MemberOrganizationMembershipWhereInput {
  return {
    ...MembershipTermStateMachine.effectiveWhere(now),
    membershipType: { in: [...DEPARTMENT_VISIBILITY_MEMBERSHIP_TYPES] },
    organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
  };
}

// 单人版(读侧详情 / 最终闸用):保持 `memberId` 标量条件与 `select: { organizationId }`。
export async function resolveEffectiveOrganizationIds(
  client: RecipientAuthorizationClient,
  memberId: string,
  now: Date,
): Promise<string[]> {
  const rows = await client.memberOrganizationMembership.findMany({
    where: { ...effectiveDepartmentMembershipWhere(now), memberId },
    select: { organizationId: true },
  });
  return rows.map(({ organizationId }) => organizationId);
}

// 批量版(广播候选用)。
async function resolveEffectiveOrganizationIdsByMember(
  client: RecipientAuthorizationClient,
  memberIds: string[],
  now: Date,
): Promise<Map<string, string[]>> {
  const rows = await client.memberOrganizationMembership.findMany({
    where: { ...effectiveDepartmentMembershipWhere(now), memberId: { in: memberIds } },
    select: { memberId: true, organizationId: true },
  });
  const byMember = new Map<string, string[]>();
  for (const row of rows) {
    const list = byMember.get(row.memberId) ?? [];
    list.push(row.organizationId);
    byMember.set(row.memberId, list);
  }
  return byMember;
}

// 管理层判定(仅 management 可见档用):SUPER_ADMIN 或持 `notification.read.record`。
// 事务外路径走 RbacService(逐请求直读已提交 PG,零缓存)。
export async function resolveManagementByRbac(
  rbac: RbacService,
  user: AudienceUserSnapshot | undefined,
): Promise<boolean> {
  if (!user) return false;
  const payload: CurrentUserPayload = {
    id: user.id,
    username: '',
    role: user.role,
    status: UserStatus.ACTIVE,
    memberId: user.memberId,
  };
  return rbac.can(payload, NOTIFICATION_MANAGEMENT_READ_PERMISSION);
}

// ============================================================================
// 入口 1:渠道无关批量受众判定
// ============================================================================
//
// 候选 memberIds → 活跃 Member(正式等级真值)+ 活跃 User(由调用方 loader 决定选哪些列)
// + 四类有效任职 → 构造 ctx → `canSeeContent` 过滤。
// `isManagement` 仅在 `visibilityCode=management` 时逐 user 解析(候选已被各渠道前置收窄)。
//
// 调用方通过 `loadActiveUsers` 注入自己的 User 查询:渠道地址列(openid / phone)因此
// 完全留在渠道层,本文件既不读也不返回任何投递地址。
export async function authorizeBroadcastRecipients<TUser extends AudienceUserSnapshot>(input: {
  client: RecipientAuthorizationClient;
  rbac: RbacService;
  notification: NotificationVisibilityRow;
  candidateMemberIds: string[];
  loadActiveUsers: (
    client: RecipientAuthorizationClient,
    activeMemberIds: string[],
  ) => Promise<TUser[]>;
  now?: Date;
}): Promise<Array<AuthorizedBroadcastRecipient<TUser>>> {
  const { client, rbac, notification, candidateMemberIds, loadActiveUsers } = input;

  const members = await client.member.findMany({
    where: notDeletedWhere({ id: { in: candidateMemberIds }, status: MemberStatus.ACTIVE }),
    select: { id: true, gradeCode: true },
  });
  const activeMemberIds = members.map((member) => member.id);
  const gradeCodeByMember = new Map(members.map(({ id, gradeCode }) => [id, gradeCode] as const));
  if (activeMemberIds.length === 0) return [];

  const users = await loadActiveUsers(client, activeMemberIds);
  const userByMember = new Map(
    users.flatMap((user) => (user.memberId ? [[user.memberId, user] as const] : [])),
  );

  const orgIdsByMember = await resolveEffectiveOrganizationIdsByMember(
    client,
    activeMemberIds,
    input.now ?? new Date(),
  );

  const needsManagement = notification.visibilityCode === NOTIFICATION_VISIBILITY_MANAGEMENT;
  const authorized: Array<AuthorizedBroadcastRecipient<TUser>> = [];
  for (const memberId of activeMemberIds) {
    const user = userByMember.get(memberId);
    const ctx: CallerVisibilityContext = {
      isMember: true, // active member 准入(canUseApp 等价)
      isFormalMember: isFormalMemberGradeCode(gradeCodeByMember.get(memberId)),
      activeOrgIds: orgIdsByMember.get(memberId) ?? [],
      isManagement: needsManagement ? await resolveManagementByRbac(rbac, user) : false,
    };
    if (canSeeContent(ctx, notification)) authorized.push({ memberId, user });
  }
  return authorized;
}

// ============================================================================
// 入口 2:Provider 前最终闸(事务内)
// ============================================================================
//
// 调用方必须把本函数放在已持有 Notification parent → outbox intent 锁的同一事务内,
// 故完整锁序固定为 Notification → intent → Member → shared organization topology → User;
// User/RBAC 链使用 shared row lock,management 细粒度判权继续锁
// RoleBinding → RbacRole → Permission → RolePermission。
// 投递地址只从这次 User 锁内快照返回,Provider 永远在事务外且不得回读 destination。
export async function authorizeRecipientForEffect(
  tx: Prisma.TransactionClient,
  notification: NotificationVisibilityRow,
  memberId: string,
  now: Date = new Date(),
): Promise<LockedRecipientSnapshot | null> {
  await lockMemberLifecycle(tx, memberId);
  await tx.$queryRaw<Array<{ locked: string }>>(Prisma.sql`
      SELECT pg_advisory_xact_lock_shared(
        CAST(${ORGANIZATION_TOPOLOGY_LOCK_KEY} AS bigint)
      )::text AS locked
    `);

  const member = await tx.member.findFirst({
    where: notDeletedWhere({ id: memberId, status: MemberStatus.ACTIVE }),
    select: { id: true, gradeCode: true },
  });
  if (!member) return null;

  const [user] = await tx.$queryRaw<LockedRecipientUser[]>(Prisma.sql`
      SELECT
        "id",
        "memberId",
        "openid",
        "role"::text AS "role",
        "status"::text AS "status"
      FROM "User"
      WHERE "memberId" = ${memberId}
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR SHARE
    `);
  if (!user || user.status !== UserStatus.ACTIVE) return null;

  const activeOrgIds = await resolveEffectiveOrganizationIds(tx, memberId, now);
  const isManagement =
    notification.visibilityCode === NOTIFICATION_VISIBILITY_MANAGEMENT
      ? await resolveManagementInTransaction(tx, user, now)
      : false;
  const ctx: CallerVisibilityContext = {
    isMember: true,
    isFormalMember: isFormalMemberGradeCode(member.gradeCode),
    activeOrgIds,
    isManagement,
  };
  return canSeeContent(ctx, notification) ? { member, user } : null;
}

// Durable management 判权必须完全留在调用方 transaction client 内，禁止回到 root
// Prisma/RbacService。只锁当前已存在的 grant 链；writer-first 撤权/软删自然先被读到，
// permission-first 则以真实行锁阻塞既有 UPDATE/DELETE 写面。未来新 grant 不属于拒权快照闭包。
async function resolveManagementInTransaction(
  tx: Prisma.TransactionClient,
  user: LockedRecipientUser,
  now: Date,
): Promise<boolean> {
  if (user.role === Role.SUPER_ADMIN) return true;

  const bindings = await tx.$queryRaw<Array<{ id: string; roleId: string }>>(Prisma.sql`
      SELECT "id", "roleId"
      FROM "role_bindings"
      WHERE "principalType"::text = 'USER'
        AND "principalId" = ${user.id}
        AND "scopeType"::text = 'GLOBAL'
        AND "status"::text = 'ACTIVE'
        AND "deletedAt" IS NULL
        AND "startedAt" <= ${now}
        AND ("endedAt" IS NULL OR "endedAt" >= ${now})
      ORDER BY "id"
      FOR SHARE
    `);
  const roleIds = [...new Set(bindings.map(({ roleId }) => roleId))].sort();
  if (roleIds.length === 0) return false;

  const roles = await tx.$queryRaw<Array<{ id: string; deletedAt: Date | null }>>(Prisma.sql`
      SELECT "id", "deletedAt"
      FROM "roles"
      WHERE "id" IN (${Prisma.join(roleIds)})
      ORDER BY "id"
      FOR SHARE
    `);
  const activeRoleIds = roles
    .filter(({ deletedAt }) => deletedAt === null)
    .map(({ id }) => id)
    .sort();
  if (activeRoleIds.length === 0) return false;

  const [permission] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "permissions"
      WHERE "code" = ${NOTIFICATION_MANAGEMENT_READ_PERMISSION}
      ORDER BY "id"
      FOR SHARE
    `);
  if (!permission) return false;

  const rolePermissions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "role_permissions"
      WHERE "roleId" IN (${Prisma.join(activeRoleIds)})
        AND "permissionId" = ${permission.id}
      ORDER BY "id"
      FOR SHARE
    `);
  return rolePermissions.length > 0;
}

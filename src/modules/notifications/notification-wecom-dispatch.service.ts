import { Injectable, Logger } from '@nestjs/common';
import { MemberStatus, type Notification, Prisma, UserStatus } from '@prisma/client';

import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { WecomSettingsService } from '../wecom/wecom-settings.service';
import { WECOM_IDENTITY_STATUS } from '../wecom/wecom.types';
// 受众资格判定(渠道无关)与 Provider 前最终闸的唯一真相 —— T5A / D-WC-19。
// ⚠️ 本文件**禁止**直接 import `content.visibility` 的任何原语:第五条 eslint 自定义规则
// (#889)对 `src/modules/notifications/**` 做辖区拦截,越线当场红。企业微信不是"新写一份
// 可见性判定",而是**第四个消费方**。
import {
  authorizeBroadcastRecipients,
  authorizeRecipientForEffect,
} from './notification-recipient-authorization.service';
import {
  DELIVERY_STATUS_SENT,
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_CHANNEL_WECOM,
} from './notification.constants';

// 企业微信通道就绪快照。**不含任何凭证** —— CorpSecret / access_token 归 Provider 内部,
// 本层只需要知道"闸开着吗"以及拼深链要用的 origin。
export interface WecomChannelReadiness {
  ready: boolean;
  corpId: string | null;
  webBaseUrl: string | null;
}

// 广播根候选解析结果。三个计数直接对应冻结稿 §10.4 末条运营五指标的前两项
// (第三到五项由 NotificationDelivery 行回答),**刻意分成三个字段而不是一个总数**:
// "可见 100 人 / 绑定 8 人 / 已发过 3 人"和"要发 5 条"是完全不同的运营信号。
export interface WecomBroadcastAudience {
  visibleAudience: number;
  identityCandidates: number;
  alreadySent: number;
  memberIds: string[];
}

// Provider 前最终闸的四种结局(§10.4 步骤 9 逐条)。
// 用判别联合而不是 `null` + 布尔标志:调用方必须显式处理每一种,漏一种是编译错误。
export type WecomRecipientAuthorization =
  // 放行:wecomUserId 是**事务内快照**,Provider 在事务外只消费它,不得回读 destination。
  | { outcome: 'authorized'; wecomUserId: string; webBaseUrl: string | null }
  // 通道(总闸或二级闸)在 child 创建后被关掉 → 终态 skipped/channel-disabled,不迟到补发。
  | { outcome: 'channel-disabled' }
  // 身份在 child 创建后被撤销 / 换绑到别的 CorpID → 终态 skipped/no-wecom-identity。
  | { outcome: 'no-identity' }
  // 资格失效(退队 / 停用 / 撤权 / 通知被撤回或软删)→ effectPerformed=false,**不落 delivery**。
  | { outcome: 'ineligible' };

// 企业微信应用消息派发(T5B;冻结稿 §10.4)。
//
// **两阶段裁决**是本文件的中心思想,别把它压成一次判断:
//   阶段一(本文件 `resolveDurableBroadcastAudience`):发送前候选
//     = SRVF 当前合法受众 ∩ live ACTIVE User ∩ 合法 Member 准入 ∩ 当前 CorpID 的 active WecomIdentity
//   阶段二(企业微信 `message/send` 的逐人回执):可见范围与基础接口许可
// 第一版**不拉通讯录、不展开应用可见范围**,也没有接口能提前精确判断每个成员的接口许可 ——
// 所以覆盖率只能由回执事后裁决,不能预计算。想"提高覆盖率"而改用 toparty/totag 群发的念头,
// 见 §10.4 第 3 条:那等于绕过 SRVF 受众判断,是本设计明确禁止的。
//
// **本服务不负责**:身份绑定/撤销(归 auth/users)· token 与 HTTP(归 wecom Provider)·
// 消息文案(归 WecomMessagePresenter)· Outbox lease/ack/nack(归 worker)·
// 受众可见性与 RBAC 口径(归 notification-recipient-authorization,T5A)。
@Injectable()
export class NotificationWecomDispatchService {
  private readonly logger = new Logger(NotificationWecomDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly wecomSettings: WecomSettingsService,
  ) {}

  /**
   * 通道就绪闸(**第一层**,D-WC-24 两层判据的前一层)。
   *
   * publish 与 root 展开都先过这一层:关着就不产生任何 wecom intent —— 出厂默认
   * `enabled=false && messageEnabled=false`,所以"什么都没配"的仓库跑完全链一条消息也不会发。
   *
   * ⚠️ 这一层**不能替代**最终闸里的复判:两者之间隔着 intent 排队、worker claim、
   * 受众判定等一整段时间,运维完全可能在这中间把开关关掉。T3 的教训就是"两段式流程的
   * 后半段漏判开关"(bind 不碰通道层 ⇒ 关了 loginEnabled 仍能拿会话),这里不重蹈。
   */
  async resolveChannelReadiness(): Promise<WecomChannelReadiness> {
    const settings = await this.wecomSettings.getActiveSettings();
    if (settings === null) return { ready: false, corpId: null, webBaseUrl: null };
    const ready =
      settings.enabled &&
      settings.messageEnabled &&
      settings.corpId !== null &&
      settings.corpId !== '';
    return { ready, corpId: settings.corpId, webBaseUrl: settings.webBaseUrl };
  }

  /**
   * 广播根候选(§10.4「广播 root候选」六步)。
   *
   * 与冻结稿列出的步骤顺序有一处**有意差异**:冻结稿先按 identity 收窄再判可见性,本实现
   * 先算完整可见受众再与 identity 取交集。两者产出的 child 集合**逐字相同**(逐人过滤,
   * 交集可交换),但只有先算完整可见受众才拿得到运营指标①"SRVF 可见受众数" ——
   * §10.4 末条要求它与"active identity候选数"分开记录,而收窄之后这个数就永远算不出来了。
   */
  async resolveDurableBroadcastAudience(
    notification: Notification,
  ): Promise<WecomBroadcastAudience> {
    const empty: WecomBroadcastAudience = {
      visibleAudience: 0,
      identityCandidates: 0,
      alreadySent: 0,
      memberIds: [],
    };

    const readiness = await this.resolveChannelReadiness();
    if (!readiness.ready || readiness.corpId === null) return empty;

    // 定向通知不走广播 fan-out(收件人由 producer 显式指定,不过可见档)。
    if (notification.audienceType === NOTIFICATION_AUDIENCE_DIRECTED) return empty;

    // ① SRVF 当前合法受众(全体活跃 Member 过 T5A 判定)—— 运营指标①。
    const candidateMemberIds = (
      await this.prisma.member.findMany({
        where: notDeletedWhere({ status: MemberStatus.ACTIVE }),
        select: { id: true },
      })
    ).map((member) => member.id);
    if (candidateMemberIds.length === 0) return empty;

    const authorized = await authorizeBroadcastRecipients({
      client: this.prisma,
      rbac: this.rbac,
      notification,
      candidateMemberIds,
      // 渠道地址(wecomUserId)**刻意不在这里取**:D-WC-18 要求它不入 payload,
      // §10.4 步骤 8 要求它只从最终闸的事务内快照产生。这里取了就一定会有人顺手塞进 payload。
      loadActiveUsers: (client, activeMemberIds) =>
        client.user.findMany({
          where: notDeletedWhere({ memberId: { in: activeMemberIds }, status: UserStatus.ACTIVE }),
          select: { id: true, memberId: true, role: true },
        }),
    });
    const visibleMemberIds = authorized.map(({ memberId }) => memberId);
    if (visibleMemberIds.length === 0) return empty;

    // ② ∩ 当前 CorpID 下 active WecomIdentity(关联 live ACTIVE User 且 memberId 非空)—— 运营指标②。
    // 未绑定的人**不进入 fan-out**,也不按姓名/部门/标签补发(§10.4 业务结果第 1 条);
    // 他们的站内信可见性完全不受影响(§10.4 业务结果第 2 条)。
    const identityRows = await this.prisma.wecomIdentity.findMany({
      where: {
        corpId: readiness.corpId,
        status: WECOM_IDENTITY_STATUS.ACTIVE,
        user: notDeletedWhere({ status: UserStatus.ACTIVE, memberId: { in: visibleMemberIds } }),
      },
      select: { user: { select: { memberId: true } } },
    });
    const identityMemberIds = [
      ...new Set(
        identityRows.flatMap(({ user }) => (user.memberId === null ? [] : [user.memberId])),
      ),
    ];
    if (identityMemberIds.length === 0) {
      return { ...empty, visibleAudience: visibleMemberIds.length };
    }

    // ③ 减去本通知本渠道已 SENT 者。NotificationDelivery SENT 是**跨 generation 的永久去重事实**
    // (与微信侧同一条不变量):re-publish 不重复推同一个人。
    const sentRows = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_WECOM,
        status: DELIVERY_STATUS_SENT,
        memberId: { in: identityMemberIds },
      },
      select: { memberId: true },
    });
    const sent = new Set(sentRows.map((row) => row.memberId));

    return {
      visibleAudience: visibleMemberIds.length,
      identityCandidates: identityMemberIds.length,
      alreadySent: sent.size,
      memberIds: identityMemberIds.filter((memberId) => !sent.has(memberId)),
    };
  }

  /**
   * Provider 前最终闸(§10.4「Provider前最终闸」九步)。**必须在调用方已持有
   * Notification parent 与 outbox intent 锁的同一事务内调用**,故完整锁序为:
   *
   *   Notification(FOR SHARE) → outbox intent(FOR UPDATE) → Member → shared org topology
   *   → User(FOR SHARE) → RoleBinding/Role/Permission/RolePermission(FOR SHARE)
   *   → **wecom_identities(FOR SHARE)** → **wecom_settings(FOR SHARE)**
   *
   * 前六段逐字复用 T5A 的 `authorizeRecipientForEffect`(不抄第二份);本方法只追加
   * 企业微信自己的两段。两段都放在**最后**是刻意的:
   * - `wecom_settings` 的写路径(PATCH)只锁自己那一行、不持有任何本链上的锁,
   *   所以无论谁先拿到都不可能成环 —— 追加在尾部不引入新的死锁边。
   * - 放在尾部也让既有锁序前缀**逐字不变**,微信小程序与短信的既有 barrier 断言不受影响。
   *
   * 返回的 `wecomUserId` 是**锁内快照**;Provider 在事务外只消费这一份,不得回读 destination。
   */
  async authorizeDurableRecipient(
    tx: Prisma.TransactionClient,
    notification: Notification,
    memberId: string,
    now: Date = new Date(),
  ): Promise<WecomRecipientAuthorization> {
    // 步骤 2-6:Member / 组织 topology / live User / management RBAC / 共享可见性规则。
    const authorized = await authorizeRecipientForEffect(tx, notification, memberId, now);
    if (!authorized) return { outcome: 'ineligible' };

    // 步骤 7:锁当前 CorpID 下 active WecomIdentity。
    // 先读 settings 拿 corpId —— 但**判据**用的是下面锁后重读的那一份,不是这一份。
    const settings = await this.readLockedSettings(tx);
    if (settings === null || !settings.enabled || !settings.messageEnabled) {
      return { outcome: 'channel-disabled' };
    }
    if (settings.corpId === null || settings.corpId === '') {
      return { outcome: 'channel-disabled' };
    }

    const [identity] = await tx.$queryRaw<Array<{ wecomUserId: string }>>(Prisma.sql`
        SELECT "wecomUserId"
        FROM "wecom_identities"
        WHERE "userId" = ${authorized.user.id}
          AND "corpId" = ${settings.corpId}
          AND "status" = ${WECOM_IDENTITY_STATUS.ACTIVE}
        ORDER BY "id"
        FOR SHARE
      `);
    if (!identity) return { outcome: 'no-identity' };

    // 步骤 8:只把事务内快照交给事务外 Provider。
    return {
      outcome: 'authorized',
      wecomUserId: identity.wecomUserId,
      webBaseUrl: settings.webBaseUrl,
    };
  }

  /**
   * 通道开关的**锁后复读**(D-WC-24 两层判据的后一层)。
   *
   * `FOR SHARE` 而不是普通 SELECT 是整条防线的关键:settings 的写路径按本仓 S1 形状
   * 先 `FOR UPDATE` 再改(wecom 模块本地铁律 ②)。取共享锁之后,"运维把 messageEnabled 关掉"
   * 这件事要么排在我们提交之前(我们读到 false,不发),要么排在之后(我们读到 true 并发出去,
   * 而关闭动作对"已经决定要发的这一条"本来就不该追溯生效)。两种都线性化,没有中间态。
   *
   * 普通 SELECT 在 READ COMMITTED 下读的是语句开始时的快照 —— 关闭事务可能已提交而我们
   * 仍读到 true,于是"关掉开关"与"这条消息发出去"同时成立。这正是 M1–M6 复审里
   * write skew 那一类问题的形状。
   *
   * 跨模块直读 `wecom_settings` 是**刻意**的:最终闸的全部行锁必须落在同一个事务客户端上
   * (T5A 的 `authorizeRecipientForEffect` 同样直读 User / role_bindings / permissions 等
   * 他模块的表),回到 WecomSettingsService 就等于换了一个连接、丢掉整条锁序。
   */
  private async readLockedSettings(tx: Prisma.TransactionClient): Promise<{
    enabled: boolean;
    messageEnabled: boolean;
    corpId: string | null;
    webBaseUrl: string | null;
  } | null> {
    const [row] = await tx.$queryRaw<
      Array<{
        enabled: boolean;
        messageEnabled: boolean;
        corpId: string | null;
        webBaseUrl: string | null;
      }>
    >(Prisma.sql`
        SELECT "enabled", "messageEnabled", "corpId", "webBaseUrl"
        FROM "wecom_settings"
        ORDER BY "id"
        FOR SHARE
      `);
    return row ?? null;
  }

  /** 供 handler 记安全日志(不含 wecomUserId / token / URL)。 */
  logChannelEvent(operation: string, notificationId: string): void {
    this.logger.log(`wecom dispatch ${operation} notification=${notificationId}`);
  }
}

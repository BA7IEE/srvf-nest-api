import { Injectable } from '@nestjs/common';
import type { Prisma, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { maskPhone } from '../sms/sms.constants';

type PrismaTx = Prisma.TransactionClient;

/** 七个事件共用的调用者上下文(actor 快照 + 资源定位 + 请求 meta)。 */
export interface MemberAuditContext {
  memberId: string;
  currentUser: CurrentUserPayload;
  auditMeta: AuditMeta;
}

export interface OffboardAuditExtra {
  memberDeactivated: boolean;
  membershipsEnded: number;
  accountDisabled: boolean;
  refreshTokensRevoked: number;
  linkedUserId: string | null;
  positionAssignmentsRevoked: number;
  supervisionsRevoked: number;
  activityResponsibilitiesEnded: number;
  roleBindingsEnded: number;
  residualActivePositionAssignments: number;
  residualActiveSupervisions: number;
}

/**
 * 队员身份三元组快照(第七轮评审 R7-A-01)。
 *
 * `memberSinceDate` 取 ISO 8601 字符串而不是 `Date`:审计 payload 落 JSON,
 * 让**写入侧**决定表示法,读审计的人才不会看到同一字段一会儿是对象一会儿是串。
 * 取值与 `MemberResponseDto.memberSinceDate` 同一表示(已归一到北京日的 UTC 午夜)。
 */
export interface MemberIdentityFacts {
  memberNo: string;
  memberSinceDate: string;
  memberOriginCode: string;
}

export interface IdentityCorrectionAuditInput {
  before: MemberIdentityFacts;
  after: MemberIdentityFacts;
  /** 本次**真正发生变化**的字段名(before ≠ after 的那些);全部未变时调用方根本不会走到这里。 */
  changedFields: readonly string[];
  /** 订正理由,DTO 层已保证非空。 */
  reason: string;
}

export interface AudienceTagsAuditInput {
  beforeTagCodes: string[];
  afterTagCodes: string[];
  addedTagCodes: string[];
  removedTagCodes: string[];
}

/** 七个事件逐字相同的信封字段(event / before / after / extra / tx 由各方法自带)。 */
function envelope(ctx: MemberAuditContext) {
  return {
    actorUserId: ctx.currentUser.id,
    actorRoleSnap: ctx.currentUser.role,
    resourceType: 'member',
    resourceId: ctx.memberId,
    meta: ctx.auditMeta,
  } as const;
}

// Member audit assembly 单一职责类(Phase 6-B 第二刀;沿 attendances / activity-registrations
// 两个既有 recorder 的同一范式,docs/architecture-boundary.md §3.5)。
//
// - `@Injectable()` 仅注入 `AuditLogsService`;**不**持有 `PrismaService`
// - `tx` 由调用方($transaction 内)透传给 `auditLogs.log({ ..., tx })`;事务边界仍由
//   `MembersService` 持有,audit 写失败仍由 Prisma `$transaction` 隐式回滚
//
// **职责边界(严守"搬家不优化")**:
// (下面这条 ❌ 约束的是**当初搬进来的那六个事件**;R7-A-01 新增的
//  `identityCorrected` 是新事件,不在"不得增删字段"的冻结面内。)
// - ✅ 7 个事件的 `before` / `after` / `extra` payload 组装 + 手机号掩码
// - ❌ 不开事务 / 不读写业务表 / 不判权 / 不做状态跃迁判断
// - ❌ 不改 event 名、`resourceType`、`actorUserId` / `actorRoleSnap` / `meta`,
//      也不增删 `before` / `after` / `extra` 的任何字段名与取值
//
// ⚠️ 两条**不可弱化**的既有语义(module CLAUDE.md 第 4、6 条),抽出后逐字仍成立:
// - `member.account-reopened` 的 `extra.wecomIdentitiesRevoked` **恒写含 0**
//   (计数由调用方在同事务内从 `revokeActiveWecomIdentityInTx` 取得)
// - `member.account.status-change` 的 `before`/`after` **只含 status**,
//   `extra` **只含** linkedUserId / refreshTokensRevoked —— 禁 phone / openid / secret
@Injectable()
export class MemberAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async accountGranted(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: { userId: string; phone: string },
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.account-granted',
      ...envelope(ctx),
      extra: { memberId: ctx.memberId, userId: input.userId, phone: maskPhone(input.phone) },
      tx,
    });
  }

  async accountBound(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: { userId: string },
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.account-bound',
      ...envelope(ctx),
      extra: { memberId: ctx.memberId, userId: input.userId },
      tx,
    });
  }

  async accountUnbound(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: { userId: string },
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.account-unbound',
      ...envelope(ctx),
      extra: { memberId: ctx.memberId, userId: input.userId },
      tx,
    });
  }

  async accountReopened(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: {
      oldUserId: string;
      newUserId: string;
      phone: string;
      // T4 / 冻结稿 §11.3 末条:复用既有 umbrella 事件,extra 只加一个计数,
      // 不为撤销这条腿另造事件。恒写数值(含 0),与 refreshTokensRevoked 同型。
      wecomIdentitiesRevoked: number;
    },
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.account-reopened',
      ...envelope(ctx),
      extra: {
        memberId: ctx.memberId,
        oldUserId: input.oldUserId,
        newUserId: input.newUserId,
        phone: maskPhone(input.phone),
        wecomIdentitiesRevoked: input.wecomIdentitiesRevoked,
      },
      tx,
    });
  }

  async accountStatusChanged(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: {
      beforeStatus: UserStatus;
      afterStatus: UserStatus;
      linkedUserId: string;
      refreshTokensRevoked: number;
    },
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.account.status-change',
      ...envelope(ctx),
      before: { status: input.beforeStatus },
      after: { status: input.afterStatus },
      extra: { linkedUserId: input.linkedUserId, refreshTokensRevoked: input.refreshTokensRevoked },
      tx,
    });
  }

  async audienceTagsUpdated(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: AudienceTagsAuditInput,
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.audience-tags.update',
      ...envelope(ctx),
      before: { tagCodes: input.beforeTagCodes },
      after: { tagCodes: input.afterTagCodes },
      extra: {
        addedTagCodes: input.addedTagCodes,
        removedTagCodes: input.removedTagCodes,
      },
      tx,
    });
  }

  // 第七轮评审 R7-A-01:队员身份主档订正(memberNo / 发号日 / 来源)。
  //
  // before / after 恒写**完整身份三元组**,不只写改动的那一两个 —— 沿
  // `member.audience-tags.update` 已有的口径:before/after 是被改对象的全量状态,
  // extra 是 delta。只记改动项的话,这条审计行本身答不出「订正之后这个人的身份事实
  // 到底是什么」,而那正是事后回溯要问的第一个问题。
  //
  // extra.reason 是**必写**的:没有理由的订正,在审计里与直接改库等价 ——
  // 事后没人能分辨那是一次订正还是一次篡改。
  async identityCorrected(
    tx: PrismaTx,
    ctx: MemberAuditContext,
    input: IdentityCorrectionAuditInput,
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'member.identity.correct',
      ...envelope(ctx),
      before: { ...input.before },
      after: { ...input.after },
      extra: { changedFields: [...input.changedFields], reason: input.reason },
      tx,
    });
  }

  // 伞事件:一条 member.offboard,extra 记各腿实际发生计数。
  async offboard(tx: PrismaTx, ctx: MemberAuditContext, input: OffboardAuditExtra): Promise<void> {
    await this.auditLogs.log({
      event: 'member.offboard',
      ...envelope(ctx),
      extra: {
        memberDeactivated: input.memberDeactivated,
        membershipsEnded: input.membershipsEnded,
        accountDisabled: input.accountDisabled,
        refreshTokensRevoked: input.refreshTokensRevoked,
        linkedUserId: input.linkedUserId,
        positionAssignmentsRevoked: input.positionAssignmentsRevoked,
        supervisionsRevoked: input.supervisionsRevoked,
        activityResponsibilitiesEnded: input.activityResponsibilitiesEnded,
        roleBindingsEnded: input.roleBindingsEnded,
        residualActivePositionAssignments: input.residualActivePositionAssignments,
        residualActiveSupervisions: input.residualActiveSupervisions,
      },
      tx,
    });
  }
}

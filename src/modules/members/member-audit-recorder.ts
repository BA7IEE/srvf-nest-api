import { Injectable } from '@nestjs/common';
import type { Prisma, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { maskPhone } from '../sms/sms.constants';

type PrismaTx = Prisma.TransactionClient;

/** 六个事件共用的调用者上下文(actor 快照 + 资源定位 + 请求 meta)。 */
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

/** 六个事件逐字相同的信封字段(event / before / after / extra / tx 由各方法自带)。 */
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
// - ✅ 6 个事件的 `before` / `after` / `extra` payload 组装 + 手机号掩码
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

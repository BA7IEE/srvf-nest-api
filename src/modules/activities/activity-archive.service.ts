import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityArchivePolicy, type ActivityArchiveReasonCode } from './activity-archive-policy';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityStateMachine } from './activity-state-machine';
import { ActivitiesService } from './activities.service';
import { activitySafeSelect, type ActivityFullRow } from './activity-access.service';
import { canonicalize } from './settlement-content-hash';

/*
 * 活动归档 / 撤销归档(合同 §6.6 + AC-004 / AC-064;维护者 2026-08-25 拍板三问)。
 *
 * ## 与 activity-lifecycle.service.ts 的关系
 *
 * 逐字照抄它的 cancel / terminate 骨架:
 *   ① Activity `FOR UPDATE` 行锁(`lockActivityForLifecycle`,与全仓活动写路径同一把、同一序)
 *   ② 判权锚
 *   ③ **幂等重放先判**(排在状态闸与业务条件之前 —— 重放打过来时活动早已被推走,
 *      先判状态会把一次合法重放判成「状态不对」;与关账第 ② 步同一处置)
 *   ④ 状态机(能不能从这个态走这条边)
 *   ⑤ ActivityArchivePolicy(**量**够不够:两套开工条件)
 *   ⑥ `claimAtStatus` 条件锁 + update + audit,全在同一事务里
 *
 * 单开一个 service 而不是塞进 lifecycle:lifecycle 已 657 行且承载 cancel / terminate /
 * clone / seal 四族,再塞两族会把它推过尺寸棘轮;且归档有自己的 Policy 与自己的两条 unique。
 *
 * ## 🔴 本文件不做的事
 *
 * ❌ 不动关账 / 结算的任何既有语义(goal §10)。归档只读 `ActivitySettlementClosureRevision`,
 *    一行都不写它,也不碰 run / version / batch / seal。
 * ❌ 不新增权限码:沿用 App managed 生命周期族既有的
 *    `activity-responsibility.override.record` + responsibility scope,零 seed 改动。
 * ❌ 不给 `cancelled` 活动开归档口 —— 维护者只拍了两套条件,取消掉的活动两套都不属于。
 */

type PrismaTx = Prisma.TransactionClient;

export interface ActivityArchiveCommand {
  readonly operationKey: string;
  /** 归档说明;可选。撤销归档同形。 */
  readonly reason?: string;
}

export interface ActivityArchiveResult {
  activityId: string;
  /** archive ⇒ 恒 'archived';unarchive ⇒ 复原后的来源状态。 */
  statusCode: string;
  occurredAt: Date;
  /** archive ⇒ 走的哪套条件;unarchive ⇒ null。 */
  reasonCode: ActivityArchiveReasonCode | null;
  /** 归档前的状态。撤销后仍**保留**在库里(留痕不清空),故两个动作都能返回它。 */
  archivedFromStatusCode: string | null;
}

function buildArchiveRequestHash(
  action: 'archive' | 'unarchive',
  activityId: string,
  input: ActivityArchiveCommand,
): string {
  // 与 buildLifecycleRequestHash 同形:action / activityId 进 canonical payload,
  // 保证「归档」与「撤销归档」、不同活动不会把同一个 key 误判成同一请求。
  return createHash('sha256')
    .update(
      canonicalize({
        action,
        activityId,
        operationKey: input.operationKey,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
      'utf8',
    )
    .digest('hex');
}

@Injectable()
export class ActivityArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly stateMachine: ActivityStateMachine,
    private readonly archivePolicy: ActivityArchivePolicy,
    private readonly responsibilityPolicy: ActivityResponsibilityPolicy,
    private readonly auditRecorder: ActivityAuditRecorder,
  ) {}

  async archive(
    activityId: string,
    command: ActivityArchiveCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityArchiveResult> {
    const requestHash = buildArchiveRequestHash('archive', activityId, command);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.activities.lockActivityForLifecycle(activityId, tx);
        await this.assertArchiveAuthority(tx, current, user);

        const replay = await this.findArchiveReplay(tx, command.operationKey, requestHash);
        if (replay) return replay;

        const transition = this.stateMachine.decide('archive', current.statusCode);
        if (!transition.allowed) throw new BizException(transition.biz);

        // 🔴 两套开工条件在这里判,且**只在这里判**一次。
        //    now 取同事务 now() —— 用本机墙钟会让「等待期过没过」在重放时算出另一个答案。
        const now = await this.readAuthoritativeNow(tx);
        const decision = this.archivePolicy.decide({
          statusCode: current.statusCode,
          updatedAt: current.updatedAt,
          now,
          archiveWaitingDays: current.archiveWaitingDays,
          activeClosure: await this.readActiveClosure(tx, activityId),
        });
        if (!decision.allowed) throw new BizException(decision.biz);

        await claimAtStatus(tx, {
          target: 'activity',
          id: current.id,
          expectedStatus: current.statusCode,
          invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
        });
        const updated = await tx.activity.update({
          where: { id: current.id },
          data: {
            statusCode: transition.nextStatusCode,
            archivedAt: now,
            archivedByUserId: user.id,
            archivedFromStatusCode: current.statusCode,
            archiveReasonCode: decision.reasonCode,
            archiveOperationKey: command.operationKey,
            archiveRequestHash: requestHash,
          },
          select: activitySafeSelect,
        });
        await this.auditRecorder.logArchive({
          activityId: current.id,
          before: current,
          after: updated,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          priorStatusCode: current.statusCode,
          nextStatusCode: transition.nextStatusCode,
          archivedAt: now,
          archiveReasonCode: decision.reasonCode,
          auditMeta,
          tx,
        });
        if (updated.archivedAt === null) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        return {
          activityId: updated.id,
          statusCode: updated.statusCode,
          occurredAt: updated.archivedAt,
          reasonCode: decision.reasonCode,
          archivedFromStatusCode: updated.archivedFromStatusCode,
        };
      });
    } catch (error) {
      this.rethrowOperationKeyConflict(error);
    }
  }

  async unarchive(
    activityId: string,
    command: ActivityArchiveCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityArchiveResult> {
    const requestHash = buildArchiveRequestHash('unarchive', activityId, command);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.activities.lockActivityForLifecycle(activityId, tx);
        await this.assertArchiveAuthority(tx, current, user);

        const replay = await this.findUnarchiveReplay(tx, command.operationKey, requestHash);
        if (replay) return replay;

        // 复原目标只能来自归档时冻下来的事实;拿不到就拒(状态机内判,见其 unarchive 分支)。
        const transition = this.stateMachine.decide(
          'unarchive',
          current.statusCode,
          current.archivedFromStatusCode ?? undefined,
        );
        if (!transition.allowed) throw new BizException(transition.biz);

        const now = await this.readAuthoritativeNow(tx);
        await claimAtStatus(tx, {
          target: 'activity',
          id: current.id,
          expectedStatus: current.statusCode,
          invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
        });
        const updated = await tx.activity.update({
          where: { id: current.id },
          data: {
            statusCode: transition.nextStatusCode,
            unarchivedAt: now,
            unarchivedByUserId: user.id,
            unarchiveOperationKey: command.operationKey,
            unarchiveRequestHash: requestHash,
            // 🔴 **刻意不清空** archivedAt / archivedByUserId / archivedFromStatusCode /
            //    archiveReasonCode:清空就把「这个活动被归档过」这件事删了,
            //    而 DoD 恰恰要求「归过又撤过」查得出来。当前是否处于归档态由
            //    statusCode 单独承载,不靠这几列的有无去推。
          },
          select: activitySafeSelect,
        });
        await this.auditRecorder.logUnarchive({
          activityId: current.id,
          before: current,
          after: updated,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          priorStatusCode: current.statusCode,
          nextStatusCode: transition.nextStatusCode,
          unarchivedAt: now,
          auditMeta,
          tx,
        });
        if (updated.unarchivedAt === null) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        return {
          activityId: updated.id,
          statusCode: updated.statusCode,
          occurredAt: updated.unarchivedAt,
          reasonCode: null,
          archivedFromStatusCode: updated.archivedFromStatusCode,
        };
      });
    } catch (error) {
      this.rethrowOperationKeyConflict(error);
    }
  }

  /**
   * 判权锚。沿 `assertLifecycleAuthority` 的既定模型:草稿没有责任行,以**发起人**为锚;
   * 发布后及其余状态只认 active owner(或既有 override)。
   *
   * ⚠️ 归档态本身不带责任语义 ⇒ 锚取「**归档前**是什么」:一个被归档的草稿仍然只有
   * 发起人这一个锚,要求它有 owner 责任行会让草稿归档后**谁都撤不回来**。
   */
  private async assertArchiveAuthority(
    tx: PrismaTx,
    current: ActivityFullRow,
    user: CurrentUserPayload,
  ): Promise<void> {
    const anchorStatus =
      current.statusCode === 'archived'
        ? (current.archivedFromStatusCode ?? current.statusCode)
        : current.statusCode;
    if (anchorStatus === 'draft') {
      await this.responsibilityPolicy.assertInitiatorOrOverride(tx, current.id, user);
      return;
    }
    await this.responsibilityPolicy.assertOwnerOrOverride(tx, current.id, user);
  }

  /** 最新一张**生效** closure。沿全仓既有取法(statusCode='active' + revision desc)。 */
  private async readActiveClosure(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ closedAt: Date } | null> {
    return await tx.activitySettlementClosureRevision.findFirst({
      where: { activityId, statusCode: 'active' },
      orderBy: { revision: 'desc' },
      select: { closedAt: true },
    });
  }

  private async readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const now = rows[0]?.authoritativeNow;
    if (!now) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    return now;
  }

  private async findArchiveReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityArchiveResult | null> {
    const existing = await tx.activity.findUnique({
      where: { archiveOperationKey: operationKey },
      select: {
        id: true,
        statusCode: true,
        archivedAt: true,
        archiveReasonCode: true,
        archivedFromStatusCode: true,
        archiveRequestHash: true,
      },
    });
    if (!existing) return null;
    // 键在但事实对不上 ⇒ 冲突,不是重放。三种对不上:payload 变了 / 没归档成 /
    // **已经被撤销归档了**(此时 statusCode 已不是 archived)——最后一种正是
    // 「拿上一轮的 key 想再归档一次」,必须拒而不是静默再归一次。
    if (
      existing.archiveRequestHash !== requestHash ||
      existing.archivedAt === null ||
      existing.statusCode !== 'archived'
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    return {
      activityId: existing.id,
      statusCode: existing.statusCode,
      occurredAt: existing.archivedAt,
      reasonCode: (existing.archiveReasonCode as ActivityArchiveReasonCode | null) ?? null,
      archivedFromStatusCode: existing.archivedFromStatusCode,
    };
  }

  private async findUnarchiveReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityArchiveResult | null> {
    const existing = await tx.activity.findUnique({
      where: { unarchiveOperationKey: operationKey },
      select: {
        id: true,
        statusCode: true,
        unarchivedAt: true,
        archivedFromStatusCode: true,
        unarchiveRequestHash: true,
      },
    });
    if (!existing) return null;
    if (
      existing.unarchiveRequestHash !== requestHash ||
      existing.unarchivedAt === null ||
      existing.statusCode === 'archived'
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    return {
      activityId: existing.id,
      statusCode: existing.statusCode,
      occurredAt: existing.unarchivedAt,
      reasonCode: null,
      archivedFromStatusCode: existing.archivedFromStatusCode,
    };
  }

  private rethrowOperationKeyConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      this.isArchiveOperationKeyTarget(error.meta?.target)
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    throw error;
  }

  private isArchiveOperationKeyTarget(target: unknown): boolean {
    const text = Array.isArray(target)
      ? target.filter((item): item is string => typeof item === 'string').join(',')
      : typeof target === 'string'
        ? target
        : '';
    return (
      text.includes('activity_archive_operation_key_key') ||
      text.includes('activity_unarchive_operation_key_key') ||
      text.includes('archiveOperationKey') ||
      text.includes('unarchiveOperationKey')
    );
  }
}

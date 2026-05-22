import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// ActivityRegistration audit assembly 单一职责类(沿 PR #196 7 audit-shape + 1 rollback
// characterization cases 锁定的现状逐字抽出)。
//
// 与 attendances/attendance-audit-recorder.ts (PR #185) 范式一致:
// - `@Injectable()` 仅注入 `AuditLogsService`;**不**持有 `PrismaService`
// - `tx: PrismaTx` 由调用方($transaction 内)透传给 `auditLogs.log({ ..., tx })`;
//   事务边界仍由 `ActivityRegistrationsService` 持有,audit 写失败仍由 Prisma `$transaction`
//   隐式回滚(沿 D-S7 红线 + PR #196 state-transition F1 audit-failure-rollback case)
//
// **职责边界(严守"搬家不优化")**:
// - ✅ snapshot 组装(`toAuditSnapshot`)+ `jsonAsObject` JSON-safe 转换
// - ✅ `AuditLogsService.log()` payload assembly(6 处写路径,3 个 method 分组)
// - ❌ 不开事务 / 不读 DB / 不写业务表
// - ❌ 不做 state machine 判断 / 不做 capacity / unique / ownership / RBAC
// - ❌ 不改 audit event 名 / `resourceType` / `actorUserId` / `actorRoleSnap` / `meta` /
//      `before` / `after` / `extra` 字段名 / 字段值;沿 PR #196 audit-characterization
//      锁定的 6 路径形状逐字保留

type PrismaTx = Prisma.TransactionClient;

const AUDIT_RESOURCE_TYPE = 'activity_registration';

// 最小结构性输入类型(沿 PR #185 attendances recorder 范式;TypeScript structural typing
// 允许调用方传入更大的 payload 类型,如 service 内 `RegistrationFullRow` 含 id /
// createdAt / updatedAt 等额外字段)。本类型只声明 `toAuditSnapshot` 实际读取的 11 字段子集,
// 避免 service ↔ recorder 双向 import 类型。
type AuditRegistrationSnapshotInput = {
  activityId: string;
  memberId: string;
  statusCode: string;
  registeredAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  extras: Prisma.JsonValue | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
};

@Injectable()
export class ActivityRegistrationAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  // ============ snapshot helpers ============

  // 沿 service 原 `jsonAsObject` 字面值零变化(用于 `extras: Prisma.JsonValue | null` →
  // `Record<string, unknown> | null` 的强类型收窄)。
  private jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  // 沿 service 原 `toAuditSnapshot` 11 字段输出零变化(沿 PR #5 audit snapshot 字段集 =
  // registrationSafeSelect 剔除 id / createdAt / updatedAt;extras 经 `jsonAsObject` 收窄)。
  // Date 字段(`registeredAt` / `reviewedAt` / `cancelledAt`)由 Prisma JsonValue 写入时
  // 自动调 `Date.toJSON()` → ISO string,沿 PR #4 范式;此处不预先 `toISOString()`,
  // 以严格保持 PR #196 audit-characterization C1 / D1 / E1 / E2 / F1 case 的 before/after
  // 字段类型(spec 内多处 `Date | string | null` 联合,允许 Prisma 序列化层透出 Date 对象)。
  private toAuditSnapshot(row: AuditRegistrationSnapshotInput): Record<string, unknown> {
    return {
      activityId: row.activityId,
      memberId: row.memberId,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      extras: this.jsonAsObject(row.extras),
      cancelledByUserId: row.cancelledByUserId,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
    };
  }

  // ============ logCreate(create admin / createMy self 共用) ============
  // event: `registration.create`;
  // `before` absent;`after` = `toAuditSnapshot(created)`;
  // `extra` 4 字段:`{ operation: 'create', viaPath, activityId, targetMemberId }`
  // 沿 PR #196 audit-characterization A1 / B1 case 锁定形状。
  async logCreate(args: {
    created: AuditRegistrationSnapshotInput & { id: string };
    actorUserId: string;
    actorRoleSnap: Role;
    viaPath: 'admin' | 'self';
    activityId: string;
    targetMemberId: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'registration.create',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.created.id,
      meta: args.auditMeta,
      after: this.toAuditSnapshot(args.created),
      extra: {
        operation: 'create',
        viaPath: args.viaPath,
        activityId: args.activityId,
        targetMemberId: args.targetMemberId,
      },
      tx: args.tx,
    });
  }

  // ============ logReview(approve / reject 共用) ============
  // event: `registration.review`;
  // `before` = `toAuditSnapshot(before)`;`after` = `toAuditSnapshot(after)`;
  // `extra` 6 字段:`{ operation: 'review', action, priorStatusCode, nextStatusCode, activityId, targetMemberId }`
  // 沿 PR #196 audit-characterization C1 / D1 case 锁定形状。
  async logReview(args: {
    registrationId: string;
    before: AuditRegistrationSnapshotInput;
    after: AuditRegistrationSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    action: 'approve' | 'reject';
    priorStatusCode: string;
    nextStatusCode: string;
    activityId: string;
    targetMemberId: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'registration.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.registrationId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      after: this.toAuditSnapshot(args.after),
      extra: {
        operation: 'review',
        action: args.action,
        priorStatusCode: args.priorStatusCode,
        nextStatusCode: args.nextStatusCode,
        activityId: args.activityId,
        targetMemberId: args.targetMemberId,
      },
      tx: args.tx,
    });
  }

  // ============ logCancel(cancelAdmin / cancelMy 共用) ============
  // event: `registration.review`(与 review 共用同 event 名,沿现状);
  // `before` = `toAuditSnapshot(before)`;`after` = `toAuditSnapshot(after)`;
  // `extra` 8 字段:`{ operation: 'review', action: 'cancel', priorStatusCode, nextStatusCode,
  //   cancelledByPath, cancelReason, activityId, targetMemberId }`
  // 沿 PR #196 audit-characterization E1 / E2 / F1 case 锁定形状(含 `cancelReason: null` 边界)。
  async logCancel(args: {
    registrationId: string;
    before: AuditRegistrationSnapshotInput;
    after: AuditRegistrationSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    nextStatusCode: string;
    cancelledByPath: 'admin' | 'self';
    cancelReason: string | null;
    activityId: string;
    targetMemberId: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'registration.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.registrationId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      after: this.toAuditSnapshot(args.after),
      extra: {
        operation: 'review',
        action: 'cancel',
        priorStatusCode: args.priorStatusCode,
        nextStatusCode: args.nextStatusCode,
        cancelledByPath: args.cancelledByPath,
        cancelReason: args.cancelReason,
        activityId: args.activityId,
        targetMemberId: args.targetMemberId,
      },
      tx: args.tx,
    });
  }
}

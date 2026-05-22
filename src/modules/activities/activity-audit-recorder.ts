import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// Activity audit assembly 单一职责类(沿 PR #199 6 audit-shape + 1 rollback
// characterization cases 锁定的现状逐字抽出;PR #200 ActivityStateMachine 抽离后的状态)。
//
// 与 attendances/attendance-audit-recorder.ts (PR #185) +
// activity-registrations/activity-registration-audit-recorder.ts (PR #198) 范式一致:
// - `@Injectable()` 仅注入 `AuditLogsService`;**不**持有 `PrismaService`
// - `tx: PrismaTx` 由调用方($transaction 内)透传给 `auditLogs.log({ ..., tx })`;
//   事务边界仍由 `ActivitiesService` 持有,audit 写失败仍由 Prisma `$transaction`
//   隐式回滚(沿 D-S7 红线 + PR #199 state-transition F1 audit-failure-rollback case)
//
// **职责边界(严守"搬家不优化")**:
// - ✅ snapshot 组装(`toAuditSnapshot`)+ `jsonAsObject` / `jsonAsStringArray` /
//      `decimalToString` JSON-safe 转换(沿 PR #199 audit-characterization 6 case
//      锁定的字段输出零变化)
// - ✅ `AuditLogsService.log()` payload assembly(5 处写路径,5 个 method 分组)
// - ❌ 不开事务 / 不读 DB / 不写业务表
// - ❌ 不做 state machine 判断 / 不做 dictionary / organization / start-end 校验
// - ❌ 不改 audit event 名 / `resourceType` / `actorUserId` / `actorRoleSnap` / `meta` /
//      `before` / `after` / `extra` 字段名 / 字段值;沿 PR #199 audit-characterization
//      锁定的 5 路径形状逐字保留;event 名 5 处共用 `'activity.publish'` **不动**
//      (沿 batch3 草案 §20.2 A1 + `src/modules/audit-logs/audit-logs.types.ts:29` 有意设计)
//
// 注意:service 侧的 `jsonAsObject` / `jsonAsStringArray` / `decimalToString` **不能删**,
// `toResponseDto` / `toListItemDto` 仍依赖。recorder 内的 3 个 helper 是私有副本,
// 沿 PR #198 范式(同一字面逻辑在 recorder 内复制一份,避免 service ↔ recorder
// 双向依赖 + 避免抽出 common util grab-bag)。

type PrismaTx = Prisma.TransactionClient;

const AUDIT_RESOURCE_TYPE = 'activity';
const ACTIVITY_AUDIT_EVENT = 'activity.publish';

// 最小结构性输入类型(沿 PR #198 范式;TypeScript structural typing 允许调用方
// 传入更大的 payload 类型,如 service 内 `ActivityFullRow` 含 id / createdAt /
// updatedAt 等额外字段)。本类型只声明 `toAuditSnapshot` 实际读取的 24 字段子集,
// 避免 service ↔ recorder 双向 import 类型。
type AuditActivitySnapshotInput = {
  title: string;
  activityTypeCode: string;
  organizationId: string;
  startAt: Date;
  endAt: Date;
  location: string;
  description: string | null;
  capacity: number | null;
  genderRequirementCode: string | null;
  registrationDeadline: Date | null;
  registrationNotes: string | null;
  statusCode: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  isPublicRegistration: boolean;
  registrationSchema: Prisma.JsonValue | null;
  coverImageUrl: string | null;
  galleryImageUrls: Prisma.JsonValue | null;
  content: Prisma.JsonValue | null;
  locationLongitude: Prisma.Decimal | null;
  locationLatitude: Prisma.Decimal | null;
};

@Injectable()
export class ActivityAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  // ============ snapshot helpers(private;沿 service `toAuditSnapshot` 字面值零变化) ============

  // 沿 service 原 `decimalToString` 字面值零变化(Prisma.Decimal → string;null 透传)。
  private decimalToString(d: Prisma.Decimal | null): string | null {
    return d === null ? null : d.toString();
  }

  // 沿 service 原 `jsonAsObject` 字面值零变化(Prisma.JsonValue → Record<string, unknown> | null)。
  private jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  // 沿 service 原 `jsonAsStringArray` 字面值零变化(Prisma.JsonValue → string[] | null)。
  private jsonAsStringArray(v: Prisma.JsonValue | null): string[] | null {
    if (v === null || !Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === 'string');
  }

  // 沿 service 原 `toAuditSnapshot` 24 字段输出零变化(沿 PR #4 audit snapshot 字段集 =
  // `activitySafeSelect` 剔除 `id` / `createdAt` / `updatedAt`;Decimal 经 `decimalToString`,
  // Json 经 `jsonAsObject` / `jsonAsStringArray`)。
  //
  // Date 字段(`startAt` / `endAt` / `registrationDeadline` / `publishedAt` / `cancelledAt`)
  // 由 Prisma JsonValue 写入时自动调 `Date.toJSON()` → ISO string,沿 service 现状;
  // 此处**不**预先 `toISOString()`,以严格保持 PR #199 audit-characterization 6 case 的
  // before/after 字段类型(spec 内多处 `Date | string | null` 联合,允许 Prisma 序列化层
  // 透出 Date 对象)。
  private toAuditSnapshot(row: AuditActivitySnapshotInput): Record<string, unknown> {
    return {
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: row.capacity,
      genderRequirementCode: row.genderRequirementCode,
      registrationDeadline: row.registrationDeadline,
      registrationNotes: row.registrationNotes,
      statusCode: row.statusCode,
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
      cancelledBy: row.cancelledBy,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      isPublicRegistration: row.isPublicRegistration,
      registrationSchema: this.jsonAsObject(row.registrationSchema),
      coverImageUrl: row.coverImageUrl,
      galleryImageUrls: this.jsonAsStringArray(row.galleryImageUrls),
      content: this.jsonAsObject(row.content),
      locationLongitude: this.decimalToString(row.locationLongitude),
      locationLatitude: this.decimalToString(row.locationLatitude),
    };
  }

  // ============ logCreate(沿 PR #199 audit-characterization A1) ============
  // event: 'activity.publish';
  // before absent;after = toAuditSnapshot(created);
  // extra 2 字段:{ operation: 'create', nextStatusCode }
  async logCreate(args: {
    created: AuditActivitySnapshotInput & { id: string };
    actorUserId: string;
    actorRoleSnap: Role;
    nextStatusCode: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ACTIVITY_AUDIT_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.created.id,
      meta: args.auditMeta,
      after: this.toAuditSnapshot(args.created),
      extra: {
        operation: 'create',
        nextStatusCode: args.nextStatusCode,
      },
      tx: args.tx,
    });
  }

  // ============ logUpdate(沿 PR #199 audit-characterization B1) ============
  // event: 'activity.publish';
  // before + after = toAuditSnapshot(...);
  // extra 3 字段:{ operation: 'update', priorStatusCode, changedFields }
  // 注:`changedFields` 必须由 service 传入(`Object.keys(dto)`),recorder **不**自行推导,
  //     以保留 PR #199 B1 锁定的字段顺序(B1 case 锁 `['title', 'location']` 插入顺序)。
  async logUpdate(args: {
    activityId: string;
    before: AuditActivitySnapshotInput;
    after: AuditActivitySnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    changedFields: string[];
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ACTIVITY_AUDIT_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.activityId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      after: this.toAuditSnapshot(args.after),
      extra: {
        operation: 'update',
        priorStatusCode: args.priorStatusCode,
        changedFields: args.changedFields,
      },
      tx: args.tx,
    });
  }

  // ============ logSoftDelete(沿 PR #199 audit-characterization C1) ============
  // event: 'activity.publish';
  // before = toAuditSnapshot(current);after **absent**(沿 service line 546-556 现状);
  // extra 2 字段:{ operation: 'softDelete', priorStatusCode }
  async logSoftDelete(args: {
    activityId: string;
    before: AuditActivitySnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ACTIVITY_AUDIT_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.activityId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      extra: {
        operation: 'softDelete',
        priorStatusCode: args.priorStatusCode,
      },
      tx: args.tx,
    });
  }

  // ============ logPublish(沿 PR #199 audit-characterization D1) ============
  // event: 'activity.publish';
  // before + after = toAuditSnapshot(...);
  // extra 3 字段:{ operation: 'publish', priorStatusCode, nextStatusCode }
  async logPublish(args: {
    activityId: string;
    before: AuditActivitySnapshotInput;
    after: AuditActivitySnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    nextStatusCode: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ACTIVITY_AUDIT_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.activityId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      after: this.toAuditSnapshot(args.after),
      extra: {
        operation: 'publish',
        priorStatusCode: args.priorStatusCode,
        nextStatusCode: args.nextStatusCode,
      },
      tx: args.tx,
    });
  }

  // ============ logCancel(沿 PR #199 audit-characterization E1 / E2) ============
  // event: 'activity.publish';
  // before + after = toAuditSnapshot(...);
  // extra 4 字段:{ operation: 'cancel', priorStatusCode, nextStatusCode, cancelReason }
  // 注:`cancelReason` 必须由 service 已经处理过 `dto.cancelReason ?? null` 后传入(`string | null`)。
  //     E2 case 锁住 `cancelReason: null` 边界,**不能**让 recorder 把 null omit 成 undefined。
  async logCancel(args: {
    activityId: string;
    before: AuditActivitySnapshotInput;
    after: AuditActivitySnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    nextStatusCode: string;
    cancelReason: string | null;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ACTIVITY_AUDIT_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.activityId,
      meta: args.auditMeta,
      before: this.toAuditSnapshot(args.before),
      after: this.toAuditSnapshot(args.after),
      extra: {
        operation: 'cancel',
        priorStatusCode: args.priorStatusCode,
        nextStatusCode: args.nextStatusCode,
        cancelReason: args.cancelReason,
      },
      tx: args.tx,
    });
  }
}

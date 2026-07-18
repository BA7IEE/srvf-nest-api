import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// V2 第一阶段批次 6 attendance audit assembly 单一职责类(沿 PR #176 / #177 / #182 /
// PR #184 characterization 锁定的 8 处 audit 行为 + audit failure rollback 零变化抽出;
// v0.47.0 F2 additive 承接第 9 处 reopen audit;敏感读取统一批次再承接 3 处 read audit)。
//
// 三抽完成后(PR #178 ContributionCalculator / PR #180 TimeOverlapPolicy /
// PR #183 AttendanceSheetStateMachine),`attendances.service.ts` 剩余最大单一职责是
// audit snapshot / log payload assembly(~200/1270 LOC、写审计 + 敏感读审计、
// 2 个 snapshot helper)。本类极小抽出,只"搬家"不优化:
//
// **职责边界(严守"搬家不优化")**:
// - ✅ Sheet + Records audit snapshot 组装(ISO 8601 时间 / Decimal.toString)
// - ✅ AuditLogsService.log() payload assembly(8 处写路径)
// - ✅ sheet.previousSnapshot 业务列的 JSON-safe 快照(buildPreviousSnapshot;
//   与 audit snapshot 同源,沿原 buildSnapshot)
// - ❌ 不开事务 / 不持有 PrismaService / 不做 DB 查询 / 不写业务表
// - ❌ 不改 audit event / resourceType / resourceId / actor / meta
// - ❌ 不改 before / after / extra 字段语义;沿 8 路径现状逐字保留
//
// tx 由调用方($transaction 内)透传给 `auditLogs.log({ ..., tx })`;事务边界一致,
// audit 写失败仍由 PrismaService.$transaction 隐式回滚(沿 D-S7 红线 / PR #184
// D1 audit-failure-rollback 锁定)。

type PrismaTx = Prisma.TransactionClient;

const AUDIT_RESOURCE_TYPE = 'attendance_sheet';

// 最小结构性输入类型(沿 PR #178 / #180 / #183 范式);只声明 audit snapshot 真正读取的字段,
// 避免把 service 内 SheetSafeRow / RecordWithMemberRow / sheetFullSelect 等
// Prisma payload 类型从 service 大规模导出。
//
// Sheet 11 字段:sheetSafeSelect / sheetFullSelect 等 Prisma payload 的真子集;
// TypeScript 结构匹配允许调用方传更大的类型(payload 含 id / createdAt / updatedAt / previousSnapshot 等额外字段)。
type AuditSheetSnapshotInput = {
  activityId: string;
  submitterUserId: string;
  submittedAt: Date;
  statusCode: string;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  finalReviewerUserId: string | null;
  finalReviewedAt: Date | null;
  finalReviewNote: string | null;
  version: number;
};

// Record 10 字段:recordWithMemberSelect 的真子集(audit snapshot 不读 member / createdAt / updatedAt / sheetId)。
type AuditRecordSnapshotInput = {
  id: string;
  memberId: string;
  roleCode: string;
  checkInAt: Date;
  checkOutAt: Date;
  serviceHours: Prisma.Decimal;
  attendanceStatusCode: string;
  note: string | null;
  registrationId: string | null;
  contributionPoints: Prisma.Decimal | null;
};

@Injectable()
export class AttendanceAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  // ============ snapshot helpers ============

  // Sheet (+ optional Records) audit snapshot(沿原 `toSheetAuditSnapshot` 字段输出零变化)。
  // records 可选:approve / reject / finalApprove 只放 sheet 快照;
  // submit / edit / softDelete / finalReject 必传 records。
  private toSheetAuditSnapshot(
    sheet: AuditSheetSnapshotInput,
    records?: AuditRecordSnapshotInput[],
  ): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {
      sheet: {
        activityId: sheet.activityId,
        submitterUserId: sheet.submitterUserId,
        submittedAt: sheet.submittedAt.toISOString(),
        statusCode: sheet.statusCode,
        reviewerUserId: sheet.reviewerUserId,
        reviewedAt: sheet.reviewedAt?.toISOString() ?? null,
        reviewNote: sheet.reviewNote,
        finalReviewerUserId: sheet.finalReviewerUserId,
        finalReviewedAt: sheet.finalReviewedAt?.toISOString() ?? null,
        finalReviewNote: sheet.finalReviewNote,
        version: sheet.version,
      },
    };
    if (records !== undefined) {
      snapshot.records = records.map((r) => ({
        id: r.id,
        memberId: r.memberId,
        roleCode: r.roleCode,
        checkInAt: r.checkInAt.toISOString(),
        checkOutAt: r.checkOutAt.toISOString(),
        serviceHours: r.serviceHours.toString(),
        attendanceStatusCode: r.attendanceStatusCode,
        note: r.note,
        registrationId: r.registrationId,
        contributionPoints: this.decimalToString(r.contributionPoints),
      }));
    }
    return snapshot;
  }

  // Q-S16 `sheet.previousSnapshot` 业务列 JSON-safe 快照(沿原 `buildSnapshot` 字段输出零变化)。
  // 与 audit snapshot 同源(字段输出格式完全一致),供 service 在 edit 路径写入
  // `sheet.previousSnapshot` 业务列。
  buildPreviousSnapshot(
    sheet: AuditSheetSnapshotInput,
    records: AuditRecordSnapshotInput[],
  ): Record<string, unknown> {
    return this.toSheetAuditSnapshot(sheet, records);
  }

  private decimalToString(d: Prisma.Decimal | null): string | null {
    return d === null ? null : d.toString();
  }

  // ============ sensitive read ============
  // 读审计无业务事务可加入;调用方完成判权与全部业务查询后 await 本方法,再返回数据。
  async logRead(args: {
    actorUserId: string;
    actorRoleSnap: Role;
    resourceType: 'activity' | 'attendance_sheet';
    resourceId: string;
    operation: 'list' | 'detail' | 'review-detail';
    count?: number;
    filterFields?: string[];
    auditMeta: AuditMeta;
  }): Promise<void> {
    const extra: Record<string, unknown> = { operation: args.operation };
    if (args.count !== undefined) extra.count = args.count;
    if (args.filterFields !== undefined) extra.filterFields = args.filterFields;
    await this.auditLogs.log({
      event: 'attendance-sheet.read.other',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      meta: args.auditMeta,
      extra,
    });
  }

  // ============ submit ============
  // event: `attendance-sheet.submit`;after = sheet + records;extra 4 字段。
  async logSubmit(args: {
    sheetId: string;
    sheet: AuditSheetSnapshotInput;
    records: AuditRecordSnapshotInput[];
    actorUserId: string;
    actorRoleSnap: Role;
    activityId: string;
    recordsCount: number;
    activityPushedToCompleted: boolean;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.submit',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      after: this.toSheetAuditSnapshot(args.sheet, args.records),
      extra: {
        operation: 'submit',
        activityId: args.activityId,
        recordsCount: args.recordsCount,
        activityPushedToCompleted: args.activityPushedToCompleted,
      },
      tx: args.tx,
    });
  }

  // ============ edit (records 分支) ============
  // event: `attendance-sheet.edit`;operation: `'edit'`;
  // before = old sheet + old records;after = new sheet + new records;
  // extra 4 字段(无 recordsCount,与 no-records 分支区分)。
  async logEdit(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    beforeRecords: AuditRecordSnapshotInput[];
    afterSheet: AuditSheetSnapshotInput;
    afterRecords: AuditRecordSnapshotInput[];
    actorUserId: string;
    actorRoleSnap: Role;
    oldRecordsCount: number;
    newRecordsCount: number;
    newVersion: number;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.edit',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before: this.toSheetAuditSnapshot(args.beforeSheet, args.beforeRecords),
      after: this.toSheetAuditSnapshot(args.afterSheet, args.afterRecords),
      extra: {
        operation: 'edit',
        oldRecordsCount: args.oldRecordsCount,
        newRecordsCount: args.newRecordsCount,
        newVersion: args.newVersion,
      },
      tx: args.tx,
    });
  }

  // ============ edit (no-records 分支) ============
  // event: `attendance-sheet.edit`;operation: `'edit-no-records'`;
  // before / after 都包含同一份 records(records 不动;沿原 service 现状);
  // extra 3 字段(无 old/newRecordsCount)。
  async logEditNoRecords(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    afterSheet: AuditSheetSnapshotInput;
    records: AuditRecordSnapshotInput[];
    actorUserId: string;
    actorRoleSnap: Role;
    recordsCount: number;
    newVersion: number;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.edit',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before: this.toSheetAuditSnapshot(args.beforeSheet, args.records),
      after: this.toSheetAuditSnapshot(args.afterSheet, args.records),
      extra: {
        operation: 'edit-no-records',
        recordsCount: args.recordsCount,
        newVersion: args.newVersion,
      },
      tx: args.tx,
    });
  }

  // ============ softDelete ============
  // event: `attendance-sheet.delete`;
  // before = sheet + records;**无** after(沿原 service 现状);
  // extra 3 字段。
  async logDelete(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    beforeRecords: AuditRecordSnapshotInput[];
    actorUserId: string;
    actorRoleSnap: Role;
    priorStatusCode: string;
    recordsCount: number;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.delete',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before: this.toSheetAuditSnapshot(args.beforeSheet, args.beforeRecords),
      extra: {
        operation: 'delete',
        priorStatusCode: args.priorStatusCode,
        recordsCount: args.recordsCount,
      },
      tx: args.tx,
    });
  }

  // ============ approve / reject 共用 ============
  // event: `attendance-sheet.review`。
  // approve:before / after = sheet only;extra.recordsCount(records 不变)。
  // reject(F4 #399):records 跟随软删 → before = sheet + records 快照(对称 finalReject),
  //   extra.recordsCount = 被软删条数。
  async logReview(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    beforeRecords?: AuditRecordSnapshotInput[]; // reject only(F4:reject 软删 records,审计含软删前快照)
    afterSheet: AuditSheetSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    action: 'approve' | 'reject';
    priorStatusCode: string;
    nextStatusCode: string;
    recordsCount?: number;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    const extra: Record<string, unknown> = {
      operation: 'review',
      action: args.action,
      priorStatusCode: args.priorStatusCode,
      nextStatusCode: args.nextStatusCode,
    };
    if (args.recordsCount !== undefined) {
      extra.recordsCount = args.recordsCount;
    }
    const before =
      args.beforeRecords !== undefined
        ? this.toSheetAuditSnapshot(args.beforeSheet, args.beforeRecords)
        : this.toSheetAuditSnapshot(args.beforeSheet);
    await this.auditLogs.log({
      event: 'attendance-sheet.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before,
      after: this.toSheetAuditSnapshot(args.afterSheet),
      extra,
      tx: args.tx,
    });
  }

  // ============ finalApprove / finalReject 共用 ============
  // event: `attendance-sheet.final-review`。
  // finalApprove:before = sheet only;after = sheet only;extra 含 `eventTriggered`。
  // finalReject:before = sheet + records;after = sheet only;extra 含 `finalReviewNote`。
  async logFinalReview(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    beforeRecords?: AuditRecordSnapshotInput[]; // finalReject only(沿原 service 现状)
    afterSheet: AuditSheetSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    action: 'final-approve' | 'final-reject';
    priorStatusCode: string;
    nextStatusCode: string;
    recordsCount: number;
    eventTriggered?: boolean; // finalApprove only(沿原 service extra 仅 finalApprove 写)
    finalReviewNote?: string; // finalReject only(沿原 service extra 仅 finalReject 写)
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    const extra: Record<string, unknown> = {
      operation: 'final-review',
      action: args.action,
      priorStatusCode: args.priorStatusCode,
      nextStatusCode: args.nextStatusCode,
      recordsCount: args.recordsCount,
    };
    if (args.eventTriggered !== undefined) extra.eventTriggered = args.eventTriggered;
    if (args.finalReviewNote !== undefined) extra.finalReviewNote = args.finalReviewNote;

    const before =
      args.beforeRecords !== undefined
        ? this.toSheetAuditSnapshot(args.beforeSheet, args.beforeRecords)
        : this.toSheetAuditSnapshot(args.beforeSheet);

    await this.auditLogs.log({
      event: 'attendance-sheet.final-review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before,
      after: this.toSheetAuditSnapshot(args.afterSheet),
      extra,
      tx: args.tx,
    });
  }

  // ============ reopen ============
  // event: `attendance-sheet.reopen`;before / after 都含 Sheet + 未软删 Records 完整快照。
  async logReopen(args: {
    sheetId: string;
    beforeSheet: AuditSheetSnapshotInput;
    afterSheet: AuditSheetSnapshotInput;
    records: AuditRecordSnapshotInput[];
    actorUserId: string;
    actorRoleSnap: Role;
    reason: string;
    priorStatusCode: string;
    nextStatusCode: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.reopen',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: args.sheetId,
      meta: args.auditMeta,
      before: this.toSheetAuditSnapshot(args.beforeSheet, args.records),
      after: this.toSheetAuditSnapshot(args.afterSheet, args.records),
      extra: {
        operation: 'reopen',
        reason: args.reason,
        priorStatusCode: args.priorStatusCode,
        nextStatusCode: args.nextStatusCode,
        recordsCount: args.records.length,
      },
      tx: args.tx,
    });
  }
}

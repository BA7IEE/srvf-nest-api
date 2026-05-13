import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { eventPlaceholder } from '../../common/event/event-placeholder';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ApproveAttendanceSheetDto,
  ATTENDANCE_SHEET_STATUS,
  AttendanceMemberSummaryDto,
  AttendanceRecordInputDto,
  AttendanceRecordResponseDto,
  AttendanceSheetActivitySummaryDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  MyAttendanceRecordsQueryDto,
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';

// V2 第一阶段批次 3B attendances service(批次 4-B 升级:终审 / D14 预填 / D11 推动)。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §13 / §15 / §16 / §19
//   - 批次4_贡献值业务规则前评审决议表 v1.0(D5 候选 B 终审 / D11 推动 / D14 5.B 预填)
//   - 批次4_贡献值业务规则_schema草案评审决议表 v1.0(D-S5 / D-S6 / D-S7 / D-S8 / D-S10 / D-S11)
//   - 批次4_贡献值业务规则_API草案 v1.0(D-A1 ~ D-A13)
//   - 批次4_贡献值业务规则_实现前业务规则说明 v1.0
//
// 关键约定:
// - 状态机闭集 5 态(批次 4-B 扩展;沿 D-S6):
//   pending / pending_final_review / approved / rejected / final_rejected
//   字符串常量集中维护在 attendances.dto.ts 的 ATTENDANCE_SHEET_STATUS;
//   service 内部 SHEET_STATUS_* 别名仅作可读性兜底,**禁止**手写裸字符串。
//   其中 **approved 业务语义 = 终审通过**(从 v0.4.0 "APD 通过" 升级);
//   pending_final_review = APD 一级已审,等终审;
//   final_rejected = 终审驳回(终态,records 跟随软删,沿 D8 主路径)。
//   注:终审业务角色为"APD 部门部长 / 副部长",当前实装权限仍沿用管理权限
//   (ADMIN / SUPER_ADMIN),细分终审权限将在后续批次实现。
// - submit:事务内一次性 create Sheet + N records;activity statusCode != cancelled
//   批次 4-B 新增:**D14 5.B 系统预填** contributionPoints(根据 ContributionRule 查表)+
//   **D11 推动** Activity.statusCode = 'completed'(若当前 published)。
// - edit:仅 pending → pending;后端生成 previousSnapshot(R28 / Q-S16);version+1;
//   旧 records 软删 + 新 records 创建(D38);重跑全部校验。
//   批次 4-B:pending_final_review / final_rejected 也不可 edit(沿 22030 / 22043)。
// - delete:仅 pending → 软删 + 级联软删 records(R20)
// - approve(APD 一级):**批次 4-B 升级:pending → pending_final_review**(从 v0.4.0 → approved 升级);
//   所有 records.contributionPoints 必填(R31,沿 D-S8 在 APD approve 时校验);
//   写 reviewerUserId/At/Note;**不再触发** attendance.recorded(沿 D-S7);触发位置移到 final-approve。
// - reject(APD 一级):仅 pending → rejected;reviewNote 必填
// - final-approve(批次 4-B 新增,沿 D-S5):pending_final_review → approved;
//   写 finalReviewer*;**同事务内触发** eventPlaceholder('attendance.recorded')(沿 D-S7);
//   audit:attendance-sheet.final-review。终审不重校验逐条 records(沿 D-S8)。
// - final-reject(批次 4-B 新增,沿 D-S5):pending_final_review → final_rejected;
//   finalReviewNote 必填(22046);records 跟随软删;**不触发** attendance.recorded(沿 D-S7);
//   audit:attendance-sheet.final-review。
// - 时间不重叠:同 memberId × [checkInAt, checkOutAt) 左闭右开;跨 Sheet / 跨 Activity 全局
//   (R16 / Q-S15);service 层校验(不做 PG EXCLUDE 约束)
// - serviceHours:未传自动 (checkOutAt-checkInAt)/3600;>0 且 ≤ 跨度(D14 / D45 / D51 / D46)
// - contributionPoints(批次 4-B 升级):**仅在 record.contributionPoints === null 时**由 ContributionRule
//   预填;调用方传值不覆盖(沿 D-A8)。无匹配规则时 service 兜底 null(不抛错;沿 D-S11 22048 不开)。
// - registrationId 跨表:非空时 registration.activityId === sheet.activityId(R23)
// - registrationId Restrict:删除 registration 时被 FK 阻断(Q-S21;不破坏历史追溯)
// - audit:submit / edit / delete / read.other / review(approve+reject) / final-review(批次 4-B)
// - event:**attendance.recorded 触发位置移到 final-approve**(沿 D-S7);submit / edit / delete /
//   approve / reject / final-reject 均不触发。
//
// V2 批次 6 PR #6(第二波最后一批):8 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;5 个事件名(`attendance-sheet.{submit, edit, delete, review, final-review}`)
// 共承担 8 处 operation,通过 `extra.operation` / `extra.action` 区分(沿 PR #4 / PR #5 范式,
// D2 同值挪字符串);resourceType 固定 `attendance_sheet`;**3 处 read.other 调用保持 pino-only
// 不迁移**(沿 Q1=A 当前阶段不记录查看行为);**`eventPlaceholder('attendance.recorded')` 与
// audit 是两套独立机制,不动**(沿 D-S7;final-approve 同事务触发业务事件,audit 同事务记录;
// 若 audit 写失败 → 整个事务回滚 → 业务事件随之回滚,由 DB 事务原子性保证)。
// records 全字段快照入 audit context:submit / edit × 2 / softDelete / finalReject 必含;
// approve / reject / finalApprove 只放 sheet 快照,`extra.recordsCount` 元数据(records 不变,
// 通过 sheet.previousSnapshot 或 finalReject 的 records 软删时间回溯)。
// 字段非敏感(打码矩阵未命中,沿 PR #3 / PR #4 / PR #5 不打码范式)。

const ACTIVITY_STATUS_PUBLISHED = 'published';
const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const ACTIVITY_STATUS_COMPLETED = 'completed';

// Sheet 状态机闭集别名(单一来源:ATTENDANCE_SHEET_STATUS,定义在 attendances.dto.ts)。
const SHEET_STATUS_PENDING = ATTENDANCE_SHEET_STATUS.PENDING;
const SHEET_STATUS_PENDING_FINAL_REVIEW = ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW;
const SHEET_STATUS_APPROVED = ATTENDANCE_SHEET_STATUS.APPROVED;
const SHEET_STATUS_REJECTED = ATTENDANCE_SHEET_STATUS.REJECTED;
const SHEET_STATUS_FINAL_REJECTED = ATTENDANCE_SHEET_STATUS.FINAL_REJECTED;

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const DICT_TYPE_ATTENDANCE_STATUS = 'attendance_status';
const AUDIT_RESOURCE_TYPE = 'attendance_sheet';

// Sheet 简化 select(不含 records 数组 + 不含 previousSnapshot)。
// 批次 4-B 新增 finalReviewer* 3 字段(D-S5;UserResponseDto 同步,沿 baseline §11.3 可选字段)。
const sheetSafeSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNote: true,
  finalReviewerUserId: true,
  finalReviewedAt: true,
  finalReviewNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// Sheet 列表精简 select。
const sheetListSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewedAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// Record + Member 嵌套 select(review-detail / /me 列表共用)。
const recordWithMemberSelect = {
  id: true,
  sheetId: true,
  memberId: true,
  roleCode: true,
  checkInAt: true,
  checkOutAt: true,
  serviceHours: true,
  attendanceStatusCode: true,
  note: true,
  registrationId: true,
  contributionPoints: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      memberNo: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.AttendanceRecordSelect;

// Sheet 完整 select(含 previousSnapshot,用于 edit 事务内读取上一版本快照)。
const sheetFullSelect = {
  ...sheetSafeSelect,
  previousSnapshot: true,
  activityId: true,
} as const satisfies Prisma.AttendanceSheetSelect;

type SheetSafeRow = Prisma.AttendanceSheetGetPayload<{ select: typeof sheetSafeSelect }>;
type SheetListRow = Prisma.AttendanceSheetGetPayload<{ select: typeof sheetListSelect }>;
type RecordWithMemberRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof recordWithMemberSelect;
}>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class AttendancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers:序列化 ============

  private decimalToString(d: Prisma.Decimal | null): string | null {
    return d === null ? null : d.toString();
  }

  private toSheetResponseDto(row: SheetSafeRow): AttendanceSheetResponseDto {
    return {
      id: row.id,
      activityId: row.activityId,
      submitterUserId: row.submitterUserId,
      submittedAt: row.submittedAt,
      statusCode: row.statusCode,
      reviewerUserId: row.reviewerUserId,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      finalReviewerUserId: row.finalReviewerUserId,
      finalReviewedAt: row.finalReviewedAt,
      finalReviewNote: row.finalReviewNote,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toSheetListItemDto(row: SheetListRow): AttendanceSheetListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      submitterUserId: row.submitterUserId,
      submittedAt: row.submittedAt,
      statusCode: row.statusCode,
      reviewedAt: row.reviewedAt,
      version: row.version,
      createdAt: row.createdAt,
    };
  }

  private toRecordResponseDto(row: RecordWithMemberRow): AttendanceRecordResponseDto {
    return {
      id: row.id,
      sheetId: row.sheetId,
      memberId: row.memberId,
      member: row.member
        ? ({
            id: row.member.id,
            memberNo: row.member.memberNo,
            displayName: row.member.displayName,
          } satisfies AttendanceMemberSummaryDto)
        : null,
      roleCode: row.roleCode,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      serviceHours: row.serviceHours.toString(),
      attendanceStatusCode: row.attendanceStatusCode,
      note: row.note,
      registrationId: row.registrationId,
      contributionPoints: this.decimalToString(row.contributionPoints),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ============ helpers:字典校验 ============

  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx: PrismaTx,
  ): Promise<void> {
    const item = await tx.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // ============ helpers:Activity / Sheet / Member 查找 ============

  // 批次 4-B 重构:findActivityForSubmission 旧版返回 {id, statusCode} 已被 findActivityForSubmissionFull
  // (返回 {id, statusCode, activityTypeCode})替代,用于 D14 预填 + D11 推动;旧函数删除。

  private async assertActivityExists(activityId: string, tx: PrismaTx): Promise<void> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async assertMemberExists(memberId: string, tx: PrismaTx): Promise<void> {
    const m = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  // R23 跨表校验:registrationId 非空时 registration.activityId === sheet.activityId。
  // 找不到 registration → MISMATCH(沿 §1.7 风格,USER 越权一律 mismatch / 404)。
  private async assertRegistrationMatchesActivity(
    registrationId: string,
    activityId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const reg = await tx.activityRegistration.findFirst({
      where: notDeletedWhere({ id: registrationId }),
      select: { activityId: true },
    });
    if (!reg || reg.activityId !== activityId) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    }
  }

  // 找 Sheet 完整数据(含 previousSnapshot,用于 edit 路径)。
  private async findSheetOrThrow(
    id: string,
    tx: PrismaTx,
  ): Promise<Prisma.AttendanceSheetGetPayload<{ select: typeof sheetFullSelect }>> {
    const sheet = await tx.attendanceSheet.findFirst({
      where: notDeletedWhere({ id }),
      select: sheetFullSelect,
    });
    if (!sheet) throw new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    return sheet;
  }

  // 队员端 currentUser → memberId(沿批次 3A `resolveUserMemberIdOrThrow` 范式)。
  private async resolveUserMemberIdOrThrow(userId: string, tx: PrismaTx): Promise<string> {
    const u = await tx.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    if (!u || u.memberId === null) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    return u.memberId;
  }

  // ============ helpers:Record 字段计算 / 校验 ============

  // 计算服务时长(小时,Decimal(5,2) 精度);D14 / D45 / D46 / D51。
  private spanHours(checkInAt: Date, checkOutAt: Date): number {
    const ms = checkOutAt.getTime() - checkInAt.getTime();
    return Math.round((ms / 3_600_000) * 100) / 100; // 保留 2 位小数
  }

  // 规范化一条 record:校验时间 + 自动计算 / 校验 serviceHours。
  // 返回 normalize 后的入库形态(serviceHours 显式 number,后续在创建时转 Decimal)。
  //
  // contributionPoints 入参三态(沿 D-A8 / D14 5.B):
  //   omit / undefined → normalized 为 undefined → 走 ContributionRule 系统预填
  //   显式 null        → normalized 为 null      → 跳过预填,落库为 null,APD 在 approve 前现场填入
  //   number           → normalized 为 number    → 调用方已传值,不预填,不覆盖
  private normalizeRecord(input: AttendanceRecordInputDto): {
    memberId: string;
    roleCode: string;
    checkInAt: Date;
    checkOutAt: Date;
    serviceHours: number;
    attendanceStatusCode: string;
    note: string | null;
    registrationId: string | null;
    contributionPoints: number | null | undefined;
  } {
    const checkInAt = new Date(input.checkInAt);
    const checkOutAt = new Date(input.checkOutAt);
    if (!(checkOutAt.getTime() > checkInAt.getTime())) {
      throw new BizException(BizCode.CHECK_OUT_BEFORE_CHECK_IN);
    }
    const spanHours = this.spanHours(checkInAt, checkOutAt);

    let serviceHours: number;
    if (input.serviceHours === undefined) {
      serviceHours = spanHours;
      if (serviceHours <= 0) {
        // 极端罕见:跨度极短,四舍五入到 0;视作 invalid
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
      }
    } else {
      serviceHours = input.serviceHours;
      if (serviceHours <= 0) {
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
      }
      if (serviceHours > spanHours) {
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
      }
    }

    return {
      memberId: input.memberId,
      roleCode: input.roleCode,
      checkInAt,
      checkOutAt,
      serviceHours,
      attendanceStatusCode: input.attendanceStatusCode,
      note: input.note ?? null,
      registrationId: input.registrationId ?? null,
      // 保留三态:undefined / null / number;由 applyContributionRulePrefill 区分处理。
      contributionPoints: input.contributionPoints,
    };
  }

  // 时间不重叠校验(R16 / Q-S15):同 memberId × [checkInAt, checkOutAt) 左闭右开
  // 跨 Sheet / 跨 Activity 全局,deletedAt IS NULL。
  // excludeSheetId:edit 时排除旧 Sheet 的 records(因为它们将被替换)。
  private async assertNoTimeOverlap(
    memberId: string,
    checkInAt: Date,
    checkOutAt: Date,
    excludeSheetId: string | undefined,
    tx: PrismaTx,
  ): Promise<void> {
    const conflicts = await tx.attendanceRecord.findMany({
      where: notDeletedWhere({
        memberId,
        ...(excludeSheetId !== undefined ? { sheetId: { not: excludeSheetId } } : {}),
        AND: [{ checkInAt: { lt: checkOutAt } }, { checkOutAt: { gt: checkInAt } }],
      }),
      select: { id: true },
      take: 1,
    });
    if (conflicts.length > 0) {
      throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
    }
  }

  // 同一 records 数组内自检不重叠(R16:同 batch 也不能内部冲突)。
  private assertNoInternalOverlap(
    records: ReturnType<AttendancesService['normalizeRecord']>[],
  ): void {
    const byMember = new Map<string, Array<{ start: number; end: number }>>();
    for (const r of records) {
      const arr = byMember.get(r.memberId) ?? [];
      const start = r.checkInAt.getTime();
      const end = r.checkOutAt.getTime();
      for (const e of arr) {
        if (start < e.end && end > e.start) {
          throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
        }
      }
      arr.push({ start, end });
      byMember.set(r.memberId, arr);
    }
  }

  // ============ submit(POST 提交 Sheet)============

  // 批次 4-B 升级:
  // - D14 5.B 系统预填 contributionPoints(若 record 未传值;沿 D-A8)
  //   规则匹配维度:activityType × attendanceRole × durationThreshold;
  //   NULL durationThreshold 多条规则按 createdAt ASC LIMIT 1(明确选取策略,沿 §3.1 复核报告);
  //   无匹配规则 → service 兜底 null,不抛错(沿 D-S11 22048 不开)。
  // - D11 推动:Activity.statusCode = 'published' → 'completed'(沿 D-S10);
  //   多 Sheet 场景下,后续 Sheet 创建时已是 completed,update 不再生效(幂等)。
  async submit(
    activityId: string,
    dto: CreateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // 1. activity 存在 + 非 cancelled;同时取 activityTypeCode + statusCode 用于 D14 预填 + D11 推动
      const activity = await this.findActivityForSubmissionFull(activityId, tx);

      // 2. 逐条 record 字典校验 + 时间规范化 + serviceHours 校验
      const normalized: ReturnType<AttendancesService['normalizeRecord']>[] = [];
      for (const input of dto.records) {
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_ROLE,
          input.roleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          tx,
        );
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_STATUS,
          input.attendanceStatusCode,
          BizCode.ATTENDANCE_STATUS_CODE_INVALID,
          tx,
        );
        await this.assertMemberExists(input.memberId, tx);
        if (input.registrationId !== undefined) {
          await this.assertRegistrationMatchesActivity(input.registrationId, activityId, tx);
        }
        normalized.push(this.normalizeRecord(input));
      }

      // 3. 数组内部时间不重叠 + 与已有跨 Sheet 全局不重叠
      this.assertNoInternalOverlap(normalized);
      for (const r of normalized) {
        await this.assertNoTimeOverlap(r.memberId, r.checkInAt, r.checkOutAt, undefined, tx);
      }

      // 4. D14 5.B 预填:仅当 record.contributionPoints === null 时按规则查表预填;
      //    传值不覆盖(沿 D-A8);无匹配规则保持 null。
      const prefilled = await this.applyContributionRulePrefill(
        normalized,
        activity.activityTypeCode,
        tx,
      );

      // 5. 事务内一次性 create Sheet + N records
      const created = await tx.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: currentUser.id,
          statusCode: SHEET_STATUS_PENDING,
          version: 1,
          records: {
            create: prefilled.map((r) => ({
              memberId: r.memberId,
              roleCode: r.roleCode,
              checkInAt: r.checkInAt,
              checkOutAt: r.checkOutAt,
              serviceHours: r.serviceHours,
              attendanceStatusCode: r.attendanceStatusCode,
              note: r.note,
              registrationId: r.registrationId,
              contributionPoints: r.contributionPoints,
            })),
          },
        },
        select: sheetSafeSelect,
      });

      // 6. D11 推动:首张 Sheet 创建 → Activity.completed(沿 D-S10);
      //    幂等:若已是 completed,update 不会改 statusCode(但走一次写减少负担,故先判定 published 才动)。
      //    cancelled 在 step 1 已拒绝;publish 状态机 draft → published → completed 单向。
      const activityPushedToCompleted = activity.statusCode === ACTIVITY_STATUS_PUBLISHED;
      if (activityPushedToCompleted) {
        await tx.activity.update({
          where: { id: activityId },
          data: { statusCode: ACTIVITY_STATUS_COMPLETED },
        });
      }

      // PR #6 audit:after 含 sheet + records 完整快照(records 创建后回查一次取完整字段)
      const createdRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: created.id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      await this.auditLogs.log({
        event: 'attendance-sheet.submit',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta: auditMeta,
        after: this.toSheetAuditSnapshot(created, createdRecords),
        extra: {
          operation: 'submit',
          activityId,
          recordsCount: createdRecords.length,
          activityPushedToCompleted,
        },
        tx,
      });

      return this.toSheetResponseDto(created);
    });
  }

  // 批次 4-B 新增:findActivityForSubmissionFull,返回 activityTypeCode + statusCode(用于 D14 + D11)。
  // 与 findActivityForSubmission 复用 22001 / 20122 校验路径,只是 select 字段更多。
  private async findActivityForSubmissionFull(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; statusCode: string; activityTypeCode: string }> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true, statusCode: true, activityTypeCode: true },
    });
    if (!act) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    if (act.statusCode === ACTIVITY_STATUS_CANCELLED) {
      throw new BizException(BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    }
    return act;
  }

  // 批次 4-B 新增:D14 5.B 预填(沿 D-S4 / D-A8 / 业务规则文档 §4)。
  // 输入:normalized records + activityTypeCode;
  // 输出:applied records(contributionPoints 已按规则预填或保持调用方传入值)。
  //
  // 入参三态处理(沿 D-A8 + v0.6 契约小修复):
  //   undefined → 走预填(匹配规则取值;无匹配规则 → null)
  //   null      → 调用方显式清空,跳过预填,保持 null(APD 在 approve 前现场填入)
  //   number    → 调用方已传值,不覆盖
  //
  // 规则匹配维度:
  //   (activityTypeCode, attendanceRoleCode, durationThreshold) WHERE deletedAt IS NULL AND status='ACTIVE'
  // 服务时长档位(若规则 durationThreshold 非 null):
  //   record.serviceHours <= rule.durationThreshold → 取 rule.pointsBelow
  //   record.serviceHours >  rule.durationThreshold → 取 rule.pointsAbove ?? pointsBelow
  // 服务时长无档位(rule.durationThreshold === null):
  //   直接取 rule.pointsBelow(pointsAbove 不参与)
  // 每日上限:rule.dailyCap 兜底 1.5(沿 Q-OPEN-7 / D-S3);
  //   预填值 = MIN(candidatePoints, effectiveDailyCap)。
  //
  // NULL durationThreshold 选取(沿 §3.1 复核报告):
  //   ORDER BY createdAt ASC LIMIT 1(明确,不随机)。
  //   TODO(批次 4.x 或后续):若运营后台引入多条 NULL durationThreshold ACTIVE 规则,
  //   考虑加 service 兜底校验或 BizCode;当前批次只取首条不阻塞创建。
  //
  // 无匹配规则:保持 contributionPoints = null(不抛错;沿 D-S11 22048 不开)。
  private async applyContributionRulePrefill(
    records: ReturnType<AttendancesService['normalizeRecord']>[],
    activityTypeCode: string,
    tx: PrismaTx,
  ): Promise<ReturnType<AttendancesService['normalizeRecord']>[]> {
    const result: ReturnType<AttendancesService['normalizeRecord']>[] = [];
    for (const r of records) {
      // 显式 null = 跳过预填(v0.6 契约小修复);number = 已传值,不覆盖
      if (r.contributionPoints !== undefined) {
        result.push(r);
        continue;
      }
      // undefined = 走预填
      const points = await this.computePrefilledPoints(
        activityTypeCode,
        r.roleCode,
        r.serviceHours,
        tx,
      );
      result.push({ ...r, contributionPoints: points });
    }
    return result;
  }

  // 默认日上限 1.5(沿 Q-OPEN-7 锁定;ContributionRule.dailyCap === null 时兜底)。
  private readonly DEFAULT_DAILY_CAP = 1.5;

  private async computePrefilledPoints(
    activityTypeCode: string,
    attendanceRoleCode: string,
    serviceHours: number,
    tx: PrismaTx,
  ): Promise<number | null> {
    const candidates = await tx.contributionRule.findMany({
      where: {
        activityTypeCode,
        attendanceRoleCode,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: {
        durationThreshold: true,
        pointsBelow: true,
        pointsAbove: true,
        dailyCap: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) {
      return null;
    }
    // 优先匹配 record.serviceHours 落入档位的规则;若多条候选(同维度多规则)按 createdAt ASC 取首条。
    // 实际唯一约束(partial unique)已限制非 NULL durationThreshold 唯一;NULL 档位可能多条,沿 §3.1 复核取首条。
    let chosen: (typeof candidates)[number] | null = null;
    for (const rule of candidates) {
      if (rule.durationThreshold === null) {
        // NULL 档位:无服务时长阈值,优先取首条;若 chosen 未设则赋值
        if (chosen === null) chosen = rule;
        continue;
      }
      // 非 NULL 档位:按 durationThreshold 匹配;首条匹配即取
      if (chosen === null) chosen = rule;
    }
    if (chosen === null) {
      chosen = candidates[0];
    }
    const threshold = chosen.durationThreshold;
    let candidatePoints: number;
    if (threshold === null) {
      candidatePoints = Number(chosen.pointsBelow);
    } else if (serviceHours <= Number(threshold)) {
      candidatePoints = Number(chosen.pointsBelow);
    } else {
      candidatePoints =
        chosen.pointsAbove !== null ? Number(chosen.pointsAbove) : Number(chosen.pointsBelow);
    }
    const effectiveCap =
      chosen.dailyCap !== null ? Number(chosen.dailyCap) : this.DEFAULT_DAILY_CAP;
    const finalPoints = Math.min(candidatePoints, effectiveCap);
    // 保留 2 位小数(对齐 Decimal(5,2))
    return Math.round(finalPoints * 100) / 100;
  }

  // ============ list(GET 列表)============

  async list(
    activityId: string,
    query: ListAttendanceSheetsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertActivityExists(activityId, tx);
    });

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.AttendanceSheetWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceSheet.findMany({
        where,
        select: sheetListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceSheet.count({ where }),
    ]);

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      activityId,
      operation: 'list',
      rowsCount: rows.length,
    });

    return {
      items: rows.map((r) => this.toSheetListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ findOne(GET Sheet 简化详情)============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<AttendanceSheetResponseDto> {
    const sheet = await this.prisma.$transaction(async (tx) => this.findSheetOrThrow(id, tx));

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      sheetId: id,
      operation: 'detail',
    });

    return this.toSheetResponseDto(sheet);
  }

  // ============ reviewDetail(GET 完整审核视图;R25)============

  async reviewDetail(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetReviewDetailDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const activity = await tx.activity.findFirst({
        where: notDeletedWhere({ id: sheet.activityId }),
        select: {
          id: true,
          title: true,
          activityTypeCode: true,
          organizationId: true,
          startAt: true,
          endAt: true,
          location: true,
          statusCode: true,
        },
      });
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const records = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      return { sheet, activity, records };
    });

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      sheetId: id,
      operation: 'review-detail',
    });

    return {
      activity: result.activity satisfies AttendanceSheetActivitySummaryDto,
      sheet: this.toSheetResponseDto(result.sheet),
      records: result.records.map((r) => this.toRecordResponseDto(r)),
    };
  }

  // ============ edit(PATCH 编辑 pending Sheet)============

  // D38 路径:
  // 1. 校验当前 statusCode === pending(approved → 22040;rejected → 22041)
  // 2. 生成 previousSnapshot(Q-S16 结构:Sheet 主字段 + records 全字段快照)
  // 3. version + 1
  // 4. 旧 records 软删 + 新 records 创建
  // 5. 重跑全部字典 / 时间 / serviceHours / registrationId 跨表校验
  async edit(
    id: string,
    dto: UpdateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode === SHEET_STATUS_APPROVED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
      }
      if (sheet.statusCode === SHEET_STATUS_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
      }
      // 批次 4-B:final_rejected 不可 edit(沿 D-S11 22043;终审驳回是终态,新提走 POST 新建)
      if (sheet.statusCode === SHEET_STATUS_FINAL_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE);
      }
      // 批次 4-B:pending_final_review 也不可 edit(沿 D-A1 / 业务规则文档 §2.1;
      //   APD 一级已审过,R31 已固化,需通过 final-reject 回退或新建 Sheet)
      if (sheet.statusCode === SHEET_STATUS_PENDING_FINAL_REVIEW) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }
      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

      // 没有 records 字段 → 等同于 no-op(不动 records,仍生成 snapshot + version+1)
      if (dto.records === undefined) {
        // 仅 version+1 + snapshot 保存当前状态
        const currentRecords = await tx.attendanceRecord.findMany({
          where: notDeletedWhere({ sheetId: id }),
          select: recordWithMemberSelect,
        });
        const snapshot = this.buildSnapshot(sheet, currentRecords);
        const updated = await tx.attendanceSheet.update({
          where: { id: sheet.id },
          data: {
            version: sheet.version + 1,
            previousSnapshot: snapshot as Prisma.InputJsonValue,
          },
          select: sheetSafeSelect,
        });
        await this.auditLogs.log({
          event: 'attendance-sheet.edit',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: id,
          meta: auditMeta,
          before: this.toSheetAuditSnapshot(sheet, currentRecords),
          after: this.toSheetAuditSnapshot(updated, currentRecords),
          extra: {
            operation: 'edit-no-records',
            recordsCount: currentRecords.length,
            newVersion: updated.version,
          },
          tx,
        });
        return this.toSheetResponseDto(updated);
      }

      // 1. 校验新 records
      const normalized: ReturnType<AttendancesService['normalizeRecord']>[] = [];
      for (const input of dto.records) {
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_ROLE,
          input.roleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          tx,
        );
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_STATUS,
          input.attendanceStatusCode,
          BizCode.ATTENDANCE_STATUS_CODE_INVALID,
          tx,
        );
        await this.assertMemberExists(input.memberId, tx);
        if (input.registrationId !== undefined) {
          await this.assertRegistrationMatchesActivity(input.registrationId, sheet.activityId, tx);
        }
        normalized.push(this.normalizeRecord(input));
      }

      this.assertNoInternalOverlap(normalized);
      for (const r of normalized) {
        // edit 路径:排除本 Sheet 旧 records(它们将被软删)
        await this.assertNoTimeOverlap(r.memberId, r.checkInAt, r.checkOutAt, id, tx);
      }

      // 2. 生成 previousSnapshot(在旧 records 软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
      });
      const snapshot = this.buildSnapshot(sheet, currentRecords);

      // 3. 软删旧 records + 创建新 records(D38)
      const now = new Date();
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.attendanceRecord.createMany({
        data: normalized.map((r) => ({
          sheetId: id,
          memberId: r.memberId,
          roleCode: r.roleCode,
          checkInAt: r.checkInAt,
          checkOutAt: r.checkOutAt,
          serviceHours: r.serviceHours,
          attendanceStatusCode: r.attendanceStatusCode,
          note: r.note,
          registrationId: r.registrationId,
          contributionPoints: r.contributionPoints,
        })),
      });

      // 4. 更新 Sheet:version+1 + previousSnapshot
      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          version: sheet.version + 1,
          previousSnapshot: snapshot as Prisma.InputJsonValue,
        },
        select: sheetSafeSelect,
      });

      // PR #6 audit:after 含新 records 完整快照(createMany 不返 id,回查一次)
      const newRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      await this.auditLogs.log({
        event: 'attendance-sheet.edit',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet, currentRecords),
        after: this.toSheetAuditSnapshot(updated, newRecords),
        extra: {
          operation: 'edit',
          oldRecordsCount: currentRecords.length,
          newRecordsCount: newRecords.length,
          newVersion: updated.version,
        },
        tx,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // PR #6 audit snapshot:用于 AuditLogsService.log() before/after 的 JSON-safe 快照。
  // 与 buildSnapshot 平行存在(语义分离:buildSnapshot 服务于 sheet.previousSnapshot 业务列;
  // toSheetAuditSnapshot 服务于 audit_logs.context;字段输出格式一致以便后续可比对)。
  // records 可选:approve / reject / finalApprove 场景 records 不变,只需 sheet 快照 +
  //   extra.recordsCount 即可;submit / edit × 2 / softDelete / finalReject 必传 records。
  // 字段全非敏感(打码矩阵未命中,沿 PR #3 / PR #4 / PR #5 不打码范式)。
  private toSheetAuditSnapshot(
    sheet: SheetSafeRow,
    records?: RecordWithMemberRow[],
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

  // Q-S16 snapshot 结构:Sheet 主字段 + records 完整快照(全字段,日期 ISO 8601,Decimal 序列化为 string)。
  private buildSnapshot(
    sheet: Prisma.AttendanceSheetGetPayload<{ select: typeof sheetFullSelect }>,
    records: RecordWithMemberRow[],
  ): Record<string, unknown> {
    return {
      sheet: {
        activityId: sheet.activityId,
        submitterUserId: sheet.submitterUserId,
        submittedAt: sheet.submittedAt.toISOString(),
        statusCode: sheet.statusCode,
        reviewerUserId: sheet.reviewerUserId,
        reviewedAt: sheet.reviewedAt?.toISOString() ?? null,
        reviewNote: sheet.reviewNote,
        // 批次 4-B:edit 路径仅 pending 状态进入,finalReviewer* 必为 null;
        // 仍写入 snapshot 保完整性(未来 schema 升级保持兼容)。
        finalReviewerUserId: sheet.finalReviewerUserId,
        finalReviewedAt: sheet.finalReviewedAt?.toISOString() ?? null,
        finalReviewNote: sheet.finalReviewNote,
        version: sheet.version,
      },
      records: records.map((r) => ({
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
      })),
    };
  }

  // ============ softDelete(DELETE)============

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode === SHEET_STATUS_APPROVED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
      }
      if (sheet.statusCode === SHEET_STATUS_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
      }
      // 批次 4-B:final_rejected 不可软删(records 已在 final-reject 软删;Sheet 主体记录保留作历史)
      if (sheet.statusCode === SHEET_STATUS_FINAL_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE);
      }
      // 批次 4-B:pending_final_review 不可软删(沿 edit 路径风格)
      if (sheet.statusCode === SHEET_STATUS_PENDING_FINAL_REVIEW) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }
      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

      // PR #6 audit:before 需要 records 完整快照(软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const now = new Date();
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      const removed = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: { deletedAt: now },
        select: sheetSafeSelect,
      });

      await this.auditLogs.log({
        event: 'attendance-sheet.delete',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet, currentRecords),
        extra: {
          operation: 'delete',
          priorStatusCode: sheet.statusCode,
          recordsCount: currentRecords.length,
        },
        tx,
      });

      return this.toSheetResponseDto(removed);
    });
  }

  // ============ approve(PATCH;APD 一级)============

  // 批次 4-B 状态机升级(沿 D-A1 / D-S6 / D-S7 / D-S8):
  // - 状态机:pending → **pending_final_review**(原 v0.4.0 是 → approved 终态)
  // - R31 仍在此校验:所有 records.contributionPoints !== null;否则 22072(沿 D-S8)
  // - 写 reviewerUserId / reviewedAt / reviewNote(APD 一级审核责任人)
  // - **不再触发** eventPlaceholder('attendance.recorded')(沿 D-S7;触发位置移到 finalApprove)
  // - audit:沿 attendance-sheet.review,action='approve';nextStatusCode 升级为 pending_final_review
  async approve(
    id: string,
    dto: ApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

      // R31:所有 records contributionPoints 必填(沿 D-S8;APD 一级 approve 时校验)
      const recordsForCheck = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: { id: true, contributionPoints: true },
      });
      if (recordsForCheck.some((r) => r.contributionPoints === null)) {
        throw new BizException(BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED);
      }

      const reviewedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          statusCode: SHEET_STATUS_PENDING_FINAL_REVIEW,
          reviewerUserId: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      await this.auditLogs.log({
        event: 'attendance-sheet.review',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet),
        after: this.toSheetAuditSnapshot(updated),
        extra: {
          operation: 'review',
          action: 'approve',
          priorStatusCode: sheet.statusCode,
          nextStatusCode: SHEET_STATUS_PENDING_FINAL_REVIEW,
          recordsCount: recordsForCheck.length,
        },
        tx,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // ============ reject(PATCH;APD 一级)============

  async reject(
    id: string,
    dto: RejectAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          statusCode: SHEET_STATUS_REJECTED,
          reviewerUserId: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote,
        },
        select: sheetSafeSelect,
      });

      await this.auditLogs.log({
        event: 'attendance-sheet.review',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet),
        after: this.toSheetAuditSnapshot(updated),
        extra: {
          operation: 'review',
          action: 'reject',
          priorStatusCode: sheet.statusCode,
          nextStatusCode: SHEET_STATUS_REJECTED,
        },
        tx,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // ============ final-approve(PATCH;批次 4-B 新增 — 终审通过)============

  // 沿 D-S5 / D-S7 / D-A2:
  // - 状态机:pending_final_review → approved(贡献值正式生效)
  // - 状态非 pending_final_review 抛 **22045** ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID
  //   (终态 approved / rejected / final_rejected 再次调用一律走此码)
  // - 写 finalReviewerUserId / finalReviewedAt / finalReviewNote
  // - **触发** eventPlaceholder('attendance.recorded')(approved-only;同事务内;沿 D-S7)
  // - audit:attendance-sheet.final-review(action='final-approve');沿 D-S11 / 业务规则文档 §8.4
  // - **不重校验**逐条 records.contributionPoints(沿 D-S8;R31 在 APD 一级已校验)
  // - 权限:终审业务角色为"APD 部门部长 / 副部长",当前实装权限仍沿用管理权限
  //   (RolesGuard ADMIN / SUPER_ADMIN),细分终审权限将在后续批次实现;
  //   不开 22044 模块码,权限不足走通用 40300。
  async finalApprove(
    id: string,
    dto: FinalApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode !== SHEET_STATUS_PENDING_FINAL_REVIEW) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
      }

      const finalReviewedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          statusCode: SHEET_STATUS_APPROVED,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt,
          finalReviewNote: dto.finalReviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      // 触发 attendance.recorded(批次 4-B 移到终审通过时;沿 D-S7;Q-S13 context schema 沿用)
      const recordsForEvent = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      eventPlaceholder('attendance.recorded', {
        activityId: updated.activityId,
        sheetId: updated.id,
        // context 沿 v0.4.0 Q-S13 schema;新增 finalReviewerUserId / finalReviewedAt 兼容字段
        reviewerUserId: updated.reviewerUserId,
        reviewedAt: updated.reviewedAt?.toISOString() ?? null,
        finalReviewerUserId: currentUser.id,
        finalReviewedAt: finalReviewedAt.toISOString(),
        records: recordsForEvent.map((r) => ({
          recordId: r.id,
          memberId: r.memberId,
          roleCode: r.roleCode,
          attendanceStatusCode: r.attendanceStatusCode,
          checkInAt: r.checkInAt.toISOString(),
          checkOutAt: r.checkOutAt.toISOString(),
          serviceHours: r.serviceHours.toString(),
          contributionPoints: this.decimalToString(r.contributionPoints),
          registrationId: r.registrationId,
        })),
      });

      await this.auditLogs.log({
        event: 'attendance-sheet.final-review',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet),
        after: this.toSheetAuditSnapshot(updated),
        extra: {
          operation: 'final-review',
          action: 'final-approve',
          priorStatusCode: sheet.statusCode,
          nextStatusCode: SHEET_STATUS_APPROVED,
          recordsCount: recordsForEvent.length,
          eventTriggered: true,
        },
        tx,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // ============ final-reject(PATCH;批次 4-B 新增 — 终审驳回)============

  // 沿 D-S5 / D-S7 / D-A2:
  // - 状态机:pending_final_review → final_rejected
  // - 状态非 pending_final_review 抛 **22045**
  // - finalReviewNote 必填(沿 RejectDto 模式;DTO 层 class-validator 已校验;此处仅作冗余日志兜底,
  //   仍由 service 拒空字符串通过 22046)
  // - 写 finalReviewerUserId / finalReviewedAt / finalReviewNote
  // - records **跟随软删**(沿 D8 主路径)
  // - **不触发** attendance.recorded(沿 D-S7;子项候选 C)
  // - audit:attendance-sheet.final-review(action='final-reject')
  // - 权限同 finalApprove:当前实装沿 ADMIN / SUPER_ADMIN,细分终审权限后置。
  async finalReject(
    id: string,
    dto: FinalRejectAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode !== SHEET_STATUS_PENDING_FINAL_REVIEW) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
      }

      // DTO 层 @MinLength(1) 已确保非空;此处冗余校验防绕过(沿 RejectDto reviewNote 风格)
      if (dto.finalReviewNote.trim().length === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED);
      }

      // PR #6 audit:before 需要 records 完整快照(records 跟随软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const finalReviewedAt = new Date();
      // records 跟随软删(沿 D8 主路径)
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: finalReviewedAt },
      });

      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          statusCode: SHEET_STATUS_FINAL_REJECTED,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt,
          finalReviewNote: dto.finalReviewNote,
        },
        select: sheetSafeSelect,
      });

      await this.auditLogs.log({
        event: 'attendance-sheet.final-review',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: this.toSheetAuditSnapshot(sheet, currentRecords),
        after: this.toSheetAuditSnapshot(updated),
        extra: {
          operation: 'final-review',
          action: 'final-reject',
          priorStatusCode: sheet.statusCode,
          nextStatusCode: SHEET_STATUS_FINAL_REJECTED,
          recordsCount: currentRecords.length,
          finalReviewNote: dto.finalReviewNote,
        },
        tx,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // ============ 队员端:listMyRecords(GET /me/attendance-records)============

  // Q-A14 / R29 / R33:仅返 approved Sheet 内 records。
  async listMyRecords(
    query: MyAttendanceRecordsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AttendanceRecordResponseDto>> {
    const memberId = await this.prisma.$transaction(async (tx) =>
      this.resolveUserMemberIdOrThrow(currentUser.id, tx),
    );

    const { page, pageSize, activityId } = query;
    const sheetWhere: Prisma.AttendanceSheetWhereInput = {
      statusCode: SHEET_STATUS_APPROVED,
      deletedAt: null,
    };
    if (activityId !== undefined) sheetWhere.activityId = activityId;

    const where = notDeletedWhere({ memberId, sheet: sheetWhere });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toRecordResponseDto(r)),
      total,
      page,
      pageSize,
    };
  }
}

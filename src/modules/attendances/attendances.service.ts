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
import {
  ApproveAttendanceSheetDto,
  AttendanceMemberSummaryDto,
  AttendanceRecordInputDto,
  AttendanceRecordResponseDto,
  AttendanceSheetActivitySummaryDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  MyAttendanceRecordsQueryDto,
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';

// V2 第一阶段批次 3B attendances service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §13 / §15 / §16 / §19
//
// 关键约定:
// - 状态机闭集 3 态:pending / approved / rejected
// - submit:事务内一次性 create Sheet + N records;activity statusCode != cancelled
// - edit:仅 pending → pending;后端生成 previousSnapshot(R28 / Q-S16);version+1;
//   旧 records 软删 + 新 records 创建(D38);重跑全部校验
// - delete:仅 pending → 软删 + 级联软删 records(R20)
// - approve:仅 pending → approved;所有 records.contributionPoints 必填(R31);
//   写 reviewerUserId/At/Note;**同事务内触发** eventPlaceholder('attendance.recorded')
// - reject:仅 pending → rejected;reviewNote 必填
// - 时间不重叠:同 memberId × [checkInAt, checkOutAt) 左闭右开;跨 Sheet / 跨 Activity 全局
//   (R16 / Q-S15);service 层校验(不做 PG EXCLUDE 约束)
// - serviceHours:未传自动 (checkOutAt-checkInAt)/3600;>0 且 ≤ 跨度(D14 / D45 / D51 / D46)
// - registrationId 跨表:非空时 registration.activityId === sheet.activityId(R23)
// - registrationId Restrict:删除 registration 时被 FK 阻断(Q-S21;不破坏历史追溯)
// - audit:submit / edit / delete / read.other / review(approve+reject)
// - event:attendance.recorded approved-only(rejected / submit / edit / delete 不触发)

const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const SHEET_STATUS_PENDING = 'pending';
const SHEET_STATUS_APPROVED = 'approved';
const SHEET_STATUS_REJECTED = 'rejected';

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const DICT_TYPE_ATTENDANCE_STATUS = 'attendance_status';

// Sheet 简化 select(不含 records 数组 + 不含 previousSnapshot)。
const sheetSafeSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNote: true,
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
  constructor(private readonly prisma: PrismaService) {}

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

  private async findActivityForSubmission(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; statusCode: string }> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true, statusCode: true },
    });
    if (!act) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    if (act.statusCode === ACTIVITY_STATUS_CANCELLED) {
      throw new BizException(BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    }
    return act;
  }

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
  private normalizeRecord(input: AttendanceRecordInputDto): {
    memberId: string;
    roleCode: string;
    checkInAt: Date;
    checkOutAt: Date;
    serviceHours: number;
    attendanceStatusCode: string;
    note: string | null;
    registrationId: string | null;
    contributionPoints: number | null;
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
      contributionPoints: input.contributionPoints ?? null,
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

  async submit(
    activityId: string,
    dto: CreateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // 1. activity 存在 + 非 cancelled
      await this.findActivityForSubmission(activityId, tx);

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

      // 4. 事务内一次性 create Sheet + N records
      const created = await tx.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: currentUser.id,
          statusCode: SHEET_STATUS_PENDING,
          version: 1,
          records: {
            create: normalized.map((r) => ({
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

      auditPlaceholder('attendance-sheet.submit', {
        operatorUserId: currentUser.id,
        activityId,
        sheetId: created.id,
        recordsCount: normalized.length,
      });

      return this.toSheetResponseDto(created);
    });
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
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode === SHEET_STATUS_APPROVED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
      }
      if (sheet.statusCode === SHEET_STATUS_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
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
        auditPlaceholder('attendance-sheet.edit', {
          operatorUserId: currentUser.id,
          sheetId: id,
          recordsCount: currentRecords.length,
          newVersion: updated.version,
          operation: 'edit-no-records',
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

      auditPlaceholder('attendance-sheet.edit', {
        operatorUserId: currentUser.id,
        sheetId: id,
        oldRecordsCount: currentRecords.length,
        newRecordsCount: normalized.length,
        newVersion: updated.version,
      });

      return this.toSheetResponseDto(updated);
    });
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
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode === SHEET_STATUS_APPROVED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
      }
      if (sheet.statusCode === SHEET_STATUS_REJECTED) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
      }
      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

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

      auditPlaceholder('attendance-sheet.delete', {
        operatorUserId: currentUser.id,
        sheetId: id,
        priorStatusCode: sheet.statusCode,
      });

      return this.toSheetResponseDto(removed);
    });
  }

  // ============ approve(PATCH)============

  // 状态机:pending → approved;非 pending 抛 22030(approved → 22040,rejected → 22041)。
  // R31:所有 records.contributionPoints !== null;否则 22072。
  // 触发 eventPlaceholder('attendance.recorded', ...)(approved-only;同事务内)。
  async approve(
    id: string,
    dto: ApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      if (sheet.statusCode !== SHEET_STATUS_PENDING) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }

      // R31:所有 records contributionPoints 必填
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
          statusCode: SHEET_STATUS_APPROVED,
          reviewerUserId: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      // 触发 attendance.recorded(approved-only;Q-S13 context schema)
      const recordsForEvent = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      eventPlaceholder('attendance.recorded', {
        activityId: updated.activityId,
        sheetId: updated.id,
        reviewerUserId: currentUser.id,
        reviewedAt: reviewedAt.toISOString(),
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

      auditPlaceholder('attendance-sheet.review', {
        operatorUserId: currentUser.id,
        sheetId: id,
        priorStatusCode: sheet.statusCode,
        nextStatusCode: SHEET_STATUS_APPROVED,
        action: 'approve',
        recordsCount: recordsForEvent.length,
      });

      return this.toSheetResponseDto(updated);
    });
  }

  // ============ reject(PATCH)============

  async reject(
    id: string,
    dto: RejectAttendanceSheetDto,
    currentUser: CurrentUserPayload,
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

      auditPlaceholder('attendance-sheet.review', {
        operatorUserId: currentUser.id,
        sheetId: id,
        priorStatusCode: sheet.statusCode,
        nextStatusCode: SHEET_STATUS_REJECTED,
        action: 'reject',
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

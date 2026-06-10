import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AttendanceMemberSummaryDto,
  AttendanceRecordResponseDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
} from './attendances.dto';

// AttendanceSheet / AttendanceRecord 响应序列化 Presenter(单一职责)。
// 沿 PR #247 service characterization + 8 组 attendances e2e 锁定的现状行为,从
// `AttendancesService` 中极小抽出(仅"搬家",不动任何字段映射 / Decimal 序列化语义);
// P1-4 第一刀(2026-06-10 方案 A 拍板),沿 architecture-boundary.md §3.1 Presenter 边界
// + AGENTS §19.7 D-7 决策锁。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ Prisma 行 → 响应 DTO 的纯字段映射(Sheet 详情 / Sheet 列表项 / Record 含 member 摘要)
// - ✅ Decimal → string 序列化(serviceHours / contributionPoints;对齐 Decimal(5,2) 出参为字符串)
// - ❌ 不写 DB / 不持有 PrismaService / 不接触事务(事务归属仍在 AttendancesService)
// - ❌ 不做鉴权 / 状态机判定 / audit / event(分别归 service / state-machine / audit-recorder)
// - ❌ 不做 select / include 查询策略(select 常量留在 service,归未来 QueryService 议题)
//
// 入参类型采用最小结构性约束(沿 `time-overlap-policy.ts` OverlapRecordLike 范式):
// 只声明映射真正读取的字段,不反向依赖 service 内的 Prisma GetPayload 派生类型;
// service 侧 GetPayload 行按结构子类型直接传入(member 在 GetPayload 中非空,
// 此处声明 `| null` 为宽参数,保留原防御分支,不改行为)。

export type AttendanceSheetRowLike = {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
};

export type AttendanceSheetListRowLike = {
  id: string;
  activityId: string;
  submitterUserId: string;
  submittedAt: Date;
  statusCode: string;
  reviewedAt: Date | null;
  version: number;
  createdAt: Date;
};

export type AttendanceRecordRowLike = {
  id: string;
  sheetId: string;
  memberId: string;
  member: { id: string; memberNo: string; displayName: string } | null;
  roleCode: string;
  checkInAt: Date;
  checkOutAt: Date;
  serviceHours: Prisma.Decimal;
  attendanceStatusCode: string;
  note: string | null;
  registrationId: string | null;
  contributionPoints: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class AttendancePresenter {
  // public:除 toRecordResponseDto 内部使用外,finalApprove 的 attendance.recorded
  // 业务事件 payload 组装也复用本方法(沿原 service 私有 helper 的两处调用,语义不变)。
  decimalToString(d: Prisma.Decimal | null): string | null {
    return d === null ? null : d.toString();
  }

  toSheetResponseDto(row: AttendanceSheetRowLike): AttendanceSheetResponseDto {
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

  toSheetListItemDto(row: AttendanceSheetListRowLike): AttendanceSheetListItemDto {
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

  toRecordResponseDto(row: AttendanceRecordRowLike): AttendanceRecordResponseDto {
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
}

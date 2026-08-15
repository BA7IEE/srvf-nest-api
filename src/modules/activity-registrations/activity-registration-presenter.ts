import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { escapeCsvField } from '../../common/csv/csv.util';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import type {
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  AdminRegistrationListItemDto,
} from './activity-registrations.dto';

// F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D6 拍板):expand 白名单,仅
// listAllForAdmin(admin/v1/registrations 全局横扫)消费。白名单是**响应形状**的一部分,
// 故随 Presenter 走。
export const REGISTRATION_EXPAND_WHITELIST = ['member', 'activity'] as const;
export type RegistrationExpandKey = (typeof REGISTRATION_EXPAND_WHITELIST)[number];

export const REGISTRATION_CSV_HEADERS = [
  'registration_id',
  'member_id',
  'member_no',
  'display_name',
  'status_code',
  'registered_at',
  'reviewed_at',
  'review_note',
  'cancelled_at',
  'cancel_reason',
] as const;

// 入参类型采用最小结构性约束(沿 `attendances/attendance-presenter.ts` 范式):
// 只声明映射真正读取的字段,不反向依赖 service 内的 Prisma GetPayload 派生类型 ——
// 否则 service → presenter → service 会绕成 import 环。
// service / query service 侧的 GetPayload 行按**结构子类型**直接传入;
// `member` / `activityPosition` 在 GetPayload 中的可空性由各自 select 决定,
// 此处一律声明为宽参数(`| null`),保留原防御分支 `?? null`,不改行为。

export type RegistrationResponseRowLike = {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
};

export type RegistrationListRowLike = {
  id: string;
  activityId: string;
  activityPosition: { id: string; name: string } | null;
  memberId: string;
  member: { memberNo: string; displayName: string } | null;
  statusCode: string;
  registeredAt: Date;
  reviewedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
};

export type RegistrationAdminListRowLike = Omit<RegistrationListRowLike, 'member'> & {
  member: { id: string; memberNo: string; displayName: string; gradeCode: string | null } | null;
  activity: { id: string; title: string; startAt: Date; organizationId: string } | null;
};

export type RegistrationCsvRowLike = {
  id: string;
  memberId: string;
  member: { memberNo: string; displayName: string } | null;
  statusCode: string;
  registeredAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
};

// 活动报名**响应序列化** Presenter(Phase 6-B 第三域第二刀;沿 docs/architecture-boundary.md §3.1)。
//
// **职责边界(严守「搬家不优化」:字段映射逐字保留)**:
// - ✅ Prisma 行 → 响应 DTO 的纯字段映射(详情 / 列表项 / 跨轴列表项含 expand 投影)
// - ✅ CSV 的表头、BOM 首 chunk 与行格式化(escapeCsvField 的**列顺序**必须与表头一致 ——
//      表头与格式化两者同处一个类,是本刀的一个附带收益:改一个忘另一个会当场对不上)
// - ✅ expand 白名单与 `parseExpandQuery` 解析(白名单是响应形状的一部分)
// - ❌ **不碰 DB**:不 import PrismaService、不注入任何东西(eslint 规则 (j) 对
//      `src/**/*presenter*.ts` 结构性禁止 import prisma.service —— 文件名刻意带 `presenter`
//      就是为了把自己放进那道闸)
// - ❌ 不做鉴权 / 状态机判定 / audit / 事务(分别归 service / state-machine / audit-recorder)
// - ❌ 不做 select / include 查询策略(归 ActivityRegistrationQueryService,第一刀已抽)
@Injectable()
export class ActivityRegistrationPresenter {
  // Prisma Json 列 → 响应用对象。数组与标量一律收敛成 null(既有语义,逐字保留)。
  jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  toResponseDto(row: RegistrationResponseRowLike): ActivityRegistrationResponseDto {
    return {
      id: row.id,
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  toListItemDto(
    row: RegistrationListRowLike,
    waitlistPosition: number | null,
  ): ActivityRegistrationListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      activityPosition:
        row.activityPosition == null
          ? null
          : {
              activityPositionId: row.activityPosition.id,
              name: row.activityPosition.name,
            },
      memberId: row.memberId,
      memberNo: row.member?.memberNo ?? null,
      memberDisplayName: row.member?.displayName ?? null,
      statusCode: row.statusCode,
      waitlistPosition,
      registeredAt: row.registeredAt,
      reviewedAt: row.reviewedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
    };
  }

  // 跨轴只读列表项映射(2026-06-23):复用 toListItemDto 同字段集 + activityTitle 上下文。
  // F2/B1(D6 拍板):expand 参数由调用方显式传入(listAllForAdmin 传解析后的集合;
  // listForMemberAdmin 恒传空集 —— 该 goal 范围仅 B1/admin/v1/registrations 支持 expand)。
  toAdminListItemDto(
    row: RegistrationAdminListRowLike,
    expand: ReadonlySet<RegistrationExpandKey>,
    waitlistPosition: number | null,
  ): AdminRegistrationListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      activityPosition:
        row.activityPosition == null
          ? null
          : {
              activityPositionId: row.activityPosition.id,
              name: row.activityPosition.name,
            },
      activityTitle: row.activity?.title ?? null,
      memberId: row.memberId,
      memberNo: row.member?.memberNo ?? null,
      memberDisplayName: row.member?.displayName ?? null,
      statusCode: row.statusCode,
      waitlistPosition,
      registeredAt: row.registeredAt,
      reviewedAt: row.reviewedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
      ...(expand.has('member') && row.member
        ? {
            member: {
              id: row.member.id,
              memberNo: row.member.memberNo,
              displayName: row.member.displayName,
              gradeCode: row.member.gradeCode,
            },
          }
        : {}),
      ...(expand.has('activity') && row.activity
        ? {
            activity: {
              id: row.activity.id,
              title: row.activity.title,
              startAt: row.activity.startAt,
              organizationId: row.activity.organizationId,
            },
          }
        : {}),
    };
  }

  // expand 查询串 → 白名单内的键集合。白名单越界项由 parseExpandQuery 丢弃(既有语义)。
  parseExpand(raw: string | undefined): ReadonlySet<RegistrationExpandKey> {
    return parseExpandQuery(raw, REGISTRATION_EXPAND_WHITELIST);
  }

  // CSV 首两个 chunk:UTF-8 BOM(让 Excel 自动识别中文)+ 表头行。
  // 与 formatCsvRow 同处一类,列顺序单一真相源。
  csvHeaderChunks(): string[] {
    return ['\uFEFF', REGISTRATION_CSV_HEADERS.join(',')];
  }

  formatCsvRow(row: RegistrationCsvRowLike): string {
    return [
      escapeCsvField(row.id),
      escapeCsvField(row.memberId),
      escapeCsvField(row.member?.memberNo ?? null),
      escapeCsvField(row.member?.displayName ?? null),
      escapeCsvField(row.statusCode),
      escapeCsvField(row.registeredAt),
      escapeCsvField(row.reviewedAt),
      escapeCsvField(row.reviewNote),
      escapeCsvField(row.cancelledAt),
      escapeCsvField(row.cancelReason),
    ].join(',');
  }
}

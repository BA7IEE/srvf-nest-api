import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  ATTENDANCE_SHEET_STATUS,
  ListAttendanceSheetsQueryDto,
  MyAttendanceRecordsQueryDto,
} from './attendances.dto';

// 集中定义**读侧**对外 select。永不包含 deletedAt(软删除内部状态)。
// §3.2 "include / select strategy" 归 QueryService;`AttendancesService` 的写路径回读复用
// 同一份 `recordWithMemberSelect`(import),不另起第二份投影。
//
// ⚠️ 刻意**没有**搬过来的两个 select:`sheetSafeSelect`(12 处写路径的回读投影)与
// `sheetFullSelect`(edit 事务内装载聚合根 + previousSnapshot)—— 它们服务的是写路径与
// §4「loading the aggregate root」,不是读侧查询构造,搬过来会把事务边界的持有关系搞模糊。

// Sheet 列表精简 select。
export const sheetListSelect = {
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
export const recordWithMemberSelect = {
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
      realName: true,
      nickname: true,
    },
  },
} as const satisfies Prisma.AttendanceRecordSelect;

// 跨轴只读 select(2026-06-23):
// - adminSheetListSelect:Sheet 列表精简 select + activity{id,title}(跨活动横扫上下文,审批工作台)。
// - adminMemberRecordSelect:Record + Member 嵌套 + sheet{activityId, activity{title}}(队员 360 考勤记录上下文)。
// 活动标题经 Prisma 嵌套关系一次取(无 N+1);activity.deletedAt 不过滤(FK onDelete=Restrict 保证行存在,
// 软删态字段仍可读,不暴露 deletedAt)。
// F2/B2(D6 拍板,2026-07-04):activity 子 select 扩至 expand 展开所需的最小字段集
// (+startAt+organizationId)——activity 是既有 Prisma 嵌套关系,一次 JOIN 单查询取回(非二次查询,
// 天然满足 D6"禁 N+1");是否投影进响应完全由 listAllSheetsForAdmin 的 expand 参数决定。
export const adminSheetListSelect = {
  ...sheetListSelect,
  activity: {
    select: {
      id: true,
      title: true,
      startAt: true,
      organizationId: true,
    },
  },
} as const satisfies Prisma.AttendanceSheetSelect;

export const adminMemberRecordSelect = {
  ...recordWithMemberSelect,
  sheet: {
    select: {
      activityId: true,
      activity: {
        select: {
          title: true,
        },
      },
    },
  },
} as const satisfies Prisma.AttendanceRecordSelect;

export type SheetListRow = Prisma.AttendanceSheetGetPayload<{ select: typeof sheetListSelect }>;
export type AdminSheetListRow = Prisma.AttendanceSheetGetPayload<{
  select: typeof adminSheetListSelect;
}>;
export type RecordWithMemberRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof recordWithMemberSelect;
}>;
export type AdminMemberRecordRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof adminMemberRecordSelect;
}>;

// 考勤单据**读侧查询构造**单一职责类(Phase 6-B 第二域第一刀;沿 docs/architecture-boundary.md §3.2)。
//
// **判权腿不在这里**(沿 members 第一刀 #1008 立下的先例):`assertCanOrThrow` /
// `assertFinalReviewAuthzOrThrow` / `assertManagedAttendanceAccess` /
// `resolveVisibleOrganizationIds`(内含 `AuthzService.getVisibleOrganizationScope()` 与
// `RBAC_FORBIDDEN` 抛出)全部仍归 `AttendancesService`;本类只接收**算好的**
// `visibleOrganizationIds` 作为入参 —— 这正是 §3.2 "permission decisions
// (except read-scope filters explicitly passed in)" 那条豁免的口径。
// 本类**不注入** rbac / authz,module 里也**不 exports** —— 避免出现一条绕过判权腿的读路径。
//
// **职责边界(严守「搬家不优化」:where / select / orderBy / skip / take 逐字保留)**:
// - ✅ 四条列表 surface 的 where 构造、分页、orderBy、读侧 select 投影
// - ✅ `memberExists` 的存在性**查询**
// - ❌ 不做 allow/deny 判定、不调 rbac / authz
// - ❌ 不写业务表、不写 audit(`logRead` 仍由 `AttendancesService` 在查询完成后 fail-closed 落库)
// - ❌ 不组装响应 DTO:presenter 调用、`expand` 投影、`activityTitle` 拼装、
//      `MEMBER_NOT_FOUND` 的抛出(BizCode 映射是业务判定,不是查询)统统留在调用方
// - ❌ 不开业务事务 —— 下面几处 `$transaction([...])` 是 Prisma **只读批处理数组形式**,
//      沿既有实现逐字保留,不是业务事务边界;`reviewDetail` / `findOne` 那种**回调式**
//      事务内的读属 §4「loading the aggregate root」,刻意不搬
@Injectable()
export class AttendanceSheetQueryService {
  constructor(private readonly prisma: PrismaService) {}

  // GET admin/v1/activities/:activityId/attendance-sheets —— 单活动内的单据列表。
  async listSheetsByActivity(
    activityId: string,
    query: ListAttendanceSheetsQueryDto,
  ): Promise<{ items: SheetListRow[]; total: number }> {
    const { page, pageSize, statusCode } = query;
    const filters: Prisma.AttendanceSheetWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceSheet.findMany({
        where,
        select: sheetListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceSheet.count({ where }),
    ]);

    return { items, total };
  }

  // GET admin/v1/attendance-sheets —— 跨活动横扫(Tier2 审批工作台)。
  // `visibleOrganizationIds` 已是「授权组织范围 ∩ 用户显式筛选」的结果,由调用方算好传入;
  // `undefined` = 不加组织 where(GLOBAL 且无筛选),与 v0.49 既有语义逐字一致。
  async listSheetsForAdmin(
    query: ListAttendanceSheetsQueryDto,
    visibleOrganizationIds: string[] | undefined,
  ): Promise<{ items: AdminSheetListRow[]; total: number }> {
    const { page, pageSize, statusCode, q, activityQ, dateFrom, dateTo } = query;

    const filters: Prisma.AttendanceSheetWhereInput = {};
    if (statusCode !== undefined) filters.statusCode = statusCode;
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.submittedAt = {
        ...(dateFrom !== undefined ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo !== undefined ? { lte: new Date(dateTo) } : {}),
      };
    }

    // activity 关联过滤累加(activityQ + organizationId/includeDescendants 可共存)。
    const activityWhere: Prisma.ActivityWhereInput = {};
    if (activityQ !== undefined) {
      activityWhere.title = { contains: activityQ, mode: 'insensitive' };
    }
    if (visibleOrganizationIds !== undefined) {
      activityWhere.organizationId = { in: visibleOrganizationIds };
    }
    if (Object.keys(activityWhere).length > 0) filters.activity = activityWhere;

    // q:跨 activity(title)+ submitter(username+nickname)全局模糊命中。
    if (q !== undefined) {
      filters.OR = [
        { activity: { title: { contains: q, mode: 'insensitive' } } },
        { submitter: { username: { contains: q, mode: 'insensitive' } } },
        { submitter: { nickname: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceSheet.findMany({
        where,
        select: adminSheetListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceSheet.count({ where }),
    ]);

    return { items, total };
  }

  // 队员存在性**查询**(不存在 / 软删 → false)。BizCode 映射(15001)留在调用方:
  // 「查不到」是事实,「查不到该报什么错」是业务判定。
  async memberExists(memberId: string): Promise<boolean> {
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    return member !== null;
  }

  // GET admin/v1/members/:memberId/attendance-records —— 某队员跨 sheet 记录(Tier3 队员 360)。
  // 仅返 approved Sheet 内 records(镜像 app /me Q-A14:已生效记录,不暴露 pending / rejected)。
  async listApprovedRecordsForMember(
    memberId: string,
    query: PaginationQueryDto,
  ): Promise<{ items: AdminMemberRecordRow[]; total: number }> {
    const { page, pageSize } = query;
    const where = notDeletedWhere({
      memberId,
      sheet: { statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, deletedAt: null },
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        select: adminMemberRecordSelect,
        orderBy: { checkInAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return { items, total };
  }

  // GET app/v1/my/attendance-records —— 队员自助(Q-A14 / R29 / R33:仅返 approved Sheet 内 records)。
  async listApprovedRecordsForSelf(
    memberId: string,
    query: MyAttendanceRecordsQueryDto,
  ): Promise<{ items: RecordWithMemberRow[]; total: number }> {
    const { page, pageSize, activityId } = query;
    const sheetWhere: Prisma.AttendanceSheetWhereInput = {
      statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
      deletedAt: null,
    };
    if (activityId !== undefined) sheetWhere.activityId = activityId;

    const where = notDeletedWhere({ memberId, sheet: sheetWhere });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return { items, total };
  }
}

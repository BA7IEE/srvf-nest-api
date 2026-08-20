import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type {
  ExportRegistrationsQueryDto,
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
} from './activity-registrations.dto';

// 集中定义**读侧**对外 select。永不包含 deletedAt(软删除内部状态)。
// §3.2 "include / select strategy" 归 QueryService。
//
// ⚠️ 刻意**没有**搬过来的一个 select:`registrationSafeSelect`(create / approve / reject /
// cancel / reopen 五条写路径的回读投影 + `findRegistrationOrThrow` 装载聚合根)——
// 它服务的是写路径与 §4「loading the aggregate root」,不是读侧查询构造,
// 搬过来会把事务边界的持有关系搞模糊。

// 列表精简 select:仅必要字段 + Member 摘要(memberNo / realName)。
export const registrationListSelect = {
  id: true,
  activityId: true,
  activityPositionId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedAt: true,
  cancelledAt: true,
  createdAt: true,
  member: {
    select: {
      memberNo: true,
      realName: true,
      nickname: true,
    },
  },
  activityPosition: {
    select: {
      id: true,
      name: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

export const registrationCsvSelect = {
  id: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedAt: true,
  reviewNote: true,
  cancelledAt: true,
  cancelReason: true,
  member: { select: { memberNo: true, realName: true, nickname: true } },
} as const satisfies Prisma.ActivityRegistrationSelect;

// 跨轴只读列表 select(2026-06-23):列表精简 select + activity{id,title} 上下文。
// 跨活动 / 跨队员横扫时 item 脱离 :activityId 路径段,经 Prisma 嵌套关系一次取活动标题(无 N+1);
// activity.deletedAt 不过滤:FK onDelete=Restrict 保证 activity 行存在,软删态字段仍可读,不暴露 deletedAt。
// F2/B1(D6 拍板,2026-07-04):member/activity 子 select 扩至 expand 展开所需的最小字段集
// (member +id+gradeCode;activity +startAt+organizationId)——member/activity 均是既有 Prisma
// 嵌套关系,一次 JOIN 单查询取回(非二次查询,天然满足 D6"禁 N+1");是否投影进响应完全由
// toAdminListItemDto 的 expand 参数决定(默认不展开,select 多取的字段不出现在响应里)。
export const registrationAdminListSelect = {
  ...registrationListSelect,
  member: {
    select: {
      id: true,
      memberNo: true,
      realName: true,
      nickname: true,
      gradeCode: true,
    },
  },
  activity: {
    select: {
      id: true,
      title: true,
      startAt: true,
      organizationId: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

export type RegistrationListRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationListSelect;
}>;
export type RegistrationAdminListRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationAdminListSelect;
}>;
export type RegistrationCsvRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationCsvSelect;
}>;

const REGISTRATION_STATUS_PASS = 'pass';
const CSV_EXPORT_BATCH_SIZE = 500;

// 活动报名**读侧查询构造**单一职责类(Phase 6-B 第三域第一刀;沿 docs/architecture-boundary.md §3.2)。
//
// **判权腿不在这里**(沿 members #1008 / attendances #1021 立下的先例):`assertCanOrThrow`、
// `assertManagedRegistrationAccess`、`resolveVisibleOrganizationIds`(内含
// `AuthzService.getVisibleOrganizationScope()` 与 `RBAC_FORBIDDEN` 抛出)全部仍归
// `ActivityRegistrationsService`;本类只接收**算好的** `visibleOrganizationIds` 作为入参 ——
// 这正是 §3.2 "permission decisions (except read-scope filters explicitly passed in)" 那条豁免的口径。
// 本类**不注入** rbac / authz,module 里也**不 exports** —— 避免出现一条绕过判权腿的读路径。
//
// **职责边界(严守「搬家不优化」:where / select / orderBy / skip / take 逐字保留)**:
// - ✅ 四条列表 surface 的 where 构造、分页、orderBy、读侧 select 投影
// - ✅ `memberExists` 的存在性**查询**
// - ✅ CSV 导出的 where 构造与 500 行游标分页**取数**
// - ❌ 不做 allow/deny 判定、不调 rbac / authz
// - ❌ 不写业务表、不写 audit(`logExport` 仍由 `ActivityRegistrationsService` 在返回 generator
//      **之前** fail-closed 落库,顺序逐字不变)
// - ❌ 不组装响应 DTO:BOM / CSV 表头 / 行格式化、`expand` 投影、`activityTitle` 拼装、
//      候补位次拼装(`ActivityRegistrationWaitlistQueryService`)、`MEMBER_NOT_FOUND` 与
//      `ACTIVITY_REGISTRATION_NOT_FOUND` 的抛出(BizCode 映射是业务判定,不是查询)统统留在调用方
// - ❌ 不开业务事务 —— 下面几处 `$transaction([...])` 是 Prisma **只读批处理数组形式**,
//      沿既有实现逐字保留,不是业务事务边界;`create` / `approve` / `cancelMy` 那种**回调式**
//      事务内的读属 §4「loading the aggregate root」,刻意不搬
@Injectable()
export class ActivityRegistrationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  // GET admin/v1/activities/:activityId/registrations —— 单活动内的报名列表。
  async listByActivity(
    activityId: string,
    query: ListRegistrationsQueryDto,
  ): Promise<{ items: RegistrationListRow[]; total: number }> {
    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return { items, total };
  }

  // GET admin/v1/registrations —— 跨活动横扫(Tier2 审批工作台)。
  // `visibleOrganizationIds` 已是「授权组织范围 ∩ 用户显式筛选」的结果,由调用方算好传入;
  // `undefined` = 不加组织 where(GLOBAL 且无筛选),与 v0.49 既有语义逐字一致。
  async listAllForAdmin(
    query: ListRegistrationsQueryDto,
    visibleOrganizationIds: string[] | undefined,
  ): Promise<{ items: RegistrationAdminListRow[]; total: number }> {
    const {
      page,
      pageSize,
      statusCode,
      q,
      memberQ,
      activityQ,
      memberId,
      activityId,
      dateFrom,
      dateTo,
    } = query;

    const filters: Prisma.ActivityRegistrationWhereInput = {};
    if (statusCode !== undefined) filters.statusCode = statusCode;
    if (memberId !== undefined) filters.memberId = memberId;
    if (activityId !== undefined) filters.activityId = activityId;
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.registeredAt = {
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

    // member 关联过滤(memberQ)。
    if (memberQ !== undefined) {
      filters.member = {
        OR: [
          { memberNo: { contains: memberQ, mode: 'insensitive' } },
          { realName: { contains: memberQ, mode: 'insensitive' } },
        ],
      };
    }

    // q:跨 member(memberNo+realName)+ activity(title)全局模糊命中。
    if (q !== undefined) {
      filters.OR = [
        { member: { memberNo: { contains: q, mode: 'insensitive' } } },
        { member: { realName: { contains: q, mode: 'insensitive' } } },
        { activity: { title: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationAdminListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
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

  // GET admin/v1/members/:memberId/registrations —— 某队员跨活动报名履历(Tier3 队员 360)。
  async listForMember(
    memberId: string,
    query: ListRegistrationsQueryDto,
  ): Promise<{ items: RegistrationAdminListRow[]; total: number }> {
    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { memberId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationAdminListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return { items, total };
  }

  // GET app/v1/my/registrations —— 队员自助报名列表。
  async listMine(
    memberId: string,
    query: ListMyRegistrationsQueryDto,
  ): Promise<{ items: RegistrationListRow[]; total: number }> {
    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { memberId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return { items, total };
  }

  // CSV 导出的 where 构造(默认 scope=pass;scope=all 不加状态过滤)。
  // 与取数分成两步是**刻意**的:调用方必须在拿到 where 之后、开始取数之前
  // fail-closed 落审计(Q-A6 / v0.44.0 finding #13),顺序不能被这层合并掉。
  buildCsvWhere(
    scope: ExportRegistrationsQueryDto['scope'],
    activityId: string,
  ): Prisma.ActivityRegistrationWhereInput {
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if ((scope ?? 'pass') === 'pass') {
      filters.statusCode = REGISTRATION_STATUS_PASS;
    }
    return notDeletedWhere(filters);
  }

  // CSV 导出取数:500 行游标分页(**禁止**恢复全量 findMany —— v0.44.0 finding #13)。
  // 逐行 yield;调用方负责 BOM / 表头 / 行格式化。取数在调用方首次 `next()` 时才发生,
  // 与既有实现的惰性一致。
  async *streamCsvRows(
    where: Prisma.ActivityRegistrationWhereInput,
  ): AsyncGenerator<RegistrationCsvRow, void, undefined> {
    let cursor: string | undefined;
    while (true) {
      const rows: RegistrationCsvRow[] = await this.prisma.activityRegistration.findMany({
        where,
        select: registrationCsvSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CSV_EXPORT_BATCH_SIZE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        yield row;
      }
      if (rows.length < CSV_EXPORT_BATCH_SIZE) break;
      cursor = rows.at(-1)!.id;
    }
  }
}

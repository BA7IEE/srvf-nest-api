import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import {
  ActivityListItemDto,
  ActivityOptionItemDto,
  ActivityOptionsQueryDto,
  ActivityOptionsResponseDto,
  ListActivitiesQueryDto,
} from './activities.dto';
import {
  ActivityAccessService,
  USER_VISIBLE_STATUS_CODES,
  activityListItemSelect,
} from './activity-access.service';

// 类型面逐字不变:ActivityFullRow / PUBLISHED_ACTIVITY_DISPLAY_FIELDS 随共享层迁走,
// 既有消费者(lifecycle / draft / closure 等)仍从本 service import —— 在此 re-export。
export type { ActivityFullRow } from './activity-access.service';
export { PUBLISHED_ACTIVITY_DISPLAY_FIELDS } from './activity-access.service';
import { toListItemDto } from './activity-presenter';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { ActivityStatusCommandService } from './activity-status-command.service';
import { ActivityWriteService } from './activity-write.service';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ACTIVITY_STATUS_ARCHIVED, ActivityStateMachine } from './activity-state-machine';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';

// V2 第一阶段批次 3A activities service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.7 / §1.11 / §1.12
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - Role 过滤(Q-A7):USER 仅可见 statusCode ∈ {published, completed} 且 deletedAt=null
// - 状态机闭集:draft / published / cancelled / completed(completed 留字典占位,Q-A11)
// - 状态机转移:draft → published(publish);draft|published → cancelled(cancel);published → completed
// - completed/cancelled 终态仅允许展示字段白名单更新；软删另受参与数据守卫约束
// - 字典校验:activityTypeCode 必填,genderRequirementCode 传入时校验
// - 组织节点禁根:organizationId 必填,但 service 校验 organization.parentId !== null
// - 起止时间:startAt < endAt(创建必校;更新时若涉及任一字段则用合并后值复校)
// - audit:create / update / publish / cancel / softDelete 全部 hook activity.publish
// - Decimal 序列化:locationLongitude / locationLatitude 显式 toString()
//
// V2 批次 6 PR #4(第二波第二步):5 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;5 个 operation 共用 `activity.publish` 事件名,
// 通过 `extra.operation` 区分(沿 batch3 草案 §20.2 A1 有意设计,D2 同值挪字符串);
// resourceType 固定 `activity`,字段全部非敏感(打码矩阵未命中)。

@Injectable()
export class ActivitiesService {
  constructor(
    // P2-14 刀 A:列表封面改为按 coverImageKey 现签。
    private readonly images: ActivityImageSigningService,
    // 第三域第三刀:多段共用的判权 / 聚合根装载 / 域校验。
    private readonly access: ActivityAccessService,
    // 建单改单与状态流转的实现持有者;本 service 仅保留同名薄委托作为唯一对外入口。
    private readonly writes: ActivityWriteService,
    // Activity OS R1 / A6：内部 from-template 写命令的唯一 façade；A6 零 HTTP 入口。
    private readonly fromTemplate: ActivityFromTemplateService,
    private readonly statuses: ActivityStatusCommandService,
    private readonly prisma: PrismaService,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 逐面迁移第一批):统一判权大脑,5 个写方法
    // 判权从 rbac.can 切 authz.explain(见 assertCanOrThrow);list / findOne 仍无码仅登录不变。
    private readonly authz: AuthzService,
    // PR-L2:业务写 + audit + durable intent 同事务；独立 worker 仅在 commit 后执行通知 Effect。
    private readonly notificationProducer: ActivityNotificationProducer,
    // F1/A6(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权)。
    private readonly organizations: OrganizationsService,
    // Insurance lifecycle PR-A:Activity 仍持有根事务与聚合锁；保险策略只在 rollout gate
    // 开启且受保护字段真实变化时查询报名事实。
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly initiationPolicy: ActivityInitiationPolicy,
    private readonly publishReviewService: ActivityPublishReviewService,
    private readonly allocationModes: ActivityAllocationModeService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  // ============ helpers ============

  // ============ list ============

  // F1/A6(D7):批量聚合 registrationCount/attendanceSheetCount(includeStats=true 时),
  // 两条 groupBy 一次查完当前页全部 activityId,禁 N+1。
  private async attachStats(items: ActivityListItemDto[]): Promise<ActivityListItemDto[]> {
    if (items.length === 0) return items;
    const activityIds = items.map((i) => i.id);
    const [regGroups, sheetGroups] = await Promise.all([
      this.prisma.activityRegistration.groupBy({
        by: ['activityId'],
        where: { activityId: { in: activityIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.attendanceSheet.groupBy({
        by: ['activityId'],
        where: { activityId: { in: activityIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const regCountByActivity = new Map(regGroups.map((g) => [g.activityId, g._count._all]));
    const sheetCountByActivity = new Map(sheetGroups.map((g) => [g.activityId, g._count._all]));
    return items.map((item) => ({
      ...item,
      registrationCount: regCountByActivity.get(item.id) ?? 0,
      attendanceSheetCount: sheetCountByActivity.get(item.id) ?? 0,
    }));
  }

  // Q-A7:USER 强制白名单状态(忽略入参 statusCode,防 draft/cancelled 存在性泄漏);
  // list/options 共用同一份状态过滤构造。
  //
  // ===== 归档默认不显示(维护者 2026-08-25 拍板②)=====
  //
  // 🔴 非 USER 且**不传 statusCode** 时,此前一条状态过滤都不加 ⇒ 已归档活动会原样出现在
  //    管理端列表里。归档的全部意义就是「默认不出现在列表里」,所以这一格必须显式排除。
  // ⚠️ 另外两条分支**不需要**动:
  //    - USER 分支恒 `in {published, completed}`,archived 不在里面(结构性排除);
  //    - 显式传了 statusCode 的分支是「我就要看这个状态」,包括 `statusCode='archived'`。
  //   ⇒ `includeArchived` 只影响「不传 statusCode 的管理端默认视图」这一格,
  //     这正是前端那个「显示已归档」勾选框要控制的东西。
  private applyStatusCodeFilter(
    filters: Prisma.ActivityWhereInput,
    currentUser: CurrentUserPayload,
    statusCode: string | undefined,
    includeArchived = false,
  ): void {
    if (currentUser.role === Role.USER) {
      filters.statusCode = { in: [...USER_VISIBLE_STATUS_CODES] };
    } else if (statusCode !== undefined) {
      filters.statusCode = statusCode;
    } else if (!includeArchived) {
      filters.statusCode = { not: ACTIVITY_STATUS_ARCHIVED };
    }
  }

  // ============ 建单 / 改单 / 状态流转 / findOne:薄委托(Phase 6-B 第三域第三刀)============
  //
  // 实现已迁至 activity-write.service.ts / activity-status-command.service.ts /
  // activity-access.service.ts(仅"搬家":判权 / 域校验 / 锁序 / 状态机 / 审计 / 通知逐字不变)。
  // 本 service 仍是本模块**唯一**对外入口 —— controller 与既有消费者调用面逐字不变。

  async lockActivityForLifecycle(
    ...args: Parameters<ActivityAccessService['lockActivityForLifecycle']>
  ) {
    return this.access.lockActivityForLifecycle(...args);
  }

  async findOne(...args: Parameters<ActivityAccessService['findOne']>) {
    return this.access.findOne(...args);
  }

  async create(...args: Parameters<ActivityWriteService['create']>) {
    return this.writes.create(...args);
  }

  async createFromTemplate(...args: Parameters<ActivityFromTemplateService['createFromTemplate']>) {
    return this.fromTemplate.createFromTemplate(...args);
  }

  async update(...args: Parameters<ActivityWriteService['update']>) {
    return this.writes.update(...args);
  }

  async softDelete(...args: Parameters<ActivityStatusCommandService['softDelete']>) {
    return this.statuses.softDelete(...args);
  }

  async publish(...args: Parameters<ActivityStatusCommandService['publish']>) {
    return this.statuses.publish(...args);
  }

  async publishWithAudienceTags(
    ...args: Parameters<ActivityStatusCommandService['publishWithAudienceTags']>
  ) {
    return this.statuses.publishWithAudienceTags(...args);
  }

  async cancel(...args: Parameters<ActivityStatusCommandService['cancel']>) {
    return this.statuses.cancel(...args);
  }

  async cancelLocked(...args: Parameters<ActivityStatusCommandService['cancelLocked']>) {
    return this.statuses.cancelLocked(...args);
  }

  async complete(...args: Parameters<ActivityStatusCommandService['complete']>) {
    return this.statuses.complete(...args);
  }

  async list(
    query: ListActivitiesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityListItemDto>> {
    const {
      page,
      pageSize,
      statusCode,
      activityTypeCode,
      organizationId,
      isPublicRegistration,
      q,
      dateFrom,
      dateTo,
      includeDescendants,
      includeStats,
      includeArchived,
    } = query;

    const filters: Prisma.ActivityWhereInput = {};
    this.applyStatusCodeFilter(filters, currentUser, statusCode, includeArchived);
    if (activityTypeCode !== undefined) filters.activityTypeCode = activityTypeCode;
    if (organizationId !== undefined) {
      filters.organizationId = includeDescendants
        ? { in: await this.organizations.queryDescendantOrgIds(organizationId) }
        : organizationId;
    }
    if (isPublicRegistration !== undefined) filters.isPublicRegistration = isPublicRegistration;
    if (q !== undefined) {
      filters.title = { contains: q, mode: 'insensitive' };
    }
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.startAt = {
        ...(dateFrom !== undefined ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo !== undefined ? { lte: new Date(dateTo) } : {}),
      };
    }

    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: activityListItemSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);

    const covers = await this.images.signCovers(rows);
    const items = rows.map((r, index) =>
      // 顺序对齐由 signCovers 保证(它是 rows.map,不重排)。
      toListItemDto(r, covers[index] ?? { coverImageUrl: null }),
    );

    return {
      items: includeStats ? await this.attachStats(items) : items,
      total,
      page,
      pageSize,
    };
  }

  // ============ F1/A6 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影。**无 rbac 码**(镜像 list/findOne 现状:活动读无码仅登录,
  // RBAC_MAP §2.4 BD-3 已就"是否新增 activity.read.* 码"结论 won't-do——活动详情
  // login-only 天然可读,新增读码属收紧而非 additive,故沿用现状不新增)。
  async options(
    query: ActivityOptionsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityOptionsResponseDto> {
    const { q, statusCode, organizationId, limit, includeArchived } = query;

    const filters: Prisma.ActivityWhereInput = {};
    this.applyStatusCodeFilter(filters, currentUser, statusCode, includeArchived);
    if (organizationId !== undefined) filters.organizationId = organizationId;
    if (q !== undefined) {
      filters.title = { contains: q, mode: 'insensitive' };
    }

    const rows = await this.prisma.activity.findMany({
      where: notDeletedWhere(filters),
      select: { id: true, title: true, startAt: true, statusCode: true },
      orderBy: { createdAt: 'desc' },
      take: limit ?? 20,
    });

    const items: ActivityOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.title,
      startAt: r.startAt,
      statusCode: r.statusCode,
    }));
    return { items };
  }

  // ============ findOne ============

  // ============ create ============

  // ============ update ============

  // ============ softDelete ============

  // ============ publish ============

  // ============ cancel ============

  // ============ complete(v0.40.0 参与域生命周期收口③ 管理端手动完结)============
}

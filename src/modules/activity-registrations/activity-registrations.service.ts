import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import { promoteActivityWaitlistWithinCapacity } from '../activities/activity-waitlist-promotion';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityAllocationService } from './activity-allocation.service';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import { ActivityQualificationEvaluatorService } from './activity-qualification-evaluator.service';
import { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';
import {
  ActivityRegistrationAccessService,
  REGISTRATION_STATUS_PASS,
  RegistrationAuthorization,
  registrationSafeSelect,
} from './activity-registration-access.service';

// 类型面逐字不变:RegistrationAuthorization 随共享层迁走,但既有消费者
// (bulk / lifecycle / controller 等)仍从本 service import —— 在此 re-export,
// 让「实现搬家」不外溢成「消费者改 import」。
export type { RegistrationAuthorization } from './activity-registration-access.service';
import { ActivityRegistrationCreateService } from './activity-registration-create.service';
import { ActivityRegistrationPresenter } from './activity-registration-presenter';
import { ActivityRegistrationReviewService } from './activity-registration-review.service';
import { ActivityRegistrationQueryService } from './activity-registration-query.service';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import { ActivityRegistrationWaitlistQueryService } from './activity-registration-waitlist-query.service';
import {
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  AdminRegistrationListItemDto,
  CancelRegistrationDto,
  ExportRegistrationsQueryDto,
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
} from './activity-registrations.dto';

// V2 第一阶段批次 3A activity-registrations service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.1 / §1.3 / §1.6 / §1.15
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - 状态机闭集 5 态:pending / pass / reject / cancelled / waitlisted
// - approve: pending → pass(capacity 复核;只 pass 占名额)
// - reject:  pending → reject(reviewNote 必填)
// - cancel:  pending|pass|waitlisted → cancelled(cancelled 释放名额 / 退出候补)
// - Q-A3:USER 自助 vs ADMIN 代报名拆开;USER 路径 memberId 强制注入 currentUser.user.memberId
// - 报名前校验:activity 存在 + 未取消 + 公开报名;满员时创建 waitlisted
// - permanent unique:同 activity 同 member 跨 cancelled / soft-deleted 全历史只有一个报名头;
//   legacy active-only 预检查暂不复用历史头,P2002 兜底仍为 ACTIVITY_REGISTRATION_ALREADY_EXISTS(21002)
// - USER 越权访问他人 registration → 404
//   (统一抛 BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,避免存在性泄漏)
// - audit:create / review(approve/reject/cancel)hook
//
// Q-A6 CSV export:
// - 不引入 csv-stringify(no new deps);手写 escapeCsvField
// - 默认 scope=pass;可选 scope=all
// - 输出 UTF-8 + BOM(让 Excel 自动识别中文)
// - 不写库 / 不落 export_logs / 不生成 AttendanceRecord(Q-A6 三条副作用禁止)
//
// V2 批次 6 PR #5(第二波第三步):6 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;2 个事件名 `registration.create` / `registration.review`
// 共用 6 个 operation,通过 `extra.viaPath` / `extra.action` 区分(沿 batch3 草案 §20.2 A2 / A3
// 有意设计,D2 同值挪字符串);resourceType 固定 `activity_registration`,字段全部非敏感
// (打码矩阵未命中,与 PR #3 / PR #4 范式一致;extras 字段是用户自定义 JSON,本次纯迁移
// 不引入打码,若后续业务认为含敏感字段需独立批次评审)。
// `exportCsv` 复用 registration.review,并在返回 generator 前 fail-closed 落库;generator 内不再
// 尾置审计,确保审计失败时 controller 尚未获得 stream、首字节尚未发送。

@Injectable()
export class ActivityRegistrationsService {
  private readonly logger = new Logger(ActivityRegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // 第三域第二刀:多段共用的前置(判权 / managed 校验 / 聚合根锁 / 回读)。
    private readonly access: ActivityRegistrationAccessService,
    // 建单与审批的实现持有者;本 service 仅保留同名薄委托作为唯一对外入口。
    private readonly creates: ActivityRegistrationCreateService,
    private readonly reviews: ActivityRegistrationReviewService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly registrationStateMachine: ActivityRegistrationStateMachine,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 逐面迁移第一批):统一判权大脑,管理端
    // 判权从 rbac.can 切 authz.explain(见 assertCanOrThrow)。
    private readonly authz: AuthzService,
    // 保险 T3:报名门槛(跨模块单向依赖 activity-registration → insurances,评审稿 E-13)
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
    // PR-L1:业务写 + audit + durable intent 共用调用方事务；provider/Notification Effect
    // 仅由独立 outbox worker 在 commit 后执行。
    private readonly notificationProducer: ActivityRegistrationNotificationProducer,
    // F2/B1(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权,镜像 F1/A6 activities.service.ts 用法)。
    private readonly organizations: OrganizationsService,
    private readonly activityParticipationPolicy: ActivityParticipationPolicy,
    private readonly waitlistQuery: ActivityRegistrationWaitlistQueryService,
    private readonly registrationLifecycle: ActivityRegistrationLifecycleService,
    private readonly allocations: ActivityAllocationService,
    // Phase 6-B 第三域第一刀(架构边界 §3.2):四条列表 surface 与 CSV 导出的读侧查询构造。
    // 判权腿不下放 —— 本类只收算好的 visibleOrganizationIds。
    private readonly registrationQuery: ActivityRegistrationQueryService,
    // Phase 6-B 第三域第二刀(架构边界 §3.1):Prisma 行 → 响应 DTO 的纯映射、expand
    // 投影与 CSV 表头 / 行格式化。纯函数类,不碰 DB(eslint 规则 (j) 结构性守护)。
    private readonly presenter: ActivityRegistrationPresenter,
  ) {}

  // ============ helpers ============

  // v0.49:扁平报名工作台按 activity.organizationId 下推授权范围；用户显式组织筛选
  // 与授权组织集合取交集。GLOBAL 且无筛选时保持旧查询，不额外加 where。
  private async resolveVisibleOrganizationIds(
    currentUser: CurrentUserPayload,
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<string[] | undefined> {
    const authScope = await this.authz.getVisibleOrganizationScope(
      currentUser,
      'activity-registration.read.record',
    );
    if (!authScope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const requestedOrgIds =
      organizationId === undefined
        ? undefined
        : includeDescendants
          ? await this.organizations.queryDescendantOrgIds(organizationId)
          : [organizationId];

    if (authScope.global) return requestedOrgIds;
    if (requestedOrgIds === undefined) return authScope.organizationIds;

    const visibleOrgIds = new Set(authScope.organizationIds);
    return requestedOrgIds.filter((id) => visibleOrgIds.has(id));
  }

  // P2002 兜底：并发首建仍稳定映射 21002；cancelled/reject 历史头在上方锁内直接复用。

  // ============ 管理端:list ============

  // ============ 建单 / 审批:薄委托(Phase 6-B 第三域第二刀)============
  //
  // 实现已迁至 activity-registration-create.service.ts / -review.service.ts
  // (仅"搬家":判权 / 锁序 / 容量裁决 / 状态机 / 审计 / 通知 intent 逐字不变)。
  // 本 service 仍是本模块**唯一**对外入口 —— controller 与其它消费者的调用面逐字不变。
  // ⚠️ 委托必须原样透传全部实参:少传一个 currentUser / auditMeta 就是少一条判权或少一条审计。

  async create(...args: Parameters<ActivityRegistrationCreateService['create']>) {
    return this.creates.create(...args);
  }

  async createMy(...args: Parameters<ActivityRegistrationCreateService['createMy']>) {
    return this.creates.createMy(...args);
  }

  async approve(...args: Parameters<ActivityRegistrationReviewService['approve']>) {
    return this.reviews.approve(...args);
  }

  async reject(...args: Parameters<ActivityRegistrationReviewService['reject']>) {
    return this.reviews.reject(...args);
  }

  async cancelAdmin(...args: Parameters<ActivityRegistrationReviewService['cancelAdmin']>) {
    return this.reviews.cancelAdmin(...args);
  }

  async reopen(...args: Parameters<ActivityRegistrationReviewService['reopen']>) {
    return this.reviews.reopen(...args);
  }

  async list(
    activityId: string,
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.read.record', {
      type: 'activity',
      id: activityId,
    });
    if (authorization === 'managed') {
      await this.access.assertManagedRegistrationAccess(activityId, currentUser);
    }
    // activity 存在性校验(管理员看不存在的活动 → 404)。
    await this.access.findActivityOrThrow(activityId);

    const { page, pageSize } = query;
    const { items: rows, total } = await this.registrationQuery.listByActivity(activityId, query);
    const waitlistPositions = await this.waitlistQuery.getPositions(rows);

    return {
      items: rows.map((r) => this.presenter.toListItemDto(r, waitlistPositions.get(r.id) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:跨活动报名横扫(Tier2 审批工作台)============

  // 2026-06-23 跨轴只读(GET admin/v1/registrations):脱离 :activityId 路径段,按 statusCode
  // 跨所有活动横扫报名(审批工作台「待我审批的」)。判权复用 read 码;item 自带 activity 上下文。
  // 既有 `list(activityId, ...)` 行为零变更——此为新增只读方法,不动旧路径。
  // F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D1/D6/D7 拍板,2026-07-04):+可选
  // q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/
  // expand。全部省略时行为逐字不变(additive)。
  async listAllForAdmin(
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    const { page, pageSize, organizationId, includeDescendants, expand } = query;
    const visibleOrganizationIds = await this.resolveVisibleOrganizationIds(
      currentUser,
      organizationId,
      includeDescendants,
    );
    const expandSet = this.presenter.parseExpand(expand);

    const { items: rows, total } = await this.registrationQuery.listAllForAdmin(
      query,
      visibleOrganizationIds,
    );
    const waitlistPositions = await this.waitlistQuery.getPositions(rows);

    return {
      items: rows.map((r) =>
        this.presenter.toAdminListItemDto(r, expandSet, waitlistPositions.get(r.id) ?? null),
      ),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:某队员报名履历(Tier3 队员 360)============

  // 2026-06-23 跨轴只读(GET admin/v1/members/:memberId/registrations):某队员跨活动报名履历
  // (队员 360「活动履历」tab)。镜像 admin-member-insurances 结构 + MEMBER_NOT_FOUND 守卫;
  // 判权复用 read 码;item 自带 activity 上下文。可选 statusCode 过滤。
  // F2/B1 范围仅覆盖 admin/v1/registrations(listAllForAdmin);本方法不消费 query 内新增的
  // q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/
  // expand 字段(DTO 共享导致的溢出,沿路线图拍板可接受),toAdminListItemDto 恒传空 expand 集,
  // 响应形状逐字不变。
  async listForMemberAdmin(
    memberId: string,
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.read.record', {
      type: 'member',
      id: memberId,
    });
    // 队员存在性守卫(不存在 / 软删 → 15001,镜像 admin-member-insurances inline 检查)。
    if (!(await this.registrationQuery.memberExists(memberId))) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }

    const { page, pageSize } = query;
    const { items: rows, total } = await this.registrationQuery.listForMember(memberId, query);
    const waitlistPositions = await this.waitlistQuery.getPositions(rows);

    return {
      items: rows.map((r) =>
        this.presenter.toAdminListItemDto(r, new Set(), waitlistPositions.get(r.id) ?? null),
      ),
      total,
      page,
      pageSize,
    };
  }

  // ============ 管理端:create(ADMIN 代报名)============

  // ============ 队员端:createMy(USER 自助)============

  // ============ 管理端:approve ============

  // ============ 管理端:reject ============

  // ============ 管理端:cancel(代取消)============

  // ============ 管理端:reopen(审批后悔药:reject → pending)============

  // ============ 队员端:listMy ============

  async listMy(
    query: ListMyRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    const memberId = await this.access.resolveUserMemberIdOrThrow(currentUser.id);

    const { page, pageSize } = query;
    const { items: rows, total } = await this.registrationQuery.listMine(memberId, query);
    const waitlistPositions = await this.waitlistQuery.getPositions(rows);

    return {
      items: rows.map((r) => this.presenter.toListItemDto(r, waitlistPositions.get(r.id) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 队员端:findMy ============

  async findMy(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityRegistrationResponseDto> {
    const memberId = await this.access.resolveUserMemberIdOrThrow(currentUser.id);

    const reg = await this.prisma.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.memberId !== memberId) {
      // USER 越权统一抛 ACTIVITY_REGISTRATION_NOT_FOUND → 404(避免存在性泄漏)
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return this.presenter.toResponseDto(reg);
  }

  // ============ 队员端:cancelMy ============

  async cancelMy(
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      const memberId = await this.access.resolveUserMemberIdOrThrow(currentUser.id, tx);

      const registrationRef = await tx.activityRegistration.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, activityId: true, memberId: true },
      });
      if (!registrationRef || registrationRef.memberId !== memberId) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
      }
      await this.access.lockActivityForRegistrationCreate(registrationRef.activityId, tx);
      const reg = await this.access.findRegistrationOrThrow(registrationRef.activityId, id, tx);
      if (reg.memberId !== memberId) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
      }

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: reg.id,
        expectedStatus: reg.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
      const lockedReg = await this.access.findRegistrationOrThrow(reg.activityId, reg.id, tx);
      // 参与域生命周期收口⑦:队员自助路径共用 live 考勤记录 / 签到证据守卫。
      await this.access.assertNoParticipationEvidence(lockedReg.id, tx);
      // K4(B-F3):活动标题 / 发布人必须在**锁后**读。放在锁前时,并发改名先提交,
      // 本事务仍会用旧标题落 durable intent —— intent 一旦落库,worker 无法自行恢复正确快照,
      // 同一次取消甚至会同时产出「旧标题的取消通知」与「新标题的候补递补通知」(递补 helper
      // 本就是锁后复读的),两条自相矛盾。本路径此刻已持 Activity `FOR UPDATE`，这里读取
      // 同一根事务下的最新已提交快照。
      const activity = await tx.activity.findFirst({
        where: notDeletedWhere({ id: lockedReg.activityId }),
        select: {
          title: true,
          publisher: { select: { memberId: true } },
        },
      });
      const cancellingMember = await tx.member.findUnique({
        where: { id: lockedReg.memberId },
        select: { memberNo: true, displayName: true },
      });

      const cancelledAt = new Date();
      await this.registrationLifecycle.cancelInTransactionTrusted(tx, {
        activityId: lockedReg.activityId,
        registrationId: lockedReg.id,
        memberId: lockedReg.memberId,
        actorUserId: currentUser.id,
        sourceCode: 'self',
        cancelReason: dto.cancelReason ?? null,
        cancelledAt,
      });
      const updated = await this.access.findRegistrationOrThrow(
        lockedReg.activityId,
        lockedReg.id,
        tx,
      );

      await this.registrationAuditRecorder.logCancel({
        registrationId: lockedReg.id,
        before: lockedReg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: lockedReg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'self',
        cancelReason: dto.cancelReason ?? null,
        activityId: lockedReg.activityId,
        targetMemberId: lockedReg.memberId,
        auditMeta,
        tx,
      });

      const allocationPromotion =
        lockedReg.statusCode === REGISTRATION_STATUS_PASS
          ? await this.allocations.promoteAfterCancellationInTransactionTrusted(tx, {
              activityId: lockedReg.activityId,
              registrationId: lockedReg.id,
              actorUser: currentUser,
              promotedAt: cancelledAt,
              auditMeta,
            })
          : { handled: false, activityTitle: activity?.title ?? '活动', promoted: [] };
      const promotion = allocationPromotion.handled
        ? allocationPromotion
        : lockedReg.statusCode === REGISTRATION_STATUS_PASS
          ? await promoteActivityWaitlistWithinCapacity({
              activityId: lockedReg.activityId,
              activityPositionId: lockedReg.activityPositionId,
              maxPromotions: 1,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              auditMeta,
              tx,
              auditLogs: this.auditLogs,
            })
          : { activityTitle: activity?.title ?? '活动', promoted: [] };

      // B-D3（维护者 2026-08-01 拍板）：只有取消**已通过**报名才通知负责人。pending / waitlisted
      // 的自助取消对负责人没有任何要做的事 —— 名额本来就没被占住、不用补人、不用改排班，
      // 全发只是噪音。取消 pass 的 intent 形状（eventKey / aggregateId / 收件人解析）逐字不变，
      // 只是不再为另两个状态多发一条。
      const ownerRecipientResolution =
        lockedReg.statusCode === REGISTRATION_STATUS_PASS
          ? await this.notificationProducer.enqueueSelfCancellation(tx, {
              registrationId: updated.id,
              activityId: lockedReg.activityId,
              activityTitle: activity?.title ?? '活动',
              publisherMemberId: activity?.publisher?.memberId ?? null,
              cancellingMember,
              cancelledAt,
              cancelReason: dto.cancelReason ?? null,
            })
          : null;
      if (!allocationPromotion.handled) {
        await this.notificationProducer.enqueueWaitlistPromotions(tx, {
          activityTitle: promotion.activityTitle,
          promoted: promotion.promoted,
        });
      }
      return {
        dto: this.presenter.toResponseDto(updated),
        activityId: lockedReg.activityId,
        ownerRecipientResolution,
      };
    });

    if (result.ownerRecipientResolution?.startsWith('missing-')) {
      this.logger.warn(
        `registration self-cancel owner notification skipped activity=${result.activityId} resolution=${result.ownerRecipientResolution}`,
      );
    }
    return result.dto;
  }

  // ============ 管理端:CSV export(Q-A6)============

  // 返回游标分页 async generator;controller 用 Readable.from 包成 StreamableFile。
  // **不写库 / 不落 export_logs / 不生成 AttendanceRecord**(Q-A6 三条副作用禁止)。
  async exportCsv(
    activityId: string,
    query: ExportRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AsyncGenerator<string, void, undefined>> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.read.record', {
      type: 'activity',
      id: activityId,
    });
    await this.access.findActivityOrThrow(activityId);

    const where = this.registrationQuery.buildCsvWhere(query.scope, activityId);

    const filterFields: string[] = [];
    if (query.format !== undefined) filterFields.push('format');
    if (query.scope !== undefined) filterFields.push('scope');
    await this.registrationAuditRecorder.logExport({
      activityId,
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      filterFields,
      auditMeta,
    });

    return this.streamRowsAsCsv(where);
  }

  private async *streamRowsAsCsv(
    where: Prisma.ActivityRegistrationWhereInput,
  ): AsyncGenerator<string, void, undefined> {
    // BOM 与表头行(呈现)已迁入 Presenter,取数(500 行游标分页)已迁入 QueryService;
    // 本方法只剩「按什么顺序把两者拼起来」这一条编排。yield 的**个数与顺序**逐字不变,
    // 惰性也不变:内层 generator 的首次查询发生在下面两个 header chunk 被消费之后。
    for (const chunk of this.presenter.csvHeaderChunks()) {
      yield chunk;
    }
    for await (const row of this.registrationQuery.streamCsvRows(where)) {
      yield `\n${this.presenter.formatCsvRow(row)}`;
    }
  }
}

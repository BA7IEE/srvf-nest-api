import { Injectable } from '@nestjs/common';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import { Prisma, Role } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import type {
  AppManagedActivitiesQueryDto,
  AppManagedActivityDetailDto,
  AppManagedActivityListItemDto,
  AppManagedActivityProjectionDto,
  AppManagedActivityWorkflowDto,
  AppManagedSettlementSummaryDto,
} from './dto/app/app-managed-activity.dto';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { ACTIVITY_STATUS_ARCHIVED } from './activity-state-machine';
import { isStaleDraft } from './activity-archive-policy';

export const managedActivitySelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  allocationModeCode: true,
  organizationId: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  statusCode: true,
  workflowRevision: true,
  requiresInsurance: true,
  isPublicRegistration: true,
  registrationModeCode: true,
  visibilityCode: true,
  defaultCheckInRadiusMeters: true,
  defaultLocationRequired: true,
  archiveWaitingDays: true,
  // P2-14 刀 A:封面 / 图集按 key 现签(不读裸 URL 遗留列)。
  coverImageKey: true,
  galleryImageKeys: true,
  createdAt: true,
  updatedAt: true,
  initiator: {
    select: { id: true, memberNo: true, realName: true, nickname: true, gradeCode: true },
  },
  responsibilityAssignments: {
    where: { status: 'active' },
    select: {
      memberId: true,
      responsibilityType: true,
      canManageRegistrations: true,
      canManageAttendance: true,
      member: {
        select: { id: true, memberNo: true, realName: true, nickname: true, gradeCode: true },
      },
    },
  },
  publishReviews: {
    orderBy: [{ requestVersion: 'desc' }],
    take: 1,
    select: {
      id: true,
      requestType: true,
      status: true,
      reviewNote: true,
    },
  },
  _count: {
    select: {
      registrations: { where: { deletedAt: null } },
    },
  },
} as const satisfies Prisma.ActivitySelect;

export type ManagedActivityRow = Prisma.ActivityGetPayload<{
  select: typeof managedActivitySelect;
}>;

const SETTLEMENT_WORKBENCH_ACTION = 'activity.settlement-generate.record';

function workflowFor(row: ManagedActivityRow, memberId: string): AppManagedActivityWorkflowDto {
  if (row.statusCode === 'draft') {
    return row.publishReviews[0]?.status === 'pending'
      ? { status: 'publish-review-pending', nextAction: '等待发布审核' }
      : {
          status: 'draft',
          nextAction: row.initiator?.id === memberId ? '提交发布审核' : null,
        };
  }
  if (row.statusCode === 'cancelled') return { status: 'cancelled', nextAction: null };
  if (row.statusCode === 'archived') return { status: 'archived', nextAction: null };
  if (row.statusCode === 'completed' || row.statusCode === 'terminated') {
    return { status: row.statusCode, nextAction: null };
  }
  if (row.statusCode === 'published') {
    return { status: 'published', nextAction: null };
  }
  return { status: 'unknown', nextAction: null };
}

@Injectable()
export class ActivityWorkflowQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly activityWorkflowGate: ActivityWorkflowGate,
    // P2-14 刀 A:封面 / 图集现签。
    private readonly images: ActivityImageSigningService,
    private readonly identities: AppIdentityResolver,
  ) {}

  async list(
    memberId: string,
    query: AppManagedActivitiesQueryDto,
  ): Promise<PageResultDto<AppManagedActivityListItemDto>> {
    const where: Prisma.ActivityWhereInput = {
      deletedAt: null,
      // 归档默认不显示(维护者 2026-08-25 拍板②)。这是 AC-004 说的那个「负责人工作台」——
      // 归档动作就在本列表的行上,列表自己不排除已归档 = 归档了还留在原地。
      // ⚠️ 显式传 statusCode(含 'archived')时按传的来,`includeArchived` 只管默认视图那一格。
      ...(query.statusCode
        ? { statusCode: query.statusCode }
        : query.includeArchived
          ? {}
          : { statusCode: { not: ACTIVITY_STATUS_ARCHIVED } }),
      OR: [
        { initiatorMemberId: memberId },
        { responsibilityAssignments: { some: { memberId, status: 'active' } } },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: managedActivitySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);
    const activityIds = rows.map((row) => row.id);
    const registrationGroups =
      activityIds.length === 0
        ? []
        : await this.prisma.activityRegistration.groupBy({
            by: ['activityId', 'statusCode'],
            where: {
              activityId: { in: activityIds },
              deletedAt: null,
              statusCode: { in: ['pending', 'waitlisted'] },
            },
            _count: { _all: true },
          });
    const pendingByActivity = new Map<string, number>();
    for (const group of registrationGroups) {
      if (group.statusCode === 'pending') {
        pendingByActivity.set(group.activityId, group._count._all);
      }
    }
    const now = new Date();

    return {
      items: rows.map((row) => {
        const assignment = row.responsibilityAssignments.find((item) => item.memberId === memberId);
        const relationship =
          assignment?.responsibilityType === 'owner'
            ? 'owner'
            : assignment?.responsibilityType === 'collaborator'
              ? 'collaborator'
              : 'initiator';
        // List visibility does not imply settlement permission. Do not invent
        // a settlement task or expose settlement state from this list.
        const workflow = workflowFor(row, memberId);
        return {
          activityId: row.id,
          title: row.title,
          statusCode: row.statusCode,
          startAt: row.startAt,
          endAt: row.endAt,
          relationship,
          pendingRegistrations: pendingByActivity.get(row.id) ?? 0,
          nextAction: workflow.nextAction,
          // AC-004「长期未处理草稿在工作台**提示**」的后端半格。
          // 判据与归档闸共用 `isStaleDraft` —— 两处各写一遍必然漂移,而漂移的形态是
          // 「亮着可归档、点下去被 20155 拒」或「能归档却不提示」,两种都没人会发现。
          staleDraft: isStaleDraft(row.statusCode, row.updatedAt, now),
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(
    activityId: string,
    memberId: string,
    user: CurrentUserPayload,
    includeSettlement = true,
  ): Promise<AppManagedActivityDetailDto> {
    const { row, registrationGroups, settlement } = includeSettlement
      ? await this.prisma.$transaction(
          async (tx) => {
            // Revalidate admission before activity visibility and scoped authz
            // using the same snapshot as the facts returned by this GET.
            const actor = await this.readCurrentActor(tx, memberId, user);
            return {
              ...(await this.readManagedBase(tx, activityId, memberId, actor.role)),
              settlement: await this.readSettlementSummary(tx, activityId, actor),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        )
      : {
          ...(await this.readManagedBase(this.prisma, activityId, memberId, user.role)),
          // A successful write must not acquire a new authorization/settlement
          // dependency merely to format its response. A subsequent GET can read it.
          settlement: { availability: 'not-requested' as const },
        };
    const registrationCount = (statusCode: string) =>
      registrationGroups.find((group) => group.statusCode === statusCode)?._count._all ?? 0;
    const owner = row.responsibilityAssignments.find(
      (assignment) => assignment.responsibilityType === 'owner',
    );
    const mine = row.responsibilityAssignments.find(
      (assignment) => assignment.memberId === memberId,
    );
    const latest = row.publishReviews[0] ?? null;
    // The workbench is neutral navigation, exposed separately as workbenchPath;
    // neither a run status nor an active closure proves an actionable task.
    const workflow = workflowFor(row, memberId);

    return {
      activity: await this.toProjection(row),
      // issue #1048 T1:`label` 由后端拼装,Prisma 行里没有。
      initiator:
        row.initiator === null
          ? null
          : {
              id: row.initiator.id,
              gradeCode: row.initiator.gradeCode,
              ...toMemberLabelFields(row.initiator),
            },
      owner:
        owner?.member == null
          ? null
          : {
              id: owner.member.id,
              gradeCode: owner.member.gradeCode,
              ...toMemberLabelFields(owner.member),
            },
      myResponsibility: mine
        ? {
            responsibilityType: mine.responsibilityType === 'owner' ? 'owner' : 'collaborator',
            canManageRegistrations: mine.canManageRegistrations,
            canManageAttendance: mine.canManageAttendance,
          }
        : null,
      publishReview: {
        latestRequestId: latest?.id ?? null,
        requestType:
          latest?.requestType === 'initial' || latest?.requestType === 'change'
            ? latest.requestType
            : null,
        status:
          latest?.status === 'pending' ||
          latest?.status === 'approved' ||
          latest?.status === 'returned' ||
          latest?.status === 'withdrawn' ||
          latest?.status === 'cancelled'
            ? latest.status
            : null,
        reviewNote: latest?.reviewNote ?? null,
        // 第 3 批第二刀封死 directPublish：发布能力只表示可发起审核，不再表示可直接 approved。
        canDirectPublish: false,
      },
      counts: {
        pendingRegistrations: registrationCount('pending'),
        waitlistedRegistrations: registrationCount('waitlisted'),
      },
      workflow,
      settlement,
    };
  }

  async loadOwned(activityId: string, memberId: string): Promise<ManagedActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        responsibilityAssignments: {
          some: { memberId, responsibilityType: 'owner', status: 'active' },
        },
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  async loadManaged(
    activityId: string,
    memberId: string,
    role: Role = Role.USER,
    tx?: Prisma.TransactionClient,
  ): Promise<ManagedActivityRow> {
    const activity = await (tx ?? this.prisma).activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        ...(role === Role.SUPER_ADMIN
          ? {}
          : {
              OR: [
                { initiatorMemberId: memberId },
                { responsibilityAssignments: { some: { memberId, status: 'active' } } },
              ],
            }),
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async readManagedBase(
    client: Prisma.TransactionClient,
    activityId: string,
    memberId: string,
    role: Role,
  ) {
    const row = await this.loadManaged(activityId, memberId, role, client);
    const registrationGroups = await client.activityRegistration.groupBy({
      by: ['statusCode'],
      where: {
        activityId,
        deletedAt: null,
        statusCode: { in: ['pending', 'waitlisted'] },
      },
      _count: { _all: true },
    });
    return { row, registrationGroups };
  }

  private async readCurrentActor(
    tx: Prisma.TransactionClient,
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<CurrentUserPayload> {
    // App admission and the request payload were resolved before this snapshot.
    // Re-read the live user/member link before using scoped grants or a role.
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (actor.memberId !== memberId) throw new BizException(BizCode.FORBIDDEN);
    const identity = await this.identities.resolve(actor, tx);
    if (!identity.canUseApp || identity.member?.id !== memberId) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return actor;
  }

  private async readSettlementSummary(
    tx: Prisma.TransactionClient,
    activityId: string,
    actor: CurrentUserPayload,
  ): Promise<AppManagedSettlementSummaryDto> {
    // The real workbench uses scoped authz for this action; a GLOBAL-only check
    // would incorrectly deny owner and attendance-collaborator bindings.
    if (
      !(await this.authz.can(
        actor,
        SETTLEMENT_WORKBENCH_ACTION,
        {
          type: 'activity',
          id: activityId,
        },
        tx,
      ))
    ) {
      return { availability: 'forbidden' };
    }
    if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
      return { availability: 'workflow-disabled' };
    }
    const [run, activeClosure] = await Promise.all([
      tx.attendanceSettlementRun.findUnique({
        where: { activityId },
        select: { statusCode: true, currentSubmittedVersion: true },
      }),
      tx.activitySettlementClosureRevision.findFirst({
        where: { activityId, statusCode: 'active' },
        orderBy: { revision: 'desc' },
        select: { revision: true, closedAt: true },
      }),
    ]);
    return {
      availability: 'available',
      runStatus: run?.statusCode ?? null,
      currentSubmittedVersion: run?.currentSubmittedVersion ?? null,
      ...(activeClosure ? { activeClosure } : {}),
      readOnly: this.activityWorkflowGate.isReadonlyMaintenance(),
      workbenchPath: `/api/app/v1/my/managed-activities/${encodeURIComponent(activityId)}/settlement`,
    };
  }

  private async toProjection(row: ManagedActivityRow): Promise<AppManagedActivityProjectionDto> {
    const signed = await this.images.signImages(row);
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      allocationModeCode: row.allocationModeCode,
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: row.capacity,
      statusCode: row.statusCode,
      workflowRevision: row.workflowRevision,
      requiresInsurance: row.requiresInsurance,
      isPublicRegistration: row.isPublicRegistration,
      registrationModeCode: row.registrationModeCode,
      visibilityCode: row.visibilityCode,
      defaultCheckInRadiusMeters: row.defaultCheckInRadiusMeters,
      defaultLocationRequired: row.defaultLocationRequired,
      archiveWaitingDays: row.archiveWaitingDays,
      coverImageUrl: signed.coverImageUrl,
      galleryImageUrls: signed.galleryImageUrls ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

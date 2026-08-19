import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, MembershipStatus, OrganizationStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { isFormalMemberGradeCode } from '../members/member-grade';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityDraftService } from './activity-draft.service';
import type {
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from './activity-positions.dto';
import { ActivityPositionsService } from './activity-positions.service';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import type {
  ChangeReviewDto,
  SubmitActivityPublishReviewDto,
} from './activity-publish-review.dto';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';
import type {
  CreateActivityCollaboratorDto,
  TransferActivityInitiatorDto,
  TransferActivityOwnerDto,
} from './activity-responsibility.dto';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import type { CreateActivityDto, UpdateActivityDto } from './activities.dto';
import { ActivitiesService } from './activities.service';
import type {
  AppActivityChangePositionDto,
  AppActivityInitiationOrganizationOptionDto,
  AppCollaboratorOptionsQueryDto,
  AppCollaboratorOptionsResponseDto,
  AppManagedActivitiesQueryDto,
  AppManagedActivityDetailDto,
  AppManagedActivityProjectionDto,
} from './dto/app/app-managed-activity.dto';
import type {
  AppManagedActivitySessionPositionsQueryDto,
  AppManagedActivitySessionsQueryDto,
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
  UpdateAppManagedActivitySessionDto,
  UpdateAppManagedActivitySessionPositionDto,
} from './dto/app/app-managed-activity-draft.dto';

@Injectable()
export class AppManagedActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly activities: ActivitiesService,
    private readonly positions: ActivityPositionsService,
    private readonly drafts: ActivityDraftService,
    private readonly reviews: ActivityPublishReviewService,
    private readonly responsibilities: ActivityResponsibilityService,
    private readonly workflowQuery: ActivityWorkflowQueryService,
    private readonly auditRecorder: ActivityAuditRecorder,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async organizationOptions(
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<AppActivityInitiationOrganizationOptionDto[]> {
    await this.assertFormalMember(memberId);
    const now = new Date();
    const [memberships, crossOrgScope] = await Promise.all([
      this.prisma.memberOrganizationMembership.findMany({
        where: {
          memberId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
          startedAt: { lte: now },
          OR: [{ endedAt: null }, { endedAt: { gt: now } }],
          organization: {
            status: OrganizationStatus.ACTIVE,
            deletedAt: null,
            parentId: { not: null },
          },
        },
        select: {
          organizationId: true,
          membershipType: true,
          organization: { select: { id: true, name: true, parentId: true } },
        },
      }),
      this.authz.getVisibleOrganizationScope(user, 'activity.create.cross-org'),
    ]);
    const membershipByOrg = new Map(memberships.map((row) => [row.organizationId, row]));
    const crossOrgIds = crossOrgScope.hasPermission
      ? crossOrgScope.global
        ? undefined
        : crossOrgScope.organizationIds
      : [];
    const organizations = await this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.ACTIVE,
        deletedAt: null,
        parentId: { not: null },
        ...(crossOrgIds === undefined
          ? {}
          : { id: { in: [...new Set([...membershipByOrg.keys(), ...crossOrgIds])] } }),
      },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const closureRows =
      organizations.length === 0
        ? []
        : await this.prisma.organizationClosure.findMany({
            where: { descendantId: { in: organizations.map((organization) => organization.id) } },
            select: {
              descendantId: true,
              depth: true,
              ancestor: { select: { name: true } },
            },
            orderBy: [{ descendantId: 'asc' }, { depth: 'desc' }],
          });
    const pathPartsByOrg = new Map<string, string[]>();
    for (const row of closureRows) {
      const parts = pathPartsByOrg.get(row.descendantId) ?? [];
      parts.push(row.ancestor.name);
      pathPartsByOrg.set(row.descendantId, parts);
    }
    return organizations
      .filter((organization) => membershipByOrg.has(organization.id) || crossOrgScope.hasPermission)
      .map((organization) => {
        const membership = membershipByOrg.get(organization.id);
        return {
          organizationId: organization.id,
          name: organization.name,
          pathLabel: (pathPartsByOrg.get(organization.id) ?? [organization.name]).join(' / '),
          source: membership ? 'membership' : 'cross-org-grant',
          membershipType: membership?.membershipType ?? null,
        };
      });
  }

  async list(memberId: string, query: AppManagedActivitiesQueryDto) {
    return this.workflowQuery.list(memberId, query);
  }

  async detail(
    activityId: string,
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<AppManagedActivityDetailDto> {
    return this.workflowQuery.detail(activityId, memberId, user);
  }

  async create(
    dto: CreateActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!this.config.activityResponsibilityWorkflow.enabled) {
      // 开关关闭 = 本部署没上责任制工作流,与「考勤声明非法」(20039)毫无关系 ——
      // 那是历史误用的码,其真身在下面的 declareAttendanceComplete。
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED);
    }
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    // 仅兼容既有的 App 管理草稿默认字段；allocationModeCode 不在这里兜底，所有新建
    // 活动都必须由 DTO 与 ActivitiesService 显式确认闭集值。
    const normalizedDto: CreateActivityDto = {
      ...dto,
      registrationModeCode: dto.registrationModeCode ?? 'open_apply',
      visibilityCode: dto.visibilityCode ?? 'internal',
      defaultLocationRequired: dto.defaultLocationRequired ?? false,
    };
    this.assertManagedDraftConfiguration(normalizedDto);
    const created = await this.activities.create(normalizedDto, user, auditMeta, 'managed');
    return this.detail(created.id, user.memberId, user);
  }

  async update(
    activityId: string,
    dto: UpdateActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    await this.activities.update(activityId, dto, user, auditMeta, 'managed');
    return this.detail(activityId, user.memberId, user);
  }

  async softDelete(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityProjectionDto> {
    const deleted = await this.activities.softDelete(activityId, user, auditMeta, 'managed');
    return {
      id: deleted.id,
      title: deleted.title,
      activityTypeCode: deleted.activityTypeCode,
      allocationModeCode: deleted.allocationModeCode,
      organizationId: deleted.organizationId,
      startAt: deleted.startAt,
      endAt: deleted.endAt,
      location: deleted.location,
      description: deleted.description,
      capacity: deleted.capacity,
      statusCode: deleted.statusCode,
      workflowRevision: deleted.workflowRevision,
      requiresInsurance: deleted.requiresInsurance,
      isPublicRegistration: deleted.isPublicRegistration,
      registrationModeCode: deleted.registrationModeCode,
      visibilityCode: deleted.visibilityCode,
      defaultCheckInRadiusMeters: deleted.defaultCheckInRadiusMeters,
      defaultLocationRequired: deleted.defaultLocationRequired,
      archiveWaitingDays: deleted.archiveWaitingDays,
      createdAt: deleted.createdAt,
      updatedAt: deleted.updatedAt,
    };
  }

  async listSessions(
    activityId: string,
    query: AppManagedActivitySessionsQueryDto,
    user: CurrentUserPayload,
  ) {
    return this.drafts.listSessions(activityId, query, user);
  }

  async createSession(
    activityId: string,
    dto: CreateAppManagedActivitySessionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.createSession(activityId, dto, user, auditMeta);
  }

  async updateSession(
    activityId: string,
    sessionId: string,
    dto: UpdateAppManagedActivitySessionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.updateSession(activityId, sessionId, dto, user, auditMeta);
  }

  async deleteSession(
    activityId: string,
    sessionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.deleteSession(activityId, sessionId, user, auditMeta);
  }

  async listSessionPositions(
    activityId: string,
    sessionId: string,
    query: AppManagedActivitySessionPositionsQueryDto,
    user: CurrentUserPayload,
  ) {
    return this.drafts.listPositions(activityId, sessionId, query, user);
  }

  async createSessionPosition(
    activityId: string,
    sessionId: string,
    dto: CreateAppManagedActivitySessionPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.createPosition(activityId, sessionId, dto, user, auditMeta);
  }

  async updateSessionPosition(
    activityId: string,
    sessionId: string,
    positionId: string,
    dto: UpdateAppManagedActivitySessionPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.updatePosition(activityId, sessionId, positionId, dto, user, auditMeta);
  }

  async deleteSessionPosition(
    activityId: string,
    sessionId: string,
    positionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.drafts.deletePosition(activityId, sessionId, positionId, user, auditMeta);
  }

  async submitInitial(activityId: string, user: CurrentUserPayload, auditMeta: AuditMeta) {
    return this.reviews.submitInitial(activityId, user, auditMeta);
  }

  async submitInitialProposal(
    activityId: string,
    dto: SubmitActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.reviews.submitInitialProposal(activityId, dto, user, auditMeta);
  }

  async submitChange(
    activityId: string,
    activityPatch: UpdateActivityDto,
    positions: AppActivityChangePositionDto[] | undefined,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.reviews.submitChange(activityId, activityPatch, positions, user, auditMeta);
  }

  async submitChangeProposal(
    activityId: string,
    dto: ChangeReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.reviews.submitChangeProposal(activityId, dto, user, auditMeta);
  }

  async templateResolution(activityId: string, user: CurrentUserPayload) {
    return this.reviews.templateResolution(activityId, user);
  }

  async directPublish(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    await this.reviews.compatibilityPublish(
      activityId,
      { requiresInsuranceConfirmed: true },
      user,
      auditMeta,
    );
    return this.detail(activityId, user.memberId, user);
  }

  async withdraw(activityId: string, user: CurrentUserPayload, auditMeta: AuditMeta) {
    const pending = await this.prisma.activityPublishReview.findFirst({
      where: { activityId, status: 'pending', submittedByUserId: user.id },
      orderBy: { requestVersion: 'desc' },
      select: { id: true },
    });
    if (!pending) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    return this.reviews.withdraw(pending.id, user, auditMeta);
  }

  async declareAttendanceComplete(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    const memberId = user.memberId;
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Activity"
        WHERE id = ${activityId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const activity = await tx.activity.findFirst({
        where: {
          id: activityId,
          deletedAt: null,
          responsibilityAssignments: {
            some: {
              memberId,
              responsibilityType: 'owner',
              status: 'active',
            },
          },
        },
        select: {
          statusCode: true,
          endAt: true,
          attendanceDeclaredCompleteAt: true,
        },
      });
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const declaredAt = new Date();
      if (
        !['published', 'completed'].includes(activity.statusCode) ||
        activity.endAt.getTime() >= declaredAt.getTime() ||
        activity.attendanceDeclaredCompleteAt !== null
      ) {
        throw new BizException(BizCode.ACTIVITY_ATTENDANCE_DECLARATION_INVALID);
      }

      await tx.activity.update({
        where: { id: activityId },
        data: {
          attendanceDeclaredCompleteAt: declaredAt,
          attendanceDeclaredCompleteByUserId: user.id,
        },
      });
      await this.auditRecorder.logAttendanceDeclaration({
        activityId,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        declaredAt,
        auditMeta,
        tx,
      });
    });
    return this.detail(activityId, memberId, user);
  }

  async listPositions(activityId: string, memberId: string) {
    await this.workflowQuery.loadManaged(activityId, memberId);
    return this.positions.list(activityId);
  }

  async createPosition(
    activityId: string,
    dto: CreateActivityPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.create(activityId, dto, user, auditMeta, 'managed');
  }

  async updatePosition(
    activityId: string,
    activityPositionId: string,
    dto: UpdateActivityPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.update(activityId, activityPositionId, dto, user, auditMeta, 'managed');
  }

  async deletePosition(
    activityId: string,
    activityPositionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.softDelete(activityId, activityPositionId, user, auditMeta, 'managed');
  }

  /**
   * AC-030 —— 协办候选选择器。合同追踪矩阵 E07:「协作候选人搜索＋page/pageSize分页,
   * 取消200人截断」。改造前 `take: 200` 且无任何入参 ⇒ 第 201 个候选人不可达。
   *
   * 🔴 可见集合红线:下面这段 `where` 与改造前**逐字一致**;`q` 只能挂在 `AND` 上做
   *    收窄,绝不允许挂 `OR`(会放宽)也绝不允许改任何一个既有子句。本方法只让候选人
   *    「翻得到」,不改「看得到谁」—— 配套 spec 用「扩面前后可见 id 集合逐个相同」钉住。
   *
   * 🔴 合同 §11.4:过滤与排序全部在 SQL 里做;`eligibilitySource` 改用**当前页批量 IN**
   *    取,不再把整场 pass 报名的 memberId 拉进应用内存(改造前那一版对 10000 人活动会
   *    一次性取回 10000 行,正是 §11.4「不加载整场 identity ids 到应用内存」点名禁止的)。
   *    查询次数因此恒为 3 次(count + 当前页 + 当前页 IN),与总人数和页大小都无关。
   */
  async collaboratorOptions(
    activityId: string,
    memberId: string,
    query: AppCollaboratorOptionsQueryDto,
  ): Promise<AppCollaboratorOptionsResponseDto> {
    const activity = await this.workflowQuery.loadOwned(activityId, memberId);
    const now = new Date();
    const { page, pageSize } = query;
    // trim 在 DTO 层做;trim 完是空串等同于「没搜」,免得空串 contains 变成全表扫描的噪音。
    const keyword = query.q === undefined || query.q === '' ? undefined : query.q;

    const where: Prisma.MemberWhereInput = {
      status: MemberStatus.ACTIVE,
      deletedAt: null,
      users: { some: { status: 'ACTIVE', deletedAt: null } },
      activityResponsibilities: {
        none: { activityId, status: 'active' },
      },
      OR: [
        {
          activityRegistrations: {
            some: { activityId, statusCode: 'pass', deletedAt: null },
          },
        },
        {
          memberOrganizationMemberships: {
            some: {
              organizationId: activity.organizationId,
              status: MembershipStatus.ACTIVE,
              deletedAt: null,
              startedAt: { lte: now },
              OR: [{ endedAt: null }, { endedAt: { gt: now } }],
            },
          },
        },
      ],
      ...(keyword === undefined
        ? {}
        : {
            AND: [
              {
                OR: [
                  { displayName: { contains: keyword, mode: 'insensitive' as const } },
                  { memberNo: { contains: keyword, mode: 'insensitive' as const } },
                ],
              },
            ],
          }),
    };

    const [total, members] = await Promise.all([
      this.prisma.member.count({ where }),
      this.prisma.member.findMany({
        where,
        select: {
          id: true,
          memberNo: true,
          displayName: true,
          gradeCode: true,
        },
        orderBy: [{ memberNo: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 空页也照发这一次查询:查询次数必须与结果多少无关(不变量 3),不能省成条件分支。
    const participantRows = await this.prisma.activityRegistration.findMany({
      where: {
        activityId,
        statusCode: 'pass',
        deletedAt: null,
        memberId: { in: members.map((member) => member.id) },
      },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    const participantMemberIds = new Set(participantRows.map((row) => row.memberId));
    return {
      items: members.map((member) => ({
        id: member.id,
        memberNo: member.memberNo,
        displayName: member.displayName,
        gradeCode: member.gradeCode,
        eligibilitySource: participantMemberIds.has(member.id)
          ? 'participant'
          : 'organization-member',
      })),
      total,
      page,
      pageSize,
    };
  }

  async listResponsibilities(activityId: string, memberId: string) {
    return this.responsibilities.listManaged(activityId, memberId);
  }

  async addCollaborator(
    activityId: string,
    dto: CreateActivityCollaboratorDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.addCollaborator(activityId, dto, user, auditMeta, 'owner');
  }

  async endCollaborator(
    activityId: string,
    assignmentId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.endCollaborator(
      activityId,
      assignmentId,
      user,
      auditMeta,
      'owner',
    );
  }

  async transferOwner(
    activityId: string,
    dto: TransferActivityOwnerDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.transferOwner(activityId, dto, user, auditMeta, 'owner');
  }

  async transferInitiator(
    activityId: string,
    dto: TransferActivityInitiatorDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.transferInitiator(activityId, dto, user, auditMeta);
  }

  private assertManagedDraftConfiguration(dto: CreateActivityDto): void {
    const registrationModes = ['open_apply', 'invitation_only', 'admin_only', 'paused'];
    const visibilityModes = ['internal', 'invitation'];
    if (
      dto.registrationModeCode === undefined ||
      dto.visibilityCode === undefined ||
      dto.defaultLocationRequired === undefined ||
      !registrationModes.includes(dto.registrationModeCode) ||
      !visibilityModes.includes(dto.visibilityCode)
    ) {
      throw new BizException(BizCode.ACTIVITY_DRAFT_CONFIGURATION_INVALID);
    }
  }

  private async assertFormalMember(memberId: string): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, status: MemberStatus.ACTIVE, deletedAt: null },
      select: { gradeCode: true },
    });
    if (!isFormalMemberGradeCode(member?.gradeCode)) {
      throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    }
  }
}

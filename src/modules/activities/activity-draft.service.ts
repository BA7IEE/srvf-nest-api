import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, MemberStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import type {
  AppManagedActivitySessionDto,
  AppManagedActivitySessionPositionDto,
  AppManagedActivitySessionPositionsQueryDto,
  AppManagedActivitySessionsQueryDto,
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
  UpdateAppManagedActivitySessionDto,
  UpdateAppManagedActivitySessionPositionDto,
} from './dto/app/app-managed-activity-draft.dto';

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const DICT_TYPE_GENDER_REQUIREMENT = 'gender_requirement';

const DRAFT_ACTIVITY_SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  statusCode: true,
  initiatorMemberId: true,
} as const satisfies Prisma.ActivitySelect;

const SESSION_SELECT = {
  id: true,
  activityId: true,
  code: true,
  name: true,
  startAt: true,
  endAt: true,
  locationText: true,
  meetingPoint: true,
  executionPoint: true,
  evacuationPoint: true,
  longitude: true,
  latitude: true,
  capacity: true,
  checkInOpenAt: true,
  checkInCloseAt: true,
  checkOutOpenAt: true,
  checkOutCloseAt: true,
  preparationStartAt: true,
  locationRequired: true,
  radiusMeters: true,
  locationPolicySourceCode: true,
  accuracyWarningMeters: true,
  lateGraceMinutes: true,
  earlyLeaveThresholdMinutes: true,
  statusCode: true,
  workflowRevision: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivitySessionSelect;

const SESSION_POSITION_SELECT = {
  id: true,
  activityId: true,
  sessionId: true,
  code: true,
  name: true,
  attendanceRoleCode: true,
  capacity: true,
  startAt: true,
  endAt: true,
  genderRequirementCode: true,
  locationRequired: true,
  radiusMeters: true,
  leaderMemberId: true,
  description: true,
  equipmentNotes: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivitySessionPositionSelect;

type PrismaTx = Prisma.TransactionClient;
type DraftActivityRow = Prisma.ActivityGetPayload<{ select: typeof DRAFT_ACTIVITY_SELECT }>;
type SessionRow = Prisma.ActivitySessionGetPayload<{ select: typeof SESSION_SELECT }>;
type SessionPositionRow = Prisma.ActivitySessionPositionGetPayload<{
  select: typeof SESSION_POSITION_SELECT;
}>;

@Injectable()
export class ActivityDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ActivityDraftAuditRecorder,
  ) {}

  async listSessions(
    activityId: string,
    query: AppManagedActivitySessionsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AppManagedActivitySessionDto>> {
    await this.loadManagedActivity(activityId, user);
    const where = { activityId, deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activitySession.findMany({
        where,
        select: SESSION_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activitySession.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.toSessionDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createSession(
    activityId: string,
    dto: CreateAppManagedActivitySessionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockManagedDraftActivity(activityId, user, tx);
        await this.assertSessionCodeAvailable(tx, activityId, dto.code);
        await this.assertSessionNameAvailable(tx, activityId, dto.name);
        const input = this.createSessionInput(dto);
        this.assertSessionValid(activity, input);

        const created = await tx.activitySession.create({
          data: {
            activityId,
            code: dto.code,
            name: dto.name,
            startAt: input.startAt,
            endAt: input.endAt,
            locationText: dto.locationText,
            meetingPoint: dto.meetingPoint ?? null,
            executionPoint: dto.executionPoint ?? null,
            evacuationPoint: dto.evacuationPoint ?? null,
            longitude: input.longitude,
            latitude: input.latitude,
            capacity: input.capacity,
            checkInOpenAt: input.checkInOpenAt,
            checkInCloseAt: input.checkInCloseAt,
            checkOutOpenAt: input.checkOutOpenAt,
            checkOutCloseAt: input.checkOutCloseAt,
            preparationStartAt: input.preparationStartAt,
            locationRequired: input.locationRequired,
            radiusMeters: input.radiusMeters,
            locationPolicySourceCode: 'session',
            lateGraceMinutes: input.lateGraceMinutes,
            earlyLeaveThresholdMinutes: input.earlyLeaveThresholdMinutes,
            statusCode: 'scheduled',
            sortOrder: dto.sortOrder ?? 0,
          },
          select: SESSION_SELECT,
        });
        await this.audit.log({
          activityId,
          sessionId: created.id,
          operation: 'draft-session-create',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return this.toSessionDto(created);
      });
    } catch (error) {
      this.rethrowConstraint(error, 'session');
    }
  }

  async updateSession(
    activityId: string,
    sessionId: string,
    dto: UpdateAppManagedActivitySessionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockManagedDraftActivity(activityId, user, tx);
        const current = await this.findSessionOrThrow(tx, activityId, sessionId);
        if (dto.name !== undefined) {
          await this.assertSessionNameAvailable(tx, activityId, dto.name, sessionId);
        }
        const input = this.mergeSessionInput(current, dto);
        this.assertSessionValid(activity, input);

        const data: Prisma.ActivitySessionUncheckedUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.startAt !== undefined) data.startAt = input.startAt;
        if (dto.endAt !== undefined) data.endAt = input.endAt;
        if (dto.locationText !== undefined) data.locationText = dto.locationText;
        if (dto.meetingPoint !== undefined) data.meetingPoint = dto.meetingPoint;
        if (dto.executionPoint !== undefined) data.executionPoint = dto.executionPoint;
        if (dto.evacuationPoint !== undefined) data.evacuationPoint = dto.evacuationPoint;
        if (dto.longitude !== undefined) data.longitude = dto.longitude;
        if (dto.latitude !== undefined) data.latitude = dto.latitude;
        if (dto.capacity !== undefined) data.capacity = dto.capacity;
        if (dto.checkInOpenAt !== undefined) data.checkInOpenAt = input.checkInOpenAt;
        if (dto.checkInCloseAt !== undefined) data.checkInCloseAt = input.checkInCloseAt;
        if (dto.checkOutOpenAt !== undefined) data.checkOutOpenAt = input.checkOutOpenAt;
        if (dto.checkOutCloseAt !== undefined) data.checkOutCloseAt = input.checkOutCloseAt;
        if (dto.preparationStartAt !== undefined) {
          data.preparationStartAt = input.preparationStartAt;
        }
        if (dto.locationRequired !== undefined) data.locationRequired = dto.locationRequired;
        if (dto.radiusMeters !== undefined) data.radiusMeters = dto.radiusMeters;
        if (dto.lateGraceMinutes !== undefined) data.lateGraceMinutes = dto.lateGraceMinutes;
        if (dto.earlyLeaveThresholdMinutes !== undefined) {
          data.earlyLeaveThresholdMinutes = dto.earlyLeaveThresholdMinutes;
        }
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

        const updated = await tx.activitySession.update({
          where: { id: current.id },
          data,
          select: SESSION_SELECT,
        });
        await this.audit.log({
          activityId,
          sessionId: updated.id,
          operation: 'draft-session-update',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
          changedFields: Object.keys(dto),
        });
        return this.toSessionDto(updated);
      });
    } catch (error) {
      this.rethrowConstraint(error, 'session');
    }
  }

  async deleteSession(
    activityId: string,
    sessionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagedDraftActivity(activityId, user, tx);
      const current = await this.findSessionOrThrow(tx, activityId, sessionId);
      const identityCount = await tx.activityParticipationIdentity.count({
        where: { activityId, sessionId },
      });
      if (identityCount > 0) {
        throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
      }
      const deletedAt = new Date();
      const removed = await tx.activitySession.update({
        where: { id: current.id },
        data: { deletedAt },
        select: SESSION_SELECT,
      });
      await tx.activitySessionPosition.updateMany({
        where: { activityId, sessionId, deletedAt: null },
        data: { deletedAt },
      });
      await this.audit.log({
        activityId,
        sessionId,
        operation: 'draft-session-delete',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      return this.toSessionDto(removed);
    });
  }

  async listPositions(
    activityId: string,
    sessionId: string,
    query: AppManagedActivitySessionPositionsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AppManagedActivitySessionPositionDto>> {
    await this.loadManagedActivity(activityId, user);
    const session = await this.prisma.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const where = { activityId, sessionId, deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activitySessionPosition.findMany({
        where,
        select: SESSION_POSITION_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activitySessionPosition.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.toPositionDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createPosition(
    activityId: string,
    sessionId: string,
    dto: CreateAppManagedActivitySessionPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionPositionDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockManagedDraftActivity(activityId, user, tx);
        const session = await this.findSessionOrThrow(tx, activityId, sessionId);
        await this.assertPositionCodeAvailable(tx, sessionId, dto.code);
        await this.assertPositionNameAvailable(tx, sessionId, dto.name);
        await this.assertDictionaryItemValid(
          tx,
          DICT_TYPE_ATTENDANCE_ROLE,
          dto.attendanceRoleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
        );
        if (dto.genderRequirementCode !== undefined && dto.genderRequirementCode !== null) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_GENDER_REQUIREMENT,
            dto.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          );
        }
        if (dto.leaderMemberId !== undefined && dto.leaderMemberId !== null) {
          await this.assertActiveLeader(tx, dto.leaderMemberId);
        }
        const input = this.createPositionInput(dto);
        this.assertPositionValid(session, input);

        const created = await tx.activitySessionPosition.create({
          data: {
            activityId,
            sessionId,
            code: dto.code,
            name: dto.name,
            attendanceRoleCode: dto.attendanceRoleCode,
            capacity: input.capacity,
            startAt: input.startAt,
            endAt: input.endAt,
            genderRequirementCode: dto.genderRequirementCode ?? null,
            locationRequired: dto.locationRequired ?? null,
            radiusMeters: input.radiusMeters,
            leaderMemberId: dto.leaderMemberId ?? null,
            description: dto.description ?? null,
            equipmentNotes: dto.equipmentNotes ?? null,
            sortOrder: dto.sortOrder ?? 0,
          },
          select: SESSION_POSITION_SELECT,
        });
        await this.audit.log({
          activityId,
          sessionId,
          positionId: created.id,
          operation: 'draft-session-position-create',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return this.toPositionDto(created);
      });
    } catch (error) {
      this.rethrowConstraint(error, 'position');
    }
  }

  async updatePosition(
    activityId: string,
    sessionId: string,
    positionId: string,
    dto: UpdateAppManagedActivitySessionPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionPositionDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockManagedDraftActivity(activityId, user, tx);
        const session = await this.findSessionOrThrow(tx, activityId, sessionId);
        const current = await this.findPositionOrThrow(tx, activityId, sessionId, positionId);
        if (dto.name !== undefined) {
          await this.assertPositionNameAvailable(tx, sessionId, dto.name, positionId);
        }
        if (dto.attendanceRoleCode !== undefined) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_ATTENDANCE_ROLE,
            dto.attendanceRoleCode,
            BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          );
        }
        if (dto.genderRequirementCode !== undefined && dto.genderRequirementCode !== null) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_GENDER_REQUIREMENT,
            dto.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          );
        }
        if (dto.leaderMemberId !== undefined && dto.leaderMemberId !== null) {
          await this.assertActiveLeader(tx, dto.leaderMemberId);
        }
        const input = this.mergePositionInput(current, dto);
        this.assertPositionValid(session, input);

        const data: Prisma.ActivitySessionPositionUncheckedUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.attendanceRoleCode !== undefined) {
          data.attendanceRoleCode = dto.attendanceRoleCode;
        }
        if (dto.capacity !== undefined) data.capacity = dto.capacity;
        if (dto.startAt !== undefined) data.startAt = input.startAt;
        if (dto.endAt !== undefined) data.endAt = input.endAt;
        if (dto.genderRequirementCode !== undefined) {
          data.genderRequirementCode = dto.genderRequirementCode;
        }
        if (dto.locationRequired !== undefined) data.locationRequired = dto.locationRequired;
        if (dto.radiusMeters !== undefined) data.radiusMeters = dto.radiusMeters;
        if (dto.leaderMemberId !== undefined) data.leaderMemberId = dto.leaderMemberId;
        if (dto.description !== undefined) data.description = dto.description;
        if (dto.equipmentNotes !== undefined) data.equipmentNotes = dto.equipmentNotes;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

        const updated = await tx.activitySessionPosition.update({
          where: { id: current.id },
          data,
          select: SESSION_POSITION_SELECT,
        });
        await this.audit.log({
          activityId,
          sessionId,
          positionId: updated.id,
          operation: 'draft-session-position-update',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
          changedFields: Object.keys(dto),
        });
        return this.toPositionDto(updated);
      });
    } catch (error) {
      this.rethrowConstraint(error, 'position');
    }
  }

  async deletePosition(
    activityId: string,
    sessionId: string,
    positionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivitySessionPositionDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockManagedDraftActivity(activityId, user, tx);
      await this.findSessionOrThrow(tx, activityId, sessionId);
      const current = await this.findPositionOrThrow(tx, activityId, sessionId, positionId);
      const identityCount = await tx.activityParticipationIdentity.count({
        where: { activityId, sessionId, currentPositionId: positionId },
      });
      if (identityCount > 0) {
        throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
      }
      const removed = await tx.activitySessionPosition.update({
        where: { id: current.id },
        data: { deletedAt: new Date() },
        select: SESSION_POSITION_SELECT,
      });
      await this.audit.log({
        activityId,
        sessionId,
        positionId,
        operation: 'draft-session-position-delete',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      return this.toPositionDto(removed);
    });
  }

  private currentMemberId(user: CurrentUserPayload): string {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    return user.memberId;
  }

  private managedActivityWhere(
    activityId: string,
    user: CurrentUserPayload,
  ): Prisma.ActivityWhereInput {
    if (user.role === Role.SUPER_ADMIN) return { id: activityId, deletedAt: null };
    return {
      id: activityId,
      deletedAt: null,
      initiatorMemberId: this.currentMemberId(user),
    };
  }

  private async loadManagedActivity(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<DraftActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: DRAFT_ACTIVITY_SELECT,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async lockManagedDraftActivity(
    activityId: string,
    user: CurrentUserPayload,
    tx: PrismaTx,
  ): Promise<DraftActivityRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const activity = await tx.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: DRAFT_ACTIVITY_SELECT,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (activity.statusCode !== 'draft') {
      throw new BizException(
        activity.statusCode === 'published'
          ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
          : BizCode.ACTIVITY_STATUS_INVALID,
      );
    }
    return activity;
  }

  private async findSessionOrThrow(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null },
      select: SESSION_SELECT,
    });
    if (!session) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return session;
  }

  private async findPositionOrThrow(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    positionId: string,
  ): Promise<SessionPositionRow> {
    const position = await tx.activitySessionPosition.findFirst({
      where: { id: positionId, activityId, sessionId, deletedAt: null },
      select: SESSION_POSITION_SELECT,
    });
    if (!position) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return position;
  }

  private async assertSessionCodeAvailable(
    tx: PrismaTx,
    activityId: string,
    code: string,
  ): Promise<void> {
    const existing = await tx.activitySession.findFirst({
      where: { activityId, code, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS);
  }

  private async assertSessionNameAvailable(
    tx: PrismaTx,
    activityId: string,
    name: string,
    excludedSessionId?: string,
  ): Promise<void> {
    const existing = await tx.activitySession.findFirst({
      where: {
        activityId,
        name,
        deletedAt: null,
        ...(excludedSessionId === undefined ? {} : { id: { not: excludedSessionId } }),
      },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS);
  }

  private async assertPositionCodeAvailable(
    tx: PrismaTx,
    sessionId: string,
    code: string,
  ): Promise<void> {
    const existing = await tx.activitySessionPosition.findFirst({
      where: { sessionId, code, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS);
  }

  private async assertPositionNameAvailable(
    tx: PrismaTx,
    sessionId: string,
    name: string,
    excludedPositionId?: string,
  ): Promise<void> {
    const existing = await tx.activitySessionPosition.findFirst({
      where: {
        sessionId,
        name,
        deletedAt: null,
        ...(excludedPositionId === undefined ? {} : { id: { not: excludedPositionId } }),
      },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS);
  }

  private async assertDictionaryItemValid(
    tx: PrismaTx,
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
  ): Promise<void> {
    const item = await tx.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: { code: typeCode, status: DictTypeStatus.ACTIVE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  private async assertActiveLeader(tx: PrismaTx, memberId: string): Promise<void> {
    const member = await tx.member.findFirst({
      where: { id: memberId, status: MemberStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
  }

  private createSessionInput(dto: CreateAppManagedActivitySessionDto) {
    return {
      startAt: this.toDate(dto.startAt, BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID),
      endAt: this.toDate(dto.endAt, BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID),
      longitude: dto.longitude ?? null,
      latitude: dto.latitude ?? null,
      capacity: dto.capacity ?? null,
      checkInOpenAt: this.toDate(dto.checkInOpenAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkInCloseAt: this.toDate(dto.checkInCloseAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkOutOpenAt: this.toDate(dto.checkOutOpenAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkOutCloseAt: this.toDate(dto.checkOutCloseAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      preparationStartAt:
        dto.preparationStartAt === undefined || dto.preparationStartAt === null
          ? null
          : this.toDate(dto.preparationStartAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      locationRequired: dto.locationRequired,
      radiusMeters: dto.radiusMeters ?? null,
      lateGraceMinutes: dto.lateGraceMinutes ?? 15,
      earlyLeaveThresholdMinutes: dto.earlyLeaveThresholdMinutes ?? 15,
    };
  }

  private mergeSessionInput(current: SessionRow, dto: UpdateAppManagedActivitySessionDto) {
    return {
      startAt:
        dto.startAt === undefined
          ? current.startAt
          : this.toDate(dto.startAt, BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID),
      endAt:
        dto.endAt === undefined
          ? current.endAt
          : this.toDate(dto.endAt, BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID),
      longitude: dto.longitude === undefined ? current.longitude : dto.longitude,
      latitude: dto.latitude === undefined ? current.latitude : dto.latitude,
      capacity: dto.capacity === undefined ? current.capacity : dto.capacity,
      checkInOpenAt:
        dto.checkInOpenAt === undefined
          ? current.checkInOpenAt
          : this.toDate(dto.checkInOpenAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkInCloseAt:
        dto.checkInCloseAt === undefined
          ? current.checkInCloseAt
          : this.toDate(dto.checkInCloseAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkOutOpenAt:
        dto.checkOutOpenAt === undefined
          ? current.checkOutOpenAt
          : this.toDate(dto.checkOutOpenAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      checkOutCloseAt:
        dto.checkOutCloseAt === undefined
          ? current.checkOutCloseAt
          : this.toDate(dto.checkOutCloseAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      preparationStartAt:
        dto.preparationStartAt === undefined
          ? current.preparationStartAt
          : dto.preparationStartAt === null
            ? null
            : this.toDate(dto.preparationStartAt, BizCode.ACTIVITY_SESSION_WINDOW_INVALID),
      locationRequired:
        dto.locationRequired === undefined ? current.locationRequired : dto.locationRequired,
      radiusMeters: dto.radiusMeters === undefined ? current.radiusMeters : dto.radiusMeters,
      lateGraceMinutes:
        dto.lateGraceMinutes === undefined ? current.lateGraceMinutes : dto.lateGraceMinutes,
      earlyLeaveThresholdMinutes:
        dto.earlyLeaveThresholdMinutes === undefined
          ? current.earlyLeaveThresholdMinutes
          : dto.earlyLeaveThresholdMinutes,
    };
  }

  private assertSessionValid(
    activity: DraftActivityRow,
    input: {
      startAt: Date;
      endAt: Date;
      longitude: unknown;
      latitude: unknown;
      capacity: number | null;
      checkInOpenAt: Date;
      checkInCloseAt: Date;
      checkOutOpenAt: Date;
      checkOutCloseAt: Date;
      preparationStartAt: Date | null;
      locationRequired: boolean;
      radiusMeters: number | null;
      lateGraceMinutes: number;
      earlyLeaveThresholdMinutes: number;
    },
  ): void {
    if (
      input.startAt.getTime() >= input.endAt.getTime() ||
      input.startAt.getTime() < activity.startAt.getTime() ||
      input.endAt.getTime() > activity.endAt.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID);
    }
    if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
      throw new BizException(BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
    }
    if (
      input.checkInOpenAt.getTime() > input.checkInCloseAt.getTime() ||
      input.checkInCloseAt.getTime() > input.checkOutCloseAt.getTime() ||
      input.checkOutOpenAt.getTime() > input.checkOutCloseAt.getTime() ||
      (input.preparationStartAt !== null &&
        input.preparationStartAt.getTime() > input.startAt.getTime()) ||
      !Number.isInteger(input.lateGraceMinutes) ||
      !Number.isInteger(input.earlyLeaveThresholdMinutes) ||
      input.lateGraceMinutes < 0 ||
      input.lateGraceMinutes > 60 ||
      input.earlyLeaveThresholdMinutes < 0 ||
      input.earlyLeaveThresholdMinutes > 60
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
    }
    const coordinatesPaired = (input.longitude === null) === (input.latitude === null);
    if (
      !coordinatesPaired ||
      (input.locationRequired &&
        (input.radiusMeters === null ||
          input.radiusMeters < 50 ||
          input.radiusMeters > 10000 ||
          input.longitude === null ||
          input.latitude === null)) ||
      (!input.locationRequired && input.radiusMeters !== null)
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID);
    }
  }

  private createPositionInput(dto: CreateAppManagedActivitySessionPositionDto) {
    return {
      capacity: dto.capacity ?? null,
      startAt:
        dto.startAt === undefined || dto.startAt === null
          ? null
          : this.toDate(dto.startAt, BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID),
      endAt:
        dto.endAt === undefined || dto.endAt === null
          ? null
          : this.toDate(dto.endAt, BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID),
      locationRequired: dto.locationRequired ?? null,
      radiusMeters: dto.radiusMeters ?? null,
    };
  }

  private mergePositionInput(
    current: SessionPositionRow,
    dto: UpdateAppManagedActivitySessionPositionDto,
  ) {
    return {
      capacity: dto.capacity === undefined ? current.capacity : dto.capacity,
      startAt:
        dto.startAt === undefined
          ? current.startAt
          : dto.startAt === null
            ? null
            : this.toDate(dto.startAt, BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID),
      endAt:
        dto.endAt === undefined
          ? current.endAt
          : dto.endAt === null
            ? null
            : this.toDate(dto.endAt, BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID),
      locationRequired:
        dto.locationRequired === undefined ? current.locationRequired : dto.locationRequired,
      radiusMeters: dto.radiusMeters === undefined ? current.radiusMeters : dto.radiusMeters,
    };
  }

  private assertPositionValid(
    session: SessionRow,
    input: {
      capacity: number | null;
      startAt: Date | null;
      endAt: Date | null;
      locationRequired: boolean | null;
      radiusMeters: number | null;
    },
  ): void {
    if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
    }
    if (
      (input.startAt === null) !== (input.endAt === null) ||
      (input.startAt !== null &&
        input.endAt !== null &&
        (input.startAt.getTime() >= input.endAt.getTime() ||
          input.startAt.getTime() < session.startAt.getTime() ||
          input.endAt.getTime() > session.endAt.getTime()))
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID);
    }
    if (
      (input.locationRequired === false && input.radiusMeters !== null) ||
      (input.radiusMeters !== null &&
        (!Number.isInteger(input.radiusMeters) ||
          input.radiusMeters < 50 ||
          input.radiusMeters > 10000))
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID);
    }
  }

  private toDate(value: string, biz: BizCodeEntry): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BizException(biz);
    return date;
  }

  private rethrowConstraint(error: unknown, target: 'session' | 'position'): never {
    const knownError = error instanceof Prisma.PrismaClientKnownRequestError ? error : undefined;
    const metaText = (value: unknown): string => {
      if (typeof value === 'string') return value;
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').join(' ')
        : '';
    };
    const details = [
      metaText(knownError?.meta?.target),
      metaText(knownError?.meta?.database_error),
      error instanceof Error ? error.message : '',
    ]
      .join(' ')
      .toLowerCase();
    if (knownError) {
      if (knownError.code === 'P2002') {
        if (target === 'session') {
          throw new BizException(
            details.includes('name')
              ? BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS
              : BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS,
          );
        }
        throw new BizException(
          details.includes('name')
            ? BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS
            : BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS,
        );
      }
      if (knownError.code === 'P2003') throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    // Prisma 对 PostgreSQL CHECK 既可能给 P2004，也可能保留底层 23514 文本为
    // PrismaClientUnknownRequestError；两个出口都必须稳定映射，不能把后者漏成 500。
    if (
      knownError?.code === 'P2004' ||
      details.includes('violates check constraint') ||
      details.includes('check constraint')
    ) {
      if (target === 'session') {
        if (details.includes('capacity')) {
          throw new BizException(BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
        }
        if (details.includes('time_range')) {
          throw new BizException(BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID);
        }
        if (
          details.includes('location') ||
          details.includes('coordinate') ||
          details.includes('policy_source')
        ) {
          throw new BizException(BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID);
        }
        throw new BizException(BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
      }
      if (details.includes('capacity')) {
        throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
      }
      if (details.includes('time_pair')) {
        throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID);
      }
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID);
    }
    throw error;
  }

  private toSessionDto(row: SessionRow): AppManagedActivitySessionDto {
    return {
      sessionId: row.id,
      activityId: row.activityId,
      code: row.code,
      name: row.name,
      startAt: row.startAt,
      endAt: row.endAt,
      locationText: row.locationText,
      meetingPoint: row.meetingPoint,
      executionPoint: row.executionPoint,
      evacuationPoint: row.evacuationPoint,
      capacity: row.capacity,
      checkInOpenAt: row.checkInOpenAt,
      checkInCloseAt: row.checkInCloseAt,
      checkOutOpenAt: row.checkOutOpenAt,
      checkOutCloseAt: row.checkOutCloseAt,
      preparationStartAt: row.preparationStartAt,
      locationRequired: row.locationRequired,
      radiusMeters: row.radiusMeters,
      locationPolicySourceCode: row.locationPolicySourceCode,
      accuracyWarningMeters: row.accuracyWarningMeters,
      lateGraceMinutes: row.lateGraceMinutes,
      earlyLeaveThresholdMinutes: row.earlyLeaveThresholdMinutes,
      statusCode: row.statusCode,
      workflowRevision: row.workflowRevision,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toPositionDto(row: SessionPositionRow): AppManagedActivitySessionPositionDto {
    return {
      positionId: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      code: row.code,
      name: row.name,
      attendanceRoleCode: row.attendanceRoleCode,
      capacity: row.capacity,
      startAt: row.startAt,
      endAt: row.endAt,
      genderRequirementCode: row.genderRequirementCode,
      locationRequired: row.locationRequired,
      radiusMeters: row.radiusMeters,
      leaderMemberId: row.leaderMemberId,
      description: row.description,
      equipmentNotes: row.equipmentNotes,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

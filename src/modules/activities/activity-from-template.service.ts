import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityTemplateDefinitionV1Error,
  parseActivityTemplateDefinitionV1,
  type ActivityTemplateDefinitionV1,
} from './activity-template-definition-v1';
import {
  ActivityAccessService,
  ACTIVITY_STATUS_DRAFT,
  DICT_TYPE_ACTIVITY_TYPE,
  DICT_TYPE_GENDER_REQUIREMENT,
  activitySafeSelect,
  type ActivityFullRow,
} from './activity-access.service';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityResponseDto } from './activities.dto';
import { toResponseDto } from './activity-presenter';
import { matchesActivityTemplateDefinitionHash } from './activity-template-definition';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const CREATE_FROM_TEMPLATE_OPERATION = 'activity.create.from_template';
const CREATE_FROM_TEMPLATE_UNIQUE_INDEX = 'activity_create_from_template_operation_key_key';
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * A6 仅是模块内 application command，刻意不做 HTTP DTO / Swagger / Controller。
 * B6 接外部入口时必须先把其 DTO 显式转换为这个闭合输入，不能直接把请求体透传进来。
 */
export interface CreateActivityFromTemplateCommand {
  readonly templateVersionId: string;
  readonly title: string;
  readonly organizationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly location: string;
  readonly registrationDeadline?: string | null;
  readonly initiatorMemberId?: string;
  readonly operationKey: string;
}

interface NormalizedCreateActivityFromTemplateCommand {
  readonly templateVersionId: string;
  readonly title: string;
  readonly organizationId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly location: string;
  readonly registrationDeadline: Date | null;
  readonly initiatorMemberId: string | undefined;
  readonly operationKey: string;
}

interface LockedTemplateVersion {
  readonly id: string;
  readonly familyId: string | null;
  readonly activityTypeCode: string;
  readonly statusCode: string;
  readonly schemaVersion: number | null;
  readonly definitionJson: Prisma.JsonValue | null;
  readonly definitionHash: string | null;
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
}

interface MaterializedSessionPosition {
  readonly code: string;
  readonly name: string;
  readonly attendanceRoleCode: string;
  readonly capacity: number | null;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly genderRequirementCode: string | null;
  readonly locationRequired: boolean | null;
  readonly radiusMeters: number | null;
  readonly description: string | null;
  readonly equipmentNotes: string | null;
  readonly sortOrder: number;
}

interface MaterializedSession {
  readonly code: string;
  readonly name: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly locationText: string;
  readonly capacity: number | null;
  readonly checkInOpenAt: Date;
  readonly checkInCloseAt: Date;
  readonly checkOutOpenAt: Date;
  readonly checkOutCloseAt: Date;
  readonly preparationStartAt: Date | null;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveThresholdMinutes: number;
  readonly sortOrder: number;
  readonly positions: readonly MaterializedSessionPosition[];
}

function badRequest(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function requireString(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) badRequest();
  return value;
}

function requireDate(value: unknown): Date {
  if (typeof value !== 'string') badRequest();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) badRequest();
  return date;
}

function optionalDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  return requireDate(value);
}

function addMinutes(base: Date, offsetMinutes: number): Date {
  const timestamp = base.getTime() + offsetMinutes * MILLISECONDS_PER_MINUTE;
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(timestamp)) {
    throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
  }
  return date;
}

function toHashPayload(
  command: NormalizedCreateActivityFromTemplateCommand,
  actorUserId: string,
  definitionHash: string,
): CanonicalValue {
  return {
    action: CREATE_FROM_TEMPLATE_OPERATION,
    actorUserId,
    operationKey: command.operationKey,
    templateVersionId: command.templateVersionId,
    definitionHash,
    title: command.title,
    organizationId: command.organizationId,
    startAt: command.startAt.toISOString(),
    endAt: command.endAt.toISOString(),
    location: command.location,
    registrationDeadline: command.registrationDeadline?.toISOString() ?? null,
    initiatorMemberId: command.initiatorMemberId ?? null,
  };
}

function buildRequestHash(
  command: NormalizedCreateActivityFromTemplateCommand,
  actorUserId: string,
  definitionHash: string,
): string {
  return createHash('sha256')
    .update(canonicalize(toHashPayload(command, actorUserId, definitionHash)), 'utf8')
    .digest('hex');
}

@Injectable()
export class ActivityFromTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityAccessService,
    private readonly allocationModes: ActivityAllocationModeService,
    private readonly initiationPolicy: ActivityInitiationPolicy,
    private readonly auditRecorder: ActivityAuditRecorder,
    private readonly images: ActivityImageSigningService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /**
   * 唯一写入口：权限 → 同一事务内幂等 / 模板锁 / 复制 / 审计。
   *
   * `ActivityWriteService.create` 与 `ActivityDraftService` 都各自拥有 transaction，不能在
   * 这里嵌套调用；A6 必须让 Activity、sessions、positions 与 audit 成败一致。
   */
  async createFromTemplate(
    command: CreateActivityFromTemplateCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.access.assertCanOrThrow(user, 'activity.create.record');
    const input = this.normalizeCommand(command);

    let row: ActivityFullRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // 幂等重放必须先于「当前模板是否可选」判定。已成功命令在模板后来 retired 后仍返回原结果。
        const replay = await this.findReplay(tx, input, user.id);
        if (replay) return replay;

        const template = await this.lockTemplateVersion(tx, input.templateVersionId);
        const { definition, definitionHash } = this.selectDefinitionOrThrow(template);
        const requestHash = buildRequestHash(input, user.id, definitionHash);

        this.allocationModes.assertValidMode(definition.activity.allocationModeCode);
        this.access.assertStartEndValid(input.startAt, input.endAt);
        this.access.assertRegistrationDeadlineValid(input.registrationDeadline, input.endAt);
        const sessions = this.materializeSessions(definition, input.startAt, input.endAt);
        await this.access.assertDictItemValid(
          DICT_TYPE_ACTIVITY_TYPE,
          template.activityTypeCode,
          BizCode.ACTIVITY_TYPE_CODE_INVALID,
          tx,
        );
        if (
          definition.activity.genderRequirementCode !== undefined &&
          definition.activity.genderRequirementCode !== null
        ) {
          await this.access.assertDictItemValid(
            DICT_TYPE_GENDER_REQUIREMENT,
            definition.activity.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
            tx,
          );
        }
        await this.access.assertOrganizationValidAndNonRoot(input.organizationId, tx);
        await this.assertMaterializedReferences(tx, sessions);

        const initiatorMemberId = this.config.activityResponsibilityWorkflow.enabled
          ? await this.initiationPolicy.resolveInitiator(
              user,
              input.organizationId,
              input.initiatorMemberId,
              tx,
            )
          : undefined;
        const created = await tx.activity.create({
          data: this.activityCreateData({
            input,
            templateVersionId: template.id,
            activityTypeCode: template.activityTypeCode,
            definition,
            requestHash,
            initiatorMemberId,
          }),
          select: activitySafeSelect,
        });

        for (const session of sessions) {
          const createdSession = await tx.activitySession.create({
            data: {
              activityId: created.id,
              code: session.code,
              name: session.name,
              startAt: session.startAt,
              endAt: session.endAt,
              locationText: session.locationText,
              meetingPoint: null,
              executionPoint: null,
              evacuationPoint: null,
              longitude: null,
              latitude: null,
              capacity: session.capacity,
              checkInOpenAt: session.checkInOpenAt,
              checkInCloseAt: session.checkInCloseAt,
              checkOutOpenAt: session.checkOutOpenAt,
              checkOutCloseAt: session.checkOutCloseAt,
              preparationStartAt: session.preparationStartAt,
              locationRequired: false,
              radiusMeters: null,
              locationPolicySourceCode: 'template',
              lateGraceMinutes: session.lateGraceMinutes,
              earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
              statusCode: 'scheduled',
              sortOrder: session.sortOrder,
            },
            select: { id: true },
          });
          for (const position of session.positions) {
            await tx.activitySessionPosition.create({
              data: {
                activityId: created.id,
                sessionId: createdSession.id,
                code: position.code,
                name: position.name,
                attendanceRoleCode: position.attendanceRoleCode,
                capacity: position.capacity,
                startAt: position.startAt,
                endAt: position.endAt,
                genderRequirementCode: position.genderRequirementCode,
                locationRequired: position.locationRequired,
                radiusMeters: position.radiusMeters,
                leaderMemberId: null,
                description: position.description,
                equipmentNotes: position.equipmentNotes,
                sortOrder: position.sortOrder,
              },
            });
          }
        }

        await this.auditRecorder.logCreateFromTemplate({
          created,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          templateVersionId: template.id,
          definitionHash,
          nextStatusCode: ACTIVITY_STATUS_DRAFT,
          auditMeta,
          tx,
        });
        return created;
      });
    } catch (error) {
      if (!this.isOperationKeyConflict(error)) throw error;
      const replay = await this.prisma.$transaction((tx) => this.findReplay(tx, input, user.id));
      if (!replay) {
        throw new BizException(BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT);
      }
      row = replay;
    }

    return toResponseDto(row, await this.images.signImages(row));
  }

  private normalizeCommand(
    command: CreateActivityFromTemplateCommand,
  ): NormalizedCreateActivityFromTemplateCommand {
    if (command === null || typeof command !== 'object' || Array.isArray(command)) badRequest();
    const input = command as unknown as Record<string, unknown>;
    const allowedKeys = new Set([
      'templateVersionId',
      'title',
      'organizationId',
      'startAt',
      'endAt',
      'location',
      'registrationDeadline',
      'initiatorMemberId',
      'operationKey',
    ]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) badRequest();
    const initiatorMemberId = input.initiatorMemberId;
    if (
      initiatorMemberId !== undefined &&
      (typeof initiatorMemberId !== 'string' ||
        initiatorMemberId.length < 8 ||
        initiatorMemberId.length > 64)
    ) {
      badRequest();
    }
    return {
      templateVersionId: requireString(input.templateVersionId, 8, 64),
      title: requireString(input.title, 1, 200),
      organizationId: requireString(input.organizationId, 8, 64),
      startAt: requireDate(input.startAt),
      endAt: requireDate(input.endAt),
      location: requireString(input.location, 1, 200),
      registrationDeadline: optionalDate(input.registrationDeadline),
      initiatorMemberId,
      operationKey: requireString(input.operationKey, 8, 128),
    };
  }

  private async findReplay(
    tx: Prisma.TransactionClient,
    input: NormalizedCreateActivityFromTemplateCommand,
    actorUserId: string,
  ): Promise<ActivityFullRow | null> {
    const existing = await tx.activity.findUnique({
      where: { createFromTemplateOperationKey: input.operationKey },
      select: {
        ...activitySafeSelect,
        createFromTemplateRequestHash: true,
        selectedTemplateVersion: {
          select: { definitionHash: true },
        },
      },
    });
    if (!existing) return null;
    const definitionHash = existing.selectedTemplateVersion?.definitionHash;
    if (typeof definitionHash !== 'string') {
      throw new BizException(BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT);
    }
    const expectedRequestHash = buildRequestHash(input, actorUserId, definitionHash);
    if (existing.createFromTemplateRequestHash !== expectedRequestHash) {
      throw new BizException(BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT);
    }
    return existing;
  }

  private async lockTemplateVersion(
    tx: Prisma.TransactionClient,
    templateVersionId: string,
  ): Promise<LockedTemplateVersion> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ActivityTemplate"
      WHERE "id" = ${templateVersionId}
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
    }
    const template = await tx.activityTemplate.findUnique({
      where: { id: templateVersionId },
      select: {
        id: true,
        familyId: true,
        activityTypeCode: true,
        statusCode: true,
        schemaVersion: true,
        definitionJson: true,
        definitionHash: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    if (!template) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
    return template;
  }

  private selectDefinitionOrThrow(template: LockedTemplateVersion): {
    definition: ActivityTemplateDefinitionV1;
    definitionHash: string;
  } {
    if (
      template.familyId === null ||
      template.statusCode !== 'active' ||
      template.schemaVersion !== 1 ||
      template.definitionJson === null ||
      template.definitionHash === null ||
      template.effectiveFrom === null ||
      Number.isNaN(template.effectiveFrom.getTime()) ||
      (template.effectiveTo !== null &&
        (Number.isNaN(template.effectiveTo.getTime()) ||
          template.effectiveTo.getTime() <= template.effectiveFrom.getTime()))
    ) {
      throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
    }
    try {
      if (
        !matchesActivityTemplateDefinitionHash(
          { schemaVersion: template.schemaVersion, definition: template.definitionJson },
          template.definitionHash,
        )
      ) {
        throw new ActivityTemplateDefinitionV1Error('definitionHash', 'does not match definition');
      }
      return {
        definition: parseActivityTemplateDefinitionV1(template.definitionJson),
        definitionHash: template.definitionHash,
      };
    } catch (error) {
      if (error instanceof ActivityTemplateDefinitionV1Error || error instanceof TypeError) {
        throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
      }
      throw error;
    }
  }

  private materializeSessions(
    definition: ActivityTemplateDefinitionV1,
    activityStartAt: Date,
    activityEndAt: Date,
  ): readonly MaterializedSession[] {
    return definition.sessions.map((session) => {
      const startAt = addMinutes(activityStartAt, session.startOffsetMinutes);
      const endAt = addMinutes(activityStartAt, session.endOffsetMinutes);
      const checkInOpenAt = addMinutes(startAt, session.checkInOpenOffsetMinutes);
      const checkInCloseAt = addMinutes(startAt, session.checkInCloseOffsetMinutes);
      const checkOutOpenAt = addMinutes(endAt, session.checkOutOpenOffsetMinutes);
      const checkOutCloseAt = addMinutes(endAt, session.checkOutCloseOffsetMinutes);
      const preparationStartAt =
        session.preparationStartOffsetMinutes === undefined ||
        session.preparationStartOffsetMinutes === null
          ? null
          : addMinutes(startAt, session.preparationStartOffsetMinutes);
      const positions = session.positions.map((position) => {
        const startOffset = position.startOffsetMinutes;
        const endOffset = position.endOffsetMinutes;
        const startAt =
          startOffset === undefined || startOffset === null
            ? null
            : addMinutes(activityStartAt, startOffset);
        const endAt =
          endOffset === undefined || endOffset === null
            ? null
            : addMinutes(activityStartAt, endOffset);
        const materialized: MaterializedSessionPosition = {
          code: position.code,
          name: position.name,
          attendanceRoleCode: position.attendanceRoleCode,
          capacity: position.capacity ?? null,
          startAt,
          endAt,
          genderRequirementCode: position.genderRequirementCode ?? null,
          locationRequired: position.locationRequired ?? null,
          radiusMeters: position.radiusMeters ?? null,
          description: position.description ?? null,
          equipmentNotes: position.equipmentNotes ?? null,
          sortOrder: position.sortOrder,
        };
        return materialized;
      });
      const materialized: MaterializedSession = {
        code: session.code,
        name: session.name,
        startAt,
        endAt,
        locationText: session.locationText,
        capacity: session.capacity ?? null,
        checkInOpenAt,
        checkInCloseAt,
        checkOutOpenAt,
        checkOutCloseAt,
        preparationStartAt,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
        sortOrder: session.sortOrder,
        positions,
      };
      this.assertSessionValid(materialized, activityStartAt, activityEndAt);
      for (const position of positions) {
        this.assertPositionValid(position, materialized);
      }
      return materialized;
    });
  }

  private assertSessionValid(
    session: MaterializedSession,
    activityStartAt: Date,
    activityEndAt: Date,
  ): void {
    if (
      session.startAt.getTime() >= session.endAt.getTime() ||
      session.startAt.getTime() < activityStartAt.getTime() ||
      session.endAt.getTime() > activityEndAt.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID);
    }
    if (
      session.capacity !== null &&
      (!Number.isInteger(session.capacity) || session.capacity < 1)
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
    }
    if (
      session.checkInOpenAt.getTime() > session.checkInCloseAt.getTime() ||
      session.checkInCloseAt.getTime() > session.checkOutCloseAt.getTime() ||
      session.checkOutOpenAt.getTime() > session.checkOutCloseAt.getTime() ||
      session.checkInOpenAt.getTime() < activityStartAt.getTime() ||
      session.checkOutOpenAt.getTime() < activityStartAt.getTime() ||
      session.checkOutCloseAt.getTime() > activityEndAt.getTime() ||
      (session.preparationStartAt !== null &&
        (session.preparationStartAt.getTime() > session.startAt.getTime() ||
          session.preparationStartAt.getTime() < activityStartAt.getTime())) ||
      !Number.isInteger(session.lateGraceMinutes) ||
      !Number.isInteger(session.earlyLeaveThresholdMinutes) ||
      session.lateGraceMinutes < 0 ||
      session.lateGraceMinutes > 60 ||
      session.earlyLeaveThresholdMinutes < 0 ||
      session.earlyLeaveThresholdMinutes > 60
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
    }
  }

  private assertPositionValid(
    position: MaterializedSessionPosition,
    session: Pick<MaterializedSession, 'startAt' | 'endAt'>,
  ): void {
    if (
      position.capacity !== null &&
      (!Number.isInteger(position.capacity) || position.capacity < 1)
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
    }
    if (
      (position.startAt === null) !== (position.endAt === null) ||
      (position.startAt !== null &&
        position.endAt !== null &&
        (position.startAt.getTime() >= position.endAt.getTime() ||
          position.startAt.getTime() < session.startAt.getTime() ||
          position.endAt.getTime() > session.endAt.getTime()))
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID);
    }
    if (
      (position.locationRequired === false && position.radiusMeters !== null) ||
      (position.radiusMeters !== null &&
        (!Number.isInteger(position.radiusMeters) ||
          position.radiusMeters < 50 ||
          position.radiusMeters > 10_000))
    ) {
      throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID);
    }
  }

  private async assertMaterializedReferences(
    tx: Prisma.TransactionClient,
    sessions: readonly MaterializedSession[],
  ): Promise<void> {
    for (const session of sessions) {
      for (const position of session.positions) {
        await this.access.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_ROLE,
          position.attendanceRoleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          tx,
        );
        if (position.genderRequirementCode !== null) {
          await this.access.assertDictItemValid(
            DICT_TYPE_GENDER_REQUIREMENT,
            position.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
            tx,
          );
        }
      }
    }
  }

  private activityCreateData(args: {
    input: NormalizedCreateActivityFromTemplateCommand;
    templateVersionId: string;
    activityTypeCode: string;
    definition: ActivityTemplateDefinitionV1;
    requestHash: string;
    initiatorMemberId: string | undefined;
  }): Prisma.ActivityUncheckedCreateInput {
    const activity = args.definition.activity;
    const data: Prisma.ActivityUncheckedCreateInput = {
      title: args.input.title,
      activityTypeCode: args.activityTypeCode,
      allocationModeCode: activity.allocationModeCode,
      organizationId: args.input.organizationId,
      startAt: args.input.startAt,
      endAt: args.input.endAt,
      location: args.input.location,
      statusCode: ACTIVITY_STATUS_DRAFT,
      selectedTemplateVersionId: args.templateVersionId,
      createFromTemplateOperationKey: args.input.operationKey,
      createFromTemplateRequestHash: args.requestHash,
      ...(args.initiatorMemberId === undefined
        ? {}
        : { initiatorMemberId: args.initiatorMemberId }),
    };
    if (activity.description !== undefined) data.description = activity.description;
    if (activity.capacity !== undefined) data.capacity = activity.capacity;
    if (activity.genderRequirementCode !== undefined) {
      data.genderRequirementCode = activity.genderRequirementCode;
    }
    if (activity.registrationNotes !== undefined)
      data.registrationNotes = activity.registrationNotes;
    if (activity.isPublicRegistration !== undefined) {
      data.isPublicRegistration = activity.isPublicRegistration;
    }
    if (activity.requiresInsurance !== undefined)
      data.requiresInsurance = activity.requiresInsurance;
    if (activity.registrationModeCode !== undefined) {
      data.registrationModeCode = activity.registrationModeCode;
    }
    if (activity.visibilityCode !== undefined) data.visibilityCode = activity.visibilityCode;
    if (activity.defaultLocationRequired !== undefined) {
      data.defaultLocationRequired = activity.defaultLocationRequired;
    }
    if (activity.defaultCheckInRadiusMeters !== undefined) {
      data.defaultCheckInRadiusMeters = activity.defaultCheckInRadiusMeters;
    }
    if (activity.archiveWaitingDays !== undefined) {
      data.archiveWaitingDays = activity.archiveWaitingDays;
    }
    if (args.input.registrationDeadline !== null) {
      data.registrationDeadline = args.input.registrationDeadline;
    }
    return data;
  }

  private isOperationKeyConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    const text = Array.isArray(target)
      ? target.filter((item): item is string => typeof item === 'string').join(',')
      : typeof target === 'string'
        ? target
        : '';
    // Activity 新建时没有其它可由外部输入撞到的 unique；driver 未给 target 时也必须
    // 回读幂等锚，不能把竞争重试泄露成 500。
    return (
      text === '' ||
      text.includes(CREATE_FROM_TEMPLATE_UNIQUE_INDEX) ||
      text.includes('createFromTemplateOperationKey')
    );
  }
}

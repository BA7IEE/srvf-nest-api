import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';
import { canonicalizeRegistrationFormDefinition } from './registration-form-definition';
import {
  RegistrationFormVersionService,
  type RegistrationFormResolvedConfig,
  type RegistrationFormTarget,
} from './registration-form-version.service';
import type {
  ChangeReviewDto,
  ChangeReviewSessionCreateDto,
  ChangeReviewSessionPositionCreateDto,
  ChangeReviewSessionPositionUpdateDto,
  ChangeReviewSessionUpdateDto,
} from './activity-publish-review.dto';

type PrismaTx = Prisma.TransactionClient;

type ResolutionSource = 'template' | 'activity' | 'system-default';

interface ProposalActivity {
  title: string;
  activityTypeCode: string;
  organizationId: string;
  startAt: string;
  endAt: string;
  location: string;
  description: string | null;
  capacity: number | null;
  genderRequirementCode: string | null;
  registrationDeadline: string | null;
  registrationNotes: string | null;
  isPublicRegistration: boolean;
  requiresInsurance: boolean;
  registrationSchema: Prisma.JsonValue | null;
  coverImageUrl: string | null;
  galleryImageUrls: Prisma.JsonValue | null;
  content: Prisma.JsonValue | null;
  locationLongitude: string | null;
  locationLatitude: string | null;
  registrationModeCode: string | null;
  visibilityCode: string | null;
  defaultCheckInRadiusMeters: number | null;
  defaultLocationRequired: boolean | null;
  archiveWaitingDays: number;
}

interface ProposalPosition {
  positionId: string | null;
  code: string;
  name: string;
  attendanceRoleCode: string;
  capacity: number | null;
  startAt: string | null;
  endAt: string | null;
  genderRequirementCode: string | null;
  qualificationRuleSetId: string | null;
  locationRequired: boolean | null;
  radiusMeters: number | null;
  leaderMemberId: string | null;
  description: string | null;
  equipmentNotes: string | null;
  sortOrder: number;
  cancelled: boolean;
}

interface ProposalSession {
  sessionId: string | null;
  clientRef: string | null;
  code: string;
  name: string;
  startAt: string;
  endAt: string;
  locationText: string;
  meetingPoint: string | null;
  executionPoint: string | null;
  evacuationPoint: string | null;
  longitude: string | null;
  latitude: string | null;
  capacity: number | null;
  checkInOpenAt: string;
  checkInCloseAt: string;
  checkOutOpenAt: string;
  checkOutCloseAt: string;
  preparationStartAt: string | null;
  locationRequired: boolean;
  radiusMeters: number | null;
  locationPolicySourceCode: string;
  accuracyWarningMeters: number;
  lateGraceMinutes: number;
  earlyLeaveThresholdMinutes: number;
  statusCode: string;
  sortOrder: number;
  positions: ProposalPosition[];
}

interface ResolvedValue<T> {
  value: T;
  source: ResolutionSource;
}

export interface ActivityTemplateResolution {
  templateVersionId: string | null;
  activity: {
    registrationModeCode: ResolvedValue<string>;
    locationRequired: ResolvedValue<boolean>;
    checkInRadiusMeters: ResolvedValue<number>;
    archiveWaitingDays: ResolvedValue<number>;
  };
  sessions: Array<{
    sessionId: string | null;
    code: string;
    statusCode: string;
    locationRequired: boolean;
    radiusMeters: number | null;
    locationPolicySourceCode: string;
    checkInOpenAt: string;
    checkInCloseAt: string;
    checkOutOpenAt: string;
    checkOutCloseAt: string;
    lateGraceMinutes: number;
    earlyLeaveThresholdMinutes: number;
    resolution: {
      locationRequired: ResolvedValue<boolean>;
      radiusMeters: ResolvedValue<number | null>;
      checkInOpenAt: ResolvedValue<string>;
      checkInCloseAt: ResolvedValue<string>;
      checkOutOpenAt: ResolvedValue<string>;
      checkOutCloseAt: ResolvedValue<string>;
      lateGraceMinutes: ResolvedValue<number>;
      earlyLeaveThresholdMinutes: ResolvedValue<number>;
    };
    positions: Array<{
      positionId: string | null;
      code: string;
      cancelled: boolean;
      locationRequired: boolean;
      radiusMeters: number | null;
      locationPolicySourceCode: string;
      resolution: {
        locationRequired: ResolvedValue<boolean>;
        radiusMeters: ResolvedValue<number | null>;
      };
    }>;
  }>;
}

/** RuleSnapshot may append only the frozen active Form pointer, never question definitions. */
export interface ActivityTemplateResolutionWithRegistrationForm extends ActivityTemplateResolution {
  registrationForm: RegistrationFormResolvedConfig | null;
}

export interface ActivityPublishProposalSnapshotV2 {
  schemaVersion: 2;
  baseWorkflowRevision: number;
  baseSnapshotHash: string;
  snapshotHash: string;
  base: {
    templateVersionId: string | null;
    resolvedConfig: ActivityTemplateResolution;
    activity: ProposalActivity;
    sessions: ProposalSession[];
  };
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  activity: ProposalActivity;
  sessions: ProposalSession[];
}

/**
 * v3 is additive over the v2 proposal envelope. The full target is canonical and hash-bound in
 * the snapshot; it is not copied into RuleSnapshot after approval.
 */
export interface ActivityPublishProposalSnapshotV3 {
  schemaVersion: 3;
  baseWorkflowRevision: number;
  baseSnapshotHash: string;
  snapshotHash: string;
  base: {
    templateVersionId: string | null;
    resolvedConfig: ActivityTemplateResolution;
    activity: ProposalActivity;
    sessions: ProposalSession[];
    registrationForm: RegistrationFormTarget | null;
  };
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  activity: ProposalActivity;
  sessions: ProposalSession[];
  registrationForm: RegistrationFormTarget | null;
}

export type ActivityPublishProposalSnapshot =
  | ActivityPublishProposalSnapshotV2
  | ActivityPublishProposalSnapshotV3;

interface CurrentProposalState {
  workflowRevision: number;
  activity: ProposalActivity;
  sessions: ProposalSession[];
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  registrationForm: RegistrationFormTarget | null;
}

interface TemplateRow {
  id: string;
  defaultRegistrationModeCode: string | null;
  defaultLocationRequired: boolean | null;
  defaultCheckInRadiusMeters: number | null;
  defaultArchiveWaitingDays: number | null;
}

const proposalActivitySelect = {
  id: true,
  statusCode: true,
  workflowRevision: true,
  title: true,
  activityTypeCode: true,
  organizationId: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  genderRequirementCode: true,
  registrationDeadline: true,
  registrationNotes: true,
  isPublicRegistration: true,
  requiresInsurance: true,
  registrationSchema: true,
  coverImageUrl: true,
  galleryImageUrls: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
  registrationModeCode: true,
  visibilityCode: true,
  defaultCheckInRadiusMeters: true,
  defaultLocationRequired: true,
  archiveWaitingDays: true,
  sessions: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
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
      sortOrder: true,
      positions: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          attendanceRoleCode: true,
          capacity: true,
          startAt: true,
          endAt: true,
          genderRequirementCode: true,
          qualificationRuleSetId: true,
          locationRequired: true,
          radiusMeters: true,
          leaderMemberId: true,
          description: true,
          equipmentNotes: true,
          sortOrder: true,
        },
      },
    },
  },
} as const satisfies Prisma.ActivitySelect;

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalize(value as CanonicalValue), 'utf8')
    .digest('hex');
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function decimal(value: { toString(): string } | null): string | null {
  return value === null ? null : value.toString();
}

function decimalInput(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
  }
  return String(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dateInput(
  value: unknown,
  biz: typeof BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
): string {
  if (typeof value !== 'string') throw new BizException(biz);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BizException(biz);
  return parsed.toISOString();
}

function nullableDateInput(value: unknown): string | null {
  if (value === null) return null;
  return dateInput(value, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
}

function assignDefined<T extends object>(target: T, source: Partial<T>): void {
  for (const key of Object.keys(source) as Array<keyof T>) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

function compareIdentity(
  left: { sortOrder: number; id: string },
  right: { sortOrder: number; id: string },
): number {
  return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
}

@Injectable()
export class ActivityPublishProposalV2Service {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly registrationForms: RegistrationFormVersionService,
  ) {}

  async buildInitial(tx: PrismaTx, activityId: string): Promise<ActivityPublishProposalSnapshotV3> {
    const current = await this.currentState(tx, activityId);
    this.assertProposalValid(current.activity, current.sessions);
    return this.toSnapshotV3(
      current,
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
      current.registrationForm,
    );
  }

  async buildChange(
    tx: PrismaTx,
    activityId: string,
    dto: ChangeReviewDto,
  ): Promise<ActivityPublishProposalSnapshotV3> {
    const current = await this.currentState(tx, activityId);
    const activity = clone(current.activity);
    const sessions = clone(current.sessions);
    this.applyActivityPatch(activity, dto.activityPatch as unknown as Partial<ProposalActivity>);
    this.applySessionCollections(sessions, dto);
    this.applyPositionCollections(sessions, dto);
    this.sortCollections(sessions);
    this.assertProposalValid(activity, sessions);

    const template = await this.findTemplate(tx, activity.activityTypeCode);
    const resolvedConfig = this.resolveConfig(activity, sessions, template);
    const registrationForm =
      dto.registrationForm === undefined
        ? current.registrationForm
        : dto.registrationForm === null
          ? null
          : (() => {
              const canonical = canonicalizeRegistrationFormDefinition(dto.registrationForm);
              return { definition: canonical.definition, schemaHash: canonical.schemaHash };
            })();
    const snapshot = this.toSnapshotV3(
      current,
      activity,
      sessions,
      template?.id ?? null,
      resolvedConfig,
      registrationForm,
    );
    if (
      snapshot.snapshotHash ===
      this.hashTargetV3(
        current.activity,
        current.sessions,
        current.templateVersionId,
        current.resolvedConfig,
        current.registrationForm,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    return snapshot;
  }

  async rebuildCurrent(
    tx: PrismaTx,
    activityId: string,
    schemaVersion: 2 | 3,
  ): Promise<{ workflowRevision: number; snapshotHash: string }> {
    // Historical v2 approvals must retain their former read/hashing behavior: do not touch the
    // Form tables at all while reconstructing a v2 stale guard.
    const current = await this.currentState(tx, activityId, schemaVersion === 3);
    return {
      workflowRevision: current.workflowRevision,
      snapshotHash:
        schemaVersion === 2
          ? this.hashTarget(
              current.activity,
              current.sessions,
              current.templateVersionId,
              current.resolvedConfig,
            )
          : this.hashTargetV3(
              current.activity,
              current.sessions,
              current.templateVersionId,
              current.resolvedConfig,
              current.registrationForm,
            ),
    };
  }

  async getTemplateResolution(
    tx: PrismaTx,
    activityId: string,
  ): Promise<ActivityTemplateResolution> {
    // Resolved template config has no Form dependency. Keeping this false preserves the
    // historical v2 approval read path while v3 asks for its active Form pointer explicitly.
    return (await this.currentState(tx, activityId, false)).resolvedConfig;
  }

  isSnapshot(value: Prisma.JsonValue): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return (
      (row.schemaVersion === 2 || row.schemaVersion === 3) && typeof row.snapshotHash === 'string'
    );
  }

  parseSnapshot(value: Prisma.JsonValue): ActivityPublishProposalSnapshot {
    if (!this.isSnapshot(value))
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    const snapshot = value as unknown as ActivityPublishProposalSnapshot;
    const { snapshotHash, ...unsigned } = snapshot;
    if (sha256(unsigned) !== snapshotHash) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    this.assertProposalValid(snapshot.activity, snapshot.sessions);
    if (snapshot.schemaVersion === 3) {
      this.assertSnapshotFormTarget(snapshot.registrationForm);
      this.assertSnapshotFormTarget(snapshot.base.registrationForm);
    }
    return snapshot;
  }

  /**
   * Apply order is intentionally visible and mechanically asserted by the batch-3 suite:
   * Activity → Sessions → Positions → batch-4 Form/Rules → batch-4 capacity → batch-5 QR
   * → population revision. Do not fold placeholders into a neighbouring write.
   */
  async apply(
    tx: PrismaTx,
    activityId: string,
    snapshot: ActivityPublishProposalSnapshot,
    input: { publish: boolean; publishedByUserId: string; at: Date },
  ): Promise<{
    workflowRevision: number;
    resolvedConfig: ActivityTemplateResolution | ActivityTemplateResolutionWithRegistrationForm;
  }> {
    await this.applyActivity(tx, activityId, snapshot.activity);
    const sessionIds = await this.applySessions(tx, activityId, snapshot.sessions, input.at);
    await this.applyPositions(tx, activityId, snapshot.sessions, sessionIds, input.at);
    let registrationForm: RegistrationFormResolvedConfig | null = null;
    if (snapshot.schemaVersion === 3) {
      const currentActivity = await tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { workflowRevision: true },
      });
      registrationForm = await this.registrationForms.applyPublishedTarget(tx, {
        activityId,
        requestType: input.publish ? 'initial' : 'change',
        target: snapshot.registrationForm,
        nextWorkflowRevision: currentActivity.workflowRevision + 1,
        at: input.at,
      });
    } else {
      await this.applyFormAndRulesPlaceholder(tx, activityId);
    }
    await this.applyCapacityBucketsPlaceholder(tx, activityId); // 第 4 批占位，刻意空实现。
    await this.applyQrCredentialsPlaceholder(tx, activityId); // 第 5 批占位，刻意空实现。
    const activity = await tx.activity.update({
      where: { id: activityId },
      data: {
        ...(input.publish
          ? { statusCode: 'published', publishedBy: input.publishedByUserId, publishedAt: input.at }
          : {}),
        workflowRevision: { increment: 1 },
        currentPopulationRevision: { increment: 1 },
      },
      select: { workflowRevision: true },
    });
    // The existing rule resolution is frozen when the proposal is submitted. v3 only appends
    // this approval's compact active Form pointer; it must not re-resolve a template that changed
    // while the review was pending.
    const resolvedConfig =
      snapshot.schemaVersion === 3
        ? { ...snapshot.resolvedConfig, registrationForm }
        : await this.getTemplateResolution(tx, activityId);
    return { workflowRevision: activity.workflowRevision, resolvedConfig };
  }

  private async currentState(
    tx: PrismaTx,
    activityId: string,
    includeRegistrationForm: boolean = true,
  ): Promise<CurrentProposalState> {
    const row = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: proposalActivitySelect,
    });
    const activity: ProposalActivity = {
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      organizationId: row.organizationId,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      location: row.location,
      description: row.description,
      capacity: row.capacity,
      genderRequirementCode: row.genderRequirementCode,
      registrationDeadline: iso(row.registrationDeadline),
      registrationNotes: row.registrationNotes,
      isPublicRegistration: row.isPublicRegistration,
      requiresInsurance: row.requiresInsurance,
      registrationSchema: clone(row.registrationSchema),
      coverImageUrl: row.coverImageUrl,
      galleryImageUrls: clone(row.galleryImageUrls),
      content: clone(row.content),
      locationLongitude: decimal(row.locationLongitude),
      locationLatitude: decimal(row.locationLatitude),
      registrationModeCode: row.registrationModeCode,
      visibilityCode: row.visibilityCode,
      defaultCheckInRadiusMeters: row.defaultCheckInRadiusMeters,
      defaultLocationRequired: row.defaultLocationRequired,
      archiveWaitingDays: row.archiveWaitingDays,
    };
    const sessions: ProposalSession[] = row.sessions.map((session) => ({
      sessionId: session.id,
      clientRef: null,
      code: session.code,
      name: session.name,
      startAt: session.startAt.toISOString(),
      endAt: session.endAt.toISOString(),
      locationText: session.locationText,
      meetingPoint: session.meetingPoint,
      executionPoint: session.executionPoint,
      evacuationPoint: session.evacuationPoint,
      longitude: decimal(session.longitude),
      latitude: decimal(session.latitude),
      capacity: session.capacity,
      checkInOpenAt: session.checkInOpenAt.toISOString(),
      checkInCloseAt: session.checkInCloseAt.toISOString(),
      checkOutOpenAt: session.checkOutOpenAt.toISOString(),
      checkOutCloseAt: session.checkOutCloseAt.toISOString(),
      preparationStartAt: iso(session.preparationStartAt),
      locationRequired: session.locationRequired,
      radiusMeters: session.radiusMeters,
      locationPolicySourceCode: session.locationPolicySourceCode,
      accuracyWarningMeters: session.accuracyWarningMeters,
      lateGraceMinutes: session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
      statusCode: session.statusCode,
      sortOrder: session.sortOrder,
      positions: session.positions.map((position) => ({
        positionId: position.id,
        code: position.code,
        name: position.name,
        attendanceRoleCode: position.attendanceRoleCode,
        capacity: position.capacity,
        startAt: iso(position.startAt),
        endAt: iso(position.endAt),
        genderRequirementCode: position.genderRequirementCode,
        qualificationRuleSetId: position.qualificationRuleSetId,
        locationRequired: position.locationRequired,
        radiusMeters: position.radiusMeters,
        leaderMemberId: position.leaderMemberId,
        description: position.description,
        equipmentNotes: position.equipmentNotes,
        sortOrder: position.sortOrder,
        cancelled: false,
      })),
    }));
    this.sortCollections(sessions);
    const template = await this.findTemplate(tx, activity.activityTypeCode);
    return {
      workflowRevision: row.workflowRevision,
      activity,
      sessions,
      templateVersionId: template?.id ?? null,
      resolvedConfig: this.resolveConfig(activity, sessions, template),
      registrationForm: includeRegistrationForm
        ? await this.registrationForms.currentTarget(tx, activityId, row.statusCode)
        : null,
    };
  }

  private async findTemplate(tx: PrismaTx, activityTypeCode: string): Promise<TemplateRow | null> {
    return tx.activityTemplate.findFirst({
      where: { activityTypeCode, statusCode: 'active' },
      orderBy: [{ version: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        defaultRegistrationModeCode: true,
        defaultLocationRequired: true,
        defaultCheckInRadiusMeters: true,
        defaultArchiveWaitingDays: true,
      },
    });
  }

  private toSnapshot(
    current: CurrentProposalState,
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
  ): ActivityPublishProposalSnapshotV2 {
    const baseSnapshotHash = this.hashTarget(
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
    );
    const unsigned = {
      schemaVersion: 2 as const,
      baseWorkflowRevision: current.workflowRevision,
      baseSnapshotHash,
      base: {
        templateVersionId: current.templateVersionId,
        resolvedConfig: current.resolvedConfig,
        activity: current.activity,
        sessions: current.sessions,
      },
      templateVersionId,
      resolvedConfig,
      activity,
      sessions,
    };
    return { ...unsigned, snapshotHash: sha256(unsigned) };
  }

  private toSnapshotV3(
    current: CurrentProposalState,
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
  ): ActivityPublishProposalSnapshotV3 {
    const baseSnapshotHash = this.hashTargetV3(
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
      current.registrationForm,
    );
    const unsigned = {
      schemaVersion: 3 as const,
      baseWorkflowRevision: current.workflowRevision,
      baseSnapshotHash,
      base: {
        templateVersionId: current.templateVersionId,
        resolvedConfig: current.resolvedConfig,
        activity: current.activity,
        sessions: current.sessions,
        registrationForm: current.registrationForm,
      },
      templateVersionId,
      resolvedConfig,
      activity,
      sessions,
      registrationForm,
    };
    return { ...unsigned, snapshotHash: sha256(unsigned) };
  }

  private hashTarget(
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
  ): string {
    return sha256({ activity, sessions, templateVersionId, resolvedConfig });
  }

  private hashTargetV3(
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
  ): string {
    return sha256({ activity, sessions, templateVersionId, resolvedConfig, registrationForm });
  }

  private assertSnapshotFormTarget(target: RegistrationFormTarget | null): void {
    if (target === null) return;
    if (!target || typeof target !== 'object' || typeof target.schemaHash !== 'string') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    try {
      const canonical = canonicalizeRegistrationFormDefinition(target.definition);
      if (canonical.schemaHash !== target.schemaHash) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
    } catch (error) {
      if (error instanceof BizException) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      throw error;
    }
  }

  private applyActivityPatch(activity: ProposalActivity, patch: Partial<ProposalActivity>): void {
    const {
      startAt,
      endAt,
      registrationDeadline,
      locationLongitude,
      locationLatitude,
      ...directValues
    } = patch;
    assignDefined(activity, directValues);
    if (startAt !== undefined) {
      activity.startAt = dateInput(startAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (endAt !== undefined) {
      activity.endAt = dateInput(endAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (registrationDeadline !== undefined) {
      activity.registrationDeadline = nullableDateInput(registrationDeadline);
    }
    if (locationLongitude !== undefined) {
      activity.locationLongitude = decimalInput(locationLongitude);
    }
    if (locationLatitude !== undefined) {
      activity.locationLatitude = decimalInput(locationLatitude);
    }
  }

  private applySessionCollections(sessions: ProposalSession[], dto: ChangeReviewDto): void {
    const seen = new Set<string>();
    for (const patch of dto.sessions.update) {
      if (!seen.add(patch.sessionId))
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      const session = sessions.find((item) => item.sessionId === patch.sessionId);
      if (!session) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      this.mergeSession(session, patch);
    }
    for (const item of dto.sessions.cancel) {
      if (!seen.add(item.sessionId))
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      const session = sessions.find((candidate) => candidate.sessionId === item.sessionId);
      if (!session) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      session.statusCode = 'cancelled';
      for (const position of session.positions) position.cancelled = true;
    }
    // A proposal-local clientRef must never alias a persisted session id: position commands accept
    // either kind of reference, so allowing that collision would silently attach children to the
    // wrong session.
    const refs = new Set<string>(
      sessions.flatMap((session) =>
        [session.sessionId, session.clientRef].filter((value): value is string => value !== null),
      ),
    );
    for (const input of dto.sessions.create) {
      const clientRef = input.clientRef ?? `create:${input.code}`;
      if (refs.has(clientRef))
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      refs.add(clientRef);
      sessions.push(this.createSession(input, clientRef));
    }
  }

  private applyPositionCollections(sessions: ProposalSession[], dto: ChangeReviewDto): void {
    const seen = new Set<string>();
    for (const patch of dto.positions.update) {
      const key = `${patch.sessionId}:${patch.positionId}`;
      if (!seen.add(key)) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      const position = this.findPosition(sessions, patch.sessionId, patch.positionId);
      this.mergePosition(position, patch);
    }
    for (const item of dto.positions.cancel) {
      const key = `${item.sessionId}:${item.positionId}`;
      if (!seen.add(key)) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      this.findPosition(sessions, item.sessionId, item.positionId).cancelled = true;
    }
    for (const input of dto.positions.create) {
      const session = sessions.find(
        (candidate) =>
          candidate.sessionId === input.sessionId || candidate.clientRef === input.sessionId,
      );
      if (!session || session.statusCode !== 'scheduled') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      session.positions.push(this.createPosition(input));
    }
  }

  private mergeSession(session: ProposalSession, patch: ChangeReviewSessionUpdateDto): void {
    if (patch.name !== undefined) session.name = patch.name;
    if (patch.startAt !== undefined) {
      session.startAt = dateInput(patch.startAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (patch.endAt !== undefined) {
      session.endAt = dateInput(patch.endAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (patch.locationText !== undefined) session.locationText = patch.locationText;
    if (patch.meetingPoint !== undefined) session.meetingPoint = patch.meetingPoint;
    if (patch.executionPoint !== undefined) session.executionPoint = patch.executionPoint;
    if (patch.evacuationPoint !== undefined) session.evacuationPoint = patch.evacuationPoint;
    if (patch.longitude !== undefined) session.longitude = decimalInput(patch.longitude);
    if (patch.latitude !== undefined) session.latitude = decimalInput(patch.latitude);
    if (patch.capacity !== undefined) session.capacity = patch.capacity;
    if (patch.checkInOpenAt !== undefined) {
      session.checkInOpenAt = dateInput(
        patch.checkInOpenAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      );
    }
    if (patch.checkInCloseAt !== undefined) {
      session.checkInCloseAt = dateInput(
        patch.checkInCloseAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      );
    }
    if (patch.checkOutOpenAt !== undefined) {
      session.checkOutOpenAt = dateInput(
        patch.checkOutOpenAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      );
    }
    if (patch.checkOutCloseAt !== undefined) {
      session.checkOutCloseAt = dateInput(
        patch.checkOutCloseAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      );
    }
    if (patch.preparationStartAt !== undefined) {
      session.preparationStartAt = nullableDateInput(patch.preparationStartAt);
    }
    if (patch.locationRequired !== undefined) session.locationRequired = patch.locationRequired;
    if (patch.radiusMeters !== undefined) session.radiusMeters = patch.radiusMeters;
    if (patch.lateGraceMinutes !== undefined) session.lateGraceMinutes = patch.lateGraceMinutes;
    if (patch.earlyLeaveThresholdMinutes !== undefined) {
      session.earlyLeaveThresholdMinutes = patch.earlyLeaveThresholdMinutes;
    }
    if (patch.sortOrder !== undefined) session.sortOrder = patch.sortOrder;
  }

  private mergePosition(
    position: ProposalPosition,
    patch: ChangeReviewSessionPositionUpdateDto,
  ): void {
    if (patch.name !== undefined) position.name = patch.name;
    if (patch.attendanceRoleCode !== undefined) {
      position.attendanceRoleCode = patch.attendanceRoleCode;
    }
    if (patch.capacity !== undefined) position.capacity = patch.capacity;
    if (patch.startAt !== undefined) position.startAt = nullableDateInput(patch.startAt);
    if (patch.endAt !== undefined) position.endAt = nullableDateInput(patch.endAt);
    if (patch.genderRequirementCode !== undefined) {
      position.genderRequirementCode = patch.genderRequirementCode;
    }
    if (patch.locationRequired !== undefined) position.locationRequired = patch.locationRequired;
    if (patch.radiusMeters !== undefined) position.radiusMeters = patch.radiusMeters;
    if (patch.leaderMemberId !== undefined) position.leaderMemberId = patch.leaderMemberId;
    if (patch.description !== undefined) position.description = patch.description;
    if (patch.equipmentNotes !== undefined) position.equipmentNotes = patch.equipmentNotes;
    if (patch.sortOrder !== undefined) position.sortOrder = patch.sortOrder;
  }

  private createSession(input: ChangeReviewSessionCreateDto, clientRef: string): ProposalSession {
    return {
      sessionId: null,
      clientRef,
      code: input.code,
      name: input.name,
      startAt: dateInput(input.startAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID),
      endAt: dateInput(input.endAt, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID),
      locationText: input.locationText,
      meetingPoint: input.meetingPoint ?? null,
      executionPoint: input.executionPoint ?? null,
      evacuationPoint: input.evacuationPoint ?? null,
      longitude: input.longitude === undefined ? null : decimalInput(input.longitude),
      latitude: input.latitude === undefined ? null : decimalInput(input.latitude),
      capacity: input.capacity ?? null,
      checkInOpenAt: dateInput(
        input.checkInOpenAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      ),
      checkInCloseAt: dateInput(
        input.checkInCloseAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      ),
      checkOutOpenAt: dateInput(
        input.checkOutOpenAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      ),
      checkOutCloseAt: dateInput(
        input.checkOutCloseAt,
        BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
      ),
      preparationStartAt:
        input.preparationStartAt === undefined ? null : nullableDateInput(input.preparationStartAt),
      locationRequired: input.locationRequired,
      radiusMeters: input.radiusMeters ?? null,
      locationPolicySourceCode: 'session',
      accuracyWarningMeters: 100,
      lateGraceMinutes: input.lateGraceMinutes ?? 15,
      earlyLeaveThresholdMinutes: input.earlyLeaveThresholdMinutes ?? 15,
      statusCode: 'scheduled',
      sortOrder: input.sortOrder ?? 0,
      positions: [],
    };
  }

  private createPosition(input: ChangeReviewSessionPositionCreateDto): ProposalPosition {
    return {
      positionId: null,
      code: input.code,
      name: input.name,
      attendanceRoleCode: input.attendanceRoleCode,
      capacity: input.capacity ?? null,
      startAt: input.startAt === undefined ? null : nullableDateInput(input.startAt),
      endAt: input.endAt === undefined ? null : nullableDateInput(input.endAt),
      genderRequirementCode: input.genderRequirementCode ?? null,
      qualificationRuleSetId: null,
      locationRequired: input.locationRequired ?? null,
      radiusMeters: input.radiusMeters ?? null,
      leaderMemberId: input.leaderMemberId ?? null,
      description: input.description ?? null,
      equipmentNotes: input.equipmentNotes ?? null,
      sortOrder: input.sortOrder ?? 0,
      cancelled: false,
    };
  }

  private findPosition(
    sessions: ProposalSession[],
    sessionRef: string,
    positionId: string,
  ): ProposalPosition {
    const session = sessions.find(
      (candidate) => candidate.sessionId === sessionRef || candidate.clientRef === sessionRef,
    );
    const position = session?.positions.find((candidate) => candidate.positionId === positionId);
    if (!position) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    return position;
  }

  private sortCollections(sessions: ProposalSession[]): void {
    sessions.sort((left, right) =>
      compareIdentity(
        { sortOrder: left.sortOrder, id: left.sessionId ?? left.clientRef ?? left.code },
        { sortOrder: right.sortOrder, id: right.sessionId ?? right.clientRef ?? right.code },
      ),
    );
    for (const session of sessions) {
      session.positions.sort((left, right) =>
        compareIdentity(
          { sortOrder: left.sortOrder, id: left.positionId ?? left.code },
          { sortOrder: right.sortOrder, id: right.positionId ?? right.code },
        ),
      );
    }
  }

  private assertProposalValid(activity: ProposalActivity, sessions: ProposalSession[]): void {
    const activityStart = new Date(activity.startAt);
    const activityEnd = new Date(activity.endAt);
    if (activityStart >= activityEnd) throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    if (
      activity.registrationDeadline !== null &&
      new Date(activity.registrationDeadline).getTime() > activityEnd.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
    const sessionCodes = new Set<string>();
    const sessionNames = new Set<string>();
    for (const session of sessions) {
      if (!sessionCodes.add(session.code))
        throw new BizException(BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS);
      if (!sessionNames.add(session.name))
        throw new BizException(BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS);
      const startAt = new Date(session.startAt);
      const endAt = new Date(session.endAt);
      if (startAt >= endAt || startAt < activityStart || endAt > activityEnd) {
        throw new BizException(BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID);
      }
      if (
        session.capacity !== null &&
        (!Number.isInteger(session.capacity) || session.capacity < 1)
      ) {
        throw new BizException(BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
      }
      const checkInOpenAt = new Date(session.checkInOpenAt);
      const checkInCloseAt = new Date(session.checkInCloseAt);
      const checkOutOpenAt = new Date(session.checkOutOpenAt);
      const checkOutCloseAt = new Date(session.checkOutCloseAt);
      if (
        checkInOpenAt > checkInCloseAt ||
        checkInCloseAt > checkOutCloseAt ||
        checkOutOpenAt > checkOutCloseAt ||
        (session.preparationStartAt !== null && new Date(session.preparationStartAt) > startAt) ||
        session.lateGraceMinutes < 0 ||
        session.lateGraceMinutes > 60 ||
        session.earlyLeaveThresholdMinutes < 0 ||
        session.earlyLeaveThresholdMinutes > 60
      ) {
        throw new BizException(BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
      }
      if (
        (session.locationRequired &&
          (session.radiusMeters === null ||
            !Number.isInteger(session.radiusMeters) ||
            session.radiusMeters < 50 ||
            session.radiusMeters > 10000)) ||
        (!session.locationRequired && session.radiusMeters !== null)
      ) {
        throw new BizException(BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID);
      }
      const positionCodes = new Set<string>();
      const positionNames = new Set<string>();
      for (const position of session.positions) {
        if (!positionCodes.add(position.code)) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS);
        }
        if (!positionNames.add(position.name)) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS);
        }
        if (position.cancelled) continue;
        if (
          position.capacity !== null &&
          (!Number.isInteger(position.capacity) || position.capacity < 1)
        ) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
        }
        if ((position.startAt === null) !== (position.endAt === null)) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID);
        }
        if (
          position.startAt !== null &&
          position.endAt !== null &&
          (new Date(position.startAt) >= new Date(position.endAt) ||
            new Date(position.startAt) < startAt ||
            new Date(position.endAt) > endAt)
        ) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID);
        }
        const effectiveRequired = position.locationRequired ?? session.locationRequired;
        const effectiveRadius = position.radiusMeters ?? session.radiusMeters;
        if (
          (effectiveRequired &&
            (effectiveRadius === null ||
              !Number.isInteger(effectiveRadius) ||
              effectiveRadius < 50 ||
              effectiveRadius > 10000)) ||
          (!effectiveRequired && position.radiusMeters !== null)
        ) {
          throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID);
        }
      }
    }
    // Capacity-bucket application is deliberately deferred to batch 4, but this aggregate's
    // existing static parent/child capacity invariant still applies before a proposal can freeze.
    const parentCapacity = activity.capacity;
    if (parentCapacity !== null) {
      const liveSessions = sessions.filter((session) => session.statusCode === 'scheduled');
      if (
        liveSessions.some(
          (session) => session.capacity !== null && session.capacity > parentCapacity,
        )
      ) {
        throw new BizException(BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
      }
      const livePositions = liveSessions.flatMap((session) =>
        session.positions.filter((position) => !position.cancelled),
      );
      if (
        livePositions.length > 0 &&
        (livePositions.some((position) => position.capacity === null) ||
          livePositions.reduce((sum, position) => sum + (position.capacity ?? 0), 0) >
            parentCapacity)
      ) {
        throw new BizException(BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
      }
    }
  }

  private resolveConfig(
    activity: ProposalActivity,
    sessions: ProposalSession[],
    template: TemplateRow | null,
  ): ActivityTemplateResolution {
    const systemRadius = this.config.get('attendance.checkInRadiusMeters', { infer: true }) ?? 500;
    const from = <T extends string | number | boolean>(
      activityValue: T | null,
      templateValue: T | null,
      systemValue: T,
    ): ResolvedValue<T> => {
      if (activityValue !== null) return { value: activityValue, source: 'activity' };
      if (templateValue !== null) return { value: templateValue, source: 'template' };
      return { value: systemValue, source: 'system-default' };
    };
    const locationRequired = from(
      activity.defaultLocationRequired,
      template?.defaultLocationRequired ?? null,
      false,
    );
    const radius = from(
      activity.defaultCheckInRadiusMeters,
      template?.defaultCheckInRadiusMeters ?? null,
      systemRadius,
    );
    const sourceFromFrozenPolicy = (policySource: string): ResolutionSource => {
      if (policySource === 'template') return 'template';
      if (policySource === 'system') return 'system-default';
      // `activity` / `session` / `position` all are persisted activity-aggregate choices.
      // The public resolution contract deliberately reduces them to the three documented sources.
      return 'activity';
    };
    return {
      templateVersionId: template?.id ?? null,
      activity: {
        registrationModeCode: from(
          activity.registrationModeCode,
          template?.defaultRegistrationModeCode ?? null,
          'open_apply',
        ),
        locationRequired,
        checkInRadiusMeters: radius,
        archiveWaitingDays: from(
          activity.archiveWaitingDays,
          template?.defaultArchiveWaitingDays ?? null,
          7,
        ),
      },
      sessions: sessions.map((session) => {
        const source = sourceFromFrozenPolicy(session.locationPolicySourceCode);
        return {
          sessionId: session.sessionId,
          code: session.code,
          statusCode: session.statusCode,
          locationRequired: session.locationRequired,
          radiusMeters: session.radiusMeters,
          locationPolicySourceCode: session.locationPolicySourceCode,
          checkInOpenAt: session.checkInOpenAt,
          checkInCloseAt: session.checkInCloseAt,
          checkOutOpenAt: session.checkOutOpenAt,
          checkOutCloseAt: session.checkOutCloseAt,
          lateGraceMinutes: session.lateGraceMinutes,
          earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
          resolution: {
            locationRequired: { value: session.locationRequired, source },
            radiusMeters: { value: session.radiusMeters, source },
            checkInOpenAt: { value: session.checkInOpenAt, source },
            checkInCloseAt: { value: session.checkInCloseAt, source },
            checkOutOpenAt: { value: session.checkOutOpenAt, source },
            checkOutCloseAt: { value: session.checkOutCloseAt, source },
            lateGraceMinutes: { value: session.lateGraceMinutes, source },
            earlyLeaveThresholdMinutes: { value: session.earlyLeaveThresholdMinutes, source },
          },
          positions: session.positions.map((position) => {
            const locationRequiredFromPosition = position.locationRequired !== null;
            const radiusFromPosition = position.radiusMeters !== null;
            const locationPolicySourceCode =
              !locationRequiredFromPosition && !radiusFromPosition
                ? session.locationPolicySourceCode
                : 'position';
            return {
              positionId: position.positionId,
              code: position.code,
              cancelled: position.cancelled,
              locationRequired: position.locationRequired ?? session.locationRequired,
              radiusMeters: position.radiusMeters ?? session.radiusMeters,
              locationPolicySourceCode,
              resolution: {
                locationRequired: {
                  value: position.locationRequired ?? session.locationRequired,
                  source: locationRequiredFromPosition ? 'activity' : source,
                },
                radiusMeters: {
                  value: position.radiusMeters ?? session.radiusMeters,
                  source: radiusFromPosition ? 'activity' : source,
                },
              },
            };
          }),
        };
      }),
    };
  }

  private async applyActivity(
    tx: PrismaTx,
    activityId: string,
    activity: ProposalActivity,
  ): Promise<void> {
    await tx.activity.update({
      where: { id: activityId },
      data: {
        title: activity.title,
        activityTypeCode: activity.activityTypeCode,
        organizationId: activity.organizationId,
        startAt: new Date(activity.startAt),
        endAt: new Date(activity.endAt),
        location: activity.location,
        description: activity.description,
        capacity: activity.capacity,
        genderRequirementCode: activity.genderRequirementCode,
        registrationDeadline:
          activity.registrationDeadline === null ? null : new Date(activity.registrationDeadline),
        registrationNotes: activity.registrationNotes,
        isPublicRegistration: activity.isPublicRegistration,
        requiresInsurance: activity.requiresInsurance,
        registrationSchema:
          activity.registrationSchema === null
            ? Prisma.DbNull
            : (activity.registrationSchema as Prisma.InputJsonValue),
        coverImageUrl: activity.coverImageUrl,
        galleryImageUrls:
          activity.galleryImageUrls === null
            ? Prisma.DbNull
            : (activity.galleryImageUrls as Prisma.InputJsonValue),
        content:
          activity.content === null ? Prisma.DbNull : (activity.content as Prisma.InputJsonValue),
        locationLongitude: activity.locationLongitude,
        locationLatitude: activity.locationLatitude,
        registrationModeCode: activity.registrationModeCode,
        visibilityCode: activity.visibilityCode,
        defaultCheckInRadiusMeters: activity.defaultCheckInRadiusMeters,
        defaultLocationRequired: activity.defaultLocationRequired,
        archiveWaitingDays: activity.archiveWaitingDays,
      },
    });
  }

  private async applySessions(
    tx: PrismaTx,
    activityId: string,
    sessions: ProposalSession[],
    at: Date,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const session of sessions) {
      const data = {
        name: session.name,
        startAt: new Date(session.startAt),
        endAt: new Date(session.endAt),
        locationText: session.locationText,
        meetingPoint: session.meetingPoint,
        executionPoint: session.executionPoint,
        evacuationPoint: session.evacuationPoint,
        longitude: session.longitude,
        latitude: session.latitude,
        capacity: session.capacity,
        checkInOpenAt: new Date(session.checkInOpenAt),
        checkInCloseAt: new Date(session.checkInCloseAt),
        checkOutOpenAt: new Date(session.checkOutOpenAt),
        checkOutCloseAt: new Date(session.checkOutCloseAt),
        preparationStartAt:
          session.preparationStartAt === null ? null : new Date(session.preparationStartAt),
        locationRequired: session.locationRequired,
        radiusMeters: session.radiusMeters,
        locationPolicySourceCode: session.locationPolicySourceCode,
        accuracyWarningMeters: session.accuracyWarningMeters,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
        statusCode: session.statusCode,
        sortOrder: session.sortOrder,
      };
      if (session.sessionId === null) {
        const created = await tx.activitySession.create({
          data: { activityId, code: session.code, ...data },
          select: { id: true },
        });
        ids.set(session.clientRef ?? session.code, created.id);
      } else {
        await tx.activitySession.update({
          where: { id: session.sessionId },
          data: { ...data, workflowRevision: { increment: 1 } },
        });
        ids.set(session.sessionId, session.sessionId);
      }
      if (session.statusCode === 'cancelled') {
        // `deletedAt` is intentionally untouched: published cancellation preserves the execution row.
        void at;
      }
    }
    return ids;
  }

  private async applyPositions(
    tx: PrismaTx,
    activityId: string,
    sessions: ProposalSession[],
    sessionIds: Map<string, string>,
    at: Date,
  ): Promise<void> {
    for (const session of sessions) {
      const key = session.sessionId ?? session.clientRef ?? session.code;
      const sessionId = sessionIds.get(key);
      if (!sessionId) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      for (const position of session.positions) {
        if (position.positionId === null) {
          if (position.cancelled) continue;
          await tx.activitySessionPosition.create({
            data: {
              activityId,
              sessionId,
              code: position.code,
              name: position.name,
              attendanceRoleCode: position.attendanceRoleCode,
              capacity: position.capacity,
              startAt: position.startAt === null ? null : new Date(position.startAt),
              endAt: position.endAt === null ? null : new Date(position.endAt),
              genderRequirementCode: position.genderRequirementCode,
              qualificationRuleSetId: position.qualificationRuleSetId,
              locationRequired: position.locationRequired,
              radiusMeters: position.radiusMeters,
              leaderMemberId: position.leaderMemberId,
              description: position.description,
              equipmentNotes: position.equipmentNotes,
              sortOrder: position.sortOrder,
            },
          });
          continue;
        }
        if (position.cancelled) {
          await tx.activitySessionPosition.update({
            where: { id: position.positionId },
            data: { deletedAt: at },
          });
          continue;
        }
        await tx.activitySessionPosition.update({
          where: { id: position.positionId },
          data: {
            name: position.name,
            attendanceRoleCode: position.attendanceRoleCode,
            capacity: position.capacity,
            startAt: position.startAt === null ? null : new Date(position.startAt),
            endAt: position.endAt === null ? null : new Date(position.endAt),
            genderRequirementCode: position.genderRequirementCode,
            qualificationRuleSetId: position.qualificationRuleSetId,
            locationRequired: position.locationRequired,
            radiusMeters: position.radiusMeters,
            leaderMemberId: position.leaderMemberId,
            description: position.description,
            equipmentNotes: position.equipmentNotes,
            sortOrder: position.sortOrder,
          },
        });
      }
    }
  }

  private applyFormAndRulesPlaceholder(tx: PrismaTx, activityId: string): Promise<void> {
    void tx;
    void activityId;
    // 第 4 批：Form / Rules proposal application。此刀必须显式经过但不得抢跑实装。
    return Promise.resolve();
  }

  private applyCapacityBucketsPlaceholder(tx: PrismaTx, activityId: string): Promise<void> {
    void tx;
    void activityId;
    // 第 4 批：capacity bucket application。此刀必须显式经过但不得抢跑实装。
    return Promise.resolve();
  }

  private applyQrCredentialsPlaceholder(tx: PrismaTx, activityId: string): Promise<void> {
    void tx;
    void activityId;
    // 第 5 批：QR credential application。此刀必须显式经过但不得抢跑实装。
    return Promise.resolve();
  }
}

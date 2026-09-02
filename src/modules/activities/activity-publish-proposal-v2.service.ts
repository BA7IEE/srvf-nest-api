import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Role } from '@prisma/client';
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
import {
  QualificationRuleSetVersionService,
  type QualificationRuleSetResolvedConfig,
} from './qualification-rule-set-version.service';
import {
  canonicalizeQualificationRuleSets,
  qualificationRuleSetsInputFromCanonical,
  type CanonicalQualificationRuleSetsDefinition,
  type QualificationRuleScope,
  type QualificationRuleSetInput,
} from './qualification-rule-set-definition';
import { ActivityCapacityBucketProjector } from './activity-capacity-bucket-projector';
import { activitySessionRescheduleEffects } from './activity-session-reschedule-effects';
import { activitySessionCancellationEffects } from './activity-session-cancellation-effects';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { isActivityAllocationModeCode } from './activity-allocation-mode';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  ChangeReviewDto,
  ChangeReviewQualificationRuleScopeDto,
  ChangeReviewQualificationRuleSetCollectionsDto,
  ChangeReviewQualificationRuleSetUpsertDto,
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
  allocationModeCode: string;
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
  // 🔴 **不是漏改** —— 维护者 2026-08-25 拍板「留着不动」(P2-14 刀 B)。
  // 对应 DB 列已 DROP,构造时一律写字面 `null`;键本身必须留着,否则
  // `snapshotHash = sha256(unsigned)` 与**已持久化**快照重算比对时不再相等,
  // 在途审核单全部当场 SNAPSHOT_INVALID。完整理由见
  // `activity-proposal.types.ts` 同名两键上的注释。
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

type ProposalActivityWithoutAllocationMode = Omit<ProposalActivity, 'allocationModeCode'>;
type ProposalActivityInput = ProposalActivityWithoutAllocationMode & {
  allocationModeCode?: string;
};

interface ProposalPosition {
  positionId: string | null;
  clientRef: string | null;
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

/** RuleSnapshot holds only active RuleSet pointers/hashes, never full rule definitions. */
export interface ActivityTemplateResolutionWithQualificationRules extends ActivityTemplateResolutionWithRegistrationForm {
  qualificationRuleSets: QualificationRuleSetResolvedConfig[];
}

export interface ActivityPublishProposalSnapshotV2 {
  schemaVersion: 2;
  baseWorkflowRevision: number;
  baseSnapshotHash: string;
  snapshotHash: string;
  base: {
    templateVersionId: string | null;
    resolvedConfig: ActivityTemplateResolution;
    activity: ProposalActivityWithoutAllocationMode;
    sessions: ProposalSession[];
  };
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  activity: ProposalActivityWithoutAllocationMode;
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
    activity: ProposalActivityWithoutAllocationMode;
    sessions: ProposalSession[];
    registrationForm: RegistrationFormTarget | null;
  };
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  activity: ProposalActivityWithoutAllocationMode;
  sessions: ProposalSession[];
  registrationForm: RegistrationFormTarget | null;
}

/** v4 adds the Activity allocation mode to both target/base and to every stale hash. */
export interface ActivityPublishProposalSnapshotV4 {
  schemaVersion: 4;
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

/** v5 adds the canonical qualification RuleSet target to base and target. */
export interface ActivityPublishProposalSnapshotV5 {
  schemaVersion: 5;
  baseWorkflowRevision: number;
  baseSnapshotHash: string;
  snapshotHash: string;
  base: {
    templateVersionId: string | null;
    resolvedConfig: ActivityTemplateResolution;
    activity: ProposalActivity;
    sessions: ProposalSession[];
    registrationForm: RegistrationFormTarget | null;
    qualificationRuleSets: CanonicalQualificationRuleSetsDefinition;
  };
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  activity: ProposalActivity;
  sessions: ProposalSession[];
  registrationForm: RegistrationFormTarget | null;
  qualificationRuleSets: CanonicalQualificationRuleSetsDefinition;
}

export type ActivityPublishProposalSnapshot =
  | ActivityPublishProposalSnapshotV2
  | ActivityPublishProposalSnapshotV3
  | ActivityPublishProposalSnapshotV4
  | ActivityPublishProposalSnapshotV5;

interface CurrentProposalState {
  workflowRevision: number;
  activity: ProposalActivity;
  sessions: ProposalSession[];
  /** Stored selection fact; unlike templateVersionId it is never synthesized from fallback. */
  selectedTemplateVersionId: string | null;
  templateVersionId: string | null;
  resolvedConfig: ActivityTemplateResolution;
  registrationForm: RegistrationFormTarget | null;
  qualificationRuleSets: CanonicalQualificationRuleSetsDefinition;
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
  selectedTemplateVersionId: true,
  allocationModeCode: true,
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

function qualificationScopeKey(scope: QualificationRuleScope): string {
  return JSON.stringify([scope.sessionId, scope.positionId]);
}

@Injectable()
export class ActivityPublishProposalV2Service {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly registrationForms: RegistrationFormVersionService,
    private readonly qualificationRules: QualificationRuleSetVersionService,
    private readonly capacityBuckets: ActivityCapacityBucketProjector,
    // ADV-018 场次取消联动的两个协作者。**刻意直接注在既有 provider 上**而不是新建一个
    // provider:新 provider 要登进 activities.module.ts,而 harness/domain-map.json 的
    // inputDigest 覆盖全部 *.module.ts ⇒ 动一行 module 就要改红区。
    private readonly notificationProducer: ActivityNotificationProducer,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async buildInitial(
    tx: PrismaTx,
    activityId: string,
  ): Promise<ActivityPublishProposalSnapshotV4 | ActivityPublishProposalSnapshotV5> {
    const current = await this.currentState(tx, activityId);
    this.assertProposalValid(current.activity, current.sessions);
    // An initial proposal only needs the V5 envelope when there is an actual
    // qualification target to freeze. Keeping an empty target in V4 would
    // silently rewrite established, qualification-free initial reviews.
    if (current.qualificationRuleSets.ruleSets.length === 0) {
      return this.toSnapshotV4(
        current,
        current.activity,
        current.sessions,
        current.templateVersionId,
        current.resolvedConfig,
        current.registrationForm,
      );
    }
    return this.toSnapshotV5(
      current,
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
      current.registrationForm,
      current.qualificationRuleSets,
    );
  }

  async buildChange(
    tx: PrismaTx,
    activityId: string,
    dto: ChangeReviewDto,
  ): Promise<ActivityPublishProposalSnapshotV4 | ActivityPublishProposalSnapshotV5> {
    const includesQualificationRuleSets = dto.qualificationRuleSets !== undefined;
    // A V4 form/activity proposal has no qualification command and must retain its historical
    // read/hash envelope. Only the explicit V5 collection command is allowed to read/freeze the
    // qualification target; this avoids silently changing unrelated established contracts.
    const current = await this.currentState(tx, activityId, true, includesQualificationRuleSets);
    const activity = clone(current.activity);
    const sessions = clone(current.sessions);
    this.applyActivityPatch(activity, dto.activityPatch as unknown as Partial<ProposalActivity>);
    this.applySessionCollections(sessions, dto);
    this.applyPositionCollections(sessions, dto);
    this.sortCollections(sessions);
    this.assertProposalValid(activity, sessions);

    const template = await this.findTemplate(
      tx,
      current.selectedTemplateVersionId,
      activity.activityTypeCode,
    );
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
    if (!includesQualificationRuleSets) {
      const cancelledSessionIds = sessions.flatMap((session) =>
        session.sessionId !== null && session.statusCode === 'cancelled' ? [session.sessionId] : [],
      );
      const cancelledPositionIds = sessions.flatMap((session) =>
        session.positions.flatMap((position) =>
          position.positionId !== null && position.cancelled ? [position.positionId] : [],
        ),
      );
      if (cancelledSessionIds.length > 0 || cancelledPositionIds.length > 0) {
        await this.qualificationRules.assertNoActiveRuleSetForCancelledTargets(tx, {
          activityId,
          sessionIds: cancelledSessionIds,
          positionIds: cancelledPositionIds,
        });
      }
      const snapshot = this.toSnapshotV4(
        current,
        activity,
        sessions,
        template?.id ?? null,
        resolvedConfig,
        registrationForm,
      );
      if (
        snapshot.snapshotHash ===
        this.hashTargetV4(
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
    const qualificationRuleSets = this.applyQualificationRuleSetCollections(
      sessions,
      dto.qualificationRuleSets,
      current.qualificationRuleSets,
    );
    const snapshot = this.toSnapshotV5(
      current,
      activity,
      sessions,
      template?.id ?? null,
      resolvedConfig,
      registrationForm,
      qualificationRuleSets,
    );
    if (
      snapshot.snapshotHash ===
      this.hashTargetV5(
        current.activity,
        current.sessions,
        current.templateVersionId,
        current.resolvedConfig,
        current.registrationForm,
        current.qualificationRuleSets,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    return snapshot;
  }

  async rebuildCurrent(
    tx: PrismaTx,
    activityId: string,
    schemaVersion: 2 | 3 | 4 | 5,
  ): Promise<{ workflowRevision: number; snapshotHash: string }> {
    // Historical v2 approvals must retain their former read/hashing behavior: do not touch the
    // Form tables at all while reconstructing a v2 stale guard.
    const current = await this.currentState(
      tx,
      activityId,
      schemaVersion !== 2,
      schemaVersion === 5,
    );
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
          : schemaVersion === 3
            ? this.hashTargetV3(
                current.activity,
                current.sessions,
                current.templateVersionId,
                current.resolvedConfig,
                current.registrationForm,
              )
            : schemaVersion === 4
              ? this.hashTargetV4(
                  current.activity,
                  current.sessions,
                  current.templateVersionId,
                  current.resolvedConfig,
                  current.registrationForm,
                )
              : this.hashTargetV5(
                  current.activity,
                  current.sessions,
                  current.templateVersionId,
                  current.resolvedConfig,
                  current.registrationForm,
                  current.qualificationRuleSets,
                ),
    };
  }

  async getTemplateResolution(
    tx: PrismaTx,
    activityId: string,
  ): Promise<ActivityTemplateResolution> {
    // Resolved template config has no Form dependency. Keeping this false preserves the
    // historical v2 approval read path; v3/v4 read the active Form pointer through their
    // snapshot-specific paths.
    return (await this.currentState(tx, activityId, false, false)).resolvedConfig;
  }

  isSnapshot(value: Prisma.JsonValue): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return (
      (row.schemaVersion === 2 ||
        row.schemaVersion === 3 ||
        row.schemaVersion === 4 ||
        row.schemaVersion === 5) &&
      typeof row.snapshotHash === 'string'
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
    if (
      snapshot.schemaVersion === 3 ||
      snapshot.schemaVersion === 4 ||
      snapshot.schemaVersion === 5
    ) {
      this.assertSnapshotFormTarget(snapshot.registrationForm);
      this.assertSnapshotFormTarget(snapshot.base.registrationForm);
    }
    if (
      (snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5) &&
      (!isActivityAllocationModeCode(snapshot.activity.allocationModeCode) ||
        !isActivityAllocationModeCode(snapshot.base.activity.allocationModeCode))
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (snapshot.schemaVersion === 5) {
      this.assertSnapshotQualificationTarget(snapshot.qualificationRuleSets);
      this.assertSnapshotQualificationTarget(snapshot.base.qualificationRuleSets);
    }
    return snapshot;
  }

  /**
   * Apply order is intentionally visible and mechanically asserted by the batch-3 suite:
   * Activity → Sessions → Positions → batch-4 Form/Rules → batch-4 capacity projector →
   * session-cancellation effects → population revision. Do not fold steps into a neighbouring
   * write.
   *
   * ⚠️ 场次取消联动必须排在 `capacityBuckets.apply()` **之后**:投影器对「掉出目标集但
   * occupied ≠ 0 的桶」是 failClosed —— 也就是「该场次还有人占着名额就不许取消」这条闸。
   * 先跑投影器,联动才只会看到已经过闸的场次。
   */
  async apply(
    tx: PrismaTx,
    activityId: string,
    snapshot: ActivityPublishProposalSnapshot,
    input: {
      publish: boolean;
      publishedByUserId: string;
      publishedByUserRole: Role;
      at: Date;
      /** 稳定批次键(审核 id),让取消通知的 eventKey / cohortKey 在重放时不漂。 */
      versionKey: string;
      auditMeta: AuditMeta;
    },
  ): Promise<{
    workflowRevision: number;
    resolvedConfig:
      | ActivityTemplateResolution
      | ActivityTemplateResolutionWithRegistrationForm
      | ActivityTemplateResolutionWithQualificationRules;
  }> {
    // 「本次由 scheduled 变成 cancelled」的场次必须在 applySessions 落库**之前**读 ——
    // 落库之后 DB 里全是 cancelled,分不出「这次刚取消」与「上次就已经取消」,联动会对
    // 早已取消的场次重复发通知。一次查完,不逐个场次查。
    const newlyCancelledSessionIds = await this.resolveNewlyCancelledSessionIds(
      tx,
      activityId,
      snapshot.sessions,
    );
    // AC-010:改期检测必须在 applySessions **之前**取(取的是「旧窗 vs 提案窗」的差异),
    // 联动本身在 apply 之后落(重签冻结的是新窗)。
    const rescheduledSessionIds = await this.resolveRescheduledSessionIds(
      tx,
      activityId,
      snapshot.sessions,
    );
    await this.applyActivity(
      tx,
      activityId,
      snapshot.activity,
      snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5
        ? snapshot.activity.allocationModeCode
        : undefined,
    );
    const sessionIds = await this.applySessions(tx, activityId, snapshot.sessions, input.at);
    const positionIds = await this.applyPositions(
      tx,
      activityId,
      snapshot.sessions,
      sessionIds,
      input.at,
    );
    let registrationForm: RegistrationFormResolvedConfig | null = null;
    if (
      snapshot.schemaVersion === 3 ||
      snapshot.schemaVersion === 4 ||
      snapshot.schemaVersion === 5
    ) {
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
    const qualificationRuleSets =
      snapshot.schemaVersion === 5
        ? await this.qualificationRules.applyPublishedTarget(tx, {
            activityId,
            requestType: input.publish ? 'initial' : 'change',
            target: snapshot.qualificationRuleSets,
            sessionIds,
            positionIds,
          })
        : [];
    await this.capacityBuckets.apply(tx, activityId);
    // ADV-018 / AC-010：单场次取消的人员 / 二维码 / 通知 / 结算人口四格联动。
    // 第 5 批交付了二维码链却没回来接这个位置（原为 applyQrCredentialsPlaceholder 空桩）。
    await activitySessionCancellationEffects.applyInTransactionTrusted(
      tx,
      { notificationProducer: this.notificationProducer, auditLogs: this.auditLogs },
      {
        activityId,
        cancelledSessionIds: newlyCancelledSessionIds,
        versionKey: input.versionKey,
        at: input.at,
        actorUserId: input.publishedByUserId,
        actorRoleSnap: input.publishedByUserRole,
        auditMeta: input.auditMeta,
      },
    );
    // AC-010 改期联动(维护者 2026-08-28 拍板「作废旧码重签」):排在 applySessions 之后,
    // 与取消联动同一事务;通知 / 人口 / 名额格不重复动(见该文件头注的格子对照表)。
    if (rescheduledSessionIds.length > 0) {
      // 惰性读取:没有改期就不需要密钥(单元测试的 ConfigService 桩可能没提供 jwt 段)。
      // 本服务的 ConfigService 是按 activities 侧 AppConfig 收窄的类型,其 Path 不含 jwt 段;
      // 密钥真源与 AttendanceQrCredentialService 同一处 —— 这里一次性窄 cast 取值,
      // 不引入第二份配置读取(改全局 AppConfig 形状属另一刀)。
      const jwt = (this.config as unknown as import('@nestjs/config').ConfigService).get<{
        secret: string;
      }>('jwt');
      if (jwt === undefined || typeof jwt.secret !== 'string') {
        throw new Error('jwt.config 未加载');
      }
      await activitySessionRescheduleEffects.applyInTransactionTrusted(
        { auditLogs: this.auditLogs },
        tx,
        {
          activityId,
          rescheduledSessionIds,
          versionKey: input.versionKey,
          at: input.at,
          actorUserId: input.publishedByUserId,
          actorRoleSnap: input.publishedByUserRole,
          auditMeta: input.auditMeta,
          jwtSecret: jwt.secret,
        },
      );
    }
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
    // The existing rule resolution is frozen when the proposal is submitted. v3/v4 append this
    // approval's compact active Form pointer; they must not re-resolve a template that changed
    // while the review was pending.
    const resolvedConfig =
      snapshot.schemaVersion === 5
        ? { ...snapshot.resolvedConfig, registrationForm, qualificationRuleSets }
        : snapshot.schemaVersion === 3 || snapshot.schemaVersion === 4
          ? { ...snapshot.resolvedConfig, registrationForm }
          : await this.getTemplateResolution(tx, activityId);
    return { workflowRevision: activity.workflowRevision, resolvedConfig };
  }

  private async currentState(
    tx: PrismaTx,
    activityId: string,
    includeRegistrationForm: boolean = true,
    includeQualificationRules: boolean = true,
  ): Promise<CurrentProposalState> {
    const row = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: proposalActivitySelect,
    });
    const activity: ProposalActivity = {
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      allocationModeCode: row.allocationModeCode,
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
      // P2-14 刀 B:两列已 DROP;此前它们恒为 null(零写入路径 + 起刀当日全库实测非空计数为 0),
      // 写死 `null` 与原来的 `row.coverImageUrl` / `clone(row.galleryImageUrls)` 取值逐字相同,
      // 于是 `snapshotHash` 一位不变。键为何不能删见 `activity-proposal.types.ts` 注释。
      coverImageUrl: null,
      galleryImageUrls: null,
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
        clientRef: null,
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
    const template = await this.findTemplate(
      tx,
      row.selectedTemplateVersionId,
      activity.activityTypeCode,
    );
    return {
      workflowRevision: row.workflowRevision,
      activity,
      sessions,
      selectedTemplateVersionId: row.selectedTemplateVersionId,
      templateVersionId: template?.id ?? null,
      resolvedConfig: this.resolveConfig(activity, sessions, template),
      registrationForm: includeRegistrationForm
        ? await this.registrationForms.currentTarget(tx, activityId, row.statusCode)
        : null,
      qualificationRuleSets: includeQualificationRules
        ? await this.qualificationRules.currentTarget(tx, activityId, row.statusCode)
        : { ruleSets: [] },
    };
  }

  private async findTemplate(
    tx: PrismaTx,
    selectedTemplateVersionId: string | null,
    activityTypeCode: string,
  ): Promise<TemplateRow | null> {
    if (selectedTemplateVersionId !== null) {
      // A4's FK makes this an integrity invariant. Do not mask a broken explicit selection by
      // silently falling back to the current active template; a retired target is still valid
      // historical input and is deliberately queried without lifecycle or Family filters.
      return tx.activityTemplate.findUniqueOrThrow({
        where: { id: selectedTemplateVersionId },
        select: {
          id: true,
          defaultRegistrationModeCode: true,
          defaultLocationRequired: true,
          defaultCheckInRadiusMeters: true,
          defaultArchiveWaitingDays: true,
        },
      });
    }
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
        activity: this.withoutAllocationMode(current.activity),
        sessions: current.sessions,
      },
      templateVersionId,
      resolvedConfig,
      activity: this.withoutAllocationMode(activity),
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
        activity: this.withoutAllocationMode(current.activity),
        sessions: current.sessions,
        registrationForm: current.registrationForm,
      },
      templateVersionId,
      resolvedConfig,
      activity: this.withoutAllocationMode(activity),
      sessions,
      registrationForm,
    };
    return { ...unsigned, snapshotHash: sha256(unsigned) };
  }

  private toSnapshotV4(
    current: CurrentProposalState,
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
  ): ActivityPublishProposalSnapshotV4 {
    const baseSnapshotHash = this.hashTargetV4(
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
      current.registrationForm,
    );
    const unsigned = {
      schemaVersion: 4 as const,
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

  private toSnapshotV5(
    current: CurrentProposalState,
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
    qualificationRuleSets: CanonicalQualificationRuleSetsDefinition,
  ): ActivityPublishProposalSnapshotV5 {
    const baseSnapshotHash = this.hashTargetV5(
      current.activity,
      current.sessions,
      current.templateVersionId,
      current.resolvedConfig,
      current.registrationForm,
      current.qualificationRuleSets,
    );
    const unsigned = {
      schemaVersion: 5 as const,
      baseWorkflowRevision: current.workflowRevision,
      baseSnapshotHash,
      base: {
        templateVersionId: current.templateVersionId,
        resolvedConfig: current.resolvedConfig,
        activity: current.activity,
        sessions: current.sessions,
        registrationForm: current.registrationForm,
        qualificationRuleSets: current.qualificationRuleSets,
      },
      templateVersionId,
      resolvedConfig,
      activity,
      sessions,
      registrationForm,
      qualificationRuleSets,
    };
    return { ...unsigned, snapshotHash: sha256(unsigned) };
  }

  private withoutAllocationMode(
    activity: ProposalActivityInput,
  ): ProposalActivityWithoutAllocationMode {
    const withoutAllocationMode = { ...activity };
    delete withoutAllocationMode.allocationModeCode;
    return withoutAllocationMode;
  }

  private hashTarget(
    activity: ProposalActivityInput,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
  ): string {
    return sha256({
      activity: this.withoutAllocationMode(activity),
      sessions,
      templateVersionId,
      resolvedConfig,
    });
  }

  private hashTargetV3(
    activity: ProposalActivityInput,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
  ): string {
    return sha256({
      activity: this.withoutAllocationMode(activity),
      sessions,
      templateVersionId,
      resolvedConfig,
      registrationForm,
    });
  }

  private hashTargetV4(
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
  ): string {
    return sha256({ activity, sessions, templateVersionId, resolvedConfig, registrationForm });
  }

  private hashTargetV5(
    activity: ProposalActivity,
    sessions: ProposalSession[],
    templateVersionId: string | null,
    resolvedConfig: ActivityTemplateResolution,
    registrationForm: RegistrationFormTarget | null,
    qualificationRuleSets: CanonicalQualificationRuleSetsDefinition,
  ): string {
    return sha256({
      activity,
      sessions,
      templateVersionId,
      resolvedConfig,
      registrationForm,
      qualificationRuleSets,
    });
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

  private assertSnapshotQualificationTarget(
    target: CanonicalQualificationRuleSetsDefinition,
  ): void {
    if (!target || typeof target !== 'object' || !Array.isArray(target.ruleSets)) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    try {
      const canonical = canonicalizeQualificationRuleSets(
        qualificationRuleSetsInputFromCanonical(target),
        'ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID',
      );
      // PostgreSQL JSONB preserves values but not object insertion order. Compare
      // the two fully canonical payloads so a key-order-only round trip cannot
      // invalidate an otherwise frozen review snapshot.
      if (
        canonicalize(canonical.definition as unknown as CanonicalValue) !==
        canonicalize(target as unknown as CanonicalValue)
      ) {
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
    const positionRefs = new Set<string>(
      sessions.flatMap((session) =>
        session.positions
          .flatMap((position) => [position.positionId, position.clientRef])
          .filter((value): value is string => value !== null),
      ),
    );
    for (const input of dto.positions.create) {
      const session = sessions.find(
        (candidate) =>
          candidate.sessionId === input.sessionId || candidate.clientRef === input.sessionId,
      );
      if (!session || session.statusCode !== 'scheduled') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (input.clientRef !== undefined) {
        if (positionRefs.has(input.clientRef)) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        }
        positionRefs.add(input.clientRef);
      }
      session.positions.push(this.createPosition(input));
    }
  }

  /**
   * V5 keeps a full canonical target in the review snapshot. Persisted ids and proposal-local
   * refs deliberately share this short-lived representation; `applyPositions` resolves every
   * local ref to a real database id before the RuleSet version service writes anything.
   */
  private applyQualificationRuleSetCollections(
    sessions: ProposalSession[],
    commands: ChangeReviewQualificationRuleSetCollectionsDto | undefined,
    current: CanonicalQualificationRuleSetsDefinition,
  ): CanonicalQualificationRuleSetsDefinition {
    const targets = new Map<string, QualificationRuleSetInput>();
    for (const ruleSet of qualificationRuleSetsInputFromCanonical(current).ruleSets) {
      targets.set(qualificationScopeKey(ruleSet.scope), ruleSet);
    }
    if (commands !== undefined) {
      const seen = new Set<string>();
      const applyUpsert = (
        input: ChangeReviewQualificationRuleSetUpsertDto,
        kind: 'create' | 'update',
      ): void => {
        const scope = this.resolveQualificationScope(sessions, input.scope);
        const key = qualificationScopeKey(scope);
        if (!seen.add(key)) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        }
        if ((kind === 'create' && targets.has(key)) || (kind === 'update' && !targets.has(key))) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        }
        targets.set(key, {
          scope,
          rules: input.rules.map((rule) => ({ ...rule })),
        });
      };
      for (const input of commands.create) applyUpsert(input, 'create');
      for (const input of commands.update) applyUpsert(input, 'update');
      for (const input of commands.cancel) {
        const scope = this.resolveQualificationScope(sessions, input.scope);
        const key = qualificationScopeKey(scope);
        if (!seen.add(key) || !targets.has(key)) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        }
        targets.delete(key);
      }
    }
    const canonical = canonicalizeQualificationRuleSets(
      { ruleSets: [...targets.values()] },
      'ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID',
    ).definition;
    this.assertQualificationScopeTargetsLive(sessions, canonical);
    return canonical;
  }

  private resolveQualificationScope(
    sessions: ProposalSession[],
    input: ChangeReviewQualificationRuleScopeDto,
  ): QualificationRuleScope {
    if (!input || typeof input !== 'object') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (input.sessionId === null) {
      if (input.positionId !== null) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      return { sessionId: null, positionId: null };
    }
    if (typeof input.sessionId !== 'string') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    const session = sessions.find(
      (candidate) =>
        candidate.sessionId === input.sessionId || candidate.clientRef === input.sessionId,
    );
    const sessionId = session?.sessionId ?? session?.clientRef;
    if (!session || typeof sessionId !== 'string') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (input.positionId === null) return { sessionId, positionId: null };
    if (typeof input.positionId !== 'string') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    const position = session.positions.find(
      (candidate) =>
        candidate.positionId === input.positionId || candidate.clientRef === input.positionId,
    );
    const positionId = position?.positionId ?? position?.clientRef;
    if (!position || typeof positionId !== 'string') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    return { sessionId, positionId };
  }

  private assertQualificationScopeTargetsLive(
    sessions: ProposalSession[],
    definition: CanonicalQualificationRuleSetsDefinition,
  ): void {
    for (const ruleSet of definition.ruleSets) {
      if (ruleSet.scope.sessionId === null) continue;
      const session = sessions.find(
        (candidate) =>
          candidate.sessionId === ruleSet.scope.sessionId ||
          candidate.clientRef === ruleSet.scope.sessionId,
      );
      if (!session || session.statusCode !== 'scheduled') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (ruleSet.scope.positionId === null) continue;
      const position = session.positions.find(
        (candidate) =>
          candidate.positionId === ruleSet.scope.positionId ||
          candidate.clientRef === ruleSet.scope.positionId,
      );
      if (!position || position.cancelled) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
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
      clientRef: input.clientRef ?? null,
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
          { sortOrder: left.sortOrder, id: left.positionId ?? left.clientRef ?? left.code },
          { sortOrder: right.sortOrder, id: right.positionId ?? right.clientRef ?? right.code },
        ),
      );
    }
  }

  private assertProposalValid(activity: ProposalActivityInput, sessions: ProposalSession[]): void {
    if (
      activity.allocationModeCode !== undefined &&
      !isActivityAllocationModeCode(activity.allocationModeCode)
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
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
    activity: ProposalActivityInput,
    allocationModeCode: string | undefined,
  ): Promise<void> {
    await tx.activity.update({
      where: { id: activityId },
      data: {
        title: activity.title,
        activityTypeCode: activity.activityTypeCode,
        ...(allocationModeCode === undefined ? {} : { allocationModeCode }),
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
        // P2-14 刀 B:两列已 DROP,不再回写(快照里的同名键恒 null,只服务哈希兼容)。
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
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const session of sessions) {
      const key = session.sessionId ?? session.clientRef ?? session.code;
      const sessionId = sessionIds.get(key);
      if (!sessionId) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      for (const position of session.positions) {
        if (position.positionId === null) {
          if (position.cancelled) continue;
          const created = await tx.activitySessionPosition.create({
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
            select: { id: true },
          });
          if (position.clientRef !== null) ids.set(position.clientRef, created.id);
          continue;
        }
        ids.set(position.positionId, position.positionId);
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
    return ids;
  }

  private applyFormAndRulesPlaceholder(tx: PrismaTx, activityId: string): Promise<void> {
    void tx;
    void activityId;
    // 第 4 批：Form / Rules proposal application。此刀必须显式经过但不得抢跑实装。
    return Promise.resolve();
  }

  /**
   * 本次审批里**刚**从非 cancelled 变成 cancelled 的既有场次。
   *
   * 提案快照每次都带**全量**场次,一个上次就取消掉的场次在这次快照里仍然是 cancelled ——
   * 只看快照会把它当成「又取消了一次」,联动就会重复发通知。因此判据取 DB 现状:
   * 「快照说 cancelled」且「库里还不是 cancelled」。
   *
   * 新建场次(`sessionId === null`)不进这里:它此刻不可能有报名、二维码或人口贡献。
   */
  /**
   * AC-010 改期检测:提案里点名保留(sessionId 非空且非 cancelled)、但任一**时间窗列**
   * (startAt / endAt / checkIn* / checkOut*)与当前库值不同的场次。只比时间窗 ——
   * 改名 / 改地点 / 改容量不是改期,不触发二维码作废重签。
   */
  private async resolveRescheduledSessionIds(
    tx: PrismaTx,
    activityId: string,
    sessions: readonly ProposalSession[],
  ): Promise<string[]> {
    // 旧 schemaVersion 的快照可能不带 sessions;防御性收窄 —— 没有场次就没有改期。
    const proposedKept = (sessions ?? []).filter(
      (session) => session.sessionId !== null && session.statusCode !== 'cancelled',
    );
    if (proposedKept.length === 0) return [];
    const rows = await tx.activitySession.findMany({
      where: { activityId, id: { in: proposedKept.map((s) => s.sessionId as string) } },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        checkInOpenAt: true,
        checkInCloseAt: true,
        checkOutOpenAt: true,
        checkOutCloseAt: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const changed: string[] = [];
    for (const session of proposedKept) {
      const current = byId.get(session.sessionId as string);
      if (current === undefined) continue;
      const windowChanged =
        new Date(session.startAt).getTime() !== current.startAt.getTime() ||
        new Date(session.endAt).getTime() !== current.endAt.getTime() ||
        new Date(session.checkInOpenAt).getTime() !== current.checkInOpenAt.getTime() ||
        new Date(session.checkInCloseAt).getTime() !== current.checkInCloseAt.getTime() ||
        new Date(session.checkOutOpenAt).getTime() !== current.checkOutOpenAt.getTime() ||
        new Date(session.checkOutCloseAt).getTime() !== current.checkOutCloseAt.getTime();
      if (windowChanged) changed.push(current.id);
    }
    return changed.sort();
  }

  private async resolveNewlyCancelledSessionIds(
    tx: PrismaTx,
    activityId: string,
    sessions: readonly ProposalSession[],
  ): Promise<string[]> {
    const proposedCancelledIds = sessions.flatMap((session) =>
      session.sessionId !== null && session.statusCode === 'cancelled' ? [session.sessionId] : [],
    );
    if (proposedCancelledIds.length === 0) return [];
    const rows = await tx.activitySession.findMany({
      where: {
        activityId,
        id: { in: proposedCancelledIds },
        statusCode: { not: 'cancelled' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }
}

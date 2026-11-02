import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAccessService } from './activity-access.service';
import { ActivityCreationService } from './activity-creation.service';
import { mapCreationPlace, mapQuickCreation } from './activity-creation-command';
import { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import {
  ActivityMetricSelectionAccess,
  lockMetricSelectionReference,
} from './activity-metric-selection-access';
import { parseActivityMetricSelection } from './activity-metric-selection';
import { writeSimpleDraftPlaces } from './activity-place-writer';
import {
  parseSimpleActivityInstance,
  simpleDraftHash,
  simpleDraftLayout,
} from './activity-simple-draft-plan';
import { parseStoredTemplateVersion } from './activity-template-version-presenter';
import { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';
import { ActivityTimePolicySelectionService } from './activity-time-policy-selection.service';
import { ActivityContributionPolicySelectionAccess } from './activity-contribution-policy-selection-access';
import { ActivityContributionPolicySelectionService } from './activity-contribution-policy-selection.service';
import { readStoredActivityTimePolicySelection } from './activity-time-policy-selection-presenter';
import { readStoredActivityContributionPolicySelection } from './activity-contribution-policy-selection-presenter';
import type {
  AdminCreateSimpleActivityDto,
  AdminSaveSimpleActivityDto,
} from './dto/admin/admin-simple-activity.dto';
import type { CanonicalValue } from './settlement-content-hash';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { ActivityPublishReviewSubmitService } from './activity-publish-review-submit.service';
import type { AdminSubmitSimpleActivityReviewDto } from './dto/admin/admin-simple-activity.dto';

const ACTIVITY = {
  id: true,
  updatedAt: true,
  title: true,
  organizationId: true,
  activityTypeCode: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  registrationDeadline: true,
  registrationNotes: true,
  statusCode: true,
  initiatorMemberId: true,
  workflowRevision: true,
  selectedTemplateVersionId: true,
  allocationModeCode: true,
  genderRequirementCode: true,
  requiresInsurance: true,
  isPublicRegistration: true,
  registrationModeCode: true,
  registrationSchema: true,
  visibilityCode: true,
  defaultLocationRequired: true,
  defaultCheckInRadiusMeters: true,
  metricRequirementCode: true,
  selectedMetricSetVersionId: true,
  selectedMetricSetDefinitionHash: true,
  metricSelectionRevision: true,
  timePolicySelectionRevision: true,
  currentTimePolicySelectionRevisionId: true,
  contributionPolicySelectionRevision: true,
  currentContributionPolicySelectionRevisionId: true,
  locationLongitude: true,
  locationLatitude: true,
} as const satisfies Prisma.ActivitySelect;
type ActivityRow = Prisma.ActivityGetPayload<{ select: typeof ACTIVITY }>;
type Tx = Prisma.TransactionClient;

@Injectable()
export class ActivitySimpleDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creation: ActivityCreationService,
    private readonly access: ActivityAccessService,
    private readonly identities: ActivityMetricSelectionAccess,
    private readonly initiation: ActivityInitiationPolicy,
    private readonly templates: ActivityFromTemplateService,
    private readonly timeAccess: ActivityTimePolicySelectionAccess,
    private readonly timePolicies: ActivityTimePolicySelectionService,
    private readonly contributionAccess: ActivityContributionPolicySelectionAccess,
    private readonly contributionPolicies: ActivityContributionPolicySelectionService,
    private readonly audit: ActivityDraftAuditRecorder,
    private readonly managed: AppManagedActivitiesService,
    private readonly reviewSubmit: ActivityPublishReviewSubmitService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  organizationOptions(user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        const actor = await this.identities.current(tx, user, 'app');
        if (!actor.memberId) throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
        return this.managed.organizationOptions(actor, actor.memberId, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  submitReview(
    activityId: string,
    input: AdminSubmitSimpleActivityReviewDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    return this.reviewSubmit.submitInitialProposal(
      activityId,
      { operationKey: input.operationKey, confirmation: input.confirmation },
      user,
      meta,
      async (tx) => {
        await this.authorize(tx, activityId, user, false);
      },
    );
  }

  async create(input: AdminCreateSimpleActivityDto, user: CurrentUserPayload, meta: AuditMeta) {
    const command = {
      ...mapQuickCreation({
        operationKey: input.operationKey,
        templateVersionId: input.templateVersionId,
        title: input.title,
        organizationId: input.organizationId,
        startAt: input.startAt,
        endAt: input.endAt,
        location: input.location,
        confirmedCapacity: input.confirmedCapacity,
        defaultPlaceVisibilityCode: input.defaultPlaceVisibilityCode,
        places: input.places,
      }),
      ...(input.instance === undefined
        ? {}
        : { instance: parseSimpleActivityInstance(input.instance) }),
    };
    const result = await this.creation.createQuick(command, user, meta, true);
    return {
      activityId: result.activity.activityId,
      createdAt: result.activity.createdAt,
      createdStatusCode: result.activity.createdStatusCode,
      replayed: result.replayed,
    };
  }

  get(activityId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        const { activity } = await this.authorize(tx, activityId, user, false);
        const bundle = await this.readBundle(tx, activity);
        this.assertSimple(bundle);
        return this.present(bundle);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  save(
    activityId: string,
    input: AdminSaveSimpleActivityDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    const instance = parseSimpleActivityInstance(input.instance);
    if (!/^[0-9a-f]{64}$/u.test(input.expectedDraftHash))
      throw new BizException(BizCode.BAD_REQUEST);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      let current = await this.authorize(tx, activityId, user, true);
      const revalidate = async () => {
        current = await this.authorize(tx, activityId, user, true);
      };
      await tx.$queryRaw`SELECT "id" FROM "ActivitySession" WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ActivitySessionPosition" WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ActivityPlace" WHERE "activityId" = ${activityId} ORDER BY "id" FOR UPDATE`;
      await revalidate();
      const before = await this.readBundle(tx, current.activity);
      this.assertSimple(before);
      if (this.hash(before) !== input.expectedDraftHash)
        throw new BizException(BizCode.ACTIVITY_SIMPLE_DRAFT_STALE);
      const selected = await this.templates.simpleDraftTemplateWithinTransaction(
        tx,
        before.template.id,
        revalidate,
      );
      if (selected.definitionHash !== before.template.definitionHash)
        throw new BizException(BizCode.ACTIVITY_SIMPLE_DRAFT_STALE);
      const startAt = new Date(input.startAt),
        endAt = new Date(input.endAt);
      this.access.assertStartEndValid(startAt, endAt);
      this.access.assertRegistrationDeadlineValid(
        instance.registrationDeadline === null ? null : new Date(instance.registrationDeadline),
        endAt,
      );
      const layout = simpleDraftLayout(
        selected.definition,
        startAt,
        endAt,
        instance.capacity,
        input.location,
      );
      await this.initiation.resolveInitiator(current.actor, input.organizationId, undefined, tx);
      await this.access.assertCanOrThrow(
        current.actor,
        'activity.update.record',
        { type: 'organization', id: input.organizationId },
        tx,
      );
      const session = before.sessions[0],
        position = before.positions[0];
      await tx.activity.update({
        where: { id: activityId },
        data: {
          title: input.title,
          organizationId: input.organizationId,
          startAt,
          endAt,
          location: input.location,
          capacity: instance.capacity,
          description: instance.description,
          registrationNotes: instance.registrationNotes,
          registrationDeadline:
            instance.registrationDeadline === null ? null : new Date(instance.registrationDeadline),
        },
      });
      await tx.activitySession.update({ where: { id: session.id }, data: layout.session });
      await tx.activitySessionPosition.update({
        where: { id: position.id },
        data: layout.position,
      });
      const places = input.places.map(mapCreationPlace);
      await writeSimpleDraftPlaces(tx, {
        activityId,
        revalidate,
        sessions: [{ id: session.id, code: session.code, locationText: input.location }],
        places: places.flatMap((place) => [place, { ...place, sessionCode: session.code }]),
      });
      await revalidate();
      if (current.activity.metricRequirementCode !== null) {
        const pointer =
          current.activity.selectedMetricSetVersionId === null
            ? null
            : await tx.activityMetricSetVersion.findFirst({
                where: { id: current.activity.selectedMetricSetVersionId },
              });
        const selection = parseActivityMetricSelection(
          current.activity.metricRequirementCode === 'not_required'
            ? { metricRequirementCode: 'not_required', metricSetPointer: null }
            : {
                metricRequirementCode: current.activity.metricRequirementCode,
                metricSetPointer: pointer && {
                  id: pointer.id,
                  code: pointer.code,
                  version: pointer.version,
                  schemaVersion: pointer.schemaVersion,
                  definitionHash: current.activity.selectedMetricSetDefinitionHash,
                },
              },
        );
        await lockMetricSelectionReference(tx, selection, revalidate);
      }
      await this.timePolicies.assertCurrentForDraftWithinTransaction(
        tx,
        current.activity,
        revalidate,
      );
      await this.contributionPolicies.assertCurrentForDraftWithinTransaction(
        tx,
        current.activity,
        revalidate,
      );
      await revalidate();
      await this.audit.log({
        activityId,
        sessionId: session.id,
        positionId: position.id,
        operation: 'simple-draft-update',
        actorUserId: current.actor.id,
        actorRoleSnap: current.actor.role,
        changedFields: [
          'title',
          'organizationId',
          'startAt',
          'endAt',
          'location',
          'capacity',
          'registrationDeadline',
          'description',
          'registrationNotes',
          'places',
        ],
        auditMeta: meta,
        tx,
      });
      const after = await this.readBundle(tx, current.activity);
      this.assertSimple(after);
      return this.present(after);
    });
  }

  private async authorize(tx: Tx, activityId: string, user: CurrentUserPayload, write: boolean) {
    if (!this.config.activityResponsibilityWorkflow.enabled)
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    const actor = await this.identities.current(tx, user, 'app');
    const activity = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: ACTIVITY,
    });
    if (!activity || !actor.memberId || actor.memberId !== activity.initiatorMemberId)
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    await this.initiation.resolveInitiator(actor, activity.organizationId, undefined, tx);
    if (write) {
      await this.access.assertCanOrThrow(
        actor,
        'activity.update.record',
        { type: 'activity', id: activityId },
        tx,
      );
      if (activity.statusCode !== 'draft')
        throw new BizException(
          activity.statusCode === 'published'
            ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
            : BizCode.ACTIVITY_STATUS_INVALID,
        );
      if (
        await tx.activityPublishReview.findFirst({
          where: { activityId, status: 'pending' },
          select: { id: true },
        })
      )
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    }
    if (activity.timePolicySelectionRevision > 0) {
      await this.timeAccess.authorize(tx, actor, 'admin', activityId, 'activity.time-policy.read');
      if (write)
        await this.timeAccess.authorize(
          tx,
          actor,
          'admin',
          activityId,
          'activity.time-policy.select',
        );
    }
    if (activity.contributionPolicySelectionRevision > 0) {
      await this.contributionAccess.authorize(
        tx,
        actor,
        'admin',
        activityId,
        'activity.contribution-policy.read',
      );
      if (write)
        await this.contributionAccess.authorize(
          tx,
          actor,
          'admin',
          activityId,
          'activity.contribution-policy.select',
        );
    }
    return { actor, activity };
  }

  private async readBundle(tx: Tx, activity: ActivityRow) {
    const template = activity.selectedTemplateVersionId
      ? await tx.activityTemplate.findFirst({
          where: { id: activity.selectedTemplateVersionId },
          include: { family: true },
        })
      : null;
    if (!template) throw new BizException(BizCode.BAD_REQUEST);
    const [sessions, positions, places, forms, review, time, contribution] = await Promise.all([
      tx.activitySession.findMany({
        where: notDeletedWhere({ activityId: activity.id }),
        orderBy: { id: 'asc' },
        take: 2,
      }),
      tx.activitySessionPosition.findMany({
        where: notDeletedWhere({ activityId: activity.id }),
        orderBy: { id: 'asc' },
        take: 2,
      }),
      tx.activityPlace.findMany({
        where: { activityId: activity.id },
        orderBy: { id: 'asc' },
        take: 13,
      }),
      tx.registrationFormVersion.findMany({
        where: { activityId: activity.id },
        include: { fields: { orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
      tx.activityPublishReview.findFirst({
        where: { activityId: activity.id },
        select: { id: true, status: true, requestType: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      activity.currentTimePolicySelectionRevisionId
        ? tx.activityTimePolicySelectionRevision.findFirst({
            where: {
              id: activity.currentTimePolicySelectionRevisionId,
              activityId: activity.id,
              revision: activity.timePolicySelectionRevision,
            },
            include: {
              items: {
                include: { version: { include: { policy: true } } },
                orderBy: { id: 'asc' },
              },
            },
          })
        : null,
      activity.currentContributionPolicySelectionRevisionId
        ? tx.activityContributionPolicySelectionRevision.findFirst({
            where: {
              id: activity.currentContributionPolicySelectionRevisionId,
              activityId: activity.id,
              revision: activity.contributionPolicySelectionRevision,
            },
            include: {
              items: {
                include: { version: { include: { policy: true } } },
                orderBy: { id: 'asc' },
              },
            },
          })
        : null,
    ]);
    if (
      activity.timePolicySelectionRevision > 0 !== (time !== null) ||
      activity.contributionPolicySelectionRevision > 0 !== (contribution !== null) ||
      (activity.timePolicySelectionRevision === 0) !==
        (activity.currentTimePolicySelectionRevisionId === null) ||
      (activity.contributionPolicySelectionRevision === 0) !==
        (activity.currentContributionPolicySelectionRevisionId === null)
    )
      throw new BizException(BizCode.BAD_REQUEST);
    if (time) readStoredActivityTimePolicySelection(time);
    if (contribution) readStoredActivityContributionPolicySelection(contribution);
    return { activity, template, sessions, positions, places, forms, review, time, contribution };
  }

  private assertSimple(bundle: Awaited<ReturnType<ActivitySimpleDraftService['readBundle']>>) {
    const { activity, sessions, positions, places, template } = bundle;
    if (
      sessions.length !== 1 ||
      positions.length !== 1 ||
      places.length < 2 ||
      places.length > 12 ||
      activity.allocationModeCode !== 'first_come'
    )
      throw new BizException(BizCode.BAD_REQUEST);
    const definition = (() => {
      try {
        return parseStoredTemplateVersion(template);
      } catch {
        throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
      }
    })();
    const expected = simpleDraftLayout(
      definition,
      activity.startAt,
      activity.endAt,
      activity.capacity,
      activity.location,
    );
    const session = sessions[0],
      position = positions[0];
    const sameInstant = (left: Date | null, right: Date | null) =>
      (left?.getTime() ?? null) === (right?.getTime() ?? null);
    const windows = [
      'checkInOpenAt',
      'checkInCloseAt',
      'checkOutOpenAt',
      'checkOutCloseAt',
      'preparationStartAt',
    ] as const;
    if (
      position.sessionId !== session.id ||
      (activity.statusCode === 'draft' && session.statusCode !== 'scheduled') ||
      position.qualificationRuleSetId !== null ||
      session.startAt.getTime() !== activity.startAt.getTime() ||
      session.endAt.getTime() !== activity.endAt.getTime() ||
      session.capacity !== activity.capacity ||
      position.capacity !== activity.capacity ||
      !sameInstant(position.startAt, expected.position.startAt) ||
      !sameInstant(position.endAt, expected.position.endAt) ||
      windows.some((field) => !sameInstant(session[field], expected.session[field])) ||
      position.code !== definition.sessions[0].positions[0].code ||
      session.code !== definition.sessions[0].code
    )
      throw new BizException(BizCode.BAD_REQUEST);
    const root = places.filter((place) => place.sessionId === null),
      local = places.filter((place) => place.sessionId === session.id);
    if (
      root.length + local.length !== places.length ||
      root.length !== local.length ||
      new Set(root.map((place) => place.roleCode)).size !== root.length ||
      new Set(local.map((place) => place.roleCode)).size !== local.length ||
      root.filter((place) => place.roleCode === 'primary').length !== 1
    )
      throw new BizException(BizCode.BAD_REQUEST);
    for (const row of root) {
      const other = local.find((place) => place.roleCode === row.roleCode);
      const projection = (place: typeof row) => ({
        activityId: place.activityId,
        roleCode: place.roleCode,
        name: place.name,
        addressText: place.addressText,
        instruction: place.instruction,
        longitude: place.longitude,
        latitude: place.latitude,
        coordinateSystemCode: place.coordinateSystemCode,
        providerCode: place.providerCode,
        providerPlaceId: place.providerPlaceId,
        visibilityCode: place.visibilityCode,
        checkInEligible: place.checkInEligible,
        radiusMeters: place.radiusMeters,
        sourcePresetId: place.sourcePresetId,
      });
      if (!other || JSON.stringify(projection(row)) !== JSON.stringify(projection(other)))
        throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  private hash(bundle: Awaited<ReturnType<ActivitySimpleDraftService['readBundle']>>) {
    const { activity, template, sessions, positions, places, forms, review, time, contribution } =
      bundle;
    return simpleDraftHash(
      JSON.parse(
        JSON.stringify({
          activity,
          template: {
            id: template.id,
            definitionHash: template.definitionHash,
            statusCode: template.statusCode,
            family: template.family,
          },
          sessions,
          positions,
          places,
          forms,
          review,
          time: time?.selectionHash ?? null,
          contribution: contribution?.selectionHash ?? null,
        }),
      ) as CanonicalValue,
    );
  }

  private present(bundle: Awaited<ReturnType<ActivitySimpleDraftService['readBundle']>>) {
    const {
      activity: row,
      template,
      sessions,
      positions,
      places,
      review,
      time,
      contribution,
    } = bundle;
    const session = sessions[0],
      position = positions[0];
    const policy = (kind: 'time' | 'contribution', revision: typeof time | typeof contribution) =>
      (revision?.items ?? []).map((item) => ({
        kind,
        layerCode: item.layerCode,
        mode: item.mode,
        name: item.version?.policy.name ?? null,
        version: item.version?.version ?? null,
        effectiveFrom: item.version?.effectiveFrom.toISOString() ?? null,
        effectiveUntil: item.version?.effectiveUntil?.toISOString() ?? null,
      }));
    return {
      activityId: row.id,
      title: row.title,
      organizationId: row.organizationId,
      activityTypeCode: row.activityTypeCode,
      allocationModeCode: row.allocationModeCode,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      location: row.location,
      instance: {
        capacity: row.capacity,
        registrationDeadline: row.registrationDeadline?.toISOString() ?? null,
        description: row.description,
        registrationNotes: row.registrationNotes,
      },
      statusCode: row.statusCode,
      review,
      editable:
        row.statusCode === 'draft' &&
        review?.status !== 'pending' &&
        template.statusCode === 'active',
      draftHash: this.hash(bundle),
      selectedTemplateVersionId: template.id,
      definitionHash: template.definitionHash!,
      session: {
        id: session.id,
        code: session.code,
        name: session.name,
        startAt: session.startAt.toISOString(),
        endAt: session.endAt.toISOString(),
        capacity: session.capacity,
        checkInOpenAt: session.checkInOpenAt.toISOString(),
        checkInCloseAt: session.checkInCloseAt.toISOString(),
        checkOutOpenAt: session.checkOutOpenAt.toISOString(),
        checkOutCloseAt: session.checkOutCloseAt.toISOString(),
        preparationStartAt: session.preparationStartAt?.toISOString() ?? null,
      },
      position: {
        id: position.id,
        code: position.code,
        name: position.name,
        attendanceRoleCode: position.attendanceRoleCode,
        capacity: position.capacity,
        startAt: position.startAt?.toISOString() ?? null,
        endAt: position.endAt?.toISOString() ?? null,
      },
      places: places
        .filter((place) => place.sessionId === null)
        .map((place) => ({
          roleCode: place.roleCode,
          visibilityCode: place.visibilityCode,
          inline: {
            name: place.name,
            addressText: place.addressText,
            ...(place.instruction === null ? {} : { instruction: place.instruction }),
            ...(place.longitude === null ||
            place.latitude === null ||
            place.coordinateSystemCode === null
              ? {}
              : {
                  coordinate: {
                    longitude: Number(place.longitude),
                    latitude: Number(place.latitude),
                    coordinateSystemCode: place.coordinateSystemCode,
                  },
                }),
            ...(place.providerCode === null ? {} : { providerCode: place.providerCode }),
            ...(place.providerPlaceId === null ? {} : { providerPlaceId: place.providerPlaceId }),
            checkInEligible: place.checkInEligible,
            ...(place.radiusMeters === null ? {} : { radiusMeters: place.radiusMeters }),
          },
        })),
      policies: [...policy('time', time), ...policy('contribution', contribution)],
    };
  }
}

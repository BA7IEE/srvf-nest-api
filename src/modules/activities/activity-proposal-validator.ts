import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma, type PrismaClient } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { UpdateActivityDto } from './activities.dto';
import type { AppActivityChangePositionDto } from './dto/app/app-managed-activity.dto';
import type {
  ActivityProposalActivity,
  ActivityProposalPosition,
  ActivityProposalSnapshot,
} from './activity-proposal.types';

type PrismaTx = Prisma.TransactionClient;
type ProposalClient = Pick<
  PrismaClient,
  'activity' | 'activityPosition' | 'activityRegistration' | 'dictItem' | 'organization'
>;

const proposalActivitySelect = {
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
  activityPositions: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      attendanceRoleCode: true,
      capacity: true,
      startAt: true,
      endAt: true,
      genderRequirementCode: true,
      description: true,
      sortOrder: true,
    },
  },
} as const satisfies Prisma.ActivitySelect;

@Injectable()
export class ActivityProposalValidator {
  async buildChangeSnapshot(
    tx: PrismaTx,
    activityId: string,
    activityPatch: UpdateActivityDto,
    submittedPositions?: AppActivityChangePositionDto[],
  ): Promise<ActivityProposalSnapshot> {
    const current = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: proposalActivitySelect,
    });
    const activity: ActivityProposalActivity = {
      title: activityPatch.title ?? current.title,
      activityTypeCode: activityPatch.activityTypeCode ?? current.activityTypeCode,
      organizationId: activityPatch.organizationId ?? current.organizationId,
      startAt: activityPatch.startAt ?? current.startAt.toISOString(),
      endAt: activityPatch.endAt ?? current.endAt.toISOString(),
      location: activityPatch.location ?? current.location,
      description: activityPatch.description ?? current.description,
      capacity: activityPatch.capacity === undefined ? current.capacity : activityPatch.capacity,
      genderRequirementCode: activityPatch.genderRequirementCode ?? current.genderRequirementCode,
      registrationDeadline:
        activityPatch.registrationDeadline ?? current.registrationDeadline?.toISOString() ?? null,
      registrationNotes: activityPatch.registrationNotes ?? current.registrationNotes,
      isPublicRegistration: activityPatch.isPublicRegistration ?? current.isPublicRegistration,
      requiresInsurance: activityPatch.requiresInsurance ?? current.requiresInsurance,
      registrationSchema:
        (activityPatch.registrationSchema as Prisma.JsonValue | undefined) ??
        current.registrationSchema,
      coverImageUrl: activityPatch.coverImageUrl ?? current.coverImageUrl,
      galleryImageUrls: current.galleryImageUrls,
      content: (activityPatch.content as Prisma.JsonValue | undefined) ?? current.content,
      locationLongitude:
        activityPatch.locationLongitude ?? current.locationLongitude?.toString() ?? null,
      locationLatitude:
        activityPatch.locationLatitude ?? current.locationLatitude?.toString() ?? null,
    };
    this.assertOrganizationUnchanged(current.organizationId, activity.organizationId);
    const positions =
      submittedPositions === undefined
        ? current.activityPositions.map(
            (position): ActivityProposalPosition => ({
              activityPositionId: position.id,
              clientRef: null,
              name: position.name,
              attendanceRoleCode: position.attendanceRoleCode,
              capacity: position.capacity,
              startAt: position.startAt?.toISOString() ?? null,
              endAt: position.endAt?.toISOString() ?? null,
              genderRequirementCode: position.genderRequirementCode,
              description: position.description,
              sortOrder: position.sortOrder,
            }),
          )
        : submittedPositions.map(
            (position): ActivityProposalPosition => ({
              activityPositionId: position.activityPositionId ?? null,
              clientRef: position.clientRef ?? null,
              name: position.name,
              attendanceRoleCode: position.attendanceRoleCode,
              capacity: position.capacity ?? null,
              startAt: position.startAt ?? null,
              endAt: position.endAt ?? null,
              genderRequirementCode: position.genderRequirementCode ?? null,
              description: position.description ?? null,
              sortOrder: position.sortOrder ?? 0,
            }),
          );
    const snapshot: ActivityProposalSnapshot = {
      schemaVersion: 1,
      activity,
      positions: this.sortPositions(positions),
    };
    await this.validate(tx, activityId, snapshot);
    return snapshot;
  }

  assertOrganizationUnchanged(currentOrganizationId: string, proposedOrganizationId: string): void {
    if (proposedOrganizationId !== currentOrganizationId) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
  }

  async validate(
    client: ProposalClient,
    activityId: string,
    snapshot: ActivityProposalSnapshot,
  ): Promise<void> {
    this.assertShape(snapshot);
    const startAt = new Date(snapshot.activity.startAt);
    const endAt = new Date(snapshot.activity.endAt);
    const registrationDeadline =
      snapshot.activity.registrationDeadline === null
        ? null
        : new Date(snapshot.activity.registrationDeadline);
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      startAt.getTime() >= endAt.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    }
    if (
      registrationDeadline !== null &&
      (Number.isNaN(registrationDeadline.getTime()) ||
        registrationDeadline.getTime() > endAt.getTime())
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
    await Promise.all([
      this.assertDictionary(
        client,
        'activity_type',
        snapshot.activity.activityTypeCode,
        BizCode.ACTIVITY_TYPE_CODE_INVALID,
      ),
      snapshot.activity.genderRequirementCode === null
        ? Promise.resolve()
        : this.assertDictionary(
            client,
            'gender_requirement',
            snapshot.activity.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          ),
      this.assertOrganization(client, snapshot.activity.organizationId),
    ]);

    const positionIds = new Set<string>();
    const clientRefs = new Set<string>();
    const names = new Set<string>();
    for (const position of snapshot.positions) {
      const hasId = position.activityPositionId !== null;
      const hasRef = position.clientRef !== null;
      if (hasId === hasRef) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (
        (position.activityPositionId !== null && positionIds.has(position.activityPositionId)) ||
        (position.clientRef !== null && clientRefs.has(position.clientRef))
      ) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (position.activityPositionId !== null) positionIds.add(position.activityPositionId);
      if (position.clientRef !== null) clientRefs.add(position.clientRef);
      if (names.has(position.name)) {
        throw new BizException(BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS);
      }
      names.add(position.name);
      const positionStart = position.startAt === null ? null : new Date(position.startAt);
      const positionEnd = position.endAt === null ? null : new Date(position.endAt);
      if (
        (positionStart === null) !== (positionEnd === null) ||
        (positionStart !== null &&
          positionEnd !== null &&
          (Number.isNaN(positionStart.getTime()) ||
            Number.isNaN(positionEnd.getTime()) ||
            positionStart.getTime() >= positionEnd.getTime() ||
            positionStart.getTime() < startAt.getTime() ||
            positionEnd.getTime() > endAt.getTime()))
      ) {
        throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
      }
      await this.assertDictionary(
        client,
        'attendance_role',
        position.attendanceRoleCode,
        BizCode.ATTENDANCE_ROLE_CODE_INVALID,
      );
      if (position.genderRequirementCode !== null) {
        await this.assertDictionary(
          client,
          'gender_requirement',
          position.genderRequirementCode,
          BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
        );
      }
    }
    const existing = await client.activityPosition.findMany({
      where: { id: { in: [...positionIds] }, activityId, deletedAt: null },
      select: { id: true },
    });
    if (existing.length !== positionIds.size) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    if (snapshot.activity.capacity !== null && snapshot.positions.length > 0) {
      if (
        snapshot.positions.some((position) => position.capacity === null) ||
        snapshot.positions.reduce((sum, position) => sum + (position.capacity ?? 0), 0) >
          snapshot.activity.capacity
      ) {
        throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
      }
    }
    const passCounts = await client.activityRegistration.groupBy({
      by: ['activityPositionId'],
      where: { activityId, statusCode: 'pass', deletedAt: null },
      _count: { _all: true },
    });
    const totalPass = passCounts.reduce((sum, row) => sum + row._count._all, 0);
    if (snapshot.activity.capacity !== null && totalPass > snapshot.activity.capacity) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
    }
    const proposalById = new Map(
      snapshot.positions
        .filter(
          (position): position is ActivityProposalPosition & { activityPositionId: string } =>
            position.activityPositionId !== null,
        )
        .map((position) => [position.activityPositionId, position]),
    );
    for (const count of passCounts) {
      if (count.activityPositionId === null) continue;
      const proposal = proposalById.get(count.activityPositionId);
      if (!proposal || (proposal.capacity !== null && count._count._all > proposal.capacity)) {
        throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
      }
    }
  }

  private assertShape(snapshot: ActivityProposalSnapshot): void {
    const activity = snapshot.activity;
    if (
      snapshot.schemaVersion !== 1 ||
      !activity ||
      !Array.isArray(snapshot.positions) ||
      typeof activity.title !== 'string' ||
      typeof activity.activityTypeCode !== 'string' ||
      typeof activity.organizationId !== 'string' ||
      typeof activity.startAt !== 'string' ||
      typeof activity.endAt !== 'string' ||
      typeof activity.location !== 'string' ||
      (activity.capacity !== null &&
        (!Number.isInteger(activity.capacity) || activity.capacity < 1))
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    for (const position of snapshot.positions) {
      if (
        !position ||
        typeof position.name !== 'string' ||
        typeof position.attendanceRoleCode !== 'string' ||
        !Number.isInteger(position.sortOrder) ||
        (position.capacity !== null &&
          (!Number.isInteger(position.capacity) || position.capacity < 1))
      ) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
    }
  }

  private async assertDictionary(
    client: ProposalClient,
    typeCode: string,
    code: string,
    biz: (typeof BizCode)[keyof typeof BizCode],
  ): Promise<void> {
    const row = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!row) throw new BizException(biz);
  }

  private async assertOrganization(client: ProposalClient, organizationId: string): Promise<void> {
    const row = await client.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { parentId: true },
    });
    if (!row) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    if (row.parentId === null) {
      throw new BizException(BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN);
    }
  }

  private sortPositions(positions: ActivityProposalPosition[]): ActivityProposalPosition[] {
    return [...positions].sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        (left.activityPositionId ?? left.clientRef ?? '').localeCompare(
          right.activityPositionId ?? right.clientRef ?? '',
        ),
    );
  }
}

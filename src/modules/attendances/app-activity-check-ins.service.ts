import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  ActivityCheckInFieldPolicy,
  type AppActivityCheckInRow,
} from './activity-check-in-field-policy';
import { ActivityCheckInLocationPolicy } from './activity-check-in-location-policy';
import {
  type ActivityCheckInAction,
  type ActivityCheckInDecision,
  ActivityCheckInPolicy,
} from './activity-check-in-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';
import { AppActivityCheckInDto } from './dto/app/app-activity-check-in.dto';
import { ActivityCheckInLocationDto } from './dto/app/activity-check-in-location.dto';

const ACTIVITY_GATE_SELECT = {
  id: true,
  statusCode: true,
  startAt: true,
  endAt: true,
  locationLongitude: true,
  locationLatitude: true,
} as const satisfies Prisma.ActivitySelect;

const REGISTRATION_GATE_SELECT = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  activityPosition: {
    select: {
      startAt: true,
      endAt: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

type ActivityGateRow = Prisma.ActivityGetPayload<{ select: typeof ACTIVITY_GATE_SELECT }>;
type RegistrationGateRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof REGISTRATION_GATE_SELECT;
}>;

interface LockedWriteContext {
  activity: ActivityGateRow;
  registration: RegistrationGateRow;
  now: Date;
}

interface LocationEvidence {
  longitude: Prisma.Decimal;
  latitude: Prisma.Decimal;
  accuracy: Prisma.Decimal | null;
  distance: Prisma.Decimal;
  geoVerified: true;
  outOfRange: false;
}

@Injectable()
export class AppActivityCheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly policy: ActivityCheckInPolicy,
    private readonly locationPolicy: ActivityCheckInLocationPolicy,
    private readonly fieldPolicy: ActivityCheckInFieldPolicy,
    private readonly presenter: ActivityCheckInPresenter,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async checkIn(
    activityId: string,
    dto: ActivityCheckInLocationDto,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    const memberId = await this.resolveMemberIdOrThrow(currentUser);
    await this.preflightWrite(activityId, memberId, 'check-in');

    let attemptedRegistrationId: string | null = null;
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const context = await this.lockAndLoadWriteContext(tx, activityId, memberId, 'check-in');
        attemptedRegistrationId = context.registration.id;

        const existing = await this.findCurrentEvidence(tx, context.registration.id);
        if (existing !== null) return existing;

        this.assertAllowed(
          this.policy.canWriteByTime(
            'check-in',
            this.resolveCheckInSchedule(context.activity, context.registration),
            context.now,
            this.config.attendance.windowToleranceHours,
          ),
        );

        const location = this.buildLocationEvidence(context.activity, dto);
        return tx.activityCheckIn.create({
          data: {
            activityId: context.activity.id,
            memberId,
            registrationId: context.registration.id,
            checkInAt: context.now,
            checkInLongitude: location.longitude,
            checkInLatitude: location.latitude,
            checkInAccuracy: location.accuracy,
            checkInDistance: location.distance,
            geoVerified: location.geoVerified,
            outOfRange: location.outOfRange,
          },
          select: this.fieldPolicy.appSelect,
        });
      });
      return this.presenter.toAppDto(row);
    } catch (error) {
      // partial unique 竞争会令当前事务进入 failed 状态；必须退出事务后再读 winner。
      if (this.isP2002(error) && attemptedRegistrationId !== null) {
        const winner = await this.findCurrentEvidence(this.prisma, attemptedRegistrationId);
        if (winner !== null) return this.presenter.toAppDto(winner);
      }
      throw error;
    }
  }

  async checkOut(
    activityId: string,
    dto: ActivityCheckInLocationDto,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    const memberId = await this.resolveMemberIdOrThrow(currentUser);
    await this.preflightWrite(activityId, memberId, 'check-out');

    const row = await this.prisma.$transaction(async (tx) => {
      const context = await this.lockAndLoadWriteContext(tx, activityId, memberId, 'check-out');
      const existing = await this.findCurrentEvidence(tx, context.registration.id);
      if (existing === null) {
        throw new BizException(BizCode.ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN);
      }
      if (existing.checkOutAt !== null) return existing;

      this.assertAllowed(
        this.policy.canWriteByTime(
          'check-out',
          this.resolveCheckInSchedule(context.activity, context.registration),
          context.now,
          this.config.attendance.windowToleranceHours,
          existing.checkInAt,
        ),
      );

      const location = this.buildLocationEvidence(context.activity, dto);
      const claimed = await tx.activityCheckIn.updateMany({
        where: { id: existing.id, deletedAt: null, checkOutAt: null },
        data: {
          checkOutAt: context.now,
          checkOutLongitude: location.longitude,
          checkOutLatitude: location.latitude,
          checkOutAccuracy: location.accuracy,
          checkOutDistance: location.distance,
        },
      });

      if (claimed.count === 0) {
        const winner = await this.findCurrentEvidence(tx, context.registration.id);
        if (winner !== null && winner.checkOutAt !== null) return winner;
        throw new BizException(BizCode.ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN);
      }

      const updated = await this.findCurrentEvidence(tx, context.registration.id);
      if (updated === null) {
        throw new BizException(BizCode.ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN);
      }
      return updated;
    });

    return this.presenter.toAppDto(row);
  }

  async getCurrent(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    const memberId = await this.resolveMemberIdOrThrow(currentUser);
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const registration = await this.prisma.activityRegistration.findFirst({
      where: {
        activityId,
        memberId,
        deletedAt: null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (registration === null) {
      throw new BizException(BizCode.ACTIVITY_CHECK_IN_NOT_FOUND);
    }

    const row = await this.findCurrentEvidence(this.prisma, registration.id);
    if (row === null) throw new BizException(BizCode.ACTIVITY_CHECK_IN_NOT_FOUND);
    return this.presenter.toAppDto(row);
  }

  private async resolveMemberIdOrThrow(currentUser: CurrentUserPayload): Promise<string> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member.id;
  }

  // 锁前查询只作快速失败；所有可变闸都会在固定锁序内用 authoritative now 重跑。
  private async preflightWrite(
    activityId: string,
    memberId: string,
    action: ActivityCheckInAction,
  ): Promise<void> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: ACTIVITY_GATE_SELECT,
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    this.assertAllowed(this.policy.canWriteByStatus(action, activity.statusCode));

    const registration = await this.prisma.activityRegistration.findFirst({
      where: {
        activityId,
        memberId,
        deletedAt: null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (registration === null) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    }
  }

  private async lockAndLoadWriteContext(
    tx: Prisma.TransactionClient,
    activityId: string,
    memberId: string,
    action: ActivityCheckInAction,
  ): Promise<LockedWriteContext> {
    // 固定锁序 Activity → 当前 pass registration。FOR SHARE 允许同活动不同队员并发，
    // 同时与活动/报名 UPDATE 冲突，阻止状态与 pass 在闸判断和证据写之间穿透。
    await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR SHARE`,
    );
    const lockedRegistrations = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "ActivityRegistration"
        WHERE "activityId" = ${activityId}
          AND "memberId" = ${memberId}
          AND "deletedAt" IS NULL
          AND "statusCode" = ${ACTIVITY_REGISTRATION_STATUS.PASS}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1
        FOR SHARE
      `,
    );

    // 两把锁取得后立即捕获唯一 authoritative now；后续时间闸和落表都只用此值。
    const now = new Date();
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: ACTIVITY_GATE_SELECT,
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    this.assertAllowed(this.policy.canWriteByStatus(action, activity.statusCode));

    const registrationId = lockedRegistrations[0]?.id;
    if (registrationId === undefined) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    }
    const registration = await tx.activityRegistration.findFirst({
      where: {
        id: registrationId,
        activityId,
        memberId,
        deletedAt: null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      },
      select: REGISTRATION_GATE_SELECT,
    });
    if (registration === null) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    }
    return { activity, registration, now };
  }

  private resolveCheckInSchedule(
    activity: Pick<ActivityGateRow, 'startAt' | 'endAt'>,
    registration: RegistrationGateRow,
  ): { startAt: Date; endAt: Date } {
    const activityPosition = registration.activityPosition;
    return activityPosition !== null &&
      activityPosition.startAt !== null &&
      activityPosition.endAt !== null
      ? { startAt: activityPosition.startAt, endAt: activityPosition.endAt }
      : activity;
  }

  private findCurrentEvidence(
    client: Pick<PrismaService, 'activityCheckIn'> | Prisma.TransactionClient,
    registrationId: string,
  ): Promise<AppActivityCheckInRow | null> {
    return client.activityCheckIn.findFirst({
      where: { registrationId, deletedAt: null },
      select: this.fieldPolicy.appSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  private buildLocationEvidence(
    activity: Pick<ActivityGateRow, 'locationLongitude' | 'locationLatitude'>,
    dto: ActivityCheckInLocationDto,
  ): LocationEvidence {
    const decision = this.locationPolicy.evaluate(
      {
        longitude: this.decimalToNumber(activity.locationLongitude),
        latitude: this.decimalToNumber(activity.locationLatitude),
      },
      dto,
      this.config.attendance.checkInRadiusMeters,
    );
    if (!decision.allowed) throw new BizException(decision.biz);

    const longitude = new Prisma.Decimal(dto.longitude.toString());
    const latitude = new Prisma.Decimal(dto.latitude.toString());
    const accuracy =
      dto.accuracy === undefined ? null : new Prisma.Decimal(dto.accuracy.toString());
    const distance = new Prisma.Decimal(decision.distanceMeters.toString()).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
    return {
      longitude,
      latitude,
      accuracy,
      distance,
      geoVerified: decision.geoVerified,
      outOfRange: decision.outOfRange,
    };
  }

  private decimalToNumber(value: Prisma.Decimal | null): number | null {
    return value === null ? null : Number(value.toString());
  }

  private assertAllowed(decision: ActivityCheckInDecision): void {
    if (!decision.allowed) throw new BizException(decision.biz);
  }

  private isP2002(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

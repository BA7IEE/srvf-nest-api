import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  AppActivityFeedbackResponseDto,
  UpsertActivityFeedbackDto,
} from './dto/app/activity-feedback.dto';

const ACTIVITY_COMPLETED = 'completed';
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVITY_GATE_SELECT = {
  id: true,
  statusCode: true,
} as const satisfies Prisma.ActivitySelect;

const ACTIVE_CLOSURE_SELECT = {
  revision: true,
  closedAt: true,
  settlementVersionId: true,
  postingBatchId: true,
} as const satisfies Prisma.ActivitySettlementClosureRevisionSelect;

const APP_FEEDBACK_SELECT = {
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityFeedbackSelect;

type ActivityGateRow = Prisma.ActivityGetPayload<{ select: typeof ACTIVITY_GATE_SELECT }>;
type ActiveClosureRow = Prisma.ActivitySettlementClosureRevisionGetPayload<{
  select: typeof ACTIVE_CLOSURE_SELECT;
}>;
type AppFeedbackRow = Prisma.ActivityFeedbackGetPayload<{ select: typeof APP_FEEDBACK_SELECT }>;
type FeedbackReadClient = Pick<
  PrismaService,
  | 'activity'
  | 'activitySettlementClosureRevision'
  | 'participantSettlementResultRevision'
  | 'activityFeedback'
>;

@Injectable()
export class ActivityFeedbacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appIdentity: AppIdentityResolver,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async upsertMine(
    activityId: string,
    dto: UpsertActivityFeedbackDto,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityFeedbackResponseDto> {
    const memberId = await this.resolveMemberIdOrThrow(currentUser);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.findActivity(tx, activityId);
        this.assertActivityCompleted(activity);
        const closure = await this.findActiveClosureOrThrow(tx, activityId);
        const now = new Date();
        const windowClosesAt = this.getWindowClosesAt(closure);
        this.assertWriteWindow(now, windowClosesAt);

        const hasCurrentEligibility = await this.hasSettlementEligibility(
          tx,
          activityId,
          memberId,
          closure,
        );
        if (!hasCurrentEligibility) {
          throw new BizException(BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED);
        }

        const existing = await tx.activityFeedback.findFirst({
          where: { activityId, memberId, deletedAt: null },
          select: { id: true },
        });
        const data = { rating: dto.rating, comment: dto.comment ?? null };
        const feedback =
          existing === null
            ? await tx.activityFeedback.create({
                data: { activityId, memberId, ...data },
                select: APP_FEEDBACK_SELECT,
              })
            : await tx.activityFeedback.update({
                where: { id: existing.id },
                data,
                select: APP_FEEDBACK_SELECT,
              });

        return this.toResponse(feedback, true, windowClosesAt, false);
      });
    } catch (error) {
      // 手写 partial unique 的 meta.target 在 Prisma / PostgreSQL 组合下不稳定；本写路径只有
      // live (activityId,memberId) 会触发 P2002，统一映射冻结码，绝不泄露 Prisma 异常。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_FEEDBACK_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  async getMine(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityFeedbackResponseDto> {
    const memberId = await this.resolveMemberIdOrThrow(currentUser);
    const now = new Date();

    const activity = await this.findActivity(this.prisma, activityId);
    this.assertActivityCompleted(activity);
    const closure = await this.findActiveClosureOrThrow(this.prisma, activityId);
    const [hasCurrentEligibility, feedback] = await Promise.all([
      this.hasSettlementEligibility(this.prisma, activityId, memberId, closure),
      this.prisma.activityFeedback.findFirst({
        where: { activityId, memberId, deletedAt: null },
        select: APP_FEEDBACK_SELECT,
      }),
    ]);
    const windowClosesAt = this.getWindowClosesAt(closure);
    const canSubmit = now.getTime() <= windowClosesAt.getTime() && hasCurrentEligibility;
    const eligibilityCorrected =
      feedback !== null &&
      !hasCurrentEligibility &&
      (await this.wasEligibleBeforeLatestClosure(this.prisma, activityId, memberId, closure));

    return this.toResponse(feedback, canSubmit, windowClosesAt, eligibilityCorrected);
  }

  private async resolveMemberIdOrThrow(currentUser: CurrentUserPayload): Promise<string> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member.id;
  }

  private async findActivity(
    client: FeedbackReadClient,
    activityId: string,
  ): Promise<ActivityGateRow> {
    const activity = await client.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: ACTIVITY_GATE_SELECT,
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async findActiveClosureOrThrow(
    client: FeedbackReadClient,
    activityId: string,
  ): Promise<ActiveClosureRow> {
    const closure = await client.activitySettlementClosureRevision.findFirst({
      where: { activityId, statusCode: 'active' },
      select: ACTIVE_CLOSURE_SELECT,
      orderBy: { revision: 'desc' },
    });
    if (closure === null) {
      throw new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED);
    }
    return closure;
  }

  private async hasSettlementEligibility(
    client: FeedbackReadClient,
    activityId: string,
    memberId: string,
    closure: ActiveClosureRow,
  ): Promise<boolean> {
    const result = await client.participantSettlementResultRevision.findFirst({
      where: {
        settlementVersionId: closure.settlementVersionId,
        statusCode: 'committed',
        resultCode: 'present',
        identity: { activityId, memberId },
        ledgerEntries: {
          some: {
            postingBatchId: closure.postingBatchId,
            entryTypeCode: 'service_credit',
            serviceHoursDelta: { gt: 0 },
          },
        },
      },
      select: { id: true },
    });
    return result !== null;
  }

  private async wasEligibleBeforeLatestClosure(
    client: FeedbackReadClient,
    activityId: string,
    memberId: string,
    latestClosure: ActiveClosureRow,
  ): Promise<boolean> {
    if (latestClosure.revision <= 1) return false;
    const priorClosures = await client.activitySettlementClosureRevision.findMany({
      where: {
        activityId,
        statusCode: 'superseded',
        revision: { lt: latestClosure.revision },
      },
      select: { settlementVersionId: true, postingBatchId: true },
      orderBy: { revision: 'desc' },
    });
    if (priorClosures.length === 0) return false;
    const priorResult = await client.participantSettlementResultRevision.findFirst({
      where: {
        statusCode: 'committed',
        resultCode: 'present',
        identity: { activityId, memberId },
        OR: priorClosures.map((closure) => ({
          settlementVersionId: closure.settlementVersionId,
          ledgerEntries: {
            some: {
              postingBatchId: closure.postingBatchId,
              entryTypeCode: 'service_credit',
              serviceHoursDelta: { gt: 0 },
            },
          },
        })),
      },
      select: { id: true },
    });
    return priorResult !== null;
  }

  private getWindowClosesAt(closure: ActiveClosureRow): Date {
    return new Date(
      closure.closedAt.getTime() + this.config.attendance.feedbackWindowDays * DAY_MS,
    );
  }

  private assertActivityCompleted(activity: ActivityGateRow): void {
    if (activity.statusCode !== ACTIVITY_COMPLETED) {
      throw new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED);
    }
  }

  private assertWriteWindow(now: Date, windowClosesAt: Date): void {
    if (now.getTime() > windowClosesAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_FEEDBACK_WINDOW_CLOSED);
    }
  }

  private toResponse(
    feedback: AppFeedbackRow | null,
    canSubmit: boolean,
    windowClosesAt: Date,
    eligibilityCorrected: boolean,
  ): AppActivityFeedbackResponseDto {
    return {
      feedback:
        feedback === null
          ? null
          : {
              rating: feedback.rating,
              comment: feedback.comment,
              createdAt: feedback.createdAt,
              updatedAt: feedback.updatedAt,
              eligibilityCorrected,
            },
      canSubmit,
      windowClosesAt: windowClosesAt.toISOString(),
    };
  }
}

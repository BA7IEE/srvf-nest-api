import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';
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
  endAt: true,
} as const satisfies Prisma.ActivitySelect;

const APP_FEEDBACK_SELECT = {
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityFeedbackSelect;

type ActivityGateRow = Prisma.ActivityGetPayload<{ select: typeof ACTIVITY_GATE_SELECT }>;
type AppFeedbackRow = Prisma.ActivityFeedbackGetPayload<{ select: typeof APP_FEEDBACK_SELECT }>;
type FeedbackReadClient = Pick<PrismaService, 'activity' | 'attendanceRecord' | 'activityFeedback'>;

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
        // 正常路径固定 3 次业务读：Activity → approved 资格 exists → live feedback。
        const activity = await this.findActivity(tx, activityId);
        const now = new Date();
        const windowClosesAt = this.getWindowClosesAt(activity);
        this.assertWriteWindow(activity, now, windowClosesAt);

        const hasApprovedAttendance = await this.hasApprovedAttendance(tx, activityId, memberId);
        if (!hasApprovedAttendance) {
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

        return this.toResponse(feedback, true, windowClosesAt);
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

    // 固定 3 次业务读；即使无评价，也要准确返回资格按钮态与本人 feedback:null。
    const activity = await this.findActivity(this.prisma, activityId);
    const hasApprovedAttendance = await this.hasApprovedAttendance(
      this.prisma,
      activityId,
      memberId,
    );
    const feedback = await this.prisma.activityFeedback.findFirst({
      where: { activityId, memberId, deletedAt: null },
      select: APP_FEEDBACK_SELECT,
    });
    const windowClosesAt = this.getWindowClosesAt(activity);
    const canSubmit =
      activity.statusCode === ACTIVITY_COMPLETED &&
      now.getTime() <= windowClosesAt.getTime() &&
      hasApprovedAttendance;

    return this.toResponse(feedback, canSubmit, windowClosesAt);
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

  private async hasApprovedAttendance(
    client: FeedbackReadClient,
    activityId: string,
    memberId: string,
  ): Promise<boolean> {
    const attendance = await client.attendanceRecord.findFirst({
      where: {
        memberId,
        deletedAt: null,
        sheet: {
          activityId,
          deletedAt: null,
          statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
        },
      },
      select: { id: true },
    });
    return attendance !== null;
  }

  private getWindowClosesAt(activity: ActivityGateRow): Date {
    return new Date(activity.endAt.getTime() + this.config.attendance.feedbackWindowDays * DAY_MS);
  }

  private assertWriteWindow(activity: ActivityGateRow, now: Date, windowClosesAt: Date): void {
    if (activity.statusCode !== ACTIVITY_COMPLETED) {
      throw new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED);
    }
    if (now.getTime() > windowClosesAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_FEEDBACK_WINDOW_CLOSED);
    }
  }

  private toResponse(
    feedback: AppFeedbackRow | null,
    canSubmit: boolean,
    windowClosesAt: Date,
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
            },
      canSubmit,
      windowClosesAt: windowClosesAt.toISOString(),
    };
  }
}

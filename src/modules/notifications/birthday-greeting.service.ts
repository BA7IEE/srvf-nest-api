import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemberStatus, UserStatus } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { OUTBOX_EVENT_BIRTHDAY_SMS, OUTBOX_PAYLOAD_VERSION } from './notification.constants';
import { NotificationOutboxService } from './notification-outbox.service';

// B 队列 F5-T2(2026-06-11):生日祝福短信 job——G-7(通知/短信/推送)首个落地点
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6,下称"评审稿")。
//
// no-cron 首次升级路径(拍板④):@nestjs/schedule 最初仅解锁本 job；v0.47.0 经新 D 档评审
// 追加唯一第二个 expiry-reminder cron。第三个仍须新 D 档评审；retention 永走手动 SOP(D-QB-3)。
//
// 选取口径(评审稿 E-B5,拍板⑤「仅 User.phone」),全条件同时满足:
//   MemberProfile.birthDate 月日 = 今天(固定 UTC+8 日界;birthDate 为必填列)
//   && profile 未软删 && Member ACTIVE 未软删
//   && User 存在 && User.phone 非空 && User ACTIVE 未软删(MemberProfile.mobile 永不使用)
//   2/29 仅闰年当天发(非闰年不发,不顺延;KISS 成文 §6.4)。
//
// durable outbox(D-Outbox):cron 只以「北京时间日期 + memberId」稳定 eventKey 入队;
// 独立 worker 执行时才解析 User.phone、复用既有 sms_send_logs 幂等并在事务外调用 provider。
// claim / lease / retry / dead 均落 PostgreSQL,多实例不依赖进程内状态。
// 隐私(E-B8):不进 audit_logs(运营触达,send_logs 流水足够);应用日志一律 maskPhone;
// 首版模板零变量,无个人信息出仓。

export interface BirthdayRunSummary {
  selected: number;
  enqueued: number;
  skippedIdempotent: number;
  failed: number;
}

@Injectable()
export class BirthdayGreetingService {
  private readonly logger = new Logger(BirthdayGreetingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: NotificationOutboxService,
  ) {}

  // 每日 09:00 Asia/Shanghai(评审稿 §6.3;name 供 SchedulerRegistry 识别)。
  // 薄壳:全部逻辑在 runOnce()(直调可测,E-B11;e2e / unit 不等真实定时)。
  @Cron('0 0 9 * * *', { name: 'birthday-greeting', timeZone: 'Asia/Shanghai' })
  async handleDailyCron(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      // job 级兜底:未预期异常只记日志,不让异常出 cron 上下文(无请求方可响应)
      this.logger.error(`birthday job failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runOnce(now: Date = new Date()): Promise<BirthdayRunSummary> {
    const summary: BirthdayRunSummary = {
      selected: 0,
      enqueued: 0,
      skippedIdempotent: 0,
      failed: 0,
    };

    const { month, day } = utc8MonthDay(now);
    const dateKey = utc8DateKey(now);

    // 选取(E-B5):JOIN 链一次取回,月日匹配在内存判定(Prisma 无月日函数;
    // 候选集 = 全部活跃队员 profile,内部系统百人级量级可承受)
    // 队员账号闭环 v2:User.memberId 改一对多(partial unique,仅 DB 层保证至多 1 条
    // live),`users` 查询显式收窄 `deletedAt: null` + `take: 1` 取当前 live 关联账号
    // ——与 v1 逐字等价(原 `user.deletedAt !== null` 应用层过滤现改为查询层 where,
    // 软删账号同样被排除在候选之外)。
    const candidates = await this.prisma.memberProfile.findMany({
      where: {
        deletedAt: null,
        member: { status: MemberStatus.ACTIVE, deletedAt: null },
      },
      select: {
        birthDate: true,
        member: {
          select: {
            id: true,
            users: {
              where: { deletedAt: null },
              select: { phone: true, status: true },
              take: 1,
            },
          },
        },
      },
    });

    const targets: string[] = [];
    for (const row of candidates) {
      const bd = utc8MonthDay(row.birthDate);
      if (bd.month !== month || bd.day !== day) continue;
      const user = row.member.users[0];
      if (!user || user.phone === null) continue;
      if (user.status !== UserStatus.ACTIVE) continue;
      targets.push(row.member.id);
    }
    summary.selected = targets.length;

    for (const memberId of targets) {
      const eventKey = `birthday-sms:${dateKey}:${memberId}`;
      try {
        const existing = await this.outbox.findByEventKey(eventKey);
        await this.outbox.enqueue({
          eventKey,
          eventType: OUTBOX_EVENT_BIRTHDAY_SMS,
          payloadVersion: OUTBOX_PAYLOAD_VERSION,
          payload: { memberId, dateKey },
          aggregateType: 'member',
          aggregateId: memberId,
          destinationType: 'member',
          destinationRef: memberId,
        });
        if (existing) summary.skippedIdempotent += 1;
        else summary.enqueued += 1;
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `birthday enqueue failed member=${memberId} errorClass=${errorClass(error)}`,
        );
      }
    }

    this.logger.log(
      `birthday job done: selected=${summary.selected} enqueued=${summary.enqueued} ` +
        `skippedIdempotent=${summary.skippedIdempotent} failed=${summary.failed}`,
    );
    return summary;
  }
}

// 固定 UTC+8 日界与月日(评审稿 E-B5;与 sms-code.service 私有 startOfDayUtc8 同口径,
// 该函数未导出且语义独立,这里模块级实现,不抽共享 util——AGENTS §2 grab-bag 禁令)
const UTC8_OFFSET_MS = 8 * 3600 * 1000;

function utc8MonthDay(d: Date): { month: number; day: number } {
  const shifted = new Date(d.getTime() + UTC8_OFFSET_MS);
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function utc8DateKey(now: Date): string {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

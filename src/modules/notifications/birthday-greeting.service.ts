import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemberStatus, UserStatus } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { SmsProviderRouter } from '../sms/sms-provider.router';
import { SmsSettingsService } from '../sms/sms-settings.service';
import { maskPhone, SMS_TEMPLATE_KEY_BIRTHDAY } from '../sms/sms.constants';
import { SmsChannelUnavailableError, SmsProviderSendError } from '../sms/sms.types';

// B 队列 F5-T2(2026-06-11):生日祝福短信 job——G-7(通知/短信/推送)首个落地点
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6,下称"评审稿")。
//
// no-cron 升级路径(拍板④):@nestjs/schedule 解锁范围**仅本 job 一个 @Cron**;
// 新增任何定时任务 = 新 D 档评审(评审稿 R-5);retention 清理永走手动 SOP(D-QB-3)。
//
// 选取口径(评审稿 E-B5,拍板⑤「仅 User.phone」),全条件同时满足:
//   MemberProfile.birthDate 月日 = 今天(固定 UTC+8 日界;birthDate 为必填列)
//   && profile 未软删 && Member ACTIVE 未软删
//   && User 存在 && User.phone 非空 && User ACTIVE 未软删(MemberProfile.mobile 永不使用)
//   2/29 仅闰年当天发(非闰年不发,不顺延;KISS 成文 §6.4)。
//
// 幂等防重发(E-B6):发前查 sms_send_logs 当日(UTC+8)同模板同号 SENT 已存在则跳过;
// 重启不重发(以 DB 为准,无内存状态);FAILED 行不挡同日重跑(FAILED ≠ 已触达)。
//
// 失败语义(E-B7):单条 provider 失败 → 写 FAILED 行,不重试不阻断,继续下一人;
// 通道整体不可用(settings 缺失 / production-like DEV_STUB / 运维中途关闭)→ 整批跳过零成本。
// 隐私(E-B8):不进 audit_logs(运营触达,send_logs 流水足够);应用日志一律 maskPhone;
// 首版模板零变量,无个人信息出仓。
// 单实例前提(E-B12):@Cron 进程级触发即全局唯一;多实例横向扩容前必须先加分布式锁。

export interface BirthdayRunSummary {
  selected: number;
  sent: number;
  skippedIdempotent: number;
  failed: number;
}

@Injectable()
export class BirthdayGreetingService {
  private readonly logger = new Logger(BirthdayGreetingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: SmsProviderRouter,
    private readonly settings: SmsSettingsService,
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
    const summary: BirthdayRunSummary = { selected: 0, sent: 0, skippedIdempotent: 0, failed: 0 };

    // 前置检查(E-B7):settings 缺失 / 未启用 / templateIdBirthday 空 → 整批跳过零行。
    // production-like 下 DEV_STUB 的禁用由 router.resolve 第二重保证(发送时抛,整批跳过)。
    const settings = await this.settings.getActiveSettings();
    if (!settings || !settings.enabled || !settings.templateIdBirthday) {
      this.logger.warn(
        'birthday job skipped: sms settings 未配置 / 未启用 / templateIdBirthday 为空',
      );
      return summary;
    }

    const { month, day } = utc8MonthDay(now);
    const dayStart = startOfDayUtc8(now);

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
      targets.push(user.phone);
    }
    summary.selected = targets.length;

    for (const phone of targets) {
      // 幂等防重发(E-B6):当日同模板同号 SENT 已存在 → 跳过
      const already = await this.prisma.smsSendLog.count({
        where: {
          phone,
          templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
          status: 'SENT',
          createdAt: { gte: dayStart },
        },
      });
      if (already > 0) {
        summary.skippedIdempotent += 1;
        continue;
      }

      let providerType: 'DEV_STUB' | 'TENCENT_SMS';
      try {
        providerType = await this.router.resolveProviderType();
      } catch (err) {
        // 通道整体不可用(如运维并发关闭 / production-like DEV_STUB):剩余整批跳过,零成本不写 FAILED
        this.logger.warn(
          `birthday job aborted: channel unavailable (${err instanceof Error ? err.message : String(err)})`,
        );
        break;
      }

      try {
        const result = await this.router.sendBirthdayGreeting({ phone });
        await this.prisma.smsSendLog.create({
          data: {
            phone,
            templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
            providerType,
            status: 'SENT',
            providerMsgId: result.providerMsgId,
          },
        });
        summary.sent += 1;
      } catch (err) {
        // 单条失败:FAILED 落流水(errCode/errMsg 不含 secret),不重试不阻断(E-B7)
        const { errCode, errMsg } = normalizeSendError(err);
        await this.prisma.smsSendLog.create({
          data: {
            phone,
            templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
            providerType,
            status: 'FAILED',
            errCode,
            errMsg,
          },
        });
        summary.failed += 1;
        this.logger.warn(`birthday send failed phone=${maskPhone(phone)} errCode=${errCode}`);
      }
    }

    this.logger.log(
      `birthday job done: selected=${summary.selected} sent=${summary.sent} ` +
        `skippedIdempotent=${summary.skippedIdempotent} failed=${summary.failed}`,
    );
    return summary;
  }
}

// 固定 UTC+8 日界与月日(评审稿 E-B5;与 sms-code.service 私有 startOfDayUtc8 同口径,
// 该函数未导出且语义独立,这里模块级实现,不抽共享 util——AGENTS §2 grab-bag 禁令)
const UTC8_OFFSET_MS = 8 * 3600 * 1000;

function startOfDayUtc8(now: Date): Date {
  const shifted = now.getTime() + UTC8_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStartShifted - UTC8_OFFSET_MS);
}

function utc8MonthDay(d: Date): { month: number; day: number } {
  const shifted = new Date(d.getTime() + UTC8_OFFSET_MS);
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function normalizeSendError(err: unknown): { errCode: string; errMsg: string } {
  if (err instanceof SmsProviderSendError) {
    return { errCode: err.errCode, errMsg: err.errMsg };
  }
  if (err instanceof SmsChannelUnavailableError) {
    return { errCode: 'CHANNEL_UNAVAILABLE', errMsg: err.message };
  }
  return { errCode: 'UNKNOWN', errMsg: err instanceof Error ? err.message : String(err) };
}

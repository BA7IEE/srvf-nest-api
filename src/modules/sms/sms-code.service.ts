import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { SmsPurpose } from '@prisma/client';
import { randomInt, timingSafeEqual } from 'node:crypto';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import {
  deriveSmsCodePepperKey,
  hashSmsVerificationCode,
  SmsCodePepperUnavailableError,
} from './sms-code-hash.util';
import { acquireSmsIssueLocks } from './sms-issue-lock';
import { SmsProviderRouter } from './sms-provider.router';
import {
  maskPhone,
  SMS_CODE_MAX_ATTEMPTS,
  SMS_CODE_TTL_SECONDS,
  SMS_DAILY_WINDOW_UTC_OFFSET_HOURS,
  SMS_DEV_STUB_FIXED_CODE,
  SMS_PHONE_DAILY_LIMIT,
  SMS_SEND_MIN_INTERVAL_SECONDS,
  SMS_TEMPLATE_KEY_VERIFY_CODE,
} from './sms.constants';
import { SmsChannelUnavailableError, SmsProviderSendError } from './sms.types';

// SMS 基础设施 T3(2026-06-10):验证码签发 / 校验消费 / DB 层防刷
// (冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md §4 / E-8~E-12 / E-27 / E-29)。
//
// 职责边界(E-30):本 Service 对 User 无感知——phone 占用检查 / 绑定落库 / audit
// 归 users 模块(users.service 调本 Service);本 Service 是 SMS 域 BizException 的
// 映射边界(SmsChannelUnavailableError → 24030;SmsProviderSendError → 24031)。
//
// 明文码纪律(D-SMS-5):明文只存在于"生成 → 交给 provider"内存链路;
// 入库只存 HMAC-SHA256(pepper, phone:purpose:code) hex;pepper 由 SMS_ENCRYPTION_KEY
// 经独立 salt 的 scrypt 派生且仅驻内存;不入 pino 日志 / 响应 / audit / OpenAPI 示例。

@Injectable()
export class SmsCodeService {
  private readonly logger = new Logger(SmsCodeService.name);
  private readonly codePepperKey: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: SmsProviderRouter,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {
    this.codePepperKey = this.cfg.sms.encryptionKey
      ? deriveSmsCodePepperKey(this.cfg.sms.encryptionKey)
      : null;
  }

  /**
   * 签发验证码并发送(D-SMS:通道 → 双锁事务〔日限 / 间隔 / 单活码〕→ 发送 → 落日志)。
   * phone 占用检查由调用方(users.service)在调用前完成。
   *
   * - 同号 <60s 再发 → SMS_SEND_INTERVAL_LIMIT(24120;跨 purpose 共享)
   * - 同号自然日(UTC+8,E-10)≥10 条 → SMS_PHONE_DAILY_LIMIT(24121;
   *   按 sms_verification_codes 当日创建行数计,含发送失败行,保守防滥用,E-11)
   * - 通道不可用 → SMS_CHANNEL_NOT_CONFIGURED(24030)
   * - provider 失败 → code 行保留(参与计数)+ send_log 记 FAILED + SMS_SEND_FAILED(24031;E-12)
   */
  async issue(input: {
    phone: string;
    purpose: SmsPurpose;
    userId: string | null; // 放宽 null:匿名 pre-auth 报名人(RECRUITMENT_BIND)无账号(E-P4-4;列本就可空)
    ip: string | null;
  }): Promise<{ expiresInSeconds: number }> {
    // 1. 通道解析(settings 缺失 / 未启用 / production-like DEV_STUB → 24030)。
    //    先解析再建 code 行:通道不可用时不产生计数占用。
    let providerType: 'DEV_STUB' | 'TENCENT_SMS';
    try {
      providerType = await this.router.resolveProviderType();
    } catch (err) {
      if (err instanceof SmsChannelUnavailableError) {
        throw new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED);
      }
      throw err;
    }

    // 2. 生成明文码(E-29:CSPRNG;DEV_STUB 固定 888888,production-like 不可达)
    const code = providerType === 'DEV_STUB' ? SMS_DEV_STUB_FIXED_CODE : generateNumericCode();
    const codeHash = this.hashCode({ phone: input.phone, purpose: input.purpose, code });

    // 3. D-SMS 原子临界区：phone → phone+purpose 固定双锁后，latest/count/旧码作废/create
    //    全部在同一事务；任一检查不得外提。日限优先裁决，使 9→双并发的后到者稳定命中 24121。
    const codeRow = await this.prisma.$transaction(async (tx) => {
      await acquireSmsIssueLocks(tx, input.phone, input.purpose);
      const now = new Date();

      const latest = await tx.smsVerificationCode.findFirst({
        where: { phone: input.phone },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const dailyCount = await tx.smsVerificationCode.count({
        where: { phone: input.phone, createdAt: { gte: startOfDayUtc8(now) } },
      });
      if (dailyCount >= SMS_PHONE_DAILY_LIMIT) {
        throw new BizException(BizCode.SMS_PHONE_DAILY_LIMIT);
      }
      if (
        latest !== null &&
        now.getTime() - latest.createdAt.getTime() < SMS_SEND_MIN_INTERVAL_SECONDS * 1000
      ) {
        throw new BizException(BizCode.SMS_SEND_INTERVAL_LIMIT);
      }

      await tx.smsVerificationCode.updateMany({
        where: {
          phone: input.phone,
          purpose: input.purpose,
          consumedAt: null,
          supersededAt: null,
        },
        data: { supersededAt: now },
      });
      return tx.smsVerificationCode.create({
        data: {
          phone: input.phone,
          purpose: input.purpose,
          codeHash,
          userId: input.userId,
          expiresAt: new Date(now.getTime() + SMS_CODE_TTL_SECONDS * 1000),
          ip: input.ip,
        },
        select: { id: true },
      });
    });

    // 4. 发送(事务外:外部调用不持事务)+ 落 send_log(append-only)
    try {
      const result = await this.router.sendVerifyCode({
        phone: input.phone,
        code,
        ttlMinutes: SMS_CODE_TTL_SECONDS / 60,
      });
      await this.prisma.smsSendLog.create({
        data: {
          phone: input.phone,
          templateKey: SMS_TEMPLATE_KEY_VERIFY_CODE,
          providerType,
          status: 'SENT',
          providerMsgId: result.providerMsgId,
          codeId: codeRow.id,
        },
      });
    } catch (err) {
      // 失败处理(E-12):code 行保留(参与间隔/日限计数),日志记 FAILED,不重试
      const { errCode, errMsg } = normalizeSendError(err);
      await this.prisma.smsSendLog.create({
        data: {
          phone: input.phone,
          templateKey: SMS_TEMPLATE_KEY_VERIFY_CODE,
          providerType,
          status: 'FAILED',
          errCode,
          errMsg,
          codeId: codeRow.id,
        },
      });
      this.logger.warn(
        `sms send failed phone=${maskPhone(input.phone)} codeId=${codeRow.id} errCode=${errCode}`,
      );
      if (err instanceof SmsChannelUnavailableError) {
        throw new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED);
      }
      throw new BizException(BizCode.SMS_SEND_FAILED);
    }

    return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
  }

  /**
   * 校验并消费验证码(评审稿 §4 校验链;**统一 24010 防枚举**,禁止细分)。
   *
   * 设计(E-8 + 评审稿 §10):本方法**不**参与调用方事务——
   * - 错码的 attempts+1 必须独立提交(若挂在外层事务里,抛错回滚会丢计数,错 5 次作废失效);
   * - 命中走单条 PostgreSQL UPDATE ... RETURNING,以同语句 DB 实时时钟校验并写入,
   *   且重查消费 / 作废 / 尝试上限,并发重放只有一个赢家;
   * - "已消费但外层绑定事务失败"的窗口极窄(P2002 占用竞态),接受重新发码,
   *   优于"先绑后消费"(后者在 audit 失败时允许码重用)。
   */
  async verifyAndConsume(input: {
    phone: string;
    purpose: SmsPurpose;
    code: string;
    userId: string | null; // 放宽 null:匿名报名人(E-P4-4);归属校验 null === null 天然放行(phone+purpose 为锚)
  }): Promise<{ codeId: string }> {
    const active = await this.loadValidActiveCodeOrThrow(input);

    // 最终抢占以数据库实时 UTC 为唯一裁决时钟。locked_code 必须先完成 FOR UPDATE，
    // db_clock 才能从其产出的 row 捕获 clock_timestamp()；热行等待不能冻结旧时钟。
    // 同一 UPDATE 随后重查消费 / 作废 / attempts / expiry；0 行仍统一 24010。
    const [consumed] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH locked_code AS MATERIALIZED (
        SELECT candidate."id"
        FROM "sms_verification_codes" AS candidate
        WHERE candidate."id" = ${active.id}
        FOR UPDATE
      ),
      db_clock AS MATERIALIZED (
        SELECT
          locked_code."id",
          clock_timestamp() AT TIME ZONE 'UTC' AS captured_at
        FROM locked_code
      )
      UPDATE "sms_verification_codes" AS target
      SET "consumedAt" = db_clock.captured_at
      FROM db_clock
      WHERE target."id" = db_clock."id"
        AND target."consumedAt" IS NULL
        AND target."supersededAt" IS NULL
        AND target."attempts" < ${SMS_CODE_MAX_ATTEMPTS}
        AND target."expiresAt" > db_clock.captured_at
      RETURNING target."id" AS "id"
    `;
    if (consumed === undefined) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    return { codeId: consumed.id };
  }

  /**
   * 只验不消费(找回密码 T2;评审稿 password-reset-by-sms-review.md E-5/E-6)。
   *
   * 供"码有效性必须先于业务检查、业务失败不得烧码"的调用方做预检
   * (password-reset:10006 新旧密码相同时不消费,可换密码用同码重试);
   * 校验链与错码 attempts+1 语义与 verifyAndConsume **完全一致**(防爆破不因预检弱化),
   * 预检通过后调用方仍须经 verifyAndConsume 原子消费(并发重放仍单赢家)。
   */
  async assertValid(input: {
    phone: string;
    purpose: SmsPurpose;
    code: string;
    userId: string | null; // 放宽 null:匿名报名人(E-P4-4)
  }): Promise<void> {
    await this.loadValidActiveCodeOrThrow(input);
  }

  // 校验链(评审稿 §4;**统一 24010 防枚举**,禁止细分;E-6 抽出供
  // verifyAndConsume / assertValid 共用,verifyAndConsume 行为零漂移):
  // 取 phone+purpose 最新活码 → 不存在 / 已过期 / 已作废(错 5 次)/ 归属不符(E-8)
  // → 统一无效;码值不符 → attempts+1(独立提交,见 verifyAndConsume 方法注释)后统一无效。
  private async loadValidActiveCodeOrThrow(input: {
    phone: string;
    purpose: SmsPurpose;
    code: string;
    userId: string | null;
  }): Promise<{ id: string }> {
    // 先固定 phone+purpose 最新活码，再由同一只读 SQL 的数据库 UTC 时钟裁决
    // attempts / expiry；不能把 eligibility 条件放进 latest_code，否则异常数据会跳回旧码。
    const [active] = await this.prisma.$queryRaw<
      Array<{ id: string; codeHash: string; userId: string | null }>
    >`
      WITH db_clock AS MATERIALIZED (
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS captured_at
      ),
      latest_code AS MATERIALIZED (
        SELECT
          candidate."id",
          candidate."codeHash",
          candidate."userId",
          candidate."expiresAt",
          candidate."attempts"
        FROM "sms_verification_codes" AS candidate
        WHERE candidate."phone" = ${input.phone}
          AND candidate."purpose" = CAST(${input.purpose} AS "SmsPurpose")
          AND candidate."consumedAt" IS NULL
          AND candidate."supersededAt" IS NULL
        ORDER BY candidate."createdAt" DESC
        LIMIT 1
      )
      SELECT
        latest_code."id",
        latest_code."codeHash",
        latest_code."userId"
      FROM latest_code
      CROSS JOIN db_clock
      WHERE latest_code."attempts" < ${SMS_CODE_MAX_ATTEMPTS}
        AND latest_code."expiresAt" > db_clock.captured_at
    `;

    // 统一无效:不存在 / DB 时钟已过期 / DB 行 attempts≥5 / 归属不符(E-8)
    if (active === undefined || active.userId !== input.userId) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    // 码值比对(timingSafeEqual 卫生习惯;两侧均为 64 字符 HMAC-SHA256 hex 定长)
    const candidateHash = this.hashCode(input);
    if (!hashEquals(candidateHash, active.codeHash)) {
      // 错码计数独立提交(见 verifyAndConsume 方法注释)，且同样只认拿到行锁后的 DB UTC。
      // 排队期间已过期 / 已消费 / 已作废 / 达上限时 0 行，不得再增加 attempts；对外仍统一 24010。
      await this.prisma.$queryRaw<Array<{ id: string }>>`
        WITH locked_code AS MATERIALIZED (
          SELECT candidate."id"
          FROM "sms_verification_codes" AS candidate
          WHERE candidate."id" = ${active.id}
          FOR UPDATE
        ),
        db_clock AS MATERIALIZED (
          SELECT
            locked_code."id",
            clock_timestamp() AT TIME ZONE 'UTC' AS captured_at
          FROM locked_code
        )
        UPDATE "sms_verification_codes" AS target
        SET "attempts" = target."attempts" + 1
        FROM db_clock
        WHERE target."id" = db_clock."id"
          AND target."consumedAt" IS NULL
          AND target."supersededAt" IS NULL
          AND target."attempts" < ${SMS_CODE_MAX_ATTEMPTS}
          AND target."expiresAt" > db_clock.captured_at
        RETURNING target."id" AS "id"
      `;
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    return { id: active.id };
  }

  private hashCode(input: { phone: string; purpose: SmsPurpose; code: string }): string {
    if (this.codePepperKey === null) {
      throw new SmsCodePepperUnavailableError();
    }
    return hashSmsVerificationCode(input, this.codePepperKey);
  }
}

// === helpers(模块内私有;不入 common grab-bag)===

// 6 位纯数字 CSPRNG(E-29;禁 Math.random)
function generateNumericCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// 两侧均为 HMAC-SHA256 hex(64 字符定长),timingSafeEqual 直接可用
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// 自然日日界:固定 UTC+8(评审稿 E-10;大陆手机号场景,不随服务器时区漂移)
function startOfDayUtc8(now: Date): Date {
  const offsetMs = SMS_DAILY_WINDOW_UTC_OFFSET_HOURS * 3600 * 1000;
  const shifted = now.getTime() + offsetMs;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStartShifted - offsetMs);
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

import { Injectable } from '@nestjs/common';
import { Role, SmsPurpose, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { maskPhone, SMS_CODE_TTL_SECONDS } from '../sms/sms.constants';
import type {
  ResetPasswordBySmsDto,
  SendPasswordResetCodeDto,
  SendPasswordResetCodeResponseDto,
} from './auth.dto';

// 找回密码 T2(2026-06-11):pre-auth SMS 验证码重置密码
// (冻结评审稿 docs/archive/reviews/password-reset-by-sms-review.md,下称"评审稿")。
//
// 文件归属(评审稿 E-1):auth 模块平铺新文件(沿 refresh-token.util.ts 先例);
// **不**进 auth.service.ts(P0-E 行为冻结以"文件零 diff"为最强证据)、
// **不**进 users.service.ts(改密/重置既有行为同理)。
//
// 防枚举(评审稿 §4,本功能安全核心):
// - send-code:号码「不存在 / 未绑定(含已被 admin 清除)/ 被禁用 / 已软删」四种无效场景
//   返回与有效号**完全相同**的泛化 200(不发码、不写 codes / send_logs、不调 provider、
//   不写 audit,零侧写痕迹);有效号走 SmsCodeService.issue 既有通道,
//   限频 / 通道错误(24120/24121/24030/24031)照常抛——残余侧信道接受理由见评审稿 R-1。
// - reset:一切失败(码错 / 过期 / 超次 / 已消费 / 归属不符 / **号码无效**)统一
//   SMS_CODE_INVALID=24010;零新增可区分账号存在性的错误码。
//
// 明文纪律:newPassword / passwordHash / 验证码明文不入日志、不入 audit、不入响应。

const BCRYPT_SALT_ROUNDS = 10; // 沿 AGENTS §9(与 users.service 同值;该常量未导出,各自模块级声明)

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsCode: SmsCodeService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * POST /api/auth/v1/password-reset/send-code(评审稿 §3.2 ①)。
   * 四种无效号码场景返回与有效号同形状同值的泛化响应(E-2/E-3);
   * 有效号 issue(purpose=PASSWORD_RESET, userId=目标用户,E-7),
   * 同号 60s 间隔 + 日 10 条跨 purpose 合计天然生效(E-18)。
   */
  async sendCode(
    dto: SendPasswordResetCodeDto,
    ip: string | null,
  ): Promise<SendPasswordResetCodeResponseDto> {
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      // 防枚举泛化 200:不发码、不留痕;300 与 SmsCodeService.issue 成功路径同值
      return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
    }
    return this.smsCode.issue({
      phone: dto.phone,
      purpose: SmsPurpose.PASSWORD_RESET,
      userId: user.id,
      ip,
    });
  }

  /**
   * POST /api/auth/v1/password-reset(评审稿 §3.2 ②)。
   * 校验顺序**冻结**(评审稿 E-5):
   *   ① 解析用户(无效 → 24010,与码无效同码同形)
   *   ② 码预检 assertValid(不消费;错码 attempts+1 后抛 24010)
   *   ③ 10006 检查(bcrypt 比对新旧;相同 → 抛,不消费验证码,可换密码用同码重试)
   *      —— ③ 必须在 ② 之后:10006 是"新密码=当前密码"oracle,
   *         只允许对已证明持有有效验证码(即手机号控制权)者可达
   *   ④ verifyAndConsume 原子消费(并发重放单赢家)
   *   ⑤ 事务:改密 + 撤销全部未撤销未过期 refresh('self-password-reset',
   *      联动撤销第 5 场景,AGENTS §9)+ audit password.reset.by-sms
   * 成功返 null(data:null;不返 token、不自动登录,D-PR-1);
   * access token 沿 D-4 不吊销(≤15m 自然过期)。
   */
  async reset(dto: ResetPasswordBySmsDto, auditMeta: AuditMeta): Promise<null> {
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    await this.smsCode.assertValid({
      phone: dto.phone,
      purpose: SmsPurpose.PASSWORD_RESET,
      code: dto.code,
      userId: user.id,
    });

    const sameAsOld = await bcrypt.compare(dto.newPassword, user.passwordHash);
    if (sameAsOld) {
      throw new BizException(BizCode.NEW_PASSWORD_SAME_AS_OLD);
    }

    const { codeId } = await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.PASSWORD_RESET,
      code: dto.code,
      userId: user.id,
    });

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
        select: { id: true },
      });

      // 联动撤销第 5 场景(评审稿 §5 / E-12;where 口径镜像 changeMyPassword):
      // 全部未撤销且未过期 refresh 即时失效(旧 refresh 统一 10007);已过期 token 本就不可用。
      const refreshRevoke = await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'self-password-reset' },
      });

      // actor = 本人(pre-auth 下 actor 即被重置账号本人,评审稿 E-11);
      // extra 手机号一律掩码;禁明文码 / codeHash / 完整号码 / 密码任何形态
      await this.auditLogs.log({
        event: 'password.reset.by-sms',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'user',
        resourceId: user.id,
        meta: auditMeta,
        extra: {
          refreshTokensRevoked: refreshRevoke.count,
          phone: maskPhone(dto.phone),
          codeId,
        },
        tx,
      });
    });

    return null;
  }

  // 用户解析口径(评审稿 E-2):不经 notDeletedWhere(需识别软删行),
  // 取行后判 deletedAt === null && status === ACTIVE;
  // null = 四种无效场景统一形状(从未绑定 / 已被 admin 清除 / DISABLED / 已软删)。
  // select 含 passwordHash 仅供 ③ 比对,永不出本 service(E-9 响应不含用户字段)。
  private async resolveActiveUserByPhone(
    phone: string,
  ): Promise<{ id: string; role: Role; passwordHash: string } | null> {
    const user = await this.prisma.user.findFirst({
      where: { phone },
      select: { id: true, role: true, status: true, deletedAt: true, passwordHash: true },
    });
    if (user === null || user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
      return null;
    }
    return { id: user.id, role: user.role, passwordHash: user.passwordHash };
  }
}

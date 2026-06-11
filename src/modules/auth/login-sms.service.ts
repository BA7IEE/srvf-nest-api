import { Injectable } from '@nestjs/common';
import { Role, SmsPurpose, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { maskPhone, SMS_CODE_TTL_SECONDS } from '../sms/sms.constants';
import { AuthService } from './auth.service';
import type {
  LoginResponseDto,
  LoginSmsDto,
  SendLoginSmsCodeDto,
  SendPasswordResetCodeResponseDto,
} from './auth.dto';

// B 队列 F4-T2(2026-06-11):OTP(验证码)登录——密码登录的**并行方式**,独立端点
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md §5,下称"评审稿";
// AGENTS §8 登录契约行已随本 PR 解锁改写,密码登录契约零变化)。
//
// 文件归属(评审稿 E-O1):auth 模块平铺新文件(沿 password-reset.service.ts 先例);
// **不**进 users.service.ts;auth.service.ts 仅做 createSession 抽取式重排(E-O6)。
//
// 防枚举(评审稿 §5.2/E-O4/E-O5,完全沿找回密码范式):
// - send-code:号码「不存在 / 未绑定(含已被 admin 清除)/ 被禁用 / 已软删」四种无效场景
//   返回与有效号**完全相同**的泛化 200(不发码、不写 codes / send_logs、不调 provider、
//   不写 audit,零侧写痕迹);有效号走 SmsCodeService.issue 既有通道,
//   限频 / 通道错误(24120/24121/24030/24031)照常抛。
// - login:一切失败(号码无效〔四场景〕/ 码错 / 过期 / 超次 / 已消费 / 归属不符)统一
//   SMS_CODE_INVALID=24010;**不用 10004**(10004 是密码登录防枚举码,语义「账号或密码错误」;
//   两套防枚举体系各自闭合,零新增 BizCode)。
//
// 会话签发同构(评审稿 E-O6):验码通过后调 AuthService.createSession(单一代码路径)——
// 同 LoginResponseDto / 同 refresh family 机制 / lastLoginAt 同步 / audit 'auth.login.sms'
// (extra: familyId + phone 掩码 + codeId;禁明文码 / token 任何形态)。
//
// 语义边界(评审稿 E-O10):不更新 phoneVerifiedAt(绑定语义专属);
// 不提供 OTP+密码二要素;号码无账号不自动注册。

@Injectable()
export class LoginSmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsCode: SmsCodeService,
    private readonly auth: AuthService,
  ) {}

  /**
   * POST /api/auth/v1/login-sms/send-code(评审稿 §5.2 ①)。
   * 四种无效号码场景返回与有效号同形状同值的泛化响应(E-O4);
   * 有效号 issue(purpose=LOGIN, userId=目标用户),
   * 同号 60s 间隔 + 日 10 条跨 purpose 合计天然生效。
   */
  async sendCode(
    dto: SendLoginSmsCodeDto,
    ip: string | null,
  ): Promise<SendPasswordResetCodeResponseDto> {
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      // 防枚举泛化 200:不发码、不留痕;300 与 SmsCodeService.issue 成功路径同值
      return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
    }
    return this.smsCode.issue({
      phone: dto.phone,
      purpose: SmsPurpose.LOGIN,
      userId: user.id,
      ip,
    });
  }

  /**
   * POST /api/auth/v1/login-sms(评审稿 §5.2 ② / E-O5 校验顺序冻结):
   *   ① 解析用户(四种无效场景 → 24010,与码无效同码同形)
   *   ② verifyAndConsume 原子消费(码错 attempts+1 后抛 24010;过期 / 超次 / 已消费 /
   *      归属不符同 24010;并发重放单赢家)
   *   ③ createSession(与密码登录同构签发;audit 'auth.login.sms')
   * 成功响应 = LoginResponseDto(与密码登录**同 DTO**,goal 拍板)。
   */
  async login(dto: LoginSmsDto, meta: AuditMeta): Promise<LoginResponseDto> {
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    const { codeId } = await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.LOGIN,
      code: dto.code,
      userId: user.id,
    });

    return this.auth.createSession(
      { id: user.id, username: user.username, role: user.role },
      meta,
      'auth.login.sms',
      { phone: maskPhone(dto.phone), codeId },
    );
  }

  // 用户解析口径(评审稿 E-O2,完全沿找回密码 E-2):不经 notDeletedWhere(需识别软删行),
  // 取行后判 deletedAt === null && status === ACTIVE;
  // null = 四种无效场景统一形状(从未绑定 / 已被 admin 清除 / DISABLED / 已软删)。
  private async resolveActiveUserByPhone(
    phone: string,
  ): Promise<{ id: string; username: string; role: Role } | null> {
    const user = await this.prisma.user.findFirst({
      where: { phone },
      select: { id: true, username: true, role: true, status: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
      return null;
    }
    return { id: user.id, username: user.username, role: user.role };
  }
}

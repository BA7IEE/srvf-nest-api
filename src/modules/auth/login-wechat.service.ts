import { Injectable } from '@nestjs/common';
import { Prisma, Role, SmsPurpose, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { maskPhone, SMS_CODE_TTL_SECONDS } from '../sms/sms.constants';
import { maskOpenid } from '../wechat/wechat.constants';
import { WechatService } from '../wechat/wechat.service';
import { AuthService } from './auth.service';
import type {
  LoginResponseDto,
  LoginWechatDto,
  SendPasswordResetCodeResponseDto,
  SendWechatBindCodeDto,
  WechatBindDto,
  WechatLoginResponseDto,
} from './auth.dto';

// 微信小程序登录 T3(2026-06-12):第三个独立认证端点 + 手机短信锚点绑定
// (冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md §4,下称"评审稿";
// AGENTS §8 登录契约已随本 PR 加微信端点行,密码登录契约零变化)。
//
// 文件归属(评审稿 E-14):auth 模块平铺新文件(沿 login-sms.service.ts / password-reset.service.ts
// 先例);**不**进 auth.service.ts(P0-E 冻结;其 diff 仅 createSession event union 类型行)。
//
// 防枚举 / 防侧写(评审稿 §4.2/§4.3,沿 login-sms 范式):
// - login-wechat:openid 未绑 → 200 `{bindingRequired:true}`(非枚举面:openid 必须经持有
//   微信账号的 wx.login code 换取);命中但账号 DISABLED / 软删 → 统一 25010(与 code 无效
//   同码同形,不为账号状态开可区分响应)。
// - wechat-bind/send-code:四种无效号码场景(不存在 / 未绑定 / 禁用 / 软删)返回与有效号
//   **完全相同**泛化 200(不发码不留痕);有效号走 SmsCodeService.issue(WECHAT_BIND)既有通道。
// - wechat-bind:号码无效统一 SMS_CODE_INVALID=24010(与码无效同码同形);
//   25002(openid 已绑他账号)仅对已过码预检者可达(③ 之后,oracle 排序沿 password-reset E-5)。
//
// 校验顺序冻结(评审稿 §4.3,实施不得调换):
//   ① code2session(最前:失败不烧 SMS 码——SMS 码有资费 + 60s 间隔,wx code 重取无感)
//   ② resolveActiveUserByPhone(四无效 → 24010)
//   ③ assertValid 码预检不消费(错码 attempts+1 → 24010)
//   ④ openid 占用(他人〔含软删占用〕→ 25002;本人 → 幂等跳过 ⑥ 绑定;null → 首绑/换绑)
//   ⑤ verifyAndConsume 原子消费(并发重放单赢家)
//   ⑥ 事务:update openid + audit wechat.{bind,rebind}.self(viaPath='pre-auth';P2002 兜底 25002)
//   ⑦ createSession('auth.login.wechat')——与密码登录同构签发(评审稿 E-15)
// ⑥⑦ 两事务串行,"绑定已提交而签发失败"窄窗口接受(E-24:客户端走 login-wechat 已绑路重登)。

@Injectable()
export class LoginWechatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
    private readonly smsCode: SmsCodeService,
    private readonly auth: AuthService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * POST /api/auth/v1/login-wechat(评审稿 §4.2)。
   * 已绑 → bindingRequired:false + session;未绑 → bindingRequired:true + session:null;
   * 命中但账号非 ACTIVE / 软删 → 统一 25010(防侧写)。
   */
  async login(dto: LoginWechatDto, meta: AuditMeta): Promise<WechatLoginResponseDto> {
    const { openid } = await this.wechat.code2session(dto.code);

    // 含软删行(openid @unique 含软删占用,评审稿 E-19);取行后判 ACTIVE
    const user = await this.prisma.user.findUnique({
      where: { openid },
      select: { id: true, username: true, role: true, status: true, deletedAt: true },
    });

    if (user === null) {
      // 未绑定:不签发、不留痕;客户端引导走 wechat-bind(届时重新 wx.login 取新 code,E-16)
      return { bindingRequired: true, session: null };
    }
    if (user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
      throw new BizException(BizCode.WECHAT_CODE_INVALID);
    }

    const session = await this.auth.createSession(
      { id: user.id, username: user.username, role: user.role },
      meta,
      'auth.login.wechat',
      { openid: maskOpenid(openid) },
    );
    return { bindingRequired: false, session };
  }

  /**
   * POST /api/auth/v1/wechat-bind/send-code(评审稿 §4.3)。
   * 四种无效号码场景返回与有效号同形状同值的泛化响应;
   * 有效号 issue(purpose=WECHAT_BIND, userId=目标用户),
   * 同号 60s 间隔 + 日 10 条跨 purpose 合计天然生效。
   */
  async sendBindCode(
    dto: SendWechatBindCodeDto,
    ip: string | null,
  ): Promise<SendPasswordResetCodeResponseDto> {
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      // 防枚举泛化 200:不发码、不留痕;300 与 SmsCodeService.issue 成功路径同值
      return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
    }
    return this.smsCode.issue({
      phone: dto.phone,
      purpose: SmsPurpose.WECHAT_BIND,
      userId: user.id,
      ip,
    });
  }

  /**
   * POST /api/auth/v1/wechat-bind(评审稿 §4.3 七步顺序冻结)。
   * 成功 = openid 绑到该手机所属账号(可覆盖该账号旧 openid = 换绑)+ 同构签发 JWT;
   * 响应 = LoginResponseDto(绑定成功必然有会话,不复用 WechatLoginResponseDto)。
   */
  async bind(dto: WechatBindDto, meta: AuditMeta): Promise<LoginResponseDto> {
    // ① code2session(失败 25010/25030/25031;不触账号信息,无 oracle;不烧 SMS 码)
    const { openid } = await this.wechat.code2session(dto.code);

    // ② 解析手机号(四无效场景 → 24010,与码无效同码同形)
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    // ③ 码预检不消费(错码 attempts+1 → 24010;通过 = 已证手机号控制权)
    await this.smsCode.assertValid({
      phone: dto.phone,
      purpose: SmsPurpose.WECHAT_BIND,
      code: dto.smsCode,
      userId: user.id,
    });

    // ④ openid 占用(必须在 ③ 之后:25002 是绑定关系 oracle,仅对已证手机控制权者可达)
    const occupied = await this.prisma.user.findUnique({
      where: { openid },
      select: { id: true },
    });
    if (occupied !== null && occupied.id !== user.id) {
      throw new BizException(BizCode.WECHAT_ALREADY_BOUND);
    }
    const alreadyBoundToSelf = occupied !== null; // occupied.id === user.id

    // ⑤ 原子消费(并发重放单赢家;独立于绑定事务,沿 SmsCodeService E-8 设计)
    const { codeId } = await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.WECHAT_BIND,
      code: dto.smsCode,
      userId: user.id,
    });

    // ⑥ 绑定事务(已绑本人则幂等跳过,不重写不重计 audit)
    if (!alreadyBoundToSelf) {
      const me = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { openid: true },
      });
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { openid },
            select: { id: true },
          });
          // audit detail openid 一律掩码(E-23);禁 wx code / 完整 openid / session_key
          await this.auditLogs.log({
            event: me.openid === null ? 'wechat.bind.self' : 'wechat.rebind.self',
            actorUserId: user.id,
            actorRoleSnap: user.role,
            resourceType: 'user',
            resourceId: user.id,
            meta,
            ...(me.openid === null ? {} : { before: { openid: maskOpenid(me.openid) } }),
            after: { openid: maskOpenid(openid) },
            extra: { viaPath: 'pre-auth', phone: maskPhone(dto.phone), codeId },
            tx,
          });
        });
      } catch (err) {
        // P2002 兜底竞态:落库撞 User_openid_key → 25002(沿 §5 数组判断铁律)
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          Array.isArray(err.meta?.target) &&
          (err.meta.target as string[]).includes('openid')
        ) {
          throw new BizException(BizCode.WECHAT_ALREADY_BOUND);
        }
        throw err;
      }
    }

    // ⑦ 同构签发(评审稿 E-15/E-24;audit auth.login.wechat 在 createSession 事务内)
    return this.auth.createSession(
      { id: user.id, username: user.username, role: user.role },
      meta,
      'auth.login.wechat',
      { openid: maskOpenid(openid) },
    );
  }

  // 用户解析口径(逐字沿 login-sms E-O2 / 找回密码 E-2):不经 notDeletedWhere(需识别软删行),
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

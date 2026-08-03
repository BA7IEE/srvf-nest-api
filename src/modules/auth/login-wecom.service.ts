import { Injectable } from '@nestjs/common';
import { Prisma, SmsPurpose, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { SMS_CODE_TTL_SECONDS } from '../sms/sms.constants';
import { WecomAuthAttemptService } from '../wecom/wecom-auth-attempt.service';
import {
  buildWecomAuthorizeUrl,
  isAcceptableWecomOAuthCode,
  isSafeWecomReturnPath,
  maskWecomUserId,
  WECOM_DEFAULT_BIND_SELF_RETURN_PATH,
  WECOM_DEFAULT_LOGIN_RETURN_PATH,
} from '../wecom/wecom.constants';
import { WecomService } from '../wecom/wecom.service';
import {
  WECOM_ATTEMPT_PURPOSE,
  WECOM_BINDING_SOURCE,
  WECOM_IDENTITY_STATUS,
} from '../wecom/wecom.types';
import { AuthService } from './auth.service';
import { lockAuthSessionUser } from './auth-session-lock';
import { isWecomLoginCredentialInvalid, WecomLoginFailureGate } from './wecom-login-failure.gate';
import type {
  LoginResponseDto,
  LoginWecomDto,
  SendPasswordResetCodeResponseDto,
  SendWecomBindCodeDto,
  WecomAuthorizeDto,
  WecomAuthorizeResponseDto,
  WecomBindDto,
  WecomLoginResponseDto,
} from './auth.dto';

// 企业微信接入 T3(2026-08-02):OAuth 登录 + 手机锚点首次绑定
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §6.2 / §9,下称"冻结稿")
//
// 文件归属:auth 模块平铺新文件,沿 login-wechat.service.ts / login-sms.service.ts 先例;
// **不**进 auth.service.ts(P0-E 冻结;它在本刀的 diff 只有第四 expectation 那一处)。
//
// ── 防枚举 / 防侧写(§6.2 规则 5/9,沿 login-wechat 范式)──
// - login-wecom:未绑定 → 200 `{bindingRequired:true, bindingTicket}`(非枚举面:
//   wecomUserId 必须经持有企业微信账号的一次性 code 换取);
//   绑定指向 DISABLED / 软删 User → 统一 36010(与 code 无效、state 无效同码同形)。
//   响应**不含** hasPhone、手机号尾号、账号状态、wecomUserId、corpId、attempt id。
// - wecom-bind/send-code:五种无效场景(号码不存在 / User.phone=null / DISABLED / 软删 /
//   与账号绑定值不一致)返回与有效号**逐字段相同**的泛化 200,不发短信、不留痕。
// - wecom-bind:号码无效统一 24010;36002 仅对已过码预检者可达(oracle 排序沿 password-reset E-5)。
//
// ── 校验顺序冻结(§6.2,实施不得调换)──
//   login:  ① CAS 消费 login state ② code 长度校验 + 事务外换身份 ③ 只收小写 userid
//           ④ 查 active identity:无 → 签 ticket 转 binding_required / 有 → createSession
//   bind:   ① ticket 有效且 binding_required ② 解析手机号(四无效 → 24010)
//           ③ SMS assertValid 不消费 ④ 身份占用预检(他人 active → 36002)
//           ⑤ SMS verifyAndConsume 单赢家 ⑥ 绑定事务 ⑦ createSession
//
// ── 锁序(§9.1,全局固定)──
//   WecomSettings(FOR SHARE)→ User(FOR UPDATE)→ WecomIdentity → WecomAuthAttempt
//   → RefreshToken / Audit。反序即死锁,任何新写路径都必须照抄这个顺序。
//
// ── 敏感值(§5.5)──
//   code / 原始 state / 原始 binding ticket 三者:不落库、不入日志、不入 Audit。
//   浏览器关联 nonce(B1)同级:只在 `Set-Cookie` 里出现一次,不进响应体 / 日志 / Audit。
//   wecomUserId 落 wecom_identities 明文(发送消息要用),但响应 / Audit / 日志只出掩码。
//
// ── P1-27 第一刀(2026-08-03,外部评审 NO-GO 后)──
//   B1:`state` 现在绑定发起授权的浏览器 —— authorize 另发 `__Host-` Cookie nonce,
//       `state = sha256(nonce)`,callback 必须同时出示两者。
//       修前实测:攻击者的 `code+state` 塞进受害者浏览器 → 受害者输入自己的手机号短信码
//       → 攻击者的企业微信身份绑到受害者账号(完整接管,已端到端复现)。
//   B3:36010 全部经 `WecomLoginFailureGate` 一个出口 —— 有界最小响应时长 + 扰动。
//       修前实测「state 无效」比其余分支快约一半,构成"我方认不认这个 state"的 oracle。

/**
 * authorize 的内部返回:对外 DTO + 只能进 Cookie 的 nonce 原值(B1)。
 *
 * 拆成两块而不是往 DTO 上加字段,是**结构性**的:`WecomAuthorizeResponseDto` 会被
 * ResponseInterceptor 原样序列化进响应体,nonce 一旦进了它就必然泄露到 body 里。
 * 分成两个字段之后,"把 nonce 写进响应体"需要有人显式去改 controller,
 * 而不是顺手加一行 DTO 字段就悄悄发生。
 */
export interface IssuedWecomAuthorize {
  dto: WecomAuthorizeResponseDto;
  browserNonce: string;
}

@Injectable()
export class LoginWecomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wecom: WecomService,
    private readonly attempts: WecomAuthAttemptService,
    private readonly smsCode: SmsCodeService,
    private readonly auth: AuthService,
    private readonly auditLogs: AuditLogsService,
    private readonly failures: WecomLoginFailureGate,
  ) {}

  /**
   * POST /api/auth/v1/login-wecom/authorize(§6.2)。
   *
   * pre-auth:任何人都能拿到一个 authorize URL —— 这不泄露任何账号信息,
   * URL 里只有企业配置(CorpID / AgentID)与一个随机 state。
   */
  async authorizeForLogin(dto: WecomAuthorizeDto): Promise<IssuedWecomAuthorize> {
    return this.createAuthorizeUrl({
      purpose: WECOM_ATTEMPT_PURPOSE.LOGIN,
      subjectUserId: null,
      returnPath: dto.returnPath,
      defaultReturnPath: WECOM_DEFAULT_LOGIN_RETURN_PATH,
    });
  }

  /**
   * POST /api/auth/v1/wecom-bind/authorize(§6.2)。
   *
   * 需登录。attempt 固定 `subjectUserId=currentUser.id` —— 这是 bind_self 的**归属锚**:
   * 随后 PUT me/wecom 会校验消费到的 state 属于当前登录用户,
   * 于是"拿别人的 state 去绑自己"在 state 消费那一步就断掉。
   */
  async authorizeForBindSelf(
    currentUser: CurrentUserPayload,
    dto: WecomAuthorizeDto,
  ): Promise<IssuedWecomAuthorize> {
    return this.createAuthorizeUrl({
      purpose: WECOM_ATTEMPT_PURPOSE.BIND_SELF,
      subjectUserId: currentUser.id,
      returnPath: dto.returnPath,
      defaultReturnPath: WECOM_DEFAULT_BIND_SELF_RETURN_PATH,
    });
  }

  /**
   * POST /api/auth/v1/login-wecom(§6.2 四步)。
   *
   * ⑦ 之外还有一条隐含纪律:**Provider 调用不在事务内**(§9.5)。
   * state 先 CAS 消费再打上游 —— 上游成功但进程随后崩溃时用户重新发起即可,
   * 刻意不复活 code / state。
   */
  async login(
    dto: LoginWecomDto,
    browserNonce: string | null,
    meta: AuditMeta,
  ): Promise<WecomLoginResponseDto> {
    // B3:计时窗从**请求处理的最开始**起算,不是从失败点。
    // 各分支的耗时差异恰恰积累在失败点之前,从失败点起算等于没算。
    const startedAt = Date.now();
    try {
      return await this.loginInner(dto, browserNonce, meta);
    } catch (err) {
      // 36010 的**唯一出口**。放在这里而不是逐分支调用,有两个理由:
      //   ① 它是个 choke point —— 将来新增的 36010 分支自动被收进来,
      //      不依赖"记得也调一次 gate"这种靠自觉的约定;
      //   ② 深层(`WecomService.exchangeOAuthCode` → 上游 40029/42003/42022)抛出的
      //      同码异常也走这里,否则"上游拒绝 code"那条永远绕过归一化。
      // 其余码(36030 通道未配置 / 36031 上游异常)不归一 —— 它们本来就是可区分的码,
      // 拖慢它们只有坏处。
      if (isWecomLoginCredentialInvalid(err)) {
        await this.failures.reject(startedAt);
      }
      throw err;
    }
  }

  private async loginInner(
    dto: LoginWecomDto,
    browserNonce: string | null,
    meta: AuditMeta,
  ): Promise<WecomLoginResponseDto> {
    // ① 原子消费 purpose=login state + 浏览器关联 nonce(B1)
    // (并发两请求单赢家;失败一律 36010,不区分"state 不对"与"浏览器不对")
    const attempt = await this.attempts.consumeState({
      state: dto.state,
      purpose: WECOM_ATTEMPT_PURPOSE.LOGIN,
      browserNonce,
    });
    if (attempt === null) {
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }

    // ②③ code 校验 + 事务外换身份(失败即把 attempt 置 failed,不回退到可用状态)
    const { corpId, wecomUserId } = await this.exchangeOrFail(attempt.id, dto.code);

    // ④ 查该企业微信身份当前的 active 绑定
    const identity = await this.prisma.wecomIdentity.findFirst({
      where: { corpId, wecomUserId, status: WECOM_IDENTITY_STATUS.ACTIVE, revokedAt: null },
      select: { id: true, userId: true },
    });

    if (identity === null) {
      // 未绑定:签发一次性 binding ticket。
      // 响应里**只有** ticket 与 returnPath —— 没有 wecomUserId / corpId / attempt id(§5.3 规则 10),
      // 也没有任何"这个企业微信号对应哪个账号"的线索。
      const issued = await this.attempts.issueBindingTicket({
        attemptId: attempt.id,
        corpId,
        wecomUserId,
      });
      if (issued === null) {
        throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      }
      return {
        bindingRequired: true,
        bindingTicket: issued.bindingTicket,
        session: null,
        returnPath: attempt.returnPath,
      };
    }

    // ⑤ 绑定存在但账号不可用 → 统一 36010(**不**返回"账号已禁用"这类可区分信息)
    const user = await this.prisma.user.findUnique({
      where: { id: identity.userId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
      await this.attempts.markFailed(attempt.id);
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }

    // ⑦ 同构签发(audit auth.login.wecom 在 createSession 事务内;
    // 第四 expectation 会在 User 锁后再校验一次这条身份行 —— §9.4 的 login vs clear 竞态就锁在那里)
    const session = await this.auth.createSession(
      identity.userId,
      {
        kind: 'wecom-identity',
        identityId: identity.id,
        corpId,
        wecomUserId,
      },
      meta,
      'auth.login.wecom',
      { identityId: identity.id, wecomUserIdMasked: maskWecomUserId(wecomUserId) },
    );
    await this.attempts.markCompleted(attempt.id);

    return {
      bindingRequired: false,
      bindingTicket: null,
      session,
      returnPath: attempt.returnPath,
    };
  }

  /**
   * POST /api/auth/v1/wecom-bind/send-code(§6.2)。
   *
   * binding ticket 必须有效但**不消费** —— 用户可能输错号码或要重发,
   * 每次都烧票等于逼他从企业微信重走一遍 OAuth。
   *
   * 防枚举:解析不到可用 User 时返回与有效号**逐字段相同**的泛化 200,不发码不留痕。
   * 有效号的限频 / 通道错误照常抛(仅对有效号可达,残余侧信道沿 wechat R-1 已接受)。
   */
  async sendBindCode(
    dto: SendWecomBindCodeDto,
    ip: string | null,
  ): Promise<SendPasswordResetCodeResponseDto> {
    const binding = await this.attempts.findValidBinding(dto.bindingTicket);
    if (binding === null) {
      throw new BizException(BizCode.WECOM_BINDING_TICKET_INVALID);
    }

    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      // 泛化 200:300 与 SmsCodeService.issue 成功路径同值同形
      return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
    }
    return this.smsCode.issue({
      phone: dto.phone,
      purpose: SmsPurpose.WECOM_BIND,
      userId: user.id,
      ip,
    });
  }

  /**
   * POST /api/auth/v1/wecom-bind(§6.2 冻结校验顺序 ①-⑦)。
   *
   * 成功 = 企业微信身份绑到该手机号所属账号(可结束该账号旧身份 = 换绑)+ 同构签发 JWT。
   * ⑥⑦ 两事务串行,"绑定已提交而签发失败"的窄窗口**接受**(§6.2 末段:
   * 客户端重新执行 login-wecom 即可,那时已是已绑定路径)。
   */
  async bind(dto: WecomBindDto, meta: AuditMeta): Promise<LoginResponseDto> {
    // ① ticket 有效且处于 binding_required(此时**不消费**;真正消费在 ⑥ 事务内)
    const binding = await this.attempts.findValidBinding(dto.bindingTicket);
    if (binding === null) {
      throw new BizException(BizCode.WECOM_BINDING_TICKET_INVALID);
    }

    // ② 解析手机号(四无效场景 → 24010,与码无效同码同形)
    const user = await this.resolveActiveUserByPhone(dto.phone);
    if (user === null) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }

    // ③ 码预检不消费(错码 attempts+1 → 24010;通过 = 已证手机号控制权)
    await this.smsCode.assertValid({
      phone: dto.phone,
      purpose: SmsPurpose.WECOM_BIND,
      code: dto.smsCode,
      userId: user.id,
    });

    // ④ 身份占用预检(必须在 ③ 之后:36002 是绑定关系 oracle,仅对已证手机控制权者可达)。
    // §9.3:**不跨用户锁目标 User** —— 双向换绑会形成 A→B / B→A 的锁环。
    // 这里只做早提示,最终正确性由 active partial unique 在 ⑥ 兜底。
    await this.assertIdentityNotTakenByOthers(this.prisma, binding, user.id);

    // ⑤ 原子消费短信码(并发重放单赢家;独立于绑定事务,沿 SmsCodeService E-8 设计)
    await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.WECOM_BIND,
      code: dto.smsCode,
      userId: user.id,
    });

    // ⑥ 绑定事务(锁序 §9.1:settings → User → identity → attempt → refresh / audit)
    const identityId = await this.runBindTransaction({
      binding,
      userId: user.id,
      phone: dto.phone,
      bindingTicket: dto.bindingTicket,
      bindingSource: WECOM_BINDING_SOURCE.PRE_AUTH,
      meta,
    });

    // ⑦ 同构签发;createSession 会在 User 锁后再验一次这条新身份(§7.3)
    return this.auth.createSession(
      user.id,
      {
        kind: 'wecom-identity',
        identityId,
        corpId: binding.corpId,
        wecomUserId: binding.wecomUserId,
      },
      meta,
      'auth.login.wecom',
      { identityId, wecomUserIdMasked: maskWecomUserId(binding.wecomUserId) },
    );
  }

  // ===== internals =====

  private async createAuthorizeUrl(input: {
    purpose: (typeof WECOM_ATTEMPT_PURPOSE)[keyof typeof WECOM_ATTEMPT_PURPOSE];
    subjectUserId: string | null;
    returnPath: string | undefined;
    defaultReturnPath: string;
  }): Promise<IssuedWecomAuthorize> {
    // returnPath 校验在**签发之前** —— 不合法就不该建 attempt 行,
    // 否则畸形 returnPath 会以每次请求一行的速度堆进台账。
    const returnPath = input.returnPath ?? input.defaultReturnPath;
    if (!isSafeWecomReturnPath(returnPath)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    const ctx = await this.wecom.getAuthorizeContext();
    const { state, browserNonce, expiresAt } = await this.attempts.createAttempt({
      purpose: input.purpose,
      subjectUserId: input.subjectUserId,
      returnPath,
    });

    return {
      dto: {
        // state 原文**只**出现在这个 URL 里;响应体不单独回显它(§6.2 末条)
        authorizeUrl: buildWecomAuthorizeUrl({
          corpId: ctx.corpId,
          agentId: ctx.agentId,
          webBaseUrl: ctx.webBaseUrl,
          state,
        }),
        expiresAt: expiresAt.toISOString(),
      },
      // B1:nonce 原文**只**交给 controller 写进 `Set-Cookie`,
      // 绝不进 DTO —— 进了 DTO 就等于把 HttpOnly 的意义抹掉。
      browserNonce,
    };
  }

  /**
   * code → wecomUserId,失败即把 attempt 置 failed 再抛。
   *
   * ⚠️ code 只作为实参传给 Provider,**不进**任何日志 / Audit / 异常 message(§5.5)。
   * 长度校验放在换身份之前:512 字节以上的入参没有任何理由打到上游。
   */
  private async exchangeOrFail(
    attemptId: string,
    code: string,
  ): Promise<{ corpId: string; wecomUserId: string }> {
    if (!isAcceptableWecomOAuthCode(code)) {
      await this.attempts.markFailed(attemptId);
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }
    const { provider, corpId } = await this.wecom.resolveLoginContext();
    try {
      const { wecomUserId } = await this.wecom.exchangeOAuthCode(provider, code);
      return { corpId, wecomUserId };
    } catch (err) {
      await this.attempts.markFailed(attemptId);
      throw err;
    }
  }

  /**
   * 目标身份是否已被**他人**的 active 绑定占用(§6.2 步骤 ④ / §9.3 预检)。
   *
   * 传 client 而不是写死 this.prisma:同一判据要在锁外(早提示)与锁内(权威)各跑一次,
   * 两次用同一段代码才不会出现"预检和终检判据不一致"这种最难查的错。
   */
  private async assertIdentityNotTakenByOthers(
    client: PrismaService | Prisma.TransactionClient,
    target: { corpId: string; wecomUserId: string },
    selfUserId: string,
  ): Promise<void> {
    const occupied = await client.wecomIdentity.findFirst({
      where: {
        corpId: target.corpId,
        wecomUserId: target.wecomUserId,
        status: WECOM_IDENTITY_STATUS.ACTIVE,
        revokedAt: null,
      },
      select: { userId: true },
    });
    if (occupied !== null && occupied.userId !== selfUserId) {
      throw new BizException(BizCode.WECOM_IDENTITY_ALREADY_BOUND);
    }
  }

  /**
   * 绑定事务(§6.2 步骤 ⑥ 逐条)。返回新 active identity 的 id 供 ⑦ 签发使用。
   *
   * 锁序严格 §9.1;每一步的"为什么"见行内注释。
   */
  private async runBindTransaction(input: {
    binding: { corpId: string; wecomUserId: string };
    userId: string;
    phone: string;
    bindingTicket: string;
    bindingSource: (typeof WECOM_BINDING_SOURCE)[keyof typeof WECOM_BINDING_SOURCE];
    meta: AuditMeta;
  }): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1) settings FOR SHARE —— 与 PATCH settings 的 FOR UPDATE 互斥。
        // 目的:CorpID 切换不能穿透正在进行的首个绑定(§9.2)。
        const settingsRows = await tx.$queryRaw<
          Array<{ id: string; corpId: string | null; enabled: boolean; loginEnabled: boolean }>
        >(
          Prisma.sql`SELECT "id", "corpId", "enabled", "loginEnabled"
                     FROM "wecom_settings" LIMIT 1 FOR SHARE`,
        );
        const settings = settingsRows[0];

        // 2) 锁后复判开关(fail-closed)。
        // ⚠️ 这一条不是冗余:bind 路径**不调** resolveLoginContext —— 换身份发生在 login 那一步,
        // 到这里 corpId / wecomUserId 都是从 attempt 行读的,整条路径不碰通道层。
        // 少了这一判,运维把 loginEnabled 关掉之后,任何手握未过期 binding ticket 的人
        // (票有 10 分钟)仍能建出 active 身份**并拿到会话** —— 开关等于没关(e2e 实测)。
        // 放在锁后而不是锁外:锁外读到的开关在拿到锁那一刻可能已被 PATCH 改掉。
        if (!settings || !settings.enabled || !settings.loginEnabled) {
          throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
        }

        // 3) 锁后二次一致:attempt 记的 corpId 必须仍等于当前 settings 的 corpId。
        // 不一致 = 从签 ticket 到现在 CorpID 被换过,这张票对应的企业已经不是当前企业。
        if (settings.corpId === null || settings.corpId !== input.binding.corpId) {
          throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
        }

        // 3) User FOR UPDATE —— 会话链路的唯一串行化点;
        // 同 User 的并发换绑在这里排队,于是 4)/6) 看到的都是彼此提交后的事实。
        if (!(await lockAuthSessionUser(tx, input.userId))) {
          throw new BizException(BizCode.SMS_CODE_INVALID);
        }
        const me = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true, role: true, status: true, deletedAt: true, phone: true },
        });
        if (
          !me ||
          me.deletedAt !== null ||
          me.status !== UserStatus.ACTIVE ||
          me.phone !== input.phone
        ) {
          throw new BizException(BizCode.SMS_CODE_INVALID);
        }

        // 4) 当前 active 身份(锁后重读)。有则是换绑,无则是首绑。
        const current = await tx.wecomIdentity.findFirst({
          where: {
            userId: me.id,
            corpId: input.binding.corpId,
            status: WECOM_IDENTITY_STATUS.ACTIVE,
            revokedAt: null,
          },
          select: { id: true, wecomUserId: true },
        });

        // 同目标 no-op:已经绑着同一个企业微信号 → 不重写、不撤 refresh、不写变更 audit。
        // 直接返回既有 id,让 ⑦ 照常签发(用户拿票走完流程,理应得到会话)。
        if (current !== null && current.wecomUserId === input.binding.wecomUserId) {
          if (!(await this.attempts.consumeBindingTicket(tx, input.bindingTicket))) {
            throw new BizException(BizCode.WECOM_BINDING_TICKET_INVALID);
          }
          return current.id;
        }

        // 5) 锁后 target occupancy 二次检查(权威判据;与 ④ 同一段代码)
        await this.assertIdentityNotTakenByOthers(tx, input.binding, me.id);

        // 6) 结束旧身份 + 建新身份。两步必须同事务 ——
        // 中途撞 wecom_identity_user_active_unique(同 User 同 corpId 至多一条 active)。
        const now = new Date();
        if (current !== null) {
          await tx.wecomIdentity.update({
            where: { id: current.id },
            data: {
              status: WECOM_IDENTITY_STATUS.REVOKED,
              revokedAt: now,
              revokedByUserId: me.id,
            },
            select: { id: true },
          });
        }
        const created = await tx.wecomIdentity.create({
          data: {
            userId: me.id,
            corpId: input.binding.corpId,
            wecomUserId: input.binding.wecomUserId,
            status: WECOM_IDENTITY_STATUS.ACTIVE,
            bindingSource: input.bindingSource,
            boundAt: now,
          },
          select: { id: true },
        });

        // 6b) 身份代际 +1(第二轮外部评审 SHOULD-FIX 1)。
        // `User.wecomIdentityVersion` 是第一刀 B2 为挡 step-up proof 的 ABA 回环加的
        // **单调代际**,当时只接了 authed 换绑与撤销原语两处,**漏了 pre-auth 这条**——
        // 而第 70 个 migration 的注释写的是"递增方:**两条**绑定事务 + 撤销原语"。
        // 这里补的就是代码欠注释的那一条。
        //
        // ⚠️ 位置有讲究,三点缺一不可:
        //   ① 在 identity 真正写完**之后** —— 上面的同目标 no-op 分支已经 return,
        //      于是"身份没变也白白作废所有 proof"这件事写不出来;
        //   ② 在撤 refresh 与 audit **之前**,且与它们同事务 —— 后腿失败必须连它一起回滚,
        //      否则会留下"没有任何身份变化的幽灵代际";
        //   ③ 走 3) 已经 `FOR UPDATE` 持住的**那把 User 锁**,不另开第二个 User 锁 ——
        //      别在这里引入新的 `User → …` 边(§9.1 锁序 settings → User → identity)。
        await tx.user.update({
          where: { id: me.id },
          data: { wecomIdentityVersion: { increment: 1 } },
          select: { id: true },
        });

        // 7) 消费 binding ticket —— 与写身份同生共死。
        // 分成两个事务的话,绑定回滚而票已烧 = 用户被卡在中间态。
        if (!(await this.attempts.consumeBindingTicket(tx, input.bindingTicket))) {
          throw new BizException(BizCode.WECOM_BINDING_TICKET_INVALID);
        }

        // 8) 撤销该 User 全部活跃未过期 refresh(身份变更 = 旧会话不再代表当前身份)
        await tx.refreshToken.updateMany({
          where: { userId: me.id, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now, revokedReason: 'self-wecom-identity-change' },
        });

        // 9) Audit:before/after **只允许掩码身份**;extra 恰好 viaPath(§11.3)。
        // 完整 wecomUserId / corpId / code / state / ticket 一律不入。
        await this.auditLogs.log({
          event: current === null ? 'wecom.bind.self' : 'wecom.rebind.self',
          actorUserId: me.id,
          actorRoleSnap: me.role,
          resourceType: 'user',
          resourceId: me.id,
          meta: input.meta,
          ...(current === null
            ? {}
            : { before: { wecomUserId: maskWecomUserId(current.wecomUserId) } }),
          after: { wecomUserId: maskWecomUserId(input.binding.wecomUserId) },
          extra: { viaPath: input.bindingSource },
          tx,
        });

        return created.id;
      });
    } catch (err) {
      if (isWecomIdentityUniqueViolation(err)) {
        throw new BizException(BizCode.WECOM_IDENTITY_ALREADY_BOUND);
      }
      throw err;
    }
  }

  // 用户解析口径(逐字沿 login-wechat / login-sms / password-reset):
  // 不经 notDeletedWhere(需识别软删行),取行后判 deletedAt === null && status === ACTIVE;
  // null = 四种无效场景统一形状(号码不存在 / User.phone 为空 / DISABLED / 已软删)。
  private async resolveActiveUserByPhone(phone: string): Promise<{ id: string } | null> {
    const user = await this.prisma.user.findFirst({
      where: { phone },
      select: { id: true, status: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
      return null;
    }
    return { id: user.id };
  }
}

/**
 * P2002 是否来自 `wecom_identities` 的两条 **partial unique**(§9.3)。
 *
 * 为什么不能"任何 P2002 都映射 36002":同一事务还会写 refresh_tokens 与 audit_logs,
 * 它们各有唯一键;把无关冲突也报成"身份已被占用"会把运维引到完全错误的方向。
 *
 * 为什么要同时认**索引名**和**列名**:这两条索引是手写 SQL 建的(Prisma DSL 表达不了
 * partial unique 的 WHERE),Prisma 对手写索引的 `meta.target` 形态不稳定 ——
 * 可能是索引名字符串,也可能是列名数组。只认一种就会在某个版本静默失配,
 * 让用户拿到裸 500 而不是 36002(§9.3 点名要求)。
 */
function isWecomIdentityUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const indexNames = ['wecom_identity_subject_active_unique', 'wecom_identity_user_active_unique'];
  if (typeof target === 'string') {
    return indexNames.includes(target) || target.includes('wecom_identit');
  }
  if (Array.isArray(target)) {
    const columns = target.map((v) => String(v));
    return (
      indexNames.some((name) => columns.includes(name)) ||
      (columns.includes('corpId') &&
        (columns.includes('wecomUserId') || columns.includes('userId')))
    );
  }
  return false;
}

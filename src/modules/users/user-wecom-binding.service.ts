import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { lockAuthSessionUser } from '../auth/auth-session-lock';
import { StepUpAction } from '../auth/auth.dto';
import {
  IdentityStepUpService,
  type StepUpWecomBindingSnapshotInput,
  type StepUpWecomIdentitySnapshotInput,
} from '../auth/identity-step-up.service';
import { RbacService } from '../permissions/rbac.service';
import { WecomAuthAttemptService } from '../wecom/wecom-auth-attempt.service';
import { isAcceptableWecomOAuthCode, maskWecomUserId } from '../wecom/wecom.constants';
import { WecomService } from '../wecom/wecom.service';
import {
  WECOM_ATTEMPT_PURPOSE,
  WECOM_BINDING_SOURCE,
  WECOM_IDENTITY_STATUS,
} from '../wecom/wecom.types';
import { AppMeWecomDto, type BindMyWecomDto } from './dto/app/app-me-wecom.dto';
import { canManageUser } from './users.policy';
import { userSafeSelect } from './users.select';
import { revokeActiveWecomIdentityInTx } from './wecom-identity-revoke';
import type { UserResponseDto } from './users.dto';

// 企业微信接入 T3(2026-08-02):本人企业微信绑定 / 换绑 + 管理员清除
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §6.3 / §6.4;
// 模块归属见 §4.1 文件计划 `users/user-wecom-binding.service.ts`)
//
// 为什么落在 users 而不是 wecom(§4.2 依赖方向):`wecom` 是**通道层**,对 User / Member /
// 业务权限无感知。身份占用、绑定落库、refresh 撤销与 Audit 全部归 auth / users。
// 本 Service 只从 wecom 模块取两样东西:闸门链 + code 换身份(WecomService)、
// 一次性 state 台账(WecomAuthAttemptService)。
//
// 为什么独立成文件而不进 users.service.ts:后者已是本仓最大的 service,
// 而这三个方法自成一个闭合的身份子域(状态机 + 锁序 + 审计口径都独立)。
//
// ⚠️ 与 auth/login-wecom.service.ts 的分工(两者都写 wecom_identities,刻意不合并):
//   - pre-auth 绑定(那边):锚点是**短信验证码**(还没登录,只能靠手机号证明账号控制权)
//   - 登录态换绑(这边):锚点是 **JWT + action-bound step-up proof**(已登录,不必再验手机)
// 两条路径的前置条件、错误码体系、防枚举要求都不同;强行抽公共函数会让参数里塞满
// "这条路径要不要做 X" 的布尔开关,反而更难核对。绑定事务的核心步骤保持逐条对齐,
// 改一边**必须**同时翻另一边。
//
// D-WC-9:**无本人裸解绑** —— App 没有 DELETE me/wecom。释放身份的唯一显式路径是
// 管理员清除(clearUserWecom)。理由:企业微信身份是组织资产,不是个人偏好设置。

@Injectable()
export class UserWecomBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wecom: WecomService,
    private readonly attempts: WecomAuthAttemptService,
    private readonly identityStepUp: IdentityStepUpService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * GET /api/app/v1/me/wecom(§6.3)。
   *
   * 准入沿 me/phone、me/wechat 的账号级豁免先例:企业微信身份是**账号级**字段,
   * Admin 没有 Member 也需要绑定,故**不**调 appIdentity.resolve + assertCanUseApp。
   * 豁免仅限本两个端点,禁止外溢。
   *
   * 未绑定不是错误(§11.2「不开」段:没有 WECOM_NOT_BOUND 这个码)——
   * 返回 `{bound:false}` 状态对象,让前端直接渲染"去绑定"按钮。
   */
  async getMyWecom(currentUser: CurrentUserPayload): Promise<AppMeWecomDto> {
    const identity = await this.prisma.wecomIdentity.findFirst({
      where: {
        userId: currentUser.id,
        status: WECOM_IDENTITY_STATUS.ACTIVE,
        revokedAt: null,
      },
      select: { wecomUserId: true, boundAt: true },
    });
    if (identity === null) {
      return { bound: false, wecomUserIdMasked: null, boundAt: null };
    }
    return {
      bound: true,
      wecomUserIdMasked: maskWecomUserId(identity.wecomUserId),
      boundAt: identity.boundAt,
    };
  }

  /**
   * PUT /api/app/v1/me/wecom(§6.3 冻结流程 ①-⑤)。
   *
   * JWT 已证"你是谁",step-up proof 再证"你现在还持有这个账号的凭证"(D-WC-8)。
   * 两者缺一不可:只有 JWT 时,一个被盗的 access token 就能把账号身份改绑到攻击者的企业微信号。
   */
  async bindMyWecom(
    currentUser: CurrentUserPayload,
    dto: BindMyWecomDto,
    browserNonce: string | null,
    auditMeta: AuditMeta,
  ): Promise<AppMeWecomDto> {
    // ① 原子消费 bind_self state + 浏览器关联 nonce(B1);subjectUserId 必须等于当前登录用户。
    // 后半句是"拿别人的 state 绑自己"的执行位 —— 消费成功也要再核归属。
    // browserNonce 来自 `__Host-` Cookie,由 controller 读出后显式传进来
    // (service 不碰 Request —— 沿本仓 AuditMeta 显式传参的同一条纪律)。
    const attempt = await this.attempts.consumeState({
      state: dto.state,
      purpose: WECOM_ATTEMPT_PURPOSE.BIND_SELF,
      browserNonce,
    });
    if (attempt === null || attempt.subjectUserId !== currentUser.id) {
      if (attempt !== null) await this.attempts.markFailed(attempt.id);
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }

    // ② code 长度校验 + **事务外**换身份(§9.5:Provider 调用不持 DB 事务)
    if (!isAcceptableWecomOAuthCode(dto.code)) {
      await this.attempts.markFailed(attempt.id);
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }
    const { provider, corpId } = await this.wecom.resolveLoginContext();
    let wecomUserId: string;
    try {
      ({ wecomUserId } = await this.wecom.exchangeOAuthCode(provider, dto.code));
    } catch (err) {
      await this.attempts.markFailed(attempt.id);
      throw err;
    }

    // ③ 锁外预验 proof(fail fast:proof 不对就别去争 settings / User 行锁)。
    // 权威判据在 ④ 锁后重算 —— 这里过了不代表最终能过。
    const preview = await this.loadUserWithWecomIdentity(currentUser.id);
    if (preview === null) {
      await this.attempts.markFailed(attempt.id);
      throw new BizException(BizCode.USER_NOT_FOUND);
    }
    this.identityStepUp.verifyProof(
      dto.stepUpToken,
      preview.user,
      StepUpAction.WECOM_BIND,
      preview.binding,
    );

    // ④ 绑定事务(锁序 §9.1:settings → User → identity → attempt → refresh / audit)
    const result = await this.runRebindTransaction({
      userId: currentUser.id,
      actorRole: currentUser.role,
      corpId,
      wecomUserId,
      stepUpToken: dto.stepUpToken,
      auditMeta,
    });
    await this.attempts.markCompleted(attempt.id);

    // ⑤ 出参一律掩码;不回显 corpId / attempt id / code / state
    return result;
  }

  /**
   * DELETE /api/admin/v1/users/:id/wecom(§6.4)。
   *
   * 冻结语义逐条:
   * - 目标必须是**未软删** User(软删统一 USER_NOT_FOUND,沿 soft-delete-transactions §10)
   * - 无 active 身份 → **幂等 200 且不写 Audit**(空转不该在审计流里制造噪音)
   * - 实际清除:User FOR UPDATE → active identity → revoked → 撤 refresh → Audit
   * - 不返回完整企业微信 UserId(before 只记掩码)
   * - **不允许**通过本接口把身份直接转移给另一 User —— 本方法根本没有"目标 User"这个入参,
   *   转移只能是"清除 + 对方重新走一遍绑定流程",这是 D-WC-9 想要的形状。
   */
  async clearUserWecom(
    currentUser: CurrentUserPayload,
    id: string,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    if (!(await this.rbac.can(currentUser, 'user.wecom.clear'))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const target = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!target) throw new BizException(BizCode.USER_NOT_FOUND);
    this.assertCanManageUser(currentUser, target);

    return this.prisma.$transaction(async (tx) => {
      // 锁序 §9.4:**先锁 User 再看 identity**,与登录路径同向。
      // 反过来(先锁 identity 再锁 User)就是死锁环 —— 冻结稿点名禁止。
      if (!(await lockAuthSessionUser(tx, id))) {
        throw new BizException(BizCode.USER_NOT_FOUND);
      }
      const lockedTarget = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!lockedTarget) throw new BizException(BizCode.USER_NOT_FOUND);
      // 锁后重判权:等锁期间目标角色可能被改(例如提到 SUPER_ADMIN)
      this.assertCanManageUser(currentUser, lockedTarget);

      // T4(2026-08-02):撤销动作走共享原语 —— 与 softDelete / reopenAccount 同一段代码
      // (D-WC-10 三个落点不得各写一套)。本方法自身的行为与 Audit 逐字不变。
      const now = new Date();
      const revocation = await revokeActiveWecomIdentityInTx(tx, {
        userId: id,
        revokedByUserId: currentUser.id,
        revokedAt: now,
      });
      if (revocation.count === 0) {
        // 幂等空转:不写 Audit、不撤 refresh(什么都没变,撤 refresh 会误伤在线会话)
        return tx.user.findUniqueOrThrow({ where: { id }, select: userSafeSelect });
      }

      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'admin-wecom-identity-change' },
      });

      await this.auditLogs.log({
        event: 'wecom.clear.by-admin',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        // §11.3:clear 的 before **只允许掩码身份**
        before: { wecomUserId: maskWecomUserId(revocation.revoked[0].wecomUserId) },
        tx,
      });

      return tx.user.findUniqueOrThrow({ where: { id }, select: userSafeSelect });
    });
  }

  // ===== internals =====

  /**
   * 换绑事务(§6.3 步骤 ④ 逐条)。
   *
   * 与 auth/login-wecom.service.ts 的 `runBindTransaction` 是**姊妹方法**:
   * 锁序、occupancy 判据、revoke+create 两步、refresh 撤销、Audit 形状全部对齐,
   * 差别只在"用什么证明账号控制权"(那边 SMS 码,这边 step-up proof)
   * 与 viaPath / bindingSource 的取值。改一边必须同时翻另一边。
   */
  private async runRebindTransaction(input: {
    userId: string;
    actorRole: CurrentUserPayload['role'];
    corpId: string;
    wecomUserId: string;
    stepUpToken: string;
    auditMeta: AuditMeta;
  }): Promise<AppMeWecomDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1) settings FOR SHARE —— 与 PATCH settings 的 FOR UPDATE 互斥(§9.2)。
        // 开关同样在锁后复判:锁外 resolveLoginContext 读到的开关,在拿到锁那一刻
        // 可能已被 PATCH 关掉(与 auth/login-wecom.service 的同位判据对齐)。
        const settingsRows = await tx.$queryRaw<
          Array<{ id: string; corpId: string | null; enabled: boolean; loginEnabled: boolean }>
        >(
          Prisma.sql`SELECT "id", "corpId", "enabled", "loginEnabled"
                     FROM "wecom_settings" LIMIT 1 FOR SHARE`,
        );
        const settings = settingsRows[0];
        if (!settings || !settings.enabled || !settings.loginEnabled) {
          throw new BizException(BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
        }
        if (settings.corpId === null || settings.corpId !== input.corpId) {
          throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
        }

        // 2) User FOR UPDATE —— 会话链路唯一串行化点
        if (!(await lockAuthSessionUser(tx, input.userId))) {
          throw new BizException(BizCode.USER_NOT_FOUND);
        }
        const locked = await this.loadUserWithWecomIdentity(input.userId, tx);
        if (locked === null) {
          throw new BizException(BizCode.USER_NOT_FOUND);
        }

        // 3) **锁后重算** action-bound snapshot 并二次验证 proof(§7.4 末句)。
        // 这一步就是 §7.4 要挡的攻击的执行位:管理员刚清除绑定 ⇒ 锁后 identity 变成 null
        // ⇒ 指纹变了 ⇒ 5 分钟内签发的旧 proof 当场失效,绑不回来。
        this.identityStepUp.verifyProof(
          input.stepUpToken,
          locked.user,
          StepUpAction.WECOM_BIND,
          locked.binding,
        );

        const current = locked.binding.identity;

        // 4) 同目标 no-op:已绑同一个企业微信号 → 不重写、不撤 refresh、不写变更 audit
        if (current !== null && current.wecomUserId === input.wecomUserId) {
          return {
            bound: true,
            wecomUserIdMasked: maskWecomUserId(current.wecomUserId),
            boundAt: locked.boundAt,
          };
        }

        // 5) target occupancy(锁后权威判据)。§9.3:不跨用户锁目标 User,
        // 最终正确性由 active partial unique 兜底,P2002 在 catch 里映射 36002。
        const occupied = await tx.wecomIdentity.findFirst({
          where: {
            corpId: input.corpId,
            wecomUserId: input.wecomUserId,
            status: WECOM_IDENTITY_STATUS.ACTIVE,
            revokedAt: null,
          },
          select: { userId: true },
        });
        if (occupied !== null && occupied.userId !== input.userId) {
          throw new BizException(BizCode.WECOM_IDENTITY_ALREADY_BOUND);
        }

        // 6) 结束旧身份 + 建新身份(必须同事务,否则中途撞 user_active_unique)
        const now = new Date();
        if (current !== null) {
          await tx.wecomIdentity.update({
            where: { id: current.id },
            data: {
              status: WECOM_IDENTITY_STATUS.REVOKED,
              revokedAt: now,
              revokedByUserId: input.userId,
            },
            select: { id: true },
          });
        }
        await tx.wecomIdentity.create({
          data: {
            userId: input.userId,
            corpId: input.corpId,
            wecomUserId: input.wecomUserId,
            status: WECOM_IDENTITY_STATUS.ACTIVE,
            bindingSource: WECOM_BINDING_SOURCE.ME,
            boundAt: now,
          },
          select: { id: true },
        });

        // 6.5) 身份代际 +1(B2)。走到这里必是**真实变更**(同目标 no-op 已在 4) 返回),
        // 与撤销侧的 `revokeActiveWecomIdentityInTx` 对称;两侧合起来,
        // "身份状态发生过任何变化"这件事就再也回不到起点。
        await tx.user.update({
          where: { id: input.userId },
          data: { wecomIdentityVersion: { increment: 1 } },
          select: { id: true },
        });

        // 7) 撤销全部活跃未过期 refresh。
        // access token 沿 P0-E D-4 **不主动吊销**,按 15 分钟自然到期(§6.3 末段)。
        await tx.refreshToken.updateMany({
          where: { userId: input.userId, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now, revokedReason: 'self-wecom-identity-change' },
        });

        // 8) Audit:before/after 只允许掩码身份;extra 恰好 viaPath(§11.3)
        await this.auditLogs.log({
          event: current === null ? 'wecom.bind.self' : 'wecom.rebind.self',
          actorUserId: input.userId,
          actorRoleSnap: input.actorRole,
          resourceType: 'user',
          resourceId: input.userId,
          meta: input.auditMeta,
          ...(current === null
            ? {}
            : { before: { wecomUserId: maskWecomUserId(current.wecomUserId) } }),
          after: { wecomUserId: maskWecomUserId(input.wecomUserId) },
          extra: { viaPath: WECOM_BINDING_SOURCE.ME },
          tx,
        });

        return {
          bound: true,
          wecomUserIdMasked: maskWecomUserId(input.wecomUserId),
          boundAt: now,
        };
      });
    } catch (err) {
      if (isWecomIdentityUniqueViolation(err)) {
        throw new BizException(BizCode.WECOM_IDENTITY_ALREADY_BOUND);
      }
      throw err;
    }
  }

  /**
   * 读 User credential snapshot + 企业微信绑定快照(代际 + 当前 active 身份指纹)。
   *
   * 传 `tx` 时读的是**锁后**事实,不传时是锁外预检。两者用同一段代码,
   * 免得出现"预检算的指纹"和"终检算的指纹"字段集不一致这种最难查的错。
   *
   * ⚠️ 代际(B2)与 User 行**同一次 select** 取回,不另发查询:
   * 分两次读会在两次之间留一个"代际已变、身份还没读"的窗口,
   * 而这个窗口正好是本刀要关的那类问题。
   */
  private async loadUserWithWecomIdentity(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    user: {
      id: string;
      passwordHash: string;
      phone: string | null;
      phoneVerifiedAt: Date | null;
      openid: string | null;
      status: UserStatus;
      deletedAt: Date | null;
    };
    binding: StepUpWecomBindingSnapshotInput;
    boundAt: Date | null;
  } | null> {
    const client = tx ?? this.prisma;
    const row = await client.user.findFirst({
      where: { id: userId, deletedAt: null, status: UserStatus.ACTIVE },
      select: {
        id: true,
        passwordHash: true,
        phone: true,
        phoneVerifiedAt: true,
        openid: true,
        status: true,
        deletedAt: true,
        wecomIdentityVersion: true,
      },
    });
    if (row === null) return null;

    // 代际不进 credential snapshot(那个算法逐字节冻结);拆出来只喂 WECOM_BIND 分支。
    const { wecomIdentityVersion, ...user } = row;

    const identity = await client.wecomIdentity.findFirst({
      where: { userId, status: WECOM_IDENTITY_STATUS.ACTIVE, revokedAt: null },
      select: {
        id: true,
        corpId: true,
        wecomUserId: true,
        status: true,
        updatedAt: true,
        boundAt: true,
      },
    });
    if (identity === null) {
      return {
        user,
        binding: { identityVersion: wecomIdentityVersion, identity: null },
        boundAt: null,
      };
    }

    const { boundAt, ...fingerprint } = identity;
    const snapshot: StepUpWecomIdentitySnapshotInput = fingerprint;
    return {
      user,
      binding: { identityVersion: wecomIdentityVersion, identity: snapshot },
      boundAt,
    };
  }

  // 两层校验的第二层(沿 users.service.ts 同名 helper 的字面范式):
  // rbac.can 已过之后,再按当前 / 目标角色跑 users.policy 的判定。
  // 复用 policy 函数而不是复制判定逻辑 —— 角色矩阵只能有一个真相源。
  private assertCanManageUser(
    currentUser: CurrentUserPayload,
    targetUser: { role: CurrentUserPayload['role'] },
  ): void {
    if (!canManageUser(currentUser.role, targetUser.role)) {
      throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
    }
  }
}

/**
 * P2002 是否来自 `wecom_identities` 的两条 partial unique(§9.3)。
 *
 * 与 auth/login-wecom.service.ts 的同名函数逐字相同 —— 两处各持一份是刻意的:
 * 它是**错误映射**而不是业务规则,跨模块 import 一个私有 helper 会让
 * auth ↔ users 之间凭空多出一条只为省十行的依赖边。
 * 判据本身由两边的 e2e 各自钉住(裸 500 会当场红)。
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

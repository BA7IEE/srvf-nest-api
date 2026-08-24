/**
 * 角色权限集变更的二次验证 proof —— **本域自己签、自己验**(P1-32 PR 5;冻结稿 §12.2)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 为什么这条 proof 不复用 `auth/identity-step-up.service.ts` 的签名快照,
 *    又为什么落在 `src/common/` 而不是 `permissions/` 或 `auth/`
 *
 * 签发方在 `auth`(identity-org),验签方在 `permissions`(platform-access)。
 * 两边都要够得着同一份实现,而**任一方向的模块间 import 都被架构闸挡住**(逐条实测):
 *
 *   · `permissions → auth`:`allowedEdges` 里 **`platform-access → identity-org` 一条都没有**
 *     ⇒ `cross-domain-import`;
 *   · `auth → permissions`:方向虽是 `confirmed: true` 的允许边,但域图上
 *     `platform-access → participation → identity-org` 已经存在
 *     ⇒ 这条边**闭合一个环**,报 `cross-domain-cycle`。
 *
 *   两种都会触 `docs:boundaries:newdebt:check` 的「禁新增代码债」棘轮(v4 §6 元规则),
 *   而基线是 selfGuard 红区 + set-monotonic,登记不进去。
 *
 * ⇒ 落在 `src/common/` —— 它是**域中立**的技术横切层(实测:`auth` 与 `permissions`
 *   现有的 `src/common/**` import 一条 finding 都不产生)。本文件零 DB、零业务表知识、
 *   零模块 import,`commonGovernance` 的五类检查逐条为 0。
 *
 * ⚠️ 「域中立」不等于「没有归属」:这段代码的**语义归属是 platform-access**
 *   (它绑的是 roleId / permissionRevision / 权限码集合)。放这里是**可达性**的要求,
 *   不是把它变成了公共设施 —— 别往里加与角色权限集无关的东西。
 *   执行位:`scripts/check-role-permission-impact.ts` 的 `proof-file-single-purpose`
 *   要求本文件**每一个导出符号**都以 `ROLE_PERMISSION_` / `RolePermission` 开头。
 *   ⚠️ 它挡的是**漂移**,挡不住蓄意规避(把不相关的东西改名成 `RolePermissionXxx`);
 *   也挡不住「另建 `src/common/security/foo.ts`」—— 那是新文件的归属问题,归 commonGovernance。
 *
 * 🔴 **这不是「同一件事的第二份实现」,是两个不同的 proof 族**:
 *
 *   · **身份绑定 proof**(`PHONE_BIND` / `WECHAT_BIND` / `WECOM_BIND`,auth 拥有)
 *     绑的是**凭证快照 + 企微身份代际** —— 那些是 identity-org 的事实;
 *   · **配置变更 proof**(本文件,platform-access 拥有)
 *     绑的是 **(roleId, expectedRevision, payloadHash)** —— 那些是 platform-access 的事实。
 *
 *   两族各有各的 **HKDF 盐 / info 域**与 **audience**,⇒ **没有任何需要保持同步的东西**
 *   (「不是第二份真相」的判据是这个,不是「我抄的时候小心一点」)。
 *   ⭐ 而且两族在**结构上互相冒充不了**:audience 与密钥域都不同,一族的 token 拿到另一族
 *   连签名都过不了 —— 比「靠 `action` 字段区分」强一档。
 *   执行位:`scripts/check-role-permission-impact.ts` 的 `proof-family-isolation` 规则
 *   拿两族真实签发的 token 互验,任一侧能冒充即红。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **本 proof 不绑凭证快照**,这是**去掉一层假保证**而不是削弱(实测三条读数):
 *
 *   · `users.service.ts` 改密码时吊销的是 **refresh token**(写 `revokedAt` /
 *     `revokedReason='self-password-…'`);
 *   · JWT 策略每请求查库,只校验 `deletedAt === null && status === ACTIVE`;
 *   · `JWT_EXPIRES_IN = 15m`,access token **无状态**。
 *
 *   ⇒ 「改密码即刻踢人」这条保证**在这条链上本来就不存在**:已签发的 access token
 *   照活 15 分钟。给 proof 绑凭证快照只会让一条不存在的保证**看起来存在** ——
 *   而假保证比没有保证更危险,因为它会被人当成真的。
 *   ⚠️ 残余风险如实登记(changelog / DTO 描述 / handoff 三处):改密码后 5 分钟内,
 *   在途的配置变更 proof 仍然有效。挡住它的是 TTL 与五元组绑定,不是凭证快照。
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';

/**
 * 🔴 下面四个常量是**族隔离**的落点 —— 与 `auth/identity-step-up.service.ts` 的同名概念
 *    **必须逐字不同**。改动前先想清楚:两族共用任一个,就等于让一族的 proof 能冒充另一族。
 */
export const ROLE_PERMISSION_STEP_UP_AUDIENCE = 'srvf.role-permission-step-up';
export const ROLE_PERMISSION_STEP_UP_HKDF_SALT = 'srvf.role-permission-step-up.hkdf-salt.v1';
export const ROLE_PERMISSION_STEP_UP_SIGNING_INFO = 'srvf.role-permission-step-up.signing.v1';
export const ROLE_PERMISSION_STEP_UP_SNAPSHOT_INFO = 'srvf.role-permission-step-up.snapshot.v1';

/** proof 有效期。与身份绑定族同为 5 分钟 —— 这一项相同不构成冒充风险(它不进签名域)。 */
export const ROLE_PERMISSION_STEP_UP_TTL_SECONDS = 300;

/** 本族 proof 的 action 名。冻结稿 §12.2 逐字。 */
export const ROLE_PERMISSION_STEP_UP_ACTION = 'RBAC_ROLE_PERMISSION_SET_REPLACE';

/**
 * proof 绑定的三元组(冻结稿 §12.2)。
 *
 * 🔴 **三项各自单独进签名快照,不许合并、不许省略。** 冻结稿 §12.2 标题逐字是
 *    「**Proof 必须绑定具体变更**」,并点名三种滥用:
 *      · 为角色 A 申请的 proof 用到角色 B          ⇒ `roleId`
 *      · revision 变化后复用                        ⇒ `expectedRevision`
 *      · 为低风险差异申请的 proof 换成高风险 payload ⇒ `payloadHash`
 *    做成**必填对象**而不是三个可选参数:可选参数漏传就静默退回旧语义,
 *    而"漏传"恰好等于把刚挡住的那条复用路重新打开。
 */
export interface RolePermissionSetStepUpBinding {
  readonly roleId: string;
  readonly expectedRevision: number;
  readonly payloadHash: string;
}

interface RolePermissionStepUpPayload {
  sub: string;
  action: string;
  snapshot: string;
  aud: string | string[];
  iat: number;
  exp: number;
}

@Injectable()
export class RolePermissionStepUpProofService {
  private readonly signingKey: Buffer;
  private readonly snapshotKey: Buffer;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const jwtCfg = config.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }
    // 两把域分离密钥:签名域与快照域分开,拿到一把推不出另一把。
    this.signingKey = this.deriveKey(jwtCfg.secret, ROLE_PERMISSION_STEP_UP_SIGNING_INFO);
    this.snapshotKey = this.deriveKey(jwtCfg.secret, ROLE_PERMISSION_STEP_UP_SNAPSHOT_INFO);
  }

  /**
   * 签发一条绑定到某次具体变更的 proof。
   *
   * ⚠️ **调用方必须先证明身份** —— 本方法不验任何因子,它只负责"把已经证明过的事实签下来"。
   *    今天唯一的调用方是 `auth` 的 step-up 端点(验完密码 / 短信 / 微信之后)。
   *    别在业务路径上直接调它,那等于自己给自己发 proof。
   */
  issue(
    userId: string,
    binding: RolePermissionSetStepUpBinding,
  ): { stepUpToken: string; expiresAt: string } {
    const stepUpToken = this.jwt.sign(
      {
        sub: userId,
        action: ROLE_PERMISSION_STEP_UP_ACTION,
        snapshot: this.snapshot(userId, binding),
      },
      {
        secret: this.signingKey,
        audience: ROLE_PERMISSION_STEP_UP_AUDIENCE,
        expiresIn: ROLE_PERMISSION_STEP_UP_TTL_SECONDS,
      },
    );
    const decoded = this.jwt.decode<{ exp: number }>(stepUpToken);
    return { stepUpToken, expiresAt: new Date(decoded.exp * 1000).toISOString() };
  }

  /**
   * 校验一条 proof 是否**正是为这次变更**签发的。
   *
   * 不通过一律 `BizException(STEP_UP_PROOF_INVALID)`(10008):签名错 / 过期 /
   * audience 不符 / 换了角色 / 换了版本号 / 换了权限码集合,对调用方是同一件事
   * (重新做一次二次验证),细分只会多一条侧信道。
   */
  verify(userId: string, stepUpToken: string, binding: RolePermissionSetStepUpBinding): void {
    try {
      const payload = this.jwt.verify<RolePermissionStepUpPayload>(stepUpToken, {
        secret: this.signingKey,
        audience: ROLE_PERMISSION_STEP_UP_AUDIENCE,
      });
      if (
        payload.sub !== userId ||
        payload.action !== ROLE_PERMISSION_STEP_UP_ACTION ||
        !this.safeEqual(payload.snapshot, this.snapshot(userId, binding))
      ) {
        throw new Error('role-permission step-up proof binding mismatch');
      }
    } catch {
      throw new BizException(BizCode.STEP_UP_PROOF_INVALID);
    }
  }

  /**
   * 绑定快照 = HMAC(snapshotKey, `[userId, roleId, expectedRevision, payloadHash]`)。
   *
   * 🔴 **用 JSON 数组而不是拼串**:`'a'+1+'b'` 与 `'a1'+'b'` 会撞成同一个串,
   *    那样"换角色"和"改 revision"就可能算出同一个快照 —— 三条维度之间的隔离没了。
   */
  private snapshot(userId: string, binding: RolePermissionSetStepUpBinding): string {
    const canonical = JSON.stringify([
      userId,
      binding.roleId,
      binding.expectedRevision,
      binding.payloadHash,
    ]);
    return createHmac('sha256', this.snapshotKey).update(canonical).digest('base64url');
  }

  private deriveKey(secret: string, info: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from(ROLE_PERMISSION_STEP_UP_HKDF_SALT, 'utf8'),
        Buffer.from(info, 'utf8'),
        32,
      ),
    );
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, SmsPurpose, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { SMS_CODE_TTL_SECONDS } from '../sms/sms.constants';
import { WechatService } from '../wechat/wechat.service';
import { WECOM_IDENTITY_STATUS } from '../wecom/wecom.types';
import { StepUpAction } from './auth.dto';
import type {
  StepUpPasswordDto,
  StepUpResponseDto,
  StepUpSmsDto,
  StepUpWechatDto,
} from './auth.dto';

const STEP_UP_TTL_SECONDS = 300;
const STEP_UP_AUDIENCE = 'srvf.identity-step-up';
const STEP_UP_HKDF_SALT = 'srvf.identity-step-up.hkdf-salt.v1';
const STEP_UP_SIGNING_INFO = 'srvf.identity-step-up.signing.v1';
const STEP_UP_SNAPSHOT_INFO = 'srvf.identity-step-up.snapshot.v1';

export enum IdentityStepUpFactor {
  PASSWORD = 'PASSWORD',
  SMS = 'SMS',
  WECHAT = 'WECHAT',
}

export interface StepUpCredentialSnapshotInput {
  id: string;
  passwordHash: string;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  openid: string | null;
  status: UserStatus;
  deletedAt: Date | null;
}

/**
 * 企业微信身份指纹的输入(冻结稿 §7.4;T3 2026-08-02)。
 *
 * 只有 `action=WECOM_BIND` 的 proof 才把它拌进 snapshot。**原值不进 token** ——
 * token 里只有 HMAC 结果,corpId / wecomUserId 都取不回来。
 */
export interface StepUpWecomIdentitySnapshotInput {
  id: string;
  corpId: string;
  wecomUserId: string;
  status: string;
  updatedAt: Date;
}

/**
 * `WECOM_BIND` proof 的完整企业微信输入(P1-27 第一刀 B2,2026-08-03)。
 *
 * 为什么必须是「代际 + 当前身份」两件套,而不是只有身份:
 * 只看身份时,**无绑定态的指纹是字面 `null`** —— `null → bind → admin clear → null`
 * 走完之后指纹又变回 `null`,无绑定态签的旧 proof 在 5 分钟 TTL 内**复活**
 * (取证探针在未修代码上实测:clear 之后拿旧 proof 再绑,HTTP 200)。
 * 这是典型 ABA:用「状态值相等」当判据,而状态值本身会回到起点。
 * `identityVersion` 单调递增,回不去,于是判据变成"世界还是不是当初那个世界"。
 *
 * 为什么把两者绑成一个入参而不是加第五个可选参数:可选参数漏传就静默退回旧语义,
 * 而漏传恰好等于"把刚修好的洞重新打开"。绑成一个必填对象,漏传是**编译错误**。
 */
export interface StepUpWecomBindingSnapshotInput {
  identityVersion: number;
  identity: StepUpWecomIdentitySnapshotInput | null;
}

type StepUpUserRow = StepUpCredentialSnapshotInput & {
  role: Role;
  wecomIdentityVersion: number;
};

interface StepUpProofPayload {
  sub: string;
  action: StepUpAction;
  factor: IdentityStepUpFactor;
  snapshot: string;
  aud: string | string[];
  iat: number;
  exp: number;
}

@Injectable()
export class IdentityStepUpService {
  private readonly signingKey: Buffer;
  private readonly snapshotKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly smsCode: SmsCodeService,
    private readonly wechat: WechatService,
    private readonly auditLogs: AuditLogsService,
    config: ConfigService,
  ) {
    const jwtCfg = config.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }
    this.signingKey = this.deriveKey(jwtCfg.secret, STEP_UP_SIGNING_INFO);
    this.snapshotKey = this.deriveKey(jwtCfg.secret, STEP_UP_SNAPSHOT_INFO);
  }

  async stepUpWithPassword(
    currentUser: CurrentUserPayload,
    dto: StepUpPasswordDto,
    meta: AuditMeta,
  ): Promise<StepUpResponseDto> {
    const user = await this.loadActiveUser(currentUser.id);
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new BizException(BizCode.STEP_UP_PROOF_INVALID);
    }
    return this.issueProof(user, dto.action, IdentityStepUpFactor.PASSWORD, meta);
  }

  async sendSmsCode(
    currentUser: CurrentUserPayload,
    _action: StepUpAction,
    ip: string | null,
  ): Promise<{ expiresInSeconds: number }> {
    const user = await this.loadActiveUser(currentUser.id);
    if (user.phone === null) {
      throw new BizException(BizCode.STEP_UP_FACTOR_UNAVAILABLE);
    }
    await this.smsCode.issue({
      phone: user.phone,
      purpose: SmsPurpose.IDENTITY_STEP_UP,
      userId: user.id,
      ip,
    });
    return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
  }

  async stepUpWithSms(
    currentUser: CurrentUserPayload,
    dto: StepUpSmsDto,
    meta: AuditMeta,
  ): Promise<StepUpResponseDto> {
    const user = await this.loadActiveUser(currentUser.id);
    if (user.phone === null) {
      throw new BizException(BizCode.STEP_UP_FACTOR_UNAVAILABLE);
    }
    await this.smsCode.verifyAndConsume({
      phone: user.phone,
      purpose: SmsPurpose.IDENTITY_STEP_UP,
      code: dto.code,
      userId: user.id,
    });
    return this.issueProof(user, dto.action, IdentityStepUpFactor.SMS, meta);
  }

  async stepUpWithWechat(
    currentUser: CurrentUserPayload,
    dto: StepUpWechatDto,
    meta: AuditMeta,
  ): Promise<StepUpResponseDto> {
    const user = await this.loadActiveUser(currentUser.id);
    if (user.openid === null) {
      throw new BizException(BizCode.STEP_UP_FACTOR_UNAVAILABLE);
    }
    const { openid } = await this.wechat.code2session(dto.code);
    if (openid !== user.openid) {
      throw new BizException(BizCode.WECHAT_CODE_INVALID);
    }
    return this.issueProof(user, dto.action, IdentityStepUpFactor.WECHAT, meta);
  }

  /**
   * 校验 action-bound proof。
   *
   * `wecomBinding` 仅在 `expectedAction=WECOM_BIND` 时参与判据(冻结稿 §7.4 + B2);
   * 其余 action 传不传都不影响结果 —— 见 `computeActionSnapshot` 的早返回。
   * 但 `WECOM_BIND` **必须**传:传 null 视为调用方漏传,统一 10008 拒掉
   * (不能默默按"无绑定"处理 —— 那正好是 B2 修掉的那条回环)。
   *
   * ⚠️ 调用方必须传**锁后重读**的快照,不能传锁前的:§7.4 要防的正是
   * "admin 刚清除绑定,旧 proof 在 5 分钟内又把身份绑回来",而锁前快照恰好是
   * 清除发生之前的那一份。代际列同理,必须与身份行在同一次锁后读里取。
   */
  verifyProof(
    stepUpToken: string,
    user: StepUpCredentialSnapshotInput,
    expectedAction: StepUpAction,
    wecomBinding: StepUpWecomBindingSnapshotInput | null = null,
  ): void {
    try {
      const payload = this.jwt.verify<StepUpProofPayload>(stepUpToken, {
        secret: this.signingKey,
        audience: STEP_UP_AUDIENCE,
      });
      const factorValid = Object.values(IdentityStepUpFactor).includes(payload.factor);
      const actualSnapshot = this.computeActionSnapshot(user, expectedAction, wecomBinding);
      if (
        payload.sub !== user.id ||
        payload.action !== expectedAction ||
        !factorValid ||
        !this.safeEqual(payload.snapshot, actualSnapshot)
      ) {
        throw new Error('step-up proof binding mismatch');
      }
    } catch {
      throw new BizException(BizCode.STEP_UP_PROOF_INVALID);
    }
  }

  // ⚠️ 本方法**逐字节冻结**:PHONE_BIND / WECHAT_BIND 的 proof 算法不因企业微信而变
  // (冻结稿 §7.4「其他 PHONE_BIND/WECHAT_BIND snapshot 算法保持逐字不变」)。
  // 要给某个 action 加料,加在 computeActionSnapshot 里,不要动这里。
  computeCredentialSnapshot(user: StepUpCredentialSnapshotInput): string {
    const canonical = JSON.stringify([
      user.id,
      user.passwordHash,
      user.phone,
      user.phoneVerifiedAt?.toISOString() ?? null,
      user.openid,
      user.status,
      user.deletedAt?.toISOString() ?? null,
    ]);
    return createHmac('sha256', this.snapshotKey).update(canonical).digest('base64url');
  }

  /**
   * action-bound snapshot(冻结稿 §7.4)。
   *
   * 非 WECOM_BIND:**原样返回** `computeCredentialSnapshot` —— 早返回是"其他 action
   * 算法零变化"的执行位,不是优化。删掉它,既有 proof 会在部署瞬间全部失效。
   *
   * WECOM_BIND:把**身份代际 + 当前 active 身份指纹**一起再过一次同一把 snapshot key 的 HMAC。
   *
   * 代际(`identityVersion`)是 B2 的核心:身份指纹在"无绑定"这一档恒为字面 `null`,
   * 于是 `null → bind → admin clear → null` 之后它会**回到起点**,旧 proof 复活。
   * 代际单调递增、绝不回绕,把"回到起点"这件事从状态空间里删掉了。
   *
   * 身份指纹本身保留(不是冗余):它挡的是"代际未变但身份行内容被改"这类更细的迁移,
   * 也让 §7.4 原有判据逐条不减。两者是**与**关系,任一变化都让 proof 失效。
   */
  private computeActionSnapshot(
    user: StepUpCredentialSnapshotInput,
    action: StepUpAction,
    wecomBinding: StepUpWecomBindingSnapshotInput | null,
  ): string {
    const base = this.computeCredentialSnapshot(user);
    if (action !== StepUpAction.WECOM_BIND) return base;

    // WECOM_BIND 必须拿到代际;拿不到就让它算不出可用 snapshot(调用方漏传 = 拒)。
    if (wecomBinding === null) {
      throw new Error('WECOM_BIND snapshot requires a wecom binding input');
    }

    const identity = wecomBinding.identity;
    const fingerprint = JSON.stringify([
      wecomBinding.identityVersion,
      identity === null
        ? null
        : [
            identity.id,
            identity.corpId,
            identity.wecomUserId,
            identity.status,
            identity.updatedAt.toISOString(),
          ],
    ]);
    return createHmac('sha256', this.snapshotKey)
      .update(`${base}|${fingerprint}`)
      .digest('base64url');
  }

  /**
   * 读取该 User 当前 active 企业微信身份(签发 WECOM_BIND proof 时用)。
   *
   * 这里**不加锁**:签发 proof 只是拍一张"此刻状态"的快照,真正的判据在最终
   * 绑定事务里锁后重算(§7.4 末句)。在这里加锁反而会让签发端点去争 identity 行。
   * 代际值不在这里读 —— 它就在 `loadActiveUser` 已经取回的 User 行上,
   * 多读一次只会多一个查询、还多一个不一致的机会。
   */
  private async loadActiveWecomIdentity(
    userId: string,
  ): Promise<StepUpWecomIdentitySnapshotInput | null> {
    const row = await this.prisma.wecomIdentity.findFirst({
      where: { userId, status: WECOM_IDENTITY_STATUS.ACTIVE, revokedAt: null },
      select: { id: true, corpId: true, wecomUserId: true, status: true, updatedAt: true },
    });
    return row;
  }

  private async loadActiveUser(id: string): Promise<StepUpUserRow> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null, status: UserStatus.ACTIVE },
      select: {
        id: true,
        passwordHash: true,
        phone: true,
        phoneVerifiedAt: true,
        openid: true,
        status: true,
        deletedAt: true,
        role: true,
        // B2:代际列与 credential snapshot 的七个输入同一次读回来。
        // **不进** computeCredentialSnapshot —— 那个算法逐字节冻结,
        // 代际只在 WECOM_BIND 分支参与(见 computeActionSnapshot)。
        wecomIdentityVersion: true,
      },
    });
    if (user === null) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }
    return user;
  }

  private async issueProof(
    user: StepUpUserRow,
    action: StepUpAction,
    factor: IdentityStepUpFactor,
    meta: AuditMeta,
  ): Promise<StepUpResponseDto> {
    // 仅 WECOM_BIND 需要多读一次身份行;其余 action 保持零额外查询(算法与开销都不变)
    const wecomBinding: StepUpWecomBindingSnapshotInput | null =
      action === StepUpAction.WECOM_BIND
        ? {
            identityVersion: user.wecomIdentityVersion,
            identity: await this.loadActiveWecomIdentity(user.id),
          }
        : null;

    const stepUpToken = this.jwt.sign(
      {
        sub: user.id,
        action,
        factor,
        snapshot: this.computeActionSnapshot(user, action, wecomBinding),
      },
      {
        secret: this.signingKey,
        audience: STEP_UP_AUDIENCE,
        expiresIn: STEP_UP_TTL_SECONDS,
      },
    );
    const decoded = this.jwt.decode<{ exp: number }>(stepUpToken);
    await this.auditLogs.log({
      event: 'auth.step-up',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'user',
      resourceId: user.id,
      meta,
      extra: { action, factor },
    });
    return {
      stepUpToken,
      expiresAt: new Date(decoded.exp * 1000).toISOString(),
    };
  }

  private deriveKey(secret: string, info: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from(STEP_UP_HKDF_SALT, 'utf8'),
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

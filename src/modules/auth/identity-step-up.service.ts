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
import type {
  StepUpAction,
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

type StepUpUserRow = StepUpCredentialSnapshotInput & {
  role: Role;
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

  verifyProof(
    stepUpToken: string,
    user: StepUpCredentialSnapshotInput,
    expectedAction: StepUpAction,
  ): void {
    try {
      const payload = this.jwt.verify<StepUpProofPayload>(stepUpToken, {
        secret: this.signingKey,
        audience: STEP_UP_AUDIENCE,
      });
      const factorValid = Object.values(IdentityStepUpFactor).includes(payload.factor);
      const actualSnapshot = this.computeCredentialSnapshot(user);
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
    const stepUpToken = this.jwt.sign(
      {
        sub: user.id,
        action,
        factor,
        snapshot: this.computeCredentialSnapshot(user),
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

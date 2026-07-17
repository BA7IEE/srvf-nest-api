import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, SmsPurpose, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogInput, AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { SmsCodeService } from '../sms/sms-code.service';
import type { WechatService } from '../wechat/wechat.service';
import { StepUpAction } from './auth.dto';
import {
  IdentityStepUpFactor,
  IdentityStepUpService,
  type StepUpCredentialSnapshotInput,
} from './identity-step-up.service';

jest.mock('bcryptjs');

const bcryptMock = jest.mocked(bcrypt);
const META: AuditMeta = { requestId: 'req-step-up', ip: '127.0.0.1', ua: 'jest' };
const CURRENT_USER = {
  id: 'user-1',
  username: 'alice',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function credential(overrides: Partial<StepUpCredentialSnapshotInput & { role: Role }> = {}) {
  return {
    id: 'user-1',
    passwordHash: 'hash-1',
    phone: '13800000001',
    phoneVerifiedAt: new Date('2026-07-17T00:00:00.000Z'),
    openid: 'openid-current-1',
    status: UserStatus.ACTIVE,
    deletedAt: null,
    role: Role.USER,
    ...overrides,
  };
}

function makeHarness() {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(credential()) },
  };
  const jwt = new JwtService();
  const smsCode = {
    issue: jest.fn().mockResolvedValue({ expiresInSeconds: 300 }),
    verifyAndConsume: jest.fn().mockResolvedValue({ codeId: 'code-1' }),
  };
  const wechat = {
    code2session: jest.fn().mockResolvedValue({ openid: 'openid-current-1' }),
  };
  const auditLogs = {
    log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn().mockReturnValue({ secret: 'access-secret-for-tests' }) };
  const service = new IdentityStepUpService(
    prisma as unknown as PrismaService,
    jwt,
    smsCode as unknown as SmsCodeService,
    wechat as unknown as WechatService,
    auditLogs as unknown as AuditLogsService,
    config as unknown as ConfigService,
  );
  return { prisma, jwt, smsCode, wechat, auditLogs, service };
}

function internals(service: IdentityStepUpService): { signingKey: Buffer; snapshotKey: Buffer } {
  return service as unknown as { signingKey: Buffer; snapshotKey: Buffer };
}

describe('IdentityStepUpService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bcryptMock.compare.mockResolvedValue(true as never);
  });

  it('HKDF signing/snapshot 两域均为 32 bytes 且互不相等', () => {
    const { service } = makeHarness();
    const { signingKey, snapshotKey } = internals(service);
    expect(signingKey).toHaveLength(32);
    expect(snapshotKey).toHaveLength(32);
    expect(signingKey.equals(snapshotKey)).toBe(false);
    expect(signingKey.equals(Buffer.from('access-secret-for-tests'))).toBe(false);
  });

  it('snapshot 稳定且任一冻结凭据字段变化都会失效', () => {
    const { service } = makeHarness();
    const base = credential();
    const first = service.computeCredentialSnapshot(base);
    expect(service.computeCredentialSnapshot({ ...base })).toBe(first);

    const variants = [
      { id: 'user-2' },
      { passwordHash: 'hash-2' },
      { phone: '13800000002' },
      { phoneVerifiedAt: new Date('2026-07-17T00:00:01.000Z') },
      { openid: 'openid-current-2' },
      { status: UserStatus.DISABLED },
      { deletedAt: new Date('2026-07-17T00:00:00.000Z') },
    ];
    for (const variant of variants) {
      expect(service.computeCredentialSnapshot({ ...base, ...variant })).not.toBe(first);
    }
  });

  it('password 成功签发 action-bound 300s proof，响应字段恰好两项，audit extra 恰好两项', async () => {
    const { service, jwt, auditLogs } = makeHarness();
    const result = await service.stepUpWithPassword(
      CURRENT_USER,
      { action: StepUpAction.PHONE_BIND, password: 'CurrentPass123' },
      META,
    );

    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'stepUpToken']);
    const payload = jwt.verify<Record<string, unknown>>(result.stepUpToken, {
      secret: internals(service).signingKey,
      audience: 'srvf.identity-step-up',
    });
    expect(payload).toMatchObject({
      sub: 'user-1',
      action: StepUpAction.PHONE_BIND,
      factor: IdentityStepUpFactor.PASSWORD,
      aud: 'srvf.identity-step-up',
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
    expect(new Date(result.expiresAt).getTime()).toBe((payload.exp as number) * 1000);

    const audit = auditLogs.log.mock.calls[0][0];
    expect(audit.event).toBe('auth.step-up');
    expect(audit.extra).toEqual({
      action: StepUpAction.PHONE_BIND,
      factor: IdentityStepUpFactor.PASSWORD,
    });
    expect(Object.keys(audit.extra ?? {}).sort()).toEqual(['action', 'factor']);
    expect(JSON.stringify(audit)).not.toContain('CurrentPass123');
    expect(JSON.stringify(audit)).not.toContain(result.stepUpToken);
  });

  it('password 错误统一 10008 且不写 audit', async () => {
    const { service, auditLogs } = makeHarness();
    bcryptMock.compare.mockResolvedValue(false as never);
    await expect(
      service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.PHONE_BIND, password: 'wrong' },
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.STEP_UP_PROOF_INVALID));
    expect(auditLogs.log).not.toHaveBeenCalled();
  });

  it('SMS 只向当前绑定 phone 签发/消费 IDENTITY_STEP_UP code，并签发 SMS proof', async () => {
    const { service, jwt, smsCode } = makeHarness();
    await expect(
      service.sendSmsCode(CURRENT_USER, StepUpAction.WECHAT_BIND, '127.0.0.1'),
    ).resolves.toEqual({ expiresInSeconds: 300 });
    expect(smsCode.issue).toHaveBeenCalledWith({
      phone: '13800000001',
      purpose: SmsPurpose.IDENTITY_STEP_UP,
      userId: 'user-1',
      ip: '127.0.0.1',
    });

    const result = await service.stepUpWithSms(
      CURRENT_USER,
      { action: StepUpAction.WECHAT_BIND, code: '888888' },
      META,
    );
    expect(smsCode.verifyAndConsume).toHaveBeenCalledWith({
      phone: '13800000001',
      purpose: SmsPurpose.IDENTITY_STEP_UP,
      code: '888888',
      userId: 'user-1',
    });
    expect(
      jwt.verify(result.stepUpToken, {
        secret: internals(service).signingKey,
        audience: 'srvf.identity-step-up',
      }),
    ).toMatchObject({
      action: StepUpAction.WECHAT_BIND,
      factor: IdentityStepUpFactor.SMS,
    });
  });

  it.each([
    ['SMS', { phone: null }],
    ['WECHAT', { openid: null }],
  ])('%s 当前因子不存在统一 10009', async (factor, override) => {
    const { service, prisma } = makeHarness();
    prisma.user.findFirst.mockResolvedValue(credential(override));
    const promise =
      factor === 'SMS'
        ? service.stepUpWithSms(
            CURRENT_USER,
            { action: StepUpAction.PHONE_BIND, code: '888888' },
            META,
          )
        : service.stepUpWithWechat(
            CURRENT_USER,
            { action: StepUpAction.WECHAT_BIND, code: 'wx-code' },
            META,
          );
    await expect(promise).rejects.toEqual(new BizException(BizCode.STEP_UP_FACTOR_UNAVAILABLE));
  });

  it('SMS 验证失败沿 24010 泛化且不写 step-up audit', async () => {
    const { service, smsCode, auditLogs } = makeHarness();
    smsCode.verifyAndConsume.mockRejectedValue(new BizException(BizCode.SMS_CODE_INVALID));
    await expect(
      service.stepUpWithSms(
        CURRENT_USER,
        { action: StepUpAction.PHONE_BIND, code: '000000' },
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.SMS_CODE_INVALID));
    expect(auditLogs.log).not.toHaveBeenCalled();
  });

  it('WeChat 只接受 code2session 得到的当前 openid', async () => {
    const { service, wechat, auditLogs } = makeHarness();
    wechat.code2session.mockResolvedValue({ openid: 'openid-other' });
    await expect(
      service.stepUpWithWechat(
        CURRENT_USER,
        { action: StepUpAction.WECHAT_BIND, code: 'wx-code' },
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.WECHAT_CODE_INVALID));
    expect(auditLogs.log).not.toHaveBeenCalled();
  });

  it('WeChat 当前 openid 匹配时签发 WECHAT proof', async () => {
    const { service, jwt, wechat } = makeHarness();
    const result = await service.stepUpWithWechat(
      CURRENT_USER,
      { action: StepUpAction.PHONE_BIND, code: 'wx-code' },
      META,
    );
    expect(wechat.code2session).toHaveBeenCalledWith('wx-code');
    expect(
      jwt.verify(result.stepUpToken, {
        secret: internals(service).signingKey,
        audience: 'srvf.identity-step-up',
      }),
    ).toMatchObject({
      action: StepUpAction.PHONE_BIND,
      factor: IdentityStepUpFactor.WECHAT,
    });
  });

  it('过期/错误 audience/user/action/stale snapshot 统一 10008', () => {
    const { service, jwt } = makeHarness();
    const row = credential();
    const base = {
      sub: row.id,
      action: StepUpAction.PHONE_BIND,
      factor: IdentityStepUpFactor.PASSWORD,
      snapshot: service.computeCredentialSnapshot(row),
    };
    const key = internals(service).signingKey;
    const tokens = [
      jwt.sign(base, { secret: 'wrong-signing-key', audience: 'srvf.identity-step-up' }),
      jwt.sign(base, { secret: key, audience: 'wrong-audience', expiresIn: 300 }),
      jwt.sign({ ...base, sub: 'other-user' }, { secret: key, audience: 'srvf.identity-step-up' }),
      jwt.sign(
        { ...base, action: StepUpAction.WECHAT_BIND },
        { secret: key, audience: 'srvf.identity-step-up' },
      ),
      jwt.sign({ ...base, snapshot: 'stale' }, { secret: key, audience: 'srvf.identity-step-up' }),
      jwt.sign(base, { secret: key, audience: 'srvf.identity-step-up', expiresIn: -1 }),
    ];

    for (const token of tokens) {
      expect(() => service.verifyProof(token, row, StepUpAction.PHONE_BIND)).toThrow(
        new BizException(BizCode.STEP_UP_PROOF_INVALID),
      );
    }
  });
});

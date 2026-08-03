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
  type StepUpWecomBindingSnapshotInput,
  type StepUpWecomIdentitySnapshotInput,
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

function credential(
  overrides: Partial<
    StepUpCredentialSnapshotInput & { role: Role; wecomIdentityVersion: number }
  > = {},
) {
  return {
    id: 'user-1',
    passwordHash: 'hash-1',
    phone: '13800000001',
    phoneVerifiedAt: new Date('2026-07-17T00:00:00.000Z'),
    openid: 'openid-current-1',
    status: UserStatus.ACTIVE,
    deletedAt: null,
    role: Role.USER,
    // P1-27 第一刀 B2:身份代际与 credential 七字段同一次读回;
    // 它**不**进 computeCredentialSnapshot(那个算法逐字节冻结)。
    wecomIdentityVersion: 0,
    ...overrides,
  };
}

// 企业微信接入 T3(2026-08-02;冻结稿 §7.4):WECOM_BIND 的身份指纹输入。
// 默认"当前有一条 active 身份";测"被清除"时把 findFirst 改回 null。
function wecomIdentity(overrides: Partial<StepUpWecomIdentitySnapshotInput> = {}) {
  return {
    id: 'wecom-identity-1',
    corpId: 'ww-corp-1',
    wecomUserId: 'zhangsan-0001',
    status: 'active',
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

// P1-27 第一刀 B2:`verifyProof` 的第四参现在是「代际 + 身份」两件套。
// `identity: null` 表示"当前无绑定",与"整个入参为 null"(调用方漏传)**不同** ——
// 后者必须被拒,那正是 ABA 回环重新打开的入口。
function wecomBinding(
  overrides: {
    identityVersion?: number;
    identity?: StepUpWecomIdentitySnapshotInput | null;
  } = {},
): StepUpWecomBindingSnapshotInput {
  return {
    identityVersion: overrides.identityVersion ?? 0,
    identity: overrides.identity === undefined ? wecomIdentity() : overrides.identity,
  };
}

function makeHarness() {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(credential()) },
    // T3:仅 action=WECOM_BIND 的签发路径会读它;默认无绑定(null)
    wecomIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
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

  // ===== 企业微信接入 T3(2026-08-02;冻结稿 §7.4)=====
  //
  // 这一组钉的是 §7.4 的两条:
  //   ① WECOM_BIND 的 snapshot 额外含当前 active 身份指纹
  //   ② **其他 action 的算法逐字不变** —— 这条只能靠"改身份后 proof 仍然有效"来证,
  //      光看代码里那句早返回不算判据(改掉它、只留注释,代码照样编译)。
  describe('WECOM_BIND action-bound identity fingerprint(§7.4)', () => {
    it('PHONE_BIND / WECHAT_BIND 的 proof 不受企业微信身份变化影响(算法零变化)', () => {
      const { service } = makeHarness();
      const row = credential();

      for (const action of [StepUpAction.PHONE_BIND, StepUpAction.WECHAT_BIND]) {
        const key = internals(service).signingKey;
        const token = new JwtService().sign(
          {
            sub: row.id,
            action,
            factor: IdentityStepUpFactor.PASSWORD,
            // 逐字用**旧**算法(不含任何企业微信输入)算 snapshot
            snapshot: service.computeCredentialSnapshot(row),
          },
          { secret: key, audience: 'srvf.identity-step-up', expiresIn: 300 },
        );
        // 无论传不传企业微信快照、传哪一条(含代际变化),非 WECOM_BIND 的判据都不该动
        expect(() => service.verifyProof(token, row, action)).not.toThrow();
        expect(() => service.verifyProof(token, row, action, wecomBinding())).not.toThrow();
        expect(() =>
          service.verifyProof(
            token,
            row,
            action,
            wecomBinding({ identity: wecomIdentity({ id: 'other' }) }),
          ),
        ).not.toThrow();
        expect(() =>
          service.verifyProof(token, row, action, wecomBinding({ identityVersion: 99 })),
        ).not.toThrow();
      }
    });

    it('WECOM_BIND:签发时有身份 → 身份被清除后同一 proof 失效', async () => {
      const { service, prisma } = makeHarness();
      const row = credential();
      prisma.wecomIdentity.findFirst.mockResolvedValue(wecomIdentity());

      const { stepUpToken } = await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );

      // 同一份身份 + 同一代际 → 通过
      expect(() =>
        service.verifyProof(stepUpToken, row, StepUpAction.WECOM_BIND, wecomBinding()),
      ).not.toThrow();

      // 被 admin 清除(锁后重读为 null)→ 指纹从"有"变成"无" ⇒ 拒。
      // 这正是 §7.4 的立项理由:防止管理员刚清除绑定,旧 proof 在 5 分钟内又把身份绑回来。
      // 注意这里连代际都不用改就已经拒 —— §7.4 原判据逐条保留,B2 是**叠加**不是替换。
      expect(() =>
        service.verifyProof(
          stepUpToken,
          row,
          StepUpAction.WECOM_BIND,
          wecomBinding({ identity: null }),
        ),
      ).toThrow(new BizException(BizCode.STEP_UP_PROOF_INVALID));

      // 第四参整体为 null = 调用方漏传 ⇒ 也必须拒。
      // 默默当成"无绑定"处理就等于把 B2 修掉的那条回环重新打开。
      expect(() => service.verifyProof(stepUpToken, row, StepUpAction.WECOM_BIND, null)).toThrow(
        new BizException(BizCode.STEP_UP_PROOF_INVALID),
      );
    });

    it('WECOM_BIND:指纹五个输入字段任一变化都会让 proof 失效', async () => {
      const { service, prisma } = makeHarness();
      const row = credential();
      prisma.wecomIdentity.findFirst.mockResolvedValue(wecomIdentity());

      const { stepUpToken } = await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );

      const variants: Array<Partial<StepUpWecomIdentitySnapshotInput>> = [
        { id: 'wecom-identity-2' },
        { corpId: 'ww-corp-2' },
        { wecomUserId: 'lisi-0002' },
        { status: 'revoked' },
        { updatedAt: new Date('2026-08-01T00:00:01.000Z') },
      ];
      for (const variant of variants) {
        expect(() =>
          service.verifyProof(
            stepUpToken,
            row,
            StepUpAction.WECOM_BIND,
            wecomBinding({ identity: wecomIdentity(variant) }),
          ),
        ).toThrow(new BizException(BizCode.STEP_UP_PROOF_INVALID));
      }
    });

    it('WECOM_BIND:签发时无身份 → 首绑场景下同一 proof 有效,但有了身份就失效', async () => {
      const { service, prisma } = makeHarness();
      const row = credential();
      prisma.wecomIdentity.findFirst.mockResolvedValue(null); // 无绑定

      const { stepUpToken } = await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );

      expect(() =>
        service.verifyProof(
          stepUpToken,
          row,
          StepUpAction.WECOM_BIND,
          wecomBinding({ identity: null }),
        ),
      ).not.toThrow();
      // 期间被别的请求绑上了 ⇒ 这张 proof 描述的世界已经不成立
      expect(() =>
        service.verifyProof(stepUpToken, row, StepUpAction.WECOM_BIND, wecomBinding()),
      ).toThrow(new BizException(BizCode.STEP_UP_PROOF_INVALID));
    });

    // ===== P1-27 第一刀 B2(2026-08-03):单调身份代际,专治 ABA 回环 =====
    //
    // 这条是本刀的核心判据。上面那条"签发时无身份 → 首绑仍有效"在**修复前后都绿**,
    // 因为它只走了 `null → 用` 一步;真正的洞在 `null → bind → clear → null`
    // 这个**回环**上 —— 身份指纹字面上回到了起点,而代际不会。
    it('WECOM_BIND:身份指纹回到 null,但代际已变 ⇒ 无绑定态签的旧 proof 不得复活(ABA)', async () => {
      const { service, prisma } = makeHarness();
      // 签发时:无绑定,代际 0
      prisma.user.findFirst.mockResolvedValue(credential({ wecomIdentityVersion: 0 }));
      prisma.wecomIdentity.findFirst.mockResolvedValue(null);

      const { stepUpToken } = await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );
      const row = credential();

      // 对照:世界没变(仍是"无绑定 + 代际 0")⇒ 仍然有效
      expect(() =>
        service.verifyProof(
          stepUpToken,
          row,
          StepUpAction.WECOM_BIND,
          wecomBinding({ identityVersion: 0, identity: null }),
        ),
      ).not.toThrow();

      // ABA:bind(代际 →1)后 admin clear(代际 →2),身份指纹又是 null。
      // **修复前**这一档与签发时逐字节相同 ⇒ 旧 proof 复活(e2e 实测 HTTP 200);
      // 修复后代际不同 ⇒ 10008。
      for (const identityVersion of [1, 2, 7]) {
        expect(() =>
          service.verifyProof(
            stepUpToken,
            row,
            StepUpAction.WECOM_BIND,
            wecomBinding({ identityVersion, identity: null }),
          ),
        ).toThrow(new BizException(BizCode.STEP_UP_PROOF_INVALID));
      }
    });

    it('WECOM_BIND:代际单独变化(身份行一字未动)也让 proof 失效', async () => {
      const { service, prisma } = makeHarness();
      prisma.user.findFirst.mockResolvedValue(credential({ wecomIdentityVersion: 3 }));
      prisma.wecomIdentity.findFirst.mockResolvedValue(wecomIdentity());

      const { stepUpToken } = await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );
      const row = credential();

      expect(() =>
        service.verifyProof(
          stepUpToken,
          row,
          StepUpAction.WECOM_BIND,
          wecomBinding({ identityVersion: 3 }),
        ),
      ).not.toThrow();
      expect(() =>
        service.verifyProof(
          stepUpToken,
          row,
          StepUpAction.WECOM_BIND,
          wecomBinding({ identityVersion: 4 }),
        ),
      ).toThrow(new BizException(BizCode.STEP_UP_PROOF_INVALID));
    });

    it('非 WECOM_BIND 的签发路径不读 wecom_identities(零额外查询)', async () => {
      const { service, prisma } = makeHarness();
      await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.PHONE_BIND, password: 'pw' },
        META,
      );
      expect(prisma.wecomIdentity.findFirst).not.toHaveBeenCalled();

      await service.stepUpWithPassword(
        CURRENT_USER,
        { action: StepUpAction.WECOM_BIND, password: 'pw' },
        META,
      );
      expect(prisma.wecomIdentity.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});

import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { DevStubRealnameProvider } from './providers/dev-stub.provider';
import type { TencentRealnameProvider } from './providers/tencent-realname.provider';
import type { RealnameSettingsService } from './realname-settings.service';
import { RealnameVerificationService } from './realname.service';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  RealnameCredentialStatus,
  type RealnameSettingsResolved,
  type RealnameVerifyResult,
} from './realname.types';

// 招新一期 · 实名核验通道 T2:RealnameVerificationService 单测——锁 resolve 选路 + 域错误→BizCode 映射边界。

const INPUT = { name: '张三', idCardNumber: '110101199003070012' };

function resolved(over: Partial<RealnameSettingsResolved>): RealnameSettingsResolved {
  return {
    id: 's1',
    providerType: 'DEV_STUB',
    enabled: true,
    region: null,
    credentials: null,
    credentialStatus: RealnameCredentialStatus.MISSING,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date('2026-06-18T00:00:00.000Z'),
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
    ...over,
  };
}

function makeService(opts: {
  settings: RealnameSettingsResolved | null;
  env?: string;
  devStubResult?: RealnameVerifyResult | Error;
  tencentResult?: RealnameVerifyResult | Error;
}): {
  service: RealnameVerificationService;
  devStub: jest.Mock;
  tencent: jest.Mock;
} {
  const settings = {
    getActiveSettings: jest.fn().mockResolvedValue(opts.settings),
  } as unknown as RealnameSettingsService;

  const make = (r?: RealnameVerifyResult | Error): jest.Mock =>
    jest
      .fn()
      .mockImplementation(() => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)));
  const devStub = make(opts.devStubResult);
  const tencent = make(opts.tencentResult);

  const service = new RealnameVerificationService(
    settings,
    { verify: devStub } as unknown as DevStubRealnameProvider,
    { verify: tencent } as unknown as TencentRealnameProvider,
    { env: opts.env ?? 'test' } as unknown as ConfigType<typeof appConfig>,
  );
  return { service, devStub, tencent };
}

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('RealnameVerificationService', () => {
  it('DEV_STUB → 路由 devStub,matched 透传', async () => {
    const { service, devStub, tencent } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: { matched: true },
    });
    const res = await service.verify(INPUT);
    expect(res).toEqual({ matched: true });
    expect(devStub).toHaveBeenCalledTimes(1);
    expect(tencent).not.toHaveBeenCalled();
  });

  it('DEV_STUB → mismatch 透传(matched=false 是返回值不是异常)', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: { matched: false, reason: 'x' },
    });
    expect(await service.verify(INPUT)).toEqual({ matched: false, reason: 'x' });
  });

  it('TENCENT_CLOUD → 路由 tencent', async () => {
    const { service, devStub, tencent } = makeService({
      settings: resolved({
        providerType: 'TENCENT_CLOUD',
        credentialStatus: RealnameCredentialStatus.CONFIGURED,
        credentials: { secretId: 'a', secretKey: 'b' },
      }),
      tencentResult: { matched: true },
    });
    expect(await service.verify(INPUT)).toEqual({ matched: true });
    expect(tencent).toHaveBeenCalledTimes(1);
    expect(devStub).not.toHaveBeenCalled();
  });

  it('provider 抛 RealnameChannelUnavailableError → BizException 27030', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: new RealnameChannelUnavailableError('x'),
    });
    const err = await catchErr(service.verify(INPUT));
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
  });

  it('provider 抛 RealnameApiError → BizException 27031', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: new RealnameApiError('FETCH_ERROR', 'TimeoutError'),
    });
    const err = await catchErr(service.verify(INPUT));
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz).toBe(BizCode.REALNAME_API_FAILED);
  });

  it('settings 缺失 → 27030(resolve 抛 ChannelUnavailable 映射)', async () => {
    const { service } = makeService({ settings: null });
    const err = await catchErr(service.verify(INPUT));
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
  });

  it('production-like 下 DEV_STUB → 27030(运行时第②重禁用)', async () => {
    const { service, devStub } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      env: 'production',
    });
    const err = await catchErr(service.verify(INPUT));
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
    expect(devStub).not.toHaveBeenCalled();
  });
});

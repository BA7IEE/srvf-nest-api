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
  type RealnameOcrResult,
  type RealnameSettingsResolved,
} from './realname.types';

// 招新实名环节 OCR 改造 · RealnameVerificationService 单测——锁 resolve 选路 + 域错误→BizCode 映射边界。

const INPUT = {
  documentTypeCode: 'mainland_id',
  image: Buffer.from('img'),
  mimeType: 'image/jpeg',
};
const OK: RealnameOcrResult = {
  recognized: true,
  name: '张三',
  idCardNumber: '110101199003070038',
  warnings: [],
};

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
    updatedAt: new Date('2026-06-22T00:00:00.000Z'),
    createdAt: new Date('2026-06-22T00:00:00.000Z'),
    ...over,
  };
}

function makeService(opts: {
  settings: RealnameSettingsResolved | null;
  env?: string;
  devStubResult?: RealnameOcrResult | Error;
  tencentResult?: RealnameOcrResult | Error;
}): {
  service: RealnameVerificationService;
  devStub: jest.Mock;
  tencent: jest.Mock;
} {
  const settings = {
    getActiveSettings: jest.fn().mockResolvedValue(opts.settings),
  } as unknown as RealnameSettingsService;

  const make = (
    r?: RealnameOcrResult | Error,
  ): jest.Mock<Promise<RealnameOcrResult>, [typeof INPUT]> =>
    jest
      .fn<Promise<RealnameOcrResult>, [typeof INPUT]>()
      .mockImplementation(() =>
        r instanceof Error ? Promise.reject(r) : Promise.resolve(r as RealnameOcrResult),
      );
  const devStub = make(opts.devStubResult);
  const tencent = make(opts.tencentResult);
  const prepare = jest.fn().mockImplementation(() => ({
    providerType: 'TENCENT_CLOUD',
    invoke: () => tencent(INPUT),
  }));

  const service = new RealnameVerificationService(
    settings,
    { recognize: devStub } as unknown as DevStubRealnameProvider,
    { prepare } as unknown as TencentRealnameProvider,
    { validateFromBuffer: jest.fn() } as never,
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

describe('RealnameVerificationService (OCR)', () => {
  it('DEV_STUB → 路由 devStub,结果透传', async () => {
    const { service, devStub, tencent } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: OK,
    });
    const res = await service.recognize(INPUT);
    expect(res).toEqual(OK);
    expect(devStub).toHaveBeenCalledTimes(1);
    expect(tencent).not.toHaveBeenCalled();
  });

  it('DEV_STUB → recognized:false 透传(不清晰是返回值不是异常)', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: { recognized: false, name: null, idCardNumber: null, warnings: [] },
    });
    expect((await service.recognize(INPUT)).recognized).toBe(false);
  });

  it('TENCENT_CLOUD → 路由 tencent', async () => {
    const { service, devStub, tencent } = makeService({
      settings: resolved({
        providerType: 'TENCENT_CLOUD',
        credentialStatus: RealnameCredentialStatus.CONFIGURED,
        credentials: { secretId: 'a', secretKey: 'b' },
      }),
      tencentResult: OK,
    });
    expect(await service.recognize(INPUT)).toEqual(OK);
    expect(tencent).toHaveBeenCalledTimes(1);
    expect(devStub).not.toHaveBeenCalled();
  });

  it('TENCENT_CLOUD 一次 OCR 只读一次 settings，并把同一 snapshot 交给 prepare', async () => {
    const oldSettings = resolved({
      providerType: 'TENCENT_CLOUD',
      region: 'ap-old',
      credentialStatus: RealnameCredentialStatus.CONFIGURED,
      credentials: { secretId: 'id-old', secretKey: 'key-old' },
    });
    const newSettings = resolved({
      providerType: 'TENCENT_CLOUD',
      region: 'ap-new',
      credentialStatus: RealnameCredentialStatus.CONFIGURED,
      credentials: { secretId: 'id-new', secretKey: 'key-new' },
    });
    const getActiveSettings = jest
      .fn()
      .mockResolvedValueOnce(oldSettings)
      .mockResolvedValueOnce(newSettings);
    const invoke = jest.fn().mockResolvedValue(OK);
    const prepare = jest.fn().mockReturnValue({ providerType: 'TENCENT_CLOUD', invoke });
    const service = new RealnameVerificationService(
      { getActiveSettings } as unknown as RealnameSettingsService,
      { recognize: jest.fn() } as unknown as DevStubRealnameProvider,
      { prepare } as unknown as TencentRealnameProvider,
      { validateFromBuffer: jest.fn() } as never,
      { env: 'test' } as unknown as ConfigType<typeof appConfig>,
    );

    await expect(service.recognize(INPUT)).resolves.toBe(OK);
    expect(getActiveSettings).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(oldSettings, INPUT);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('provider 抛 RealnameChannelUnavailableError → BizException 27030', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: new RealnameChannelUnavailableError('x'),
    });
    const err = await catchErr(service.recognize(INPUT));
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
  });

  it('provider 抛 RealnameApiError → BizException 27031', async () => {
    const { service } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      devStubResult: new RealnameApiError('FETCH_ERROR', 'TimeoutError'),
    });
    const err = await catchErr(service.recognize(INPUT));
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz).toBe(BizCode.REALNAME_API_FAILED);
  });

  it('settings 缺失 → 27030(resolve 抛 ChannelUnavailable 映射)', async () => {
    const { service } = makeService({ settings: null });
    const err = await catchErr(service.recognize(INPUT));
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
  });

  it('production-like 下 DEV_STUB → 27030(运行时第②重禁用)', async () => {
    const { service, devStub } = makeService({
      settings: resolved({ providerType: 'DEV_STUB' }),
      env: 'production',
    });
    const err = await catchErr(service.recognize(INPUT));
    expect((err as BizException).biz).toBe(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
    expect(devStub).not.toHaveBeenCalled();
  });
});

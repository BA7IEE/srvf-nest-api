import type { RealnameSettingsService } from '../realname-settings.service';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  RealnameCredentialStatus,
  type RealnameSettingsResolved,
} from '../realname.types';
import { TencentRealnameProvider } from './tencent-realname.provider';

// 招新一期 · 实名核验通道 T2:真实腾讯云 Provider 单测(评审稿 §8;真通道休眠 → 仅 mock fetch 锁结构)
//
// 覆盖:matched / mismatch / 腾讯云 Error 回执→27031 / HTTP 非 200→27031 / 非 JSON→27031 /
//      fetch 超时→27031 / 通道未配置→27030(RealnameChannelUnavailableError)。
// 不验真实签名值(TC3 依赖 Date,确定性签名留 e2e 之外;此处锁请求构造与结果/错误映射)。

const CONFIGURED: RealnameSettingsResolved = {
  id: 's1',
  providerType: 'TENCENT_CLOUD',
  enabled: true,
  region: 'ap-guangzhou',
  credentials: { secretId: 'AKIDexampleSecretId', secretKey: 'exampleSecretKey' },
  credentialStatus: RealnameCredentialStatus.CONFIGURED,
  remarks: null,
  updatedBy: null,
  updatedAt: new Date('2026-06-18T00:00:00.000Z'),
  createdAt: new Date('2026-06-18T00:00:00.000Z'),
};

function makeProvider(resolved: RealnameSettingsResolved | null): TencentRealnameProvider {
  const settings = {
    getActiveSettings: jest.fn().mockResolvedValue(resolved),
  } as unknown as RealnameSettingsService;
  return new TencentRealnameProvider(settings);
}

function mockFetchJson(body: unknown, init?: { ok?: boolean; status?: number }): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

const INPUT = { name: '张三', idCardNumber: '110101199003070012' };

describe('TencentRealnameProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("Result='0' → matched", async () => {
    mockFetchJson({ Response: { Result: '0', Description: '一致', RequestId: 'r1' } });
    const res = await makeProvider(CONFIGURED).verify(INPUT);
    expect(res.matched).toBe(true);
  });

  it("Result='-1' → mismatch(带 reason=Description)", async () => {
    mockFetchJson({
      Response: { Result: '-1', Description: '姓名和身份证号不一致', RequestId: 'r1' },
    });
    const res = await makeProvider(CONFIGURED).verify(INPUT);
    expect(res.matched).toBe(false);
    expect(res.reason).toBe('姓名和身份证号不一致');
  });

  it('腾讯云 Error 回执 → RealnameApiError(27031)', async () => {
    mockFetchJson({
      Response: { Error: { Code: 'AuthFailure', Message: 'bad signature' }, RequestId: 'r1' },
    });
    await expect(makeProvider(CONFIGURED).verify(INPUT)).rejects.toBeInstanceOf(RealnameApiError);
  });

  it('HTTP 非 200 → RealnameApiError', async () => {
    mockFetchJson('', { ok: false, status: 500 });
    await expect(makeProvider(CONFIGURED).verify(INPUT)).rejects.toBeInstanceOf(RealnameApiError);
  });

  it('非 JSON body → RealnameApiError', async () => {
    mockFetchJson('<html>gateway error</html>');
    await expect(makeProvider(CONFIGURED).verify(INPUT)).rejects.toBeInstanceOf(RealnameApiError);
  });

  it('缺 Response 包裹 → RealnameApiError', async () => {
    mockFetchJson({ NotResponse: {} });
    await expect(makeProvider(CONFIGURED).verify(INPUT)).rejects.toBeInstanceOf(RealnameApiError);
  });

  it('fetch 超时 / 网络错误 → RealnameApiError', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    global.fetch = jest.fn().mockRejectedValue(err);
    await expect(makeProvider(CONFIGURED).verify(INPUT)).rejects.toBeInstanceOf(RealnameApiError);
  });

  it('通道未配置(settings=null)→ RealnameChannelUnavailableError(不调 fetch)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await expect(makeProvider(null).verify(INPUT)).rejects.toBeInstanceOf(
      RealnameChannelUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('credentialStatus≠CONFIGURED → RealnameChannelUnavailableError', async () => {
    const invalid = {
      ...CONFIGURED,
      credentialStatus: RealnameCredentialStatus.INVALID,
      credentials: null,
    };
    await expect(makeProvider(invalid).verify(INPUT)).rejects.toBeInstanceOf(
      RealnameChannelUnavailableError,
    );
  });
});

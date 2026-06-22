import type { RealnameSettingsService } from '../realname-settings.service';
import {
  REALNAME_OCR_ACTION_HK_MACAU,
  REALNAME_OCR_ACTION_MAINLAND_ID,
  REALNAME_OCR_ACTION_PASSPORT,
} from '../realname.constants';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  RealnameCredentialStatus,
  type RealnameOcrInput,
  type RealnameSettingsResolved,
} from '../realname.types';
import { TencentRealnameProvider } from './tencent-realname.provider';

// 招新实名环节 OCR 改造 · 真实腾讯云 OCR Provider 单测(评审稿 §8;真通道休眠 → 仅 mock fetch 锁结构)
//
// 覆盖三 action(RecognizeValidIDCardOCR / MLIDPassportOCR / MainlandPermitOCR)成功映射 +
// recognized=false(关键字段缺/非机读)+ 防伪告警透传 + 回乡证类别 +
// 腾讯云 Error 回执→27031 / HTTP 非 200→27031 / 非 JSON→27031 / 缺 Response→27031 / 超时→27031 /
// 通道未配→27030(不调 fetch)/ 非 OCR 类型→ChannelUnavailable(不调 fetch)。
// 不验真实签名值(TC3 依赖 Date);此处锁请求构造(action header / host / version)与结果/错误映射。

const CONFIGURED: RealnameSettingsResolved = {
  id: 's1',
  providerType: 'TENCENT_CLOUD',
  enabled: true,
  region: 'ap-guangzhou',
  credentials: { secretId: 'AKIDexampleSecretId', secretKey: 'exampleSecretKey' },
  credentialStatus: RealnameCredentialStatus.CONFIGURED,
  remarks: null,
  updatedBy: null,
  updatedAt: new Date('2026-06-22T00:00:00.000Z'),
  createdAt: new Date('2026-06-22T00:00:00.000Z'),
};

function makeProvider(resolved: RealnameSettingsResolved | null): TencentRealnameProvider {
  const settings = {
    getActiveSettings: jest.fn().mockResolvedValue(resolved),
  } as unknown as RealnameSettingsService;
  return new TencentRealnameProvider(settings);
}

function mockFetchJson(body: unknown, init?: { ok?: boolean; status?: number }): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  global.fetch = fn;
  return fn;
}

function input(documentTypeCode: string): RealnameOcrInput {
  return { documentTypeCode, image: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg' };
}

describe('TencentRealnameProvider (OCR)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('mainland RecognizeValidIDCardOCR:Name+IdNum → recognized + 字段;action header 正确', async () => {
    const fn = mockFetchJson({
      Response: { Name: '张三', IdNum: '110101199003070038', WarnInfos: [], RequestId: 'r1' },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(true);
    expect(res.name).toBe('张三');
    expect(res.idCardNumber).toBe('110101199003070038');
    expect(res.warnings).toEqual([]);
    // 锁 action / version header
    const headers = ((fn.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> })
      .headers;
    expect(headers['X-TC-Action']).toBe(REALNAME_OCR_ACTION_MAINLAND_ID);
    expect(headers['X-TC-Version']).toBe('2018-11-19');
    expect(headers.Host).toBe('ocr.tencentcloudapi.com');
  });

  it('mainland 防伪告警透传(WarnInfos 非空 → warnings)', async () => {
    mockFetchJson({
      Response: { Name: '张三', IdNum: '110101199003070038', WarnInfos: [9101, 9102] },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(true);
    expect(res.warnings).toEqual(['9101', '9102']);
  });

  it('mainland 关键字段缺(无 IdNum)→ recognized:false(不清晰,非异常)', async () => {
    mockFetchJson({ Response: { Name: '张三', RequestId: 'r1' } });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(false);
  });

  it('passport MLIDPassportOCR:Name+ID → recognized;action 正确', async () => {
    const fn = mockFetchJson({ Response: { Name: 'ZHANG SAN', ID: 'E12345678', RequestId: 'r1' } });
    const res = await makeProvider(CONFIGURED).recognize(input('passport'));
    expect(res.recognized).toBe(true);
    expect(res.idCardNumber).toBe('E12345678');
    const headers = ((fn.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> })
      .headers;
    expect(headers['X-TC-Action']).toBe(REALNAME_OCR_ACTION_PASSPORT);
  });

  it('passport 非机读(无 ID)→ recognized:false', async () => {
    mockFetchJson({ Response: { Name: 'ZHANG SAN', RequestId: 'r1' } });
    const res = await makeProvider(CONFIGURED).recognize(input('passport'));
    expect(res.recognized).toBe(false);
  });

  it('hk_macau MainlandPermitOCR:Name+Number+CardType → documentCategory;action 正确', async () => {
    const fn = mockFetchJson({
      Response: {
        Name: '陈某',
        Number: 'H1234567',
        CardType: '港澳居民来往内地通行证',
        RequestId: 'r1',
      },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('hk_macau_permit'));
    expect(res.recognized).toBe(true);
    expect(res.idCardNumber).toBe('H1234567');
    expect(res.documentCategory).toBe('港澳居民来往内地通行证');
    const headers = ((fn.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> })
      .headers;
    expect(headers['X-TC-Action']).toBe(REALNAME_OCR_ACTION_HK_MACAU);
  });

  it('腾讯云 Error 回执 → RealnameApiError(27031)', async () => {
    mockFetchJson({
      Response: { Error: { Code: 'AuthFailure', Message: 'bad signature' }, RequestId: 'r1' },
    });
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
  });

  it('HTTP 非 200 → RealnameApiError', async () => {
    mockFetchJson('', { ok: false, status: 500 });
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
  });

  it('非 JSON body → RealnameApiError', async () => {
    mockFetchJson('<html>gateway error</html>');
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
  });

  it('缺 Response 包裹 → RealnameApiError', async () => {
    mockFetchJson({ NotResponse: {} });
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
  });

  it('fetch 超时 / 网络错误 → RealnameApiError', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    global.fetch = jest.fn().mockRejectedValue(err);
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
  });

  it('通道未配置(settings=null)→ RealnameChannelUnavailableError(不调 fetch)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await expect(makeProvider(null).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
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
    await expect(makeProvider(invalid).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameChannelUnavailableError,
    );
  });

  it('非 OCR 证件类型 → RealnameChannelUnavailableError(防御,不调 fetch)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await expect(
      makeProvider(CONFIGURED).recognize(input('foreigner_permit')),
    ).rejects.toBeInstanceOf(RealnameChannelUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

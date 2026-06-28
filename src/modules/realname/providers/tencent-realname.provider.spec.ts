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

// 招新实名环节 OCR 改造 · 真实腾讯云 OCR Provider 单测(评审稿 §8)
//
// mainland 用**腾讯云线上真实嵌套结构**(Response.IDCardInfo.{Name,IdNum}.Content + WarnInfos 标志位)锁定,
// 替掉旧的「顶层 Name/IdNum」循环 mock(那曾让字段映射 bug 漏网,详见 2026-06-29 修复)。
// 覆盖三 action(RecognizeValidIDCardOCR / MLIDPassportOCR / MainlandPermitOCR)成功映射 +
// recognized=false(Content 缺/非机读,真不清晰)+ IDCardInfo 容器整块缺失→契约错 27031(去混淆,不当不清晰)+
// 防伪标志收窄(复印/翻拍/PS 进防伪,质量类不进)+ 回乡证类别 +
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

  // 鉴伪版 RecognizeValidIDCardOCR 真实响应:字段嵌在 Response.IDCardInfo,每项是 { Content } 对象;
  // WarnInfos 是标志位对象(1=命中)。下列 mock 镜像线上结构(替掉旧的「顶层 Name/IdNum」循环 mock)。
  it('mainland RecognizeValidIDCardOCR:嵌套 IDCardInfo.Content → recognized + 字段;action header 正确', async () => {
    const fn = mockFetchJson({
      Response: {
        IDCardInfo: {
          Name: { Content: '张三', Confidence: 90 },
          IdNum: { Content: '110101199003070038', Confidence: 90 },
          WarnInfos: { CopyCheck: 0, ReshootCheck: 0, PSCheck: 0 },
        },
        RequestId: 'r1',
      },
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

  // OCR 鉴伪版充分利用(2026-06-29,评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §3.6/§8 D5):
  // 请求体显式带 7 Enable* 开关(仅 mainland)+ 扩展字段嵌套映射(Sex/Nation/Birth/Address/Authority/ValidDate
  // 每项 ContentInfo + 字段级 IsReflect/IsInComplete/IsKey* 标志)+ 顶层 CardImage/PortraitImage/Type 透传 +
  // 卡片级 cardWarnings 全集投影。以线上文档真实嵌套结构 mock 锁定;运维上线校正字段名。
  it('mainland 鉴伪版充分利用:请求体带 7 Enable* 开关 + 扩展字段/裁剪图/Type/cardWarnings 映射', async () => {
    const fn = mockFetchJson({
      Response: {
        IDCardInfo: {
          Name: { Content: '张三', Confidence: 99 },
          IdNum: { Content: '110101199003070038', Confidence: 99 },
          Sex: { Content: '男', IsReflect: false, IsInComplete: false },
          Nation: { Content: '汉', IsReflect: 1, IsInComplete: 0 },
          Birth: { Content: '1990/3/7' },
          Address: { Content: '北京市朝阳区某街道', IsKeyInComplete: true },
          Authority: { Content: '北京市公安局朝阳分局' },
          ValidDate: { Content: '2010.07.21-2020.07.21' },
          WarnInfos: {
            CopyCheck: 0,
            ReshootCheck: 0,
            PSCheck: 0,
            BorderCheck: 1,
            OcclusionCheck: 0,
            BlurCheck: 1,
          },
        },
        CardImage: 'base64-card-crop-bytes',
        PortraitImage: 'base64-portrait-crop-bytes',
        Type: '中华人民共和国居民身份证',
        RequestId: 'r-rich',
      },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));

    // 既有行为锁:recognized/name/idCardNumber/warnings 不受充分利用影响(BorderCheck/BlurCheck 是质量,不进 forgery)
    expect(res.recognized).toBe(true);
    expect(res.name).toBe('张三');
    expect(res.warnings).toEqual([]);

    // 请求体带 7 Enable* 开关
    const body = JSON.parse(
      ((fn.mock.calls[0] as unknown[])[1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.EnablePortrait).toBe(true);
    expect(body.EnableCropImage).toBe(true);
    expect(body.EnableBorderCheck).toBe(true);
    expect(body.EnableOcclusionCheck).toBe(true);
    expect(body.EnableCopyCheck).toBe(true);
    expect(body.EnableReshootCheck).toBe(true);
    expect(body.EnableQualityCheck).toBe(true);
    expect(typeof body.ImageBase64).toBe('string');

    // 扩展字段映射(content + 字段级 reflect/incomplete 合并 Key*)
    expect(res.extendedFields?.sex).toEqual({ content: '男', reflect: false, incomplete: false });
    expect(res.extendedFields?.nation).toEqual({ content: '汉', reflect: true, incomplete: false });
    expect(res.extendedFields?.address).toEqual({
      content: '北京市朝阳区某街道',
      reflect: false,
      incomplete: true, // IsKeyInComplete=true 合并入 incomplete
    });
    expect(res.extendedFields?.authority?.content).toBe('北京市公安局朝阳分局');
    expect(res.extendedFields?.validDate?.content).toBe('2010.07.21-2020.07.21');

    // 顶层 Type + 裁剪图 base64 透传(裁剪图仅 submit 路径消费)
    expect(res.documentType).toBe('中华人民共和国居民身份证');
    expect(res.cardImageBase64).toBe('base64-card-crop-bytes');
    expect(res.portraitImageBase64).toBe('base64-portrait-crop-bytes');

    // 卡片级告警全集(质量类 border/blur 在此结构化回显,但**不**进 warnings 防伪子集)
    expect(res.cardWarnings).toEqual({
      copy: false,
      reshoot: false,
      ps: false,
      border: true,
      occlusion: false,
      blur: true,
    });
  });

  it('mainland 不返裁剪图/扩展字段(仅 Name/IdNum)→ 裁剪图 null + 扩展字段全 null(降级不报错)', async () => {
    mockFetchJson({
      Response: {
        IDCardInfo: { Name: { Content: '张三' }, IdNum: { Content: '110101199003070038' } },
        RequestId: 'r-min',
      },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(true);
    expect(res.cardImageBase64).toBeNull();
    expect(res.portraitImageBase64).toBeNull();
    expect(res.documentType).toBeNull();
    expect(res.extendedFields?.address).toBeNull();
  });

  it('passport 请求体不带 Enable*(那 action 无鉴伪/裁剪能力;维持 { ImageBase64 })', async () => {
    const fn = mockFetchJson({ Response: { Name: 'ZHANG SAN', ID: 'E12345678', RequestId: 'r1' } });
    await makeProvider(CONFIGURED).recognize(input('passport'));
    const body = JSON.parse(
      ((fn.mock.calls[0] as unknown[])[1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.ImageBase64).toBeDefined();
    expect(body.EnablePortrait).toBeUndefined();
    expect(body.EnableCropImage).toBeUndefined();
    expect(Object.keys(body)).toEqual(['ImageBase64']);
  });

  it('mainland 防伪标志(Copy/PS=1)→ warnings;质量标志(Blur=1)不当防伪', async () => {
    mockFetchJson({
      Response: {
        IDCardInfo: {
          Name: { Content: '张三' },
          IdNum: { Content: '110101199003070038' },
          WarnInfos: { CopyCheck: 1, PSCheck: 1, ReshootCheck: 0, BlurCheck: 1, BorderCheck: 1 },
        },
      },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(true);
    // 仅复印/翻拍/PS 进防伪;模糊/边缘(质量)不进
    expect(res.warnings).toEqual(['CopyCheck', 'PSCheck']);
  });

  it('mainland IDCardInfo 在但 Content 读不出关键字段 → recognized:false(真不清晰,非异常)', async () => {
    mockFetchJson({
      Response: { IDCardInfo: { Name: { Content: '张三' } }, RequestId: 'r1' },
    });
    const res = await makeProvider(CONFIGURED).recognize(input('mainland_id'));
    expect(res.recognized).toBe(false);
    expect(res.name).toBe('张三');
    expect(res.idCardNumber).toBeNull();
  });

  it('mainland IDCardInfo 容器整块缺失 → RealnameApiError(契约错,**不**降级成 recognized:false)', async () => {
    mockFetchJson({ Response: { RequestId: 'r1' } });
    await expect(makeProvider(CONFIGURED).recognize(input('mainland_id'))).rejects.toBeInstanceOf(
      RealnameApiError,
    );
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

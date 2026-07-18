import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';

import COS from 'cos-nodejs-sdk-v5';

import type { StorageSettingsService } from '../storage-settings.service';
import { CredentialStatus, type StorageSettingsResolved } from '../storage-settings.types';
import { CosProviderUnavailableError, CosStorageProvider } from './cos.provider';

// V2.x C-7.5 PR #8:cos.provider 单元测试(沿 Q-89-4 拍板 A:整包 mock SDK,禁止真实联网)

jest.mock('cos-nodejs-sdk-v5', () => {
  const mockInstance = {
    putObject: jest.fn(),
    deleteObject: jest.fn(),
    getObjectUrl: jest.fn(),
    headObject: jest.fn(),
    getObject: jest.fn(),
  };
  const Constructor = jest.fn().mockImplementation(() => mockInstance);
  // 暴露给测试用例引用
  (Constructor as unknown as { __mockInstance: typeof mockInstance }).__mockInstance = mockInstance;
  return { __esModule: true, default: Constructor };
});

const COSMock = COS as unknown as jest.Mock & {
  __mockInstance: {
    putObject: jest.Mock;
    deleteObject: jest.Mock;
    getObjectUrl: jest.Mock;
    headObject: jest.Mock;
    getObject: jest.Mock;
  };
};

function makeSettings(overrides: Partial<StorageSettingsResolved> = {}): StorageSettingsResolved {
  return {
    id: 'cuid-settings',
    providerType: 'COS',
    enabled: true,
    bucket: 'srvf-attachments-1250000000',
    region: 'ap-shanghai',
    envPrefix: 'prod',
    uploadUrlTtlSeconds: 600,
    downloadUrlTtlSeconds: 300,
    lifecycleDays: 30,
    enableSignedUrl: true,
    enableVersioning: true,
    corsAllowedOrigins: null,
    maxObjectSizeBytes: null,
    allowedMimePolicyMode: 'INHERIT',
    credentials: { secretId: 'AKID-test-id', secretKey: 'secret-test-key' },
    credentialStatus: CredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeSettingsServiceMock(settings: StorageSettingsResolved | null): {
  service: StorageSettingsService;
  getActiveSettings: jest.Mock;
} {
  const getActiveSettings = jest.fn().mockResolvedValue(settings);
  const service = { getActiveSettings } as unknown as StorageSettingsService;
  return { service, getActiveSettings };
}

describe('CosStorageProvider', () => {
  beforeEach(() => {
    COSMock.mockClear();
    COSMock.__mockInstance.putObject.mockReset();
    COSMock.__mockInstance.deleteObject.mockReset();
    COSMock.__mockInstance.getObjectUrl.mockReset();
    COSMock.__mockInstance.headObject.mockReset();
    COSMock.__mockInstance.getObject.mockReset();
  });

  describe('putObject', () => {
    it('Buffer 入参 → 调 SDK Bucket/Region/Key/Body/ContentType + 返 stripQuotes(ETag)', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.putObject.mockResolvedValue({
        ETag: '"abc123def456"',
        statusCode: 200,
      });
      const svc = new CosStorageProvider(service);
      const result = await svc.putObject({
        key: 'attachments/prod/2026/05/15/cuid.png',
        body: Buffer.from('payload'),
        contentType: 'image/png',
      });
      expect(COSMock.__mockInstance.putObject).toHaveBeenCalledWith({
        Bucket: 'srvf-attachments-1250000000',
        Region: 'ap-shanghai',
        Key: 'attachments/prod/2026/05/15/cuid.png',
        Body: Buffer.from('payload'),
        ContentType: 'image/png',
      });
      expect(result).toEqual({
        key: 'attachments/prod/2026/05/15/cuid.png',
        size: 7,
        contentType: 'image/png',
        etag: 'abc123def456', // 双引号被剥除
      });
    });

    it('Stream 入参 → buffer 化后调 SDK', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.putObject.mockResolvedValue({ ETag: '"xyz"' });
      const body = Readable.from([Buffer.from('chunk1'), Buffer.from('chunk2')]);
      const svc = new CosStorageProvider(service);
      const result = await svc.putObject({ key: 'k', body });
      const calls = COSMock.__mockInstance.putObject.mock.calls as unknown as Array<
        [{ Body: Buffer }]
      >;
      const callArg = calls[0][0];
      expect(Buffer.isBuffer(callArg.Body)).toBe(true);
      expect(callArg.Body.toString('utf8')).toBe('chunk1chunk2');
      expect(result.size).toBe(12);
    });
  });

  describe('deleteObject', () => {
    it('调 SDK Bucket/Region/Key', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.deleteObject.mockResolvedValue({ statusCode: 204 });
      const svc = new CosStorageProvider(service);
      await svc.deleteObject('attachments/prod/foo.png');
      expect(COSMock.__mockInstance.deleteObject).toHaveBeenCalledWith({
        Bucket: 'srvf-attachments-1250000000',
        Region: 'ap-shanghai',
        Key: 'attachments/prod/foo.png',
      });
    });

    it('协议幂等:不存在 key 也返成功(沿 COS/S3 协议;Q-89-6)', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      // COS 协议对不存在 key 也返 204;SDK 不抛
      COSMock.__mockInstance.deleteObject.mockResolvedValue({ statusCode: 204 });
      const svc = new CosStorageProvider(service);
      await expect(svc.deleteObject('never-existed')).resolves.toBeUndefined();
    });
  });

  describe('generateUploadUrl', () => {
    it('Method=PUT + Sign=true + Expires + headers 含 Content-Type', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.getObjectUrl.mockReturnValue(
        'https://srvf-attachments-1250000000.cos.ap-shanghai.myqcloud.com/k?sig=xxx',
      );
      const before = Date.now();
      const svc = new CosStorageProvider(service);
      const result = await svc.generateUploadUrl({
        key: 'attachments/prod/foo.png',
        contentType: 'image/png',
        expiresIn: 600,
      });
      expect(COSMock.__mockInstance.getObjectUrl).toHaveBeenCalledWith({
        Bucket: 'srvf-attachments-1250000000',
        Region: 'ap-shanghai',
        Key: 'attachments/prod/foo.png',
        Method: 'PUT',
        Sign: true,
        Expires: 600,
      });
      expect(result.url).toContain('sig=xxx');
      expect(result.method).toBe('PUT');
      expect(result.headers).toEqual({ 'Content-Type': 'image/png' });
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600 * 1000);
    });
  });

  describe('generateDownloadUrl', () => {
    it('Method=GET + 不含 contentDisposition 时 URL 不附加 query', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.getObjectUrl.mockReturnValue('https://example.com/k?sig=xxx');
      const svc = new CosStorageProvider(service);
      const result = await svc.generateDownloadUrl({
        key: 'attachments/prod/bar.png',
        expiresIn: 300,
      });
      expect(COSMock.__mockInstance.getObjectUrl).toHaveBeenCalledWith({
        Bucket: 'srvf-attachments-1250000000',
        Region: 'ap-shanghai',
        Key: 'attachments/prod/bar.png',
        Method: 'GET',
        Sign: true,
        Expires: 300,
      });
      expect(result.url).toBe('https://example.com/k?sig=xxx');
    });

    it('contentDisposition → 拼 response-content-disposition query', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.getObjectUrl.mockReturnValue('https://example.com/k?sig=xxx');
      const svc = new CosStorageProvider(service);
      const result = await svc.generateDownloadUrl({
        key: 'k',
        expiresIn: 300,
        contentDisposition: 'attachment; filename="hello.txt"',
      });
      // 已有 ?sig=xxx → 用 & 续接
      expect(result.url).toContain('&response-content-disposition=');
      expect(result.url).toContain(encodeURIComponent('attachment; filename="hello.txt"'));
    });

    it('contentDisposition + URL 无 query → 用 ? 起始', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.getObjectUrl.mockReturnValue('https://example.com/k');
      const svc = new CosStorageProvider(service);
      const result = await svc.generateDownloadUrl({
        key: 'k',
        expiresIn: 300,
        contentDisposition: 'attachment',
      });
      expect(result.url).toBe('https://example.com/k?response-content-disposition=attachment');
    });
  });

  describe('headObject', () => {
    it('存在 → exists+size+etag+contentType+lastModified', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.headObject.mockResolvedValue({
        ETag: '"abc123"',
        statusCode: 200,
        headers: {
          'content-length': '12345',
          'content-type': 'image/png',
          'last-modified': 'Wed, 15 May 2026 12:00:00 GMT',
        },
      });
      const svc = new CosStorageProvider(service);
      const result = await svc.headObject('k');
      expect(result.exists).toBe(true);
      expect(result.size).toBe(12345);
      expect(result.etag).toBe('abc123');
      expect(result.contentType).toBe('image/png');
      expect(result.lastModified).toEqual(new Date('Wed, 15 May 2026 12:00:00 GMT'));
    });

    it('不存在(statusCode=404)→ exists=false', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.headObject.mockRejectedValue({ statusCode: 404 });
      const svc = new CosStorageProvider(service);
      const result = await svc.headObject('never');
      expect(result.exists).toBe(false);
    });

    it('不存在(code=NoSuchKey)→ exists=false', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.headObject.mockRejectedValue({ code: 'NoSuchKey' });
      const svc = new CosStorageProvider(service);
      const result = await svc.headObject('never');
      expect(result.exists).toBe(false);
    });

    it('其他错误 → 抛(沿 Q-89-6;非 404 不静默)', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.headObject.mockRejectedValue({ statusCode: 500 });
      const svc = new CosStorageProvider(service);
      await expect(svc.headObject('k')).rejects.toEqual({ statusCode: 500 });
    });
  });

  describe('hashObjectSha256At', () => {
    it('把旧 pinned bucket/region 流式写入 digest sink，不请求 Buffer Body', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      const chunks = [Buffer.from('chunk-one-'), Buffer.from('chunk-two')];
      COSMock.__mockInstance.getObject.mockImplementation(
        ({ Output }: { Output: NodeJS.WritableStream }) =>
          new Promise((resolve, reject) => {
            Output.once('error', reject);
            Output.write(chunks[0]);
            Output.end(chunks[1], () => resolve({ ETag: '"stream-etag"' }));
          }),
      );
      const locator = {
        providerType: 'COS' as const,
        bucket: 'old-pinned-bucket',
        region: 'ap-old',
        localNamespace: null,
      };
      const progress: number[] = [];
      const svc = new CosStorageProvider(service);

      const result = await svc.hashObjectSha256At(locator, 'same.bin', (bytesRead) => {
        progress.push(bytesRead);
        return Promise.resolve();
      });

      expect(COSMock.__mockInstance.getObject).toHaveBeenCalledTimes(1);
      const calls = COSMock.__mockInstance.getObject.mock.calls as unknown as Array<
        [
          {
            Bucket: string;
            Region: string;
            Key: string;
            Output: NodeJS.WritableStream;
          },
        ]
      >;
      const call = calls[0]?.[0];
      expect(call).toMatchObject({
        Bucket: locator.bucket,
        Region: locator.region,
        Key: 'same.bin',
      });
      expect(call?.Output).toBeInstanceOf(Writable);
      const body = Buffer.concat(chunks);
      expect(result).toEqual({
        size: body.length,
        checksum: createHash('sha256').update(body).digest('hex'),
        etag: 'stream-etag',
      });
      expect(progress).toEqual([chunks[0].length, body.length]);
    });
  });

  describe('readObjectPrefix', () => {
    it('使用 COS Range 回读固定前缀', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.getObject.mockResolvedValue({ Body: Buffer.from('prefix-bytes') });
      const svc = new CosStorageProvider(service);

      await expect(svc.readObjectPrefix('attachments/prod/a.jpg', 12)).resolves.toEqual(
        Buffer.from('prefix-bytes'),
      );
      expect(COSMock.__mockInstance.getObject).toHaveBeenCalledWith({
        Bucket: 'srvf-attachments-1250000000',
        Region: 'ap-shanghai',
        Key: 'attachments/prod/a.jpg',
        Range: 'bytes=0-11',
      });
    });
  });

  describe('4 档守护', () => {
    it('settings null → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(null);
      const svc = new CosStorageProvider(service);
      await expect(svc.putObject({ key: 'k', body: Buffer.from('x') })).rejects.toThrow(
        CosProviderUnavailableError,
      );
    });

    it('providerType=LOCAL → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'LOCAL' }));
      const svc = new CosStorageProvider(service);
      await expect(svc.deleteObject('k')).rejects.toThrow(/providerType=LOCAL/);
    });

    it('credentialStatus=MISSING → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(
        makeSettings({
          credentialStatus: CredentialStatus.MISSING,
          credentials: null,
        }),
      );
      const svc = new CosStorageProvider(service);
      await expect(
        svc.generateUploadUrl({ key: 'k', contentType: 'image/png', expiresIn: 600 }),
      ).rejects.toThrow(/credentialStatus=missing/);
    });

    it('credentialStatus=INVALID → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(
        makeSettings({
          credentialStatus: CredentialStatus.INVALID,
          credentials: null,
        }),
      );
      const svc = new CosStorageProvider(service);
      await expect(svc.generateDownloadUrl({ key: 'k', expiresIn: 300 })).rejects.toThrow(
        /credentialStatus=invalid/,
      );
    });

    it('bucket 缺失 → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ bucket: null }));
      const svc = new CosStorageProvider(service);
      await expect(svc.headObject('k')).rejects.toThrow(/bucket \/ region 未配置/);
    });

    it('region 缺失 → CosProviderUnavailableError', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ region: null }));
      const svc = new CosStorageProvider(service);
      await expect(svc.headObject('k')).rejects.toThrow(/bucket \/ region 未配置/);
    });

    it('错误信息不含 secretId / secretKey 明文(沿 §6.6 Q22)', async () => {
      const { service } = makeSettingsServiceMock(
        makeSettings({
          credentialStatus: CredentialStatus.INVALID,
          credentials: null,
        }),
      );
      const svc = new CosStorageProvider(service);
      try {
        await svc.putObject({ key: 'k', body: Buffer.from('x') });
        fail('expected throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain('AKID');
        expect(msg).not.toContain('secret-test-key');
      }
    });
  });

  describe('每次方法调用都查 settings', () => {
    it('两次 putObject 都调 getActiveSettings(确保 invalidate 后能拿到新 settings)', async () => {
      const { service, getActiveSettings } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.putObject.mockResolvedValue({ ETag: '"e"' });
      const svc = new CosStorageProvider(service);
      await svc.putObject({ key: 'k1', body: Buffer.from('x') });
      await svc.putObject({ key: 'k2', body: Buffer.from('x') });
      expect(getActiveSettings).toHaveBeenCalledTimes(2);
    });

    it('每次方法调用都新建 COS 实例(不缓存;沿 Q-89-2 拍板 A)', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.deleteObject.mockResolvedValue({ statusCode: 204 });
      const svc = new CosStorageProvider(service);
      await svc.deleteObject('k1');
      await svc.deleteObject('k2');
      // Constructor 被调 2 次
      expect(COSMock).toHaveBeenCalledTimes(2);
    });

    it('Constructor 收到 SecretId / SecretKey + Timeout 8000ms(外部 SDK 超时,goal G3)', async () => {
      const { service } = makeSettingsServiceMock(makeSettings());
      COSMock.__mockInstance.deleteObject.mockResolvedValue({ statusCode: 204 });
      const svc = new CosStorageProvider(service);
      await svc.deleteObject('k');
      expect(COSMock).toHaveBeenCalledWith({
        SecretId: 'AKID-test-id',
        SecretKey: 'secret-test-key',
        // Timeout 单位 ms;真实 COS 未接通,超时配置就位由此锁定
        Timeout: 8000,
      });
    });
  });
});

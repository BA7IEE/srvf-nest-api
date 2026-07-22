import { Logger } from '@nestjs/common';

import type { CosStorageProvider } from './providers/cos.provider';
import type { LocalStorageProvider } from './providers/local.provider';
import type { StorageSettingsService } from './storage-settings.service';
import { CredentialStatus, type StorageSettingsResolved } from './storage-settings.types';
import { StorageProviderUnavailableError } from './storage.interface';
import { StorageProviderRouter } from './storage-provider.router';

// V2.x C-7.5 PR #8:storage-provider.router 单元测试(沿 Q-89-1 拍板 A 动态路由)
//
// 覆盖矩阵:
// 1. settings null → fallback Local
// 2. providerType=LOCAL → Local
// 3. providerType=COS → Cos
// 4. 未知 providerType → fallback Local + WARN(防御)
// 5. 6 个动态方法各自路由；pinned 业务 Effect 默认受 enabled kill switch 约束
// 6. 只有显式 manual maintenance 可按 pinned locator 绕过 kill switch
// 7. 每次方法调用都 live-read；一次 Effect 只把同一 snapshot 交给 prepared COS route

function makeSettings(overrides: Partial<StorageSettingsResolved> = {}): StorageSettingsResolved {
  return {
    id: 'cuid',
    providerType: 'COS',
    enabled: true,
    bucket: 'b',
    region: 'r',
    envPrefix: 'prod',
    uploadUrlTtlSeconds: 600,
    downloadUrlTtlSeconds: 300,
    lifecycleDays: 30,
    enableSignedUrl: true,
    enableVersioning: true,
    corsAllowedOrigins: null,
    maxObjectSizeBytes: null,
    allowedMimePolicyMode: 'INHERIT',
    credentials: { secretId: 'id', secretKey: 'key' },
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
  const service = {
    getActiveSettings,
    isProductionEnvironment: jest.fn().mockReturnValue(false),
  } as unknown as StorageSettingsService;
  return { service, getActiveSettings };
}

interface MockProvider<T> {
  instance: T;
  prepare?: jest.Mock;
  putObject: jest.Mock;
  deleteObject: jest.Mock;
  generateUploadUrl: jest.Mock;
  generateDownloadUrl: jest.Mock;
  headObject: jest.Mock;
  readObjectPrefix: jest.Mock;
  putObjectAt: jest.Mock;
  deleteObjectAt: jest.Mock;
  generateUploadUrlAt: jest.Mock;
  generateDownloadUrlAt: jest.Mock;
  headObjectAt: jest.Mock;
  readObjectPrefixAt: jest.Mock;
  hashObjectSha256At: jest.Mock;
}

function makeLocalMock(): MockProvider<LocalStorageProvider> {
  const putObject = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObject = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrl = jest.fn().mockResolvedValue({});
  const generateDownloadUrl = jest.fn().mockResolvedValue({});
  const headObject = jest.fn().mockResolvedValue({ exists: false });
  const readObjectPrefix = jest.fn().mockResolvedValue(Buffer.from('prefix'));
  const putObjectAt = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObjectAt = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrlAt = jest.fn().mockResolvedValue({});
  const generateDownloadUrlAt = jest.fn().mockResolvedValue({});
  const headObjectAt = jest.fn().mockResolvedValue({ exists: false });
  const readObjectPrefixAt = jest.fn().mockResolvedValue(Buffer.from('prefix'));
  const hashObjectSha256At = jest.fn().mockResolvedValue({ size: 1, checksum: 'a'.repeat(64) });
  const instance = {
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
    readObjectPrefix,
    putObjectAt,
    deleteObjectAt,
    generateUploadUrlAt,
    generateDownloadUrlAt,
    headObjectAt,
    readObjectPrefixAt,
    hashObjectSha256At,
  } as unknown as LocalStorageProvider;
  return {
    instance,
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
    readObjectPrefix,
    putObjectAt,
    deleteObjectAt,
    generateUploadUrlAt,
    generateDownloadUrlAt,
    headObjectAt,
    readObjectPrefixAt,
    hashObjectSha256At,
  };
}

function makeCosMock(): MockProvider<CosStorageProvider> {
  const putObject = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObject = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrl = jest.fn().mockResolvedValue({});
  const generateDownloadUrl = jest.fn().mockResolvedValue({});
  const headObject = jest.fn().mockResolvedValue({ exists: false });
  const readObjectPrefix = jest.fn().mockResolvedValue(Buffer.from('prefix'));
  const putObjectAt = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObjectAt = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrlAt = jest.fn().mockResolvedValue({});
  const generateDownloadUrlAt = jest.fn().mockResolvedValue({});
  const headObjectAt = jest.fn().mockResolvedValue({ exists: false });
  const readObjectPrefixAt = jest.fn().mockResolvedValue(Buffer.from('prefix'));
  const hashObjectSha256At = jest.fn().mockResolvedValue({ size: 1, checksum: 'b'.repeat(64) });
  const prepared = {
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
    readObjectPrefix,
    putObjectAt,
    deleteObjectAt,
    generateUploadUrlAt,
    generateDownloadUrlAt,
    headObjectAt,
    readObjectPrefixAt,
  };
  const prepare = jest.fn().mockReturnValue(prepared);
  const instance = {
    ...prepared,
    prepare,
    putObjectAt,
    deleteObjectAt,
    generateUploadUrlAt,
    generateDownloadUrlAt,
    headObjectAt,
    readObjectPrefixAt,
    hashObjectSha256At,
  } as unknown as CosStorageProvider;
  return {
    instance,
    prepare,
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
    readObjectPrefix,
    putObjectAt,
    deleteObjectAt,
    generateUploadUrlAt,
    generateDownloadUrlAt,
    headObjectAt,
    readObjectPrefixAt,
    hashObjectSha256At,
  };
}

describe('StorageProviderRouter', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('resolve', () => {
    it('settings null → 路由到 Local', async () => {
      const { service } = makeSettingsServiceMock(null);
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await router.putObject({ key: 'k', body: Buffer.from('x') });
      expect(localMock.putObject).toHaveBeenCalled();
      expect(cosMock.putObject).not.toHaveBeenCalled();
    });

    it('providerType=LOCAL → 路由到 Local', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'LOCAL' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await router.putObject({ key: 'k', body: Buffer.from('x') });
      expect(localMock.putObject).toHaveBeenCalled();
      expect(cosMock.putObject).not.toHaveBeenCalled();
    });

    it('providerType=COS → 路由到 Cos', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'COS' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await router.putObject({ key: 'k', body: Buffer.from('x') });
      expect(cosMock.putObject).toHaveBeenCalled();
      expect(localMock.putObject).not.toHaveBeenCalled();
    });

    it('enabled=false → 6 个普通业务 Effect 全部 fail-closed 且零 Provider 调用', async () => {
      const { service, getActiveSettings } = makeSettingsServiceMock(
        makeSettings({ enabled: false }),
      );
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      const calls = [
        () => router.putObject({ key: 'k', body: Buffer.from('x') }),
        () => router.deleteObject('k'),
        () => router.generateUploadUrl({ key: 'k', contentType: 'image/png', expiresIn: 60 }),
        () => router.generateDownloadUrl({ key: 'k', expiresIn: 60 }),
        () => router.headObject('k'),
        () => router.readObjectPrefix('k', 12),
      ];

      for (const call of calls) {
        await expect(call()).rejects.toThrow(StorageProviderUnavailableError);
      }
      expect(getActiveSettings).toHaveBeenCalledTimes(6);
      expect(localMock.putObject).not.toHaveBeenCalled();
      expect(localMock.deleteObject).not.toHaveBeenCalled();
      expect(localMock.generateUploadUrl).not.toHaveBeenCalled();
      expect(localMock.generateDownloadUrl).not.toHaveBeenCalled();
      expect(localMock.headObject).not.toHaveBeenCalled();
      expect(localMock.readObjectPrefix).not.toHaveBeenCalled();
      expect(cosMock.prepare).not.toHaveBeenCalled();
      expect(cosMock.putObject).not.toHaveBeenCalled();
      expect(cosMock.deleteObject).not.toHaveBeenCalled();
      expect(cosMock.generateUploadUrl).not.toHaveBeenCalled();
      expect(cosMock.generateDownloadUrl).not.toHaveBeenCalled();
      expect(cosMock.headObject).not.toHaveBeenCalled();
      expect(cosMock.readObjectPrefix).not.toHaveBeenCalled();
    });

    it('未知 providerType → fallback Local + WARN', async () => {
      const { service } = makeSettingsServiceMock(
        makeSettings({ providerType: 'UNKNOWN' as unknown as 'COS' }),
      );
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await router.putObject({ key: 'k', body: Buffer.from('x') });
      expect(localMock.putObject).toHaveBeenCalled();
      expect(cosMock.putObject).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown providerType=UNKNOWN'));
    });

    it.each([
      ['missing settings', null],
      ['LOCAL', makeSettings({ providerType: 'LOCAL' })],
      ['unknown', makeSettings({ providerType: 'UNKNOWN' as unknown as 'COS' })],
    ])('production %s → fail-closed 且零 Provider 调用', async (_label, settings) => {
      const { service } = makeSettingsServiceMock(settings);
      jest.spyOn(service, 'isProductionEnvironment').mockReturnValue(true);
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await expect(router.putObject({ key: 'k', body: Buffer.from('x') })).rejects.toThrow(
        StorageProviderUnavailableError,
      );
      expect(localMock.putObject).not.toHaveBeenCalled();
      expect(cosMock.prepare).not.toHaveBeenCalled();
      expect(cosMock.putObject).not.toHaveBeenCalled();
    });
  });

  describe('6 方法路由', () => {
    it('putObject 路由到 COS', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'COS' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.putObject({ key: 'k', body: Buffer.from('x') });
      expect(cosMock.putObject).toHaveBeenCalled();
    });

    it('deleteObject 路由到 Local', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'LOCAL' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.deleteObject('k');
      expect(localMock.deleteObject).toHaveBeenCalledWith('k');
      expect(cosMock.deleteObject).not.toHaveBeenCalled();
    });

    it('generateUploadUrl 路由到 COS', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'COS' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.generateUploadUrl({ key: 'k', contentType: 'image/png', expiresIn: 600 });
      expect(cosMock.generateUploadUrl).toHaveBeenCalled();
    });

    it('generateDownloadUrl 路由到 Local(settings null fallback)', async () => {
      const { service } = makeSettingsServiceMock(null);
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.generateDownloadUrl({ key: 'k', expiresIn: 300 });
      expect(localMock.generateDownloadUrl).toHaveBeenCalled();
      expect(cosMock.generateDownloadUrl).not.toHaveBeenCalled();
    });

    it('headObject 路由到 COS', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'COS' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.headObject('k');
      expect(cosMock.headObject).toHaveBeenCalledWith('k');
    });

    it('readObjectPrefix 路由到 Local', async () => {
      const { service } = makeSettingsServiceMock(makeSettings({ providerType: 'LOCAL' }));
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.readObjectPrefix('k', 12);
      expect(localMock.readObjectPrefix).toHaveBeenCalledWith('k', 12);
      expect(cosMock.readObjectPrefix).not.toHaveBeenCalled();
    });
  });

  describe('每次调用都 live-read', () => {
    it('两次 putObject → getActiveSettings 调用 2 次', async () => {
      const { service, getActiveSettings } = makeSettingsServiceMock(makeSettings());
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.putObject({ key: 'k1', body: Buffer.from('x') });
      await router.putObject({ key: 'k2', body: Buffer.from('x') });
      expect(getActiveSettings).toHaveBeenCalledTimes(2);
    });

    it('COS Effect 只读一次 settings，并把该 snapshot 传给 prepare', async () => {
      const oldSettings = makeSettings({ bucket: 'bucket-old', region: 'region-old' });
      const newSettings = makeSettings({ bucket: 'bucket-new', region: 'region-new' });
      const getActiveSettings = jest
        .fn()
        .mockResolvedValueOnce(oldSettings)
        .mockResolvedValueOnce(newSettings);
      const service = {
        getActiveSettings,
        isProductionEnvironment: jest.fn().mockReturnValue(false),
      } as unknown as StorageSettingsService;
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);

      await router.putObject({ key: 'k', body: Buffer.from('x') });

      expect(getActiveSettings).toHaveBeenCalledTimes(1);
      expect(cosMock.prepare).toHaveBeenCalledTimes(1);
      expect(cosMock.prepare).toHaveBeenCalledWith(oldSettings);
      expect(cosMock.putObject).toHaveBeenCalledTimes(1);
    });
  });

  it('普通 pinned SHA-256 先检查 enabled，再按 locator 类型直达 Provider', async () => {
    const { service, getActiveSettings } = makeSettingsServiceMock(makeSettings());
    const localMock = makeLocalMock();
    const cosMock = makeCosMock();
    const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
    const locator = {
      providerType: 'COS' as const,
      bucket: 'old-pinned-bucket',
      region: 'ap-old',
      localNamespace: null,
    };

    await router.hashObjectSha256At(locator, 'k');

    expect(cosMock.hashObjectSha256At).toHaveBeenCalledWith(locator, 'k', undefined);
    expect(localMock.hashObjectSha256At).not.toHaveBeenCalled();
    expect(getActiveSettings).toHaveBeenCalledTimes(1);
  });

  it('enabled=false → 普通 pinned 上传/签名/读取/删除全部 fail-closed 且零 Provider 调用', async () => {
    const { service, getActiveSettings } = makeSettingsServiceMock(
      makeSettings({ enabled: false }),
    );
    const localMock = makeLocalMock();
    const cosMock = makeCosMock();
    const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
    const locator = {
      providerType: 'COS' as const,
      bucket: 'old-pinned-bucket',
      region: 'ap-old',
      localNamespace: null,
    };
    const calls = [
      () => router.putObjectAt(locator, { key: 'k', body: Buffer.from('x') }),
      () => router.deleteObjectAt(locator, 'k'),
      () =>
        router.generateUploadUrlAt(locator, {
          key: 'k',
          contentType: 'image/png',
          expiresIn: 60,
        }),
      () => router.generateDownloadUrlAt(locator, { key: 'k', expiresIn: 60 }),
      () => router.headObjectAt(locator, 'k'),
      () => router.readObjectPrefixAt(locator, 'k', 12),
      () => router.hashObjectSha256At(locator, 'k'),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toThrow(StorageProviderUnavailableError);
    }
    expect(getActiveSettings).toHaveBeenCalledTimes(7);
    expect(cosMock.prepare).not.toHaveBeenCalled();
    expect(cosMock.putObjectAt).not.toHaveBeenCalled();
    expect(cosMock.deleteObjectAt).not.toHaveBeenCalled();
    expect(cosMock.generateUploadUrlAt).not.toHaveBeenCalled();
    expect(cosMock.generateDownloadUrlAt).not.toHaveBeenCalled();
    expect(cosMock.headObjectAt).not.toHaveBeenCalled();
    expect(cosMock.readObjectPrefixAt).not.toHaveBeenCalled();
    expect(cosMock.hashObjectSha256At).not.toHaveBeenCalled();
    expect(localMock.putObjectAt).not.toHaveBeenCalled();
    expect(localMock.deleteObjectAt).not.toHaveBeenCalled();
    expect(localMock.generateUploadUrlAt).not.toHaveBeenCalled();
    expect(localMock.generateDownloadUrlAt).not.toHaveBeenCalled();
    expect(localMock.headObjectAt).not.toHaveBeenCalled();
    expect(localMock.readObjectPrefixAt).not.toHaveBeenCalled();
    expect(localMock.hashObjectSha256At).not.toHaveBeenCalled();
  });

  it.each([
    ['missing settings', null],
    ['LOCAL', makeSettings({ providerType: 'LOCAL' })],
    ['unknown', makeSettings({ providerType: 'UNKNOWN' as unknown as 'COS' })],
  ])('production %s → 普通 pinned Effect fail-closed', async (_label, settings) => {
    const { service } = makeSettingsServiceMock(settings);
    jest.spyOn(service, 'isProductionEnvironment').mockReturnValue(true);
    const localMock = makeLocalMock();
    const cosMock = makeCosMock();
    const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
    const locator = {
      providerType: 'COS' as const,
      bucket: 'old-pinned-bucket',
      region: 'ap-old',
      localNamespace: null,
    };

    await expect(router.deleteObjectAt(locator, 'k')).rejects.toThrow(
      StorageProviderUnavailableError,
    );
    expect(cosMock.deleteObjectAt).not.toHaveBeenCalled();
    expect(localMock.deleteObjectAt).not.toHaveBeenCalled();
  });

  it('显式 manual maintenance 可按 pinned locator 绕过 disabled settings', async () => {
    const { service, getActiveSettings } = makeSettingsServiceMock(
      makeSettings({ enabled: false }),
    );
    const localMock = makeLocalMock();
    const cosMock = makeCosMock();
    const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
    const locator = {
      providerType: 'COS' as const,
      bucket: 'old-pinned-bucket',
      region: 'ap-old',
      localNamespace: null,
    };

    await router.hashObjectSha256At(locator, 'k', undefined, { maintenance: true });

    expect(cosMock.hashObjectSha256At).toHaveBeenCalledWith(locator, 'k', undefined);
    expect(getActiveSettings).not.toHaveBeenCalled();
  });
});

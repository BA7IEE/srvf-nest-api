import { Logger } from '@nestjs/common';

import type { CosStorageProvider } from './providers/cos.provider';
import type { LocalStorageProvider } from './providers/local.provider';
import type { StorageSettingsService } from './storage-settings.service';
import { CredentialStatus, type StorageSettingsResolved } from './storage-settings.types';
import { StorageProviderRouter } from './storage-provider.router';

// V2.x C-7.5 PR #8:storage-provider.router 单元测试(沿 Q-89-1 拍板 A 动态路由)
//
// 覆盖矩阵:
// 1. settings null → fallback Local
// 2. providerType=LOCAL → Local
// 3. providerType=COS → Cos
// 4. 未知 providerType → fallback Local + WARN(防御)
// 5. 5 方法各自路由到对应 Provider
// 6. 每次方法调用都 resolve(确保 settings invalidate 后能拿到新 provider)

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
  const service = { getActiveSettings } as unknown as StorageSettingsService;
  return { service, getActiveSettings };
}

interface MockProvider<T> {
  instance: T;
  putObject: jest.Mock;
  deleteObject: jest.Mock;
  generateUploadUrl: jest.Mock;
  generateDownloadUrl: jest.Mock;
  headObject: jest.Mock;
}

function makeLocalMock(): MockProvider<LocalStorageProvider> {
  const putObject = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObject = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrl = jest.fn().mockResolvedValue({});
  const generateDownloadUrl = jest.fn().mockResolvedValue({});
  const headObject = jest.fn().mockResolvedValue({ exists: false });
  const instance = {
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
  } as unknown as LocalStorageProvider;
  return { instance, putObject, deleteObject, generateUploadUrl, generateDownloadUrl, headObject };
}

function makeCosMock(): MockProvider<CosStorageProvider> {
  const putObject = jest.fn().mockResolvedValue({ key: 'k', size: 1 });
  const deleteObject = jest.fn().mockResolvedValue(undefined);
  const generateUploadUrl = jest.fn().mockResolvedValue({});
  const generateDownloadUrl = jest.fn().mockResolvedValue({});
  const headObject = jest.fn().mockResolvedValue({ exists: false });
  const instance = {
    putObject,
    deleteObject,
    generateUploadUrl,
    generateDownloadUrl,
    headObject,
  } as unknown as CosStorageProvider;
  return { instance, putObject, deleteObject, generateUploadUrl, generateDownloadUrl, headObject };
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
  });

  describe('5 方法路由', () => {
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
  });

  describe('每次调用都 resolve(确保 invalidate 后能拿到新 provider)', () => {
    it('两次 putObject → getActiveSettings 调用 2 次', async () => {
      const { service, getActiveSettings } = makeSettingsServiceMock(makeSettings());
      const localMock = makeLocalMock();
      const cosMock = makeCosMock();
      const router = new StorageProviderRouter(service, localMock.instance, cosMock.instance);
      await router.putObject({ key: 'k1', body: Buffer.from('x') });
      await router.putObject({ key: 'k2', body: Buffer.from('x') });
      expect(getActiveSettings).toHaveBeenCalledTimes(2);
    });
  });
});

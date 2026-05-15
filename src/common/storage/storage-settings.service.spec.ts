import { Logger } from '@nestjs/common';
import type { StorageSettings as StorageSettingsRow } from '@prisma/client';

import type { PrismaService } from '../../database/prisma.service';
import { StorageCryptoDecryptError, StorageCryptoService } from './storage-crypto.service';
import { StorageSettingsService } from './storage-settings.service';
import { CredentialStatus } from './storage-settings.types';

// V2.x C-7.5 PR #6:storage-settings.service 单元测试(沿 Q-87-5 拍板 A 必须覆盖)
//
// 覆盖矩阵:
// 1. DB 空 → 返 null + 缓存 null
// 2. DB 1 条 + credentialConfigured=false → CONFIGURED 字段为 null + credentialStatus=MISSING
// 3. DB 1 条 + credentialConfigured=true + 解密成功 → CONFIGURED + credentials 含明文
// 4. DB 1 条 + credentialConfigured=true + 解密失败 → INVALID + credentials=null
// 5. DB 1 条 + credentialConfigured=true + 加密列为 null(数据不一致防御)→ MISSING
// 6. DB 多条记录 → 取最早 + 打 WARN 日志
// 7. 缓存命中(60s 内不再调 prisma)
// 8. invalidate() 主动清缓存

type FindManyArgs = {
  orderBy?: unknown;
  take?: number;
};

function makePrismaMock(rows: StorageSettingsRow[]): {
  prisma: PrismaService;
  findManyMock: jest.Mock<Promise<StorageSettingsRow[]>, [FindManyArgs]>;
} {
  const findManyMock = jest
    .fn<Promise<StorageSettingsRow[]>, [FindManyArgs]>()
    .mockResolvedValue(rows);
  const prisma = {
    storageSettings: { findMany: findManyMock },
  } as unknown as PrismaService;
  return { prisma, findManyMock };
}

// 类型完整的 StorageSettingsRow 工厂(Prisma 生成的 row 类型必须全字段就位)
function makeRow(overrides: Partial<StorageSettingsRow> = {}): StorageSettingsRow {
  const now = new Date('2026-05-16T00:00:00Z');
  return {
    id: 'cuid-storage-1',
    providerType: 'COS',
    enabled: true,
    bucket: 'srvf-attachments',
    region: 'ap-shanghai',
    envPrefix: 'dev',
    uploadUrlTtlSeconds: 600,
    downloadUrlTtlSeconds: 300,
    lifecycleDays: 30,
    enableSignedUrl: true,
    enableVersioning: true,
    corsAllowedOrigins: null,
    maxObjectSizeBytes: null,
    allowedMimePolicyMode: 'INHERIT',
    secretIdEncrypted: null,
    secretKeyEncrypted: null,
    credentialConfigured: false,
    remarks: null,
    updatedBy: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function makeCryptoMock(options: { decrypt?: (payload: string) => string }): StorageCryptoService {
  return {
    isAvailable: () => true,
    encrypt: (p: string) => p,
    decrypt: options.decrypt ?? ((p: string) => p),
  } as unknown as StorageCryptoService;
}

describe('StorageSettingsService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('DB 空', () => {
    it('返 null', async () => {
      const { prisma } = makePrismaMock([]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result).toBeNull();
    });
  });

  describe('DB 1 条 + credentialConfigured=false', () => {
    it('返 resolved + credentialStatus=MISSING + credentials=null', async () => {
      const { prisma } = makePrismaMock([makeRow({ credentialConfigured: false })]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result).not.toBeNull();
      expect(result!.credentialStatus).toBe(CredentialStatus.MISSING);
      expect(result!.credentials).toBeNull();
      expect(result!.providerType).toBe('COS');
      expect(result!.bucket).toBe('srvf-attachments');
    });
  });

  describe('DB 1 条 + credentialConfigured=true + 解密成功', () => {
    it('返 resolved + credentialStatus=CONFIGURED + credentials 明文', async () => {
      const { prisma } = makePrismaMock([
        makeRow({
          credentialConfigured: true,
          secretIdEncrypted: 'ENC(AKID-id)',
          secretKeyEncrypted: 'ENC(secret-key)',
        }),
      ]);
      const crypto = makeCryptoMock({
        decrypt: (p) => p.replace(/^ENC\(|\)$/g, ''),
      });
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result!.credentialStatus).toBe(CredentialStatus.CONFIGURED);
      expect(result!.credentials).toEqual({
        secretId: 'AKID-id',
        secretKey: 'secret-key',
      });
    });
  });

  describe('DB 1 条 + credentialConfigured=true + 解密失败', () => {
    it('返 resolved + credentialStatus=INVALID + credentials=null + WARN 日志', async () => {
      const { prisma } = makePrismaMock([
        makeRow({
          credentialConfigured: true,
          secretIdEncrypted: 'BAD_CIPHER',
          secretKeyEncrypted: 'BAD_CIPHER',
        }),
      ]);
      const crypto = makeCryptoMock({
        decrypt: () => {
          throw new StorageCryptoDecryptError('auth tag mismatch');
        },
      });
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result!.credentialStatus).toBe(CredentialStatus.INVALID);
      expect(result!.credentials).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('DB 1 条 + credentialConfigured=true + 加密列为 null(防御)', () => {
    it('返 MISSING + WARN 日志(数据不一致)', async () => {
      const { prisma } = makePrismaMock([
        makeRow({
          credentialConfigured: true,
          secretIdEncrypted: null, // 故意:credentialConfigured 与加密列不一致
          secretKeyEncrypted: null,
        }),
      ]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result!.credentialStatus).toBe(CredentialStatus.MISSING);
      expect(result!.credentials).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('DB 多条记录(singleton 违反)', () => {
    it('取 createdAt 最早的一条 + 打 WARN', async () => {
      const earlier = makeRow({
        id: 'cuid-earlier',
        createdAt: new Date('2026-05-16T00:00:00Z'),
        bucket: 'first',
      });
      const later = makeRow({
        id: 'cuid-later',
        createdAt: new Date('2026-05-16T01:00:00Z'),
        bucket: 'second',
      });
      // findMany orderBy=asc,所以传入顺序就是 [earlier, later]
      const { prisma } = makePrismaMock([earlier, later]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      const result = await svc.getActiveSettings();
      expect(result!.id).toBe('cuid-earlier');
      expect(result!.bucket).toBe('first');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('storage_settings singleton violated'),
      );
    });
  });

  describe('缓存', () => {
    it('60s 内第二次调用不查 DB', async () => {
      const { prisma, findManyMock } = makePrismaMock([makeRow()]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      await svc.getActiveSettings();
      await svc.getActiveSettings();
      await svc.getActiveSettings();
      expect(findManyMock).toHaveBeenCalledTimes(1);
    });

    it('DB 空时也缓存 null', async () => {
      const { prisma, findManyMock } = makePrismaMock([]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      const r1 = await svc.getActiveSettings();
      const r2 = await svc.getActiveSettings();
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(findManyMock).toHaveBeenCalledTimes(1);
    });

    it('invalidate() 后再查 DB', async () => {
      const { prisma, findManyMock } = makePrismaMock([makeRow()]);
      const crypto = makeCryptoMock({});
      const svc = new StorageSettingsService(prisma, crypto);

      await svc.getActiveSettings();
      svc.invalidate();
      await svc.getActiveSettings();
      expect(findManyMock).toHaveBeenCalledTimes(2);
    });
  });
});

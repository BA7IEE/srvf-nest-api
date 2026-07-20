import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { RealnameVerificationSettings as RealnameSettingsRow } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RbacService } from '../permissions/rbac.service';
import { RealnameCryptoDecryptError, type RealnameCryptoService } from './realname-crypto.service';
import { RealnameSettingsService } from './realname-settings.service';
import { RealnameCredentialStatus } from './realname.types';

function makeRow(overrides: Partial<RealnameSettingsRow> = {}): RealnameSettingsRow {
  const now = new Date('2026-07-20T00:00:00.000Z');
  return {
    id: 'realname-settings-1',
    providerType: 'TENCENT_CLOUD',
    enabled: true,
    region: 'ap-guangzhou',
    secretIdEncrypted: 'enc-id',
    secretKeyEncrypted: 'enc-key',
    credentialConfigured: true,
    remarks: null,
    updatedBy: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function makeService(rows: Array<RealnameSettingsRow | null>, decrypt = (value: string) => value) {
  const findFirst = jest.fn<Promise<RealnameSettingsRow | null>, []>();
  for (const row of rows) findFirst.mockResolvedValueOnce(row);
  const prisma = {
    realnameVerificationSettings: { findFirst },
  } as unknown as PrismaService;
  const crypto = {
    encrypt: (value: string) => value,
    decrypt,
  } as unknown as RealnameCryptoService;
  const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService;
  const cfg = { env: 'development' } as ConfigType<typeof appConfig>;
  return {
    service: new RealnameSettingsService(prisma, crypto, rbac, auditLogs, cfg),
    findFirst,
  };
}

describe('RealnameSettingsService live-read', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('每次 getActiveSettings 都查 DB，并直接返回下一代配置', async () => {
    const { service, findFirst } = makeService([
      makeRow({ region: 'ap-guangzhou' }),
      makeRow({ region: 'ap-shanghai' }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({ region: 'ap-guangzhou' });
    await expect(service.getActiveSettings()).resolves.toMatchObject({ region: 'ap-shanghai' });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect('invalidate' in service).toBe(false);
  });

  it('空→有→空不等待、不 reload、不 invalidate', async () => {
    const { service, findFirst } = makeService([null, makeRow(), null]);

    await expect(service.getActiveSettings()).resolves.toBeNull();
    await expect(service.getActiveSettings()).resolves.toMatchObject({ id: 'realname-settings-1' });
    await expect(service.getActiveSettings()).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(3);
  });

  it('缺失密文仍映射 MISSING', async () => {
    const { service } = makeService([
      makeRow({ credentialConfigured: true, secretIdEncrypted: null, secretKeyEncrypted: null }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: RealnameCredentialStatus.MISSING,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('解密失败仍映射 INVALID', async () => {
    const decrypt = () => {
      throw new RealnameCryptoDecryptError('invalid cipher');
    };
    const { service } = makeService([makeRow()], decrypt);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: RealnameCredentialStatus.INVALID,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

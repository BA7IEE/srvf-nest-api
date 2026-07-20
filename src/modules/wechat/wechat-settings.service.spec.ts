import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { WechatSettings as WechatSettingsRow } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RbacService } from '../permissions/rbac.service';
import { WechatCryptoDecryptError, type WechatCryptoService } from './wechat-crypto.service';
import { WechatSettingsService } from './wechat-settings.service';
import { WechatCredentialStatus } from './wechat.types';

function makeRow(overrides: Partial<WechatSettingsRow> = {}): WechatSettingsRow {
  const now = new Date('2026-07-20T00:00:00.000Z');
  return {
    id: 'wechat-settings-1',
    providerType: 'WECHAT',
    enabled: true,
    appId: 'wx-old',
    appSecretEncrypted: 'enc-secret',
    credentialConfigured: true,
    remarks: null,
    updatedBy: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function makeService(rows: Array<WechatSettingsRow | null>, decrypt = (value: string) => value) {
  const findFirst = jest.fn<Promise<WechatSettingsRow | null>, []>();
  for (const row of rows) findFirst.mockResolvedValueOnce(row);
  const prisma = { wechatSettings: { findFirst } } as unknown as PrismaService;
  const crypto = {
    encrypt: (value: string) => value,
    decrypt,
  } as unknown as WechatCryptoService;
  const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService;
  const cfg = { env: 'development' } as ConfigType<typeof appConfig>;
  return {
    service: new WechatSettingsService(prisma, crypto, rbac, auditLogs, cfg),
    findFirst,
  };
}

describe('WechatSettingsService live-read', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('每次 getActiveSettings 都查 DB，并直接返回下一代配置', async () => {
    const { service, findFirst } = makeService([
      makeRow({ appId: 'wx-old' }),
      makeRow({ appId: 'wx-new' }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({ appId: 'wx-old' });
    await expect(service.getActiveSettings()).resolves.toMatchObject({ appId: 'wx-new' });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect('invalidate' in service).toBe(false);
  });

  it('空→有→空不等待、不 reload、不 invalidate', async () => {
    const { service, findFirst } = makeService([null, makeRow(), null]);

    await expect(service.getActiveSettings()).resolves.toBeNull();
    await expect(service.getActiveSettings()).resolves.toMatchObject({ id: 'wechat-settings-1' });
    await expect(service.getActiveSettings()).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(3);
  });

  it('缺失密文仍映射 MISSING', async () => {
    const { service } = makeService([
      makeRow({ credentialConfigured: true, appSecretEncrypted: null }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: WechatCredentialStatus.MISSING,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('解密失败仍映射 INVALID', async () => {
    const decrypt = () => {
      throw new WechatCryptoDecryptError('invalid cipher');
    };
    const { service } = makeService([makeRow()], decrypt);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: WechatCredentialStatus.INVALID,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('generation 只随 token 身份相关字段变化，remarks/updatedAt 不造成无谓刷新', async () => {
    const base = makeRow();
    const { service } = makeService([
      base,
      makeRow({ remarks: 'ops note', updatedAt: new Date('2026-07-21T00:00:00.000Z') }),
      makeRow({ appId: 'wx-next' }),
      makeRow({ appSecretEncrypted: 'enc-secret-next' }),
    ]);

    const first = await service.getActiveSettings();
    const remarksOnly = await service.getActiveSettings();
    const appIdChanged = await service.getActiveSettings();
    const secretChanged = await service.getActiveSettings();

    expect(remarksOnly?.configurationGeneration).toBe(first?.configurationGeneration);
    expect(appIdChanged?.configurationGeneration).not.toBe(first?.configurationGeneration);
    expect(secretChanged?.configurationGeneration).not.toBe(first?.configurationGeneration);
    expect(first?.configurationGeneration).not.toContain('enc-secret');
  });
});

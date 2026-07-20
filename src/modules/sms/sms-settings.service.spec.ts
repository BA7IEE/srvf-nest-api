import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { SmsSettings as SmsSettingsRow } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RbacService } from '../permissions/rbac.service';
import { SmsCryptoDecryptError, type SmsCryptoService } from './sms-crypto.service';
import { SmsSettingsService } from './sms-settings.service';
import { SmsCredentialStatus } from './sms.types';

function makeRow(overrides: Partial<SmsSettingsRow> = {}): SmsSettingsRow {
  const now = new Date('2026-07-20T00:00:00.000Z');
  return {
    id: 'sms-settings-1',
    providerType: 'TENCENT_SMS',
    enabled: true,
    sdkAppId: '1400000000',
    signName: 'SRVF',
    region: 'ap-guangzhou',
    templateIdVerifyCode: 'verify-old',
    templateIdBirthday: 'birthday-old',
    templateIdNotification: 'notification-old',
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

function makeService(rows: Array<SmsSettingsRow | null>, decrypt = (value: string) => value) {
  const findFirst = jest.fn<Promise<SmsSettingsRow | null>, []>();
  for (const row of rows) findFirst.mockResolvedValueOnce(row);
  const prisma = { smsSettings: { findFirst } } as unknown as PrismaService;
  const crypto = {
    encrypt: (value: string) => value,
    decrypt,
  } as unknown as SmsCryptoService;
  const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService;
  const cfg = { env: 'development' } as ConfigType<typeof appConfig>;
  return {
    service: new SmsSettingsService(prisma, crypto, rbac, auditLogs, cfg),
    findFirst,
  };
}

describe('SmsSettingsService live-read', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('每次 getActiveSettings 都查 DB，并直接返回下一代配置', async () => {
    const { service, findFirst } = makeService([
      makeRow({ templateIdVerifyCode: 'verify-old' }),
      makeRow({ templateIdVerifyCode: 'verify-new' }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      templateIdVerifyCode: 'verify-old',
    });
    await expect(service.getActiveSettings()).resolves.toMatchObject({
      templateIdVerifyCode: 'verify-new',
    });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect('invalidate' in service).toBe(false);
  });

  it('空→有→空不等待、不 reload、不 invalidate', async () => {
    const { service, findFirst } = makeService([null, makeRow(), null]);

    await expect(service.getActiveSettings()).resolves.toBeNull();
    await expect(service.getActiveSettings()).resolves.toMatchObject({ id: 'sms-settings-1' });
    await expect(service.getActiveSettings()).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(3);
  });

  it('缺失密文仍映射 MISSING', async () => {
    const { service } = makeService([
      makeRow({ credentialConfigured: true, secretIdEncrypted: null, secretKeyEncrypted: null }),
    ]);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: SmsCredentialStatus.MISSING,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('解密失败仍映射 INVALID', async () => {
    const decrypt = () => {
      throw new SmsCryptoDecryptError('invalid cipher');
    };
    const { service } = makeService([makeRow()], decrypt);

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      credentials: null,
      credentialStatus: SmsCredentialStatus.INVALID,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

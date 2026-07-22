import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { RbacService } from '../../src/modules/permissions/rbac.service';
import { StorageCryptoService } from '../../src/modules/storage/storage-crypto.service';
import { StorageSettingsService } from '../../src/modules/storage/storage-settings.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const USER: CurrentUserPayload = {
  id: 'storage-production-operator',
  username: 'storage-production-operator',
  role: Role.SUPER_ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const AUDIT_META = { requestId: 'storage-production-invariant', ip: null, ua: null };

describe('production StorageSettings runtime invariant', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: StorageCryptoService;
  let service: StorageSettingsService;
  let auditLog: jest.Mock;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    crypto = app.get(StorageCryptoService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    auditLog = jest.fn().mockResolvedValue(undefined);
    service = new StorageSettingsService(
      prisma,
      crypto,
      { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService,
      { log: auditLog } as unknown as AuditLogsService,
      { env: 'production' } as ConfigType<typeof appConfig>,
    );
  });

  async function seedValidSettings(): Promise<void> {
    await prisma.storageSettings.create({
      data: {
        providerType: 'COS',
        enabled: true,
        bucket: 'srvf-production',
        region: 'ap-shanghai',
        envPrefix: 'production',
        secretIdEncrypted: crypto.encrypt('runtime-secret-id'),
        secretKeyEncrypted: crypto.encrypt('runtime-secret-key'),
        credentialConfigured: true,
      },
    });
  }

  it.each([
    [{ providerType: 'LOCAL' as const }, { providerType: 'COS', bucket: 'srvf-production' }],
    [{ bucket: null }, { providerType: 'COS', bucket: 'srvf-production' }],
    [{ region: '' }, { providerType: 'COS', region: 'ap-shanghai' }],
  ])(
    'rejects invalid merged production state and rolls the transaction back',
    async (dto, expected) => {
      await seedValidSettings();

      await expect(service.updateSettings(dto, USER, AUDIT_META)).rejects.toEqual(
        new BizException(BizCode.BAD_REQUEST),
      );
      expect(await prisma.storageSettings.findFirstOrThrow()).toMatchObject(expected);
      expect(auditLog).not.toHaveBeenCalled();
    },
  );

  it('rejects production PATCH when persisted credentials are not configured', async () => {
    await prisma.storageSettings.create({
      data: {
        providerType: 'COS',
        enabled: true,
        bucket: 'srvf-production',
        region: 'ap-shanghai',
        credentialConfigured: false,
      },
    });

    await expect(
      service.updateSettings({ remarks: 'must not commit' }, USER, AUDIT_META),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
    expect((await prisma.storageSettings.findFirstOrThrow()).remarks).toBeNull();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('allows enabled=false and same-location/non-location updates', async () => {
    await seedValidSettings();

    const result = await service.updateSettings(
      { bucket: 'srvf-production', enabled: false, remarks: 'maintenance' },
      USER,
      AUDIT_META,
    );

    expect(result).toMatchObject({
      providerType: 'COS',
      enabled: false,
      bucket: 'srvf-production',
      region: 'ap-shanghai',
      credentialStatus: 'configured',
    });
    expect(await prisma.storageSettings.findFirstOrThrow()).toMatchObject({
      providerType: 'COS',
      enabled: false,
      bucket: 'srvf-production',
      region: 'ap-shanghai',
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it.each([
    { field: 'providerType', dto: { providerType: 'LOCAL' as const } },
    { field: 'bucket', dto: { bucket: 'srvf-production-next' } },
    { field: 'region', dto: { region: 'ap-guangzhou' } },
  ])('freezes production location field $field and rolls back audit', async ({ dto }) => {
    await seedValidSettings();

    await expect(service.updateSettings(dto, USER, AUDIT_META)).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(await prisma.storageSettings.findFirstOrThrow()).toMatchObject({
      providerType: 'COS',
      bucket: 'srvf-production',
      region: 'ap-shanghai',
    });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('rejects production PATCH on an empty table instead of creating the legacy LOCAL default', async () => {
    await expect(service.updateSettings({ enabled: false }, USER, AUDIT_META)).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(await prisma.storageSettings.count()).toBe(0);
    expect(auditLog).not.toHaveBeenCalled();
  });
});

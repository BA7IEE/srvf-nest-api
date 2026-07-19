import type { ConfigType } from '@nestjs/config';
import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { AppMeInsurancesService } from './app-me-insurances.service';

type TelemetryHarness = {
  logger: { log: jest.Mock<void, [Record<string, unknown>]> };
  recordExpectedVersionUsage: (
    expectedVersion: number | undefined,
    operation: 'update' | 'delete',
  ) => void;
};

describe('AppMeInsurancesService expectedVersion telemetry', () => {
  it('emits queryable present/missing facts with only surface + operation dimensions and no PII/id', () => {
    const service = new AppMeInsurancesService(
      {} as AppIdentityResolver,
      {} as PrismaService,
      {} as AuditLogsService,
      { insurance: { enforcementEnabled: false } } as ConfigType<typeof appConfig>,
    );
    const harness = service as unknown as TelemetryHarness;
    const log = jest.fn<void, [Record<string, unknown>]>();
    harness.logger = { log };

    harness.recordExpectedVersionUsage(undefined, 'update');
    harness.recordExpectedVersionUsage(0, 'delete');

    expect(log.mock.calls).toEqual([
      [
        {
          event: 'insurance_expected_version_missing',
          surface: 'app',
          operation: 'update',
        },
      ],
      [
        {
          event: 'insurance_expected_version_present',
          surface: 'app',
          operation: 'delete',
        },
      ],
    ]);
    for (const [payload] of log.mock.calls) {
      expect(Object.keys(payload).sort()).toEqual(['event', 'operation', 'surface']);
      expect(JSON.stringify(payload)).not.toMatch(/member|insuranceId|user|policy|insurer/i);
    }
  });
});

describe('AppMeInsurancesService PR3 cutover gate', () => {
  function makeService(enforcementEnabled: boolean) {
    const appIdentity = { resolve: jest.fn() };
    const prisma = { $transaction: jest.fn() };
    const auditLogs = { log: jest.fn() };
    const service = new AppMeInsurancesService(
      appIdentity as unknown as AppIdentityResolver,
      prisma as unknown as PrismaService,
      auditLogs as unknown as AuditLogsService,
      { insurance: { enforcementEnabled } } as ConfigType<typeof appConfig>,
    );
    return { service, appIdentity, prisma, auditLogs };
  }

  it.each(['update', 'delete'] as const)(
    'gate=true rejects missing expectedVersion before identity/transaction/audit (%s)',
    async (operation) => {
      const { service, appIdentity, prisma, auditLogs } = makeService(true);
      const call =
        operation === 'update'
          ? service.updateMy(
              'insurance-1',
              { insurerName: 'updated' },
              {
                id: 'user-1',
                username: 'u',
                role: Role.USER,
                status: UserStatus.ACTIVE,
                memberId: null,
              },
              { requestId: 'req-1', ip: null, ua: null },
            )
          : service.softDeleteMy(
              'insurance-1',
              undefined,
              {
                id: 'user-1',
                username: 'u',
                role: Role.USER,
                status: UserStatus.ACTIVE,
                memberId: null,
              },
              { requestId: 'req-1', ip: null, ua: null },
            );

      await expect(call).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
      expect(appIdentity.resolve).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    },
  );
});

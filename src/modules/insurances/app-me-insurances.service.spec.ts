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

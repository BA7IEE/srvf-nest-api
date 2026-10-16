import type { PrismaClient } from '@prisma/client';
import {
  assertCurrentDiagnosticApplication,
  E4_DIAGNOSTIC_PLAN,
  E4_POLICY_BAND_PLAN,
  E4_REAL_KEY_CARRY,
  E4_REAL_SOURCE_C,
  verifyPolicyBandDatabase,
  verifyPolicyBandMigrationSource,
} from '../../../test/diagnostics/e4-prepare-cost.diagnostic-spec';

describe('146 strict current catalog and historical diagnostic boundary', () => {
  const correct = {
    count: 146,
    pending: 0,
    planning_checksum: E4_POLICY_BAND_PLAN.migrationSha256,
    prior_checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
    source_checksum: E4_REAL_SOURCE_C.migrationSha256,
    checksum: E4_REAL_KEY_CARRY.migrationSha256,
    complete_pin: E4_POLICY_BAND_PLAN.completeFunctionMd5,
    source_pin: E4_REAL_SOURCE_C.sourceFunctionMd5,
    statement_guard: true,
    deferred_guard: true,
  };
  const db = (row: object) =>
    ({ $queryRaw: jest.fn().mockResolvedValue([row]) }) as unknown as Pick<
      PrismaClient,
      '$queryRaw'
    >;

  it('accepts the approved one-keyword migration and exact completed146 metadata', async () => {
    verifyPolicyBandMigrationSource();
    await expect(verifyPolicyBandDatabase(db(correct))).resolves.toBeUndefined();
  });
  it.each([
    { count: 145 },
    { pending: 1 },
    { planning_checksum: '0'.repeat(64) },
    { complete_pin: E4_REAL_KEY_CARRY.completeFunctionMd5 },
    { source_pin: '0'.repeat(32) },
    { statement_guard: false },
    { deferred_guard: false },
  ])('rejects incomplete, historical or altered metadata: %j', async (change) => {
    await expect(verifyPolicyBandDatabase(db({ ...correct, ...change }))).rejects.toThrow();
  });
  it('rejects the145 full-chain driver before its installer instead of building an incompatible fixture', () => {
    expect(() => assertCurrentDiagnosticApplication({ SRVF_E4_REAL_KEY_CARRY: '1' })).toThrow(
      'Refused before fixture installation',
    );
    expect(() => assertCurrentDiagnosticApplication({})).not.toThrow();
  });
});

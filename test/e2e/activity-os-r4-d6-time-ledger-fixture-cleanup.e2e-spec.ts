import { PrismaClient } from '@prisma/client';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
import { withTimeLedgerFixtureCleanup } from '../setup/time-ledger-fixture-cleanup';
import { PrismaService } from '../../src/database/prisma.service';
import { createD13Fixture } from '../helpers/activity-time-policy.fixture';
import * as testApp from '../setup/test-app';
import * as reset from '../setup/reset-db';
import * as users from '../fixtures/users.fixture';

describe('D6 fixture initialization failure cleanup', () => {
  it.each(['reset', 'first-user'] as const)(
    'closes the real application after %s fails',
    async (stage) => {
      const originalCreate = testApp.createTestApp;
      const failure = new Error('deliberate fixture initialization failure');
      let close: jest.SpyInstance | undefined;
      let disconnect: jest.SpyInstance | undefined;
      let finish: (() => Promise<void>) | undefined;
      jest.spyOn(testApp, 'createTestApp').mockImplementation(async () => {
        const app = await originalCreate();
        finish = app.close.bind(app);
        const db = app.get(PrismaService);
        await assertConnectedTestDatabase(db);
        close = jest.spyOn(app, 'close');
        disconnect = jest.spyOn(db, '$disconnect');
        return app;
      });
      const resetting = jest.spyOn(reset, 'resetDb');
      if (stage === 'reset') resetting.mockRejectedValue(failure);
      else {
        resetting.mockResolvedValue(undefined);
        jest.spyOn(users, 'createTestUser').mockRejectedValue(failure);
      }
      try {
        await expect(createD13Fixture()).rejects.toBe(failure);
        expect(resetting).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        jest.restoreAllMocks();
        await finish?.();
      }
    },
  );
});

describe('D6 scoped fixture trigger handling', () => {
  const db = new PrismaClient();
  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await assertConnectedTestDatabase(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const states = () => db.$queryRaw<{ name: string; enabled: string }[]>`
    SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger
    WHERE tgrelid IN ('"ParticipationTimeLedgerEntry"'::regclass, '"ParticipationTimeLedgerManifest"'::regclass,
      '"ParticipationTimeCorrectionManifest"'::regclass, '"ParticipationTimeCorrectionEntry"'::regclass,
      '"ParticipationTimeCorrectionCommitReceipt"'::regclass, '"CorrectionPendingTimeAllocation"'::regclass,
      '"CorrectionPendingTimeAllocationEvidence"'::regclass, '"CorrectionTimeSourceProof"'::regclass,
      '"CorrectionTimeAllocationBinding"'::regclass)
    AND NOT tgisinternal ORDER BY tgname
  `;
  it('refuses ordinary truncate outside the controlled fixture transaction', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await assertConnectedTestDatabase(tx);
        await tx.$executeRawUnsafe('TRUNCATE "ParticipationTimeLedgerEntry" CASCADE');
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  });
  it('restores every trigger state after successful same-connection fixture cleanup', async () => {
    const before = await states();
    expect(
      before.filter((row) => row.name.startsWith('ptl') && row.name.endsWith('no_truncate')),
    ).toHaveLength(2);
    expect(
      before.filter((row) => row.name.startsWith('ptc') && row.name.endsWith('no_truncate')),
    ).toHaveLength(3);
    expect(
      before.filter((row) => /^(cpta|cptae|ctsp|ctab)_no_truncate$/u.test(row.name)),
    ).toHaveLength(4);
    await db.$transaction(
      (tx) =>
        withTimeLedgerFixtureCleanup(tx, async (inner) => {
          expect(inner).toBe(tx);
          await inner.$executeRawUnsafe(
            'TRUNCATE "CorrectionTimeAllocationBinding", "CorrectionPendingTimeAllocationEvidence", "CorrectionTimeSourceProof", "CorrectionPendingTimeAllocation", "ParticipantSettlementTimeBucketSource", "ParticipantTimeAllocationSlice", "ParticipantTimeAllocationEvidence", "ParticipantTimeAllocationCommandReceipt", "ParticipantTimeAllocationRevision", "ParticipationTimeLedgerEntry", "ParticipationTimeLedgerManifest", "ParticipationTimeCorrectionEntry", "ParticipationTimeCorrectionManifest", "ParticipationTimeCorrectionCommitReceipt"',
          );
        }),
      { timeout: 60_000 },
    );
    expect(await states()).toEqual(before);
  });
  it('rolls back trigger changes when fixture construction throws', async () => {
    const before = await states();
    await expect(
      db.$transaction(
        (tx) =>
          withTimeLedgerFixtureCleanup(tx, async () => {
            throw new Error('deliberate fixture failure');
          }),
        { timeout: 60_000 },
      ),
    ).rejects.toThrow('deliberate fixture failure');
    expect(await states()).toEqual(before);
  });
});

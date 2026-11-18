import type { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
import {
  timeLedgerFixtureTriggerSql,
  withTimeLedgerFixtureCleanup,
} from '../setup/time-ledger-fixture-cleanup';
import { PrismaService } from '../../src/database/prisma.service';
import { createD13Fixture } from '../helpers/activity-time-policy.fixture';
import * as testApp from '../setup/test-app';
import * as reset from '../setup/reset-db';
import * as users from '../fixtures/users.fixture';
import { r5CurrentBusinessTableNames } from '../helpers/r5-current-source-pins';

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
  const db = new PrismaClient({ log: [{ level: 'query', emit: 'event' }] });
  const statements: string[] = [];
  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await assertConnectedTestDatabase(db);
    db.$on('query', ({ query }) => statements.push(query));
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const states = () => db.$queryRaw<{ name: string; enabled: string }[]>`
    SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger
    WHERE tgrelid IN ('"ParticipationTimeCutoverBinding"'::regclass, '"ActivityTimeCutoverReceipt"'::regclass,
      '"ParticipationTimeLedgerEntry"'::regclass, '"ParticipationTimeLedgerManifest"'::regclass,
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
    expect(before.filter((row) => /^(ptce|ptcm|ptcr)_no_truncate$/u.test(row.name))).toHaveLength(
      3,
    );
    expect(
      before.filter((row) => /^(cpta|cptae|ctsp|ctab)_no_truncate$/u.test(row.name)),
    ).toHaveLength(4);
    expect(before.filter((row) => /^(atcr|ptcb)_no_truncate$/u.test(row.name))).toHaveLength(2);
    await db.$transaction(
      (tx) =>
        withTimeLedgerFixtureCleanup(tx, async (inner) => {
          expect(inner).toBe(tx);
          await inner.$executeRawUnsafe(
            'TRUNCATE "ActivityContributionPolicySelectionCommandReceipt", "ActivityContributionPolicySelectionItem", "ActivityContributionPolicySelectionRevision", "ParticipationTimeCutoverBinding", "ActivityTimeCutoverReceipt", "CorrectionTimeAllocationBinding", "CorrectionPendingTimeAllocationEvidence", "CorrectionTimeSourceProof", "CorrectionPendingTimeAllocation", "ParticipantSettlementTimeBucketSource", "ParticipantTimeAllocationSlice", "ParticipantTimeAllocationEvidence", "ParticipantTimeAllocationCommandReceipt", "ParticipantTimeAllocationRevision", "ParticipationTimeLedgerEntry", "ParticipationTimeLedgerManifest", "ParticipationTimeCorrectionEntry", "ParticipationTimeCorrectionManifest", "ParticipationTimeCorrectionCommitReceipt" CASCADE',
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

  it('preserves the captured reset roots and FK CASCADE closure without expanding cleanup', async () => {
    statements.length = 0;
    await reset.resetDb({ get: () => db } as unknown as INestApplication);
    const base = statements.find(
      (sql) => sql.startsWith('TRUNCATE TABLE ') && sql.includes('"DictType"'),
    );
    expect(base).toBeDefined();
    const roots = [...base!.matchAll(/"([A-Za-z0-9_]+)"/gu)].map(([, table]) => table);
    expect(roots).toHaveLength(85);
    const closure = await db.$queryRaw<{ name: string }[]>(Prisma.sql`
      WITH RECURSIVE affected(oid) AS (
        SELECT oid FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN (${Prisma.join(roots)})
        UNION
        SELECT fk.conrelid FROM pg_constraint fk JOIN affected a ON fk.confrelid=a.oid
        WHERE fk.contype='f'
      )
      SELECT c.relname AS name FROM affected a JOIN pg_class c ON c.oid=a.oid
      ORDER BY c.relname COLLATE "C"
    `);
    const names = closure.map(({ name }) => name);
    // The old base TRUNCATE reaches 190 tables, not every table in the manifest.
    // Other cleanup phases/caller-owned catalogs must not be silently pulled into it.
    expect(names).toHaveLength(190);
    expect(createHash('sha256').update(names.join('\n')).digest('hex')).toBe(
      '2252cc41e6dcc28d46e5e8f000892165355c88658de4c2eea970f6595bbd469f',
    );
    const approved = new Set(r5CurrentBusinessTableNames());
    expect(names.every((name) => approved.has(name))).toBe(true);
    expect(names).toContain('TeamJoinContributionMilestone');
    expect(closure.some(({ name }) => name === '_prisma_migrations')).toBe(false);
  });

  it.each(['Prisma', 'psql'] as const)(
    'rolls back real TRUNCATE effects and trigger changes after a %s cleanup fault',
    async (path) => {
      const record = await db.dictType.create({
        data: { code: `harness-cleanup-failure-${path}`, label: 'cleanup rollback sentinel' },
      });
      const before = await states();
      const failure = new Error('deliberate failure after real truncate');
      await expect(
        db.$transaction(
          async (tx) => {
            const cleanup = async () => {
              await tx.$executeRawUnsafe('TRUNCATE TABLE "DictType" CASCADE');
              expect(await tx.dictType.count({ where: { id: record.id } })).toBe(0);
              throw failure;
            };
            if (path === 'Prisma') await withTimeLedgerFixtureCleanup(tx, cleanup);
            else {
              await tx.$executeRawUnsafe(timeLedgerFixtureTriggerSql().before);
              await cleanup();
            }
          },
          { timeout: 60_000 },
        ),
      ).rejects.toBe(failure);
      expect(await db.dictType.findUnique({ where: { id: record.id } })).toEqual(record);
      expect(await states()).toEqual(before);
    },
  );

  it.each(
    (['Prisma', 'psql'] as const).flatMap((path) =>
      (['O', 'A', 'R', 'D'] as const).map((enabled) => ({ path, enabled })),
    ),
  )('restores original $enabled trigger state through $path cleanup', async ({ path, enabled }) => {
    const before = await states();
    const failure = new Error('rollback characterization DDL');
    await expect(
      db.$transaction(
        async (tx) => {
          const clause = { O: 'ENABLE', A: 'ENABLE ALWAYS', R: 'ENABLE REPLICA', D: 'DISABLE' }[
            enabled
          ];
          await tx.$executeRawUnsafe(
            `ALTER TABLE "ParticipationTimeLedgerEntry" ${clause} TRIGGER "ptle_no_truncate"`,
          );
          if (path === 'Prisma') {
            await withTimeLedgerFixtureCleanup(tx, async () => undefined);
          } else {
            const sql = timeLedgerFixtureTriggerSql();
            await tx.$executeRawUnsafe(sql.before);
            await tx.$executeRawUnsafe(sql.after);
          }
          const [state] = await tx.$queryRaw<{ enabled: string }[]>`
            SELECT tgenabled::text AS enabled FROM pg_trigger
            WHERE tgrelid='public."ParticipationTimeLedgerEntry"'::regclass
              AND tgname='ptle_no_truncate' AND NOT tgisinternal
          `;
          expect(state.enabled).toBe(enabled);
          throw failure;
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBe(failure);
    expect(await states()).toEqual(before);
  });
});

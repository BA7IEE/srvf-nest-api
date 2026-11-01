import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../database/prisma.service';
import type { HumanCorrectionExecution } from './human-correction-execution.module';
import { HumanCorrectionHttpBoundary } from './human-correction-http-providers';
import {
  assertHumanCorrectionPoolBudget,
  HumanCorrectionRuntimeClient,
} from './human-correction-runtime-client';

const n = 'postgresql://ordinary@unit.invalid/db?connection_limit=4';
const p = 'postgresql://protected@unit.invalid/db?connection_limit=1';
describe('explicit Human client boundary (no database)', () => {
  it('splits the existing five-connection envelope without changing URL or role', () => {
    expect(() => assertHumanCorrectionPoolBudget(n, p)).not.toThrow();
  });
  it.each([
    [n, undefined],
    [n, 'postgresql://protected@unit.invalid/db'],
    [n, p + '&connection_limit=1'],
    [n, p.replace('=1', '=2')],
    [n, p.replace('/db?', '/other?')],
    [n, p.replace('unit.invalid', 'other.invalid')],
    [n, p.replace('protected', 'ordinary')],
  ])('rejects missing/ambiguous/unbounded or shared connection inputs %#', (normal, human) => {
    expect(() => assertHumanCorrectionPoolBudget(normal, human)).toThrow();
  });

  it('suppresses both connect and cleanup exception payloads', async () => {
    const client = new HumanCorrectionRuntimeClient(p);
    jest.spyOn(client, '$connect').mockRejectedValue(new Error('private connection detail'));
    jest.spyOn(client, '$disconnect').mockRejectedValue(new Error('private cleanup detail'));
    await expect(client.onModuleInit()).rejects.toThrow('CONNECT_CLEANUP');
    await expect(client.onModuleInit()).rejects.not.toThrow('private');
  });

  function boundary(rows: unknown, cleanupFails = false) {
    const tx = {
      $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>().mockResolvedValue(0),
      $queryRaw: jest
        .fn<Promise<unknown>, [TemplateStringsArray, ...unknown[]]>()
        .mockResolvedValue(rows),
    };
    const transaction = jest.fn(async (body: (tx: unknown) => Promise<void>) => body(tx));
    const ordinary = { $transaction: transaction } as unknown as PrismaService;
    const disconnect = cleanupFails
      ? jest.fn().mockRejectedValue(new Error('private cleanup detail'))
      : jest.fn().mockResolvedValue(undefined);
    const client = { $disconnect: disconnect } as unknown as PrismaService;
    const config = new ConfigService({ database: { url: n, humanCorrectionUrl: p } });
    const guard = new HumanCorrectionHttpBoundary(ordinary, config, {
      client,
      database: { name: 'unit-db', oid: 1 },
    } as HumanCorrectionExecution);
    return { guard, transaction, tx, disconnect };
  }
  it('does no admission SQL when the feature is off', async () => {
    const f = boundary([]);
    await new HumanCorrectionHttpBoundary(
      { $transaction: f.transaction } as unknown as PrismaService,
      new ConfigService(),
      null,
    ).onModuleInit();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('uses a read-only ordinary transaction to check both effective and reset identities', async () => {
    const f = boundary([{ safe: true }]);
    await f.guard.onModuleInit();
    expect(f.tx.$executeRaw.mock.calls[0][0].join('')).toBe('SET TRANSACTION READ ONLY');
    const sql = f.tx.$queryRaw.mock.calls[0][0].join('');
    expect(sql).toContain('session_user');
    expect(sql).toContain('current_user');
    expect(sql).toContain('has_any_column_privilege');
    expect(sql).toContain("'SET'");
    expect(sql).toContain('m.admin_option');
    expect(sql).toContain('relowner');
    expect(sql).toContain('datdba');
    expect(sql).toContain('has_schema_privilege');
    expect(f.disconnect).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    { rows: [{ safe: false }] },
    { rows: [{ safe: true }, { safe: true }] },
    { rows: [{ safe: null }] },
  ])('fails closed on unproved ordinary authority %#', async ({ rows }) => {
    const f = boundary(rows);
    await expect(f.guard.onModuleInit()).rejects.toThrow('ORDINARY_ITEM_AUTHORITY');
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });
  it('does not leak a failed ordinary-boundary cleanup exception', async () => {
    const f = boundary([{ safe: false }], true);
    await expect(f.guard.onModuleInit()).rejects.toThrow('ORDINARY_BOUNDARY_CLEANUP');
  });
  it('refuses a third lazy shadow client before any connection starts', () => {
    const config = new ConfigService({
      database: { url: n, humanCorrectionUrl: p },
      app: { contributionShadowMode: 'shadow' },
    });
    expect(
      () =>
        new HumanCorrectionHttpBoundary({} as PrismaService, config, {
          client: {},
        } as HumanCorrectionExecution),
    ).toThrow('UNBUDGETED_SHADOW_CLIENT');
  });
});

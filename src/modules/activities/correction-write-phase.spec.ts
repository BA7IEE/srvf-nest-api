import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  beginCorrectionWritePhase,
  materializeCorrectionWritePhase,
  sealCorrectionWritePhase,
} from './correction-write-phase';

const receipt = (phase: 'prepare' | 'commit', state: 'OPEN' | 'SEALED') => ({
  applicationId: 'application',
  phase,
  state,
  batchId: 'batch',
  protocolVersion: 1,
});

describe('controlled correction materialization receipt', () => {
  const materialized = {
    application_id: 'application',
    batch_id: 'batch',
    source_count: 10000,
    segment_count: 1000,
    allocation_count: 1000,
    slice_count: 5000,
    evidence_count: 0,
    receipt_count: 1000,
    binding_count: 10000,
    state: 'MATERIALIZED',
  };
  const run = (query: jest.Mock) =>
    materializeCorrectionWritePhase(client(query), 'application', 'actor', 'batch', 1000);

  it('binds the authenticated service actor and application as SQL parameters', async () => {
    const query = jest.fn().mockResolvedValue([materialized]);
    await expect(run(query)).resolves.toBe(1000);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, app, actor] = query.mock.calls[0] as [TemplateStringsArray, string, string];
    expect(sql.join('?')).toContain('public.r5_correction_materialize_phase(');
    expect([app, actor]).toEqual(['application', 'actor']);
  });

  it.each([
    ['different locked batch', { batch_id: 'another-batch' }],
    ['different application', { application_id: 'another-application' }],
    ['different approved delta', { segment_count: 999, allocation_count: 999, receipt_count: 999 }],
    ['N below delta', { source_count: 999, binding_count: 999 }],
    ['missing binding', { binding_count: 9999 }],
    ['missing allocation', { allocation_count: 999 }],
    ['missing receipt', { receipt_count: 999 }],
    ['negative slices', { slice_count: -1 }],
    ['fractional evidence', { evidence_count: 0.5 }],
    ['string count', { segment_count: '1000' }],
    ['unmaterialized phase', { state: 'OPEN' }],
  ])('rejects %s without retry', async (_label, changes) => {
    const query = jest.fn().mockResolvedValue([{ ...materialized, ...changes }]);
    await expect(run(query)).rejects.toMatchObject({ biz: BizCode.CORRECTION_CHANGE_SET_INVALID });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([[], [materialized, materialized], [null], null, undefined].map((rows) => ({ rows })))(
    'rejects invalid receipt cardinality %j',
    async ({ rows }) => {
      await expect(run(jest.fn().mockResolvedValue(rows))).rejects.toMatchObject({
        biz: BizCode.CORRECTION_CHANGE_SET_INVALID,
      });
    },
  );

  it.each([
    ['P5B01', BizCode.CORRECTION_BASE_VERSION_CHANGED],
    ['P5C01', BizCode.CORRECTION_CHANGE_SET_INVALID],
  ])('maps only known Prisma P2010/%s', async (sqlstate, biz) => {
    const failure = new Prisma.PrismaClientKnownRequestError('original SQL detail', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: sqlstate },
    });
    await expect(run(jest.fn().mockRejectedValue(failure))).rejects.toMatchObject({ biz });
  });

  it.each(['23514', '42501', '55000', '40P01', '57014'])(
    'preserves P2010/%s verbatim',
    async (sqlstate) => {
      const failure = new Prisma.PrismaClientKnownRequestError('original SQL detail', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: sqlstate },
      });
      const query = jest.fn().mockRejectedValue(failure);
      await expect(run(query)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates P2028 without treating the database outcome as rollback', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError('outcome must be read', {
      code: 'P2028',
      clientVersion: 'test',
    });
    const query = jest.fn().mockRejectedValue(failure);
    await expect(run(query)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not map a plain object impersonating a Prisma error', async () => {
    const failure = { code: 'P2010', meta: { code: 'P5C01' } };
    await expect(run(jest.fn().mockRejectedValue(failure))).rejects.toBe(failure);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected delta %s before SQL',
    async (count) => {
      const query = jest.fn();
      await expect(
        materializeCorrectionWritePhase(client(query), 'application', 'actor', 'batch', count),
      ).rejects.toMatchObject({ biz: BizCode.CORRECTION_CHANGE_SET_INVALID });
      expect(query).not.toHaveBeenCalled();
    },
  );
});
const client = (query: jest.Mock) => ({ $queryRaw: query }) as unknown as Prisma.TransactionClient;

describe('correction database phase boundary', () => {
  it.each(['prepare', 'commit'] as const)(
    'binds %s values without SQL concatenation',
    async (phase) => {
      const applicationId = "application'); DROP TABLE anything; --";
      const query = jest.fn().mockResolvedValue([{ ...receipt(phase, 'OPEN'), applicationId }]);
      await beginCorrectionWritePhase(client(query), applicationId, phase);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, boundId, boundPhase] = query.mock.calls[0] as [
        TemplateStringsArray,
        string,
        string,
      ];
      expect(sql.join('?')).toContain('public.r5_correction_begin_phase(?::text, ?::text)');
      expect(sql.join('')).not.toContain(applicationId);
      expect([boundId, boundPhase]).toEqual([applicationId, phase]);
    },
  );

  it.each(['prepare', 'commit'] as const)(
    'requires a database SEALED receipt for %s',
    async (phase) => {
      const query = jest.fn().mockResolvedValue([receipt(phase, 'SEALED')]);
      await expect(
        sealCorrectionWritePhase(client(query), 'application', phase),
      ).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      const [sql] = query.mock.calls[0] as [TemplateStringsArray, string, string];
      expect(sql.join('')).toContain('public.r5_correction_seal_phase');
    },
  );

  it.each(
    [
      [],
      [receipt('prepare', 'OPEN'), receipt('prepare', 'OPEN')],
      [{ ...receipt('prepare', 'OPEN'), applicationId: 'other' }],
      [receipt('commit', 'OPEN')],
      [receipt('prepare', 'SEALED')],
      [{ ...receipt('prepare', 'OPEN'), protocolVersion: 0 }],
      [{ ...receipt('prepare', 'OPEN'), protocolVersion: '1' }],
      [{ ...receipt('prepare', 'OPEN'), batchId: '' }],
      [{ ...receipt('prepare', 'OPEN'), batchId: null }],
    ].map((rows) => ({ rows })),
  )('rejects a missing, mismatched or incompatible database receipt: %j', async ({ rows }) => {
    await expect(
      beginCorrectionWritePhase(
        client(jest.fn().mockResolvedValue(rows)),
        'application',
        'prepare',
      ),
    ).rejects.toThrow();
  });

  it('does not accept OPEN as a successful seal', async () => {
    await expect(
      sealCorrectionWritePhase(
        client(jest.fn().mockResolvedValue([receipt('commit', 'OPEN')])),
        'application',
        'commit',
      ),
    ).rejects.toThrow();
  });

  it.each(['missing function', 'role precondition', 'deferred check'])(
    'preserves %s failure without retry or fallback',
    async (message) => {
      const failure = new Error(message);
      const query = jest.fn().mockRejectedValue(failure);
      await expect(beginCorrectionWritePhase(client(query), 'application', 'prepare')).rejects.toBe(
        failure,
      );
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
});

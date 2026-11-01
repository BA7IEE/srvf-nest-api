import { installR5MainPrepareProfile } from './r5-main-prepare-profile';

// Synthetic observer/transaction model. These tests prove the instrumentation
// preserves its originals; they are NOT native SQL or database outcome proof.
function model(failure?: Error, flushFails = false) {
  const order: string[] = [];
  const options = { timeout: 60000, maxWait: 2000, isolationLevel: 'ReadCommitted' };
  const engine = {
    transaction: async (phase: string) => {
      order.push('engine/' + phase);
    },
  };
  const identity = {
    database: 'app_test_r5_setmat_20261029_q1',
    databaseOid: 1998913,
    pid: 11,
    xid: '99',
    role: 'actual-original-role',
    sessionUser: 'actual-login',
  };
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => {
      order.push('query');
      return sql.join('').includes('pg_current_xact_id_if_assigned') ? [{ identity }] : [];
    },
    $executeRaw: async (_sql: TemplateStringsArray, ..._values: unknown[]) => {
      void _sql;
      void _values;
      order.push('execute');
      if (failure) throw failure;
      return 1;
    },
    activitySettlementContributionRevision: {
      create: async (input: unknown) => {
        order.push('create');
        return input;
      },
    },
  };
  const prisma = {
    _engine: engine,
    $transaction: async <T>(body: (value: typeof tx) => Promise<T>, opts: unknown) => {
      expect(opts).toBe(options);
      await engine.transaction('start');
      try {
        const value = await body(tx);
        await engine.transaction('commit');
        return value;
      } catch (error) {
        await engine.transaction('rollback');
        throw error;
      }
    },
  };
  const noop = async () => {};
  const contributionQueries = {
    readTimeEvaluationInTx: noop,
    readTimePolicySelectionInTx: noop,
    readFrozenPoliciesInTx: noop,
  };
  const access = { authorize: noop },
    audit = { log: noop };
  const contributions = {
    assertNewNativeActivityInTx: noop,
    prepareTimeInTx: noop,
    async insertEvaluations(t: typeof tx, _root: unknown, rows: unknown[]) {
      const json = JSON.stringify(rows);
      await t.$executeRaw`INSERT INTO "ParticipantContributionEvaluation" SELECT * FROM jsonb_to_recordset(${json}::jsonb)`;
    },
  };
  const timeQueries = { readDraftContextInTx: noop, readSourceSetInTx: noop, evaluateInTx: noop };
  const timeSettlement = {
    lockedProof: async (_t: typeof tx) => {
      void _t;
      order.push('lockedProof');
    },
    lockedSources: noop,
    insertBuckets: noop,
    receipt: noop,
    async write() {
      return await prisma.$transaction(async (t) => {
        await this.lockedProof(t);
        await contributionQueries.readTimeEvaluationInTx();
        await t.activitySettlementContributionRevision.create({ only: 'not-exported' });
        await contributions.insertEvaluations(t, {}, [{ sensitive: 'never-export-this-value' }]);
        await audit.log();
        return 'native-result';
      }, options);
    },
    async prepare(_activity: string) {
      void _activity;
      return await this.write();
    },
  };
  const persisted: unknown[] = [];
  const observe = jest.fn(async (id: unknown) => ({
    synthetic: true,
    identity: id,
    database: identity.database,
    databaseOid: identity.databaseOid,
    cluster: '7695840193603043362',
    xid: identity.xid,
    status: failure ? 'aborted' : 'committed',
    observerPid: 12,
  }));
  const hook = installR5MainPrepareProfile(
    { prisma, timeSettlement, timeQueries, contributions, contributionQueries, access, audit },
    {
      activityId: 'new-source',
      observeOutcome: observe,
      persist: (value) => {
        if (flushFails) throw new Error('diagnostic sink failed');
        persisted.push(value);
        return '/synthetic/profile.json';
      },
    },
  );
  return { prisma, tx, timeSettlement, hook, order, persisted, observe, identity };
}
describe('MAIN_PREPARE profiling instrumentation (NO DATABASE)', () => {
  it('preserves the native receiver, result, 60s options and call order', async () => {
    const f = model();
    try {
      expect(await f.timeSettlement.prepare('new-source')).toBe('native-result');
      expect(f.order).toEqual([
        'engine/start',
        'query',
        'lockedProof',
        'create',
        'execute',
        'engine/commit',
      ]);
      const s = f.hook.snapshot();
      expect(s.transactions).toHaveLength(1);
      expect(s.transactions[0].options.timeout).toBe(60000);
      expect(s.transactions[0].callback).toBe('FULFILLED');
      expect(s.transactions[0].transactionPromise).toBe('FULFILLED');
      expect(s.complete).toBe(true);
    } finally {
      f.hook.restore();
    }
  });
  it('keeps the exact native error while recording rollback separately', async () => {
    const error = Object.assign(new Error('native failure'), { code: 'P2028' }),
      f = model(error);
    try {
      await expect(f.timeSettlement.prepare('new-source')).rejects.toBe(error);
      const s = f.hook.snapshot();
      expect(s.transactions[0].callback).toBe('REJECTED');
      expect(s.transactions[0].transactionPromise).toBe('REJECTED');
      expect(f.order.at(-1)).toBe('engine/rollback');
      expect(f.observe).toHaveBeenCalledWith(f.identity);
    } finally {
      f.hook.restore();
    }
  });
  it('captures JSON byte count and the pre-SQL gap without copying arguments or rows', async () => {
    const f = model();
    try {
      await f.timeSettlement.prepare('new-source');
      const s = f.hook.snapshot();
      const insert = s.spans.find((x) => x.label === 'E4/insertEvaluations');
      expect(insert?.details?.evaluationCount).toBe(1);
      expect(insert?.details?.preSqlGapMs).toEqual(expect.any(Number));
      expect(
        s.spans.find((x) => x.details?.evaluationInsert)?.details?.serializedEvaluationBytes,
      ).toBeGreaterThan(0);
      expect(JSON.stringify(s)).not.toContain('never-export-this-value');
      expect(JSON.stringify(s)).not.toContain('not-exported');
    } finally {
      f.hook.restore();
    }
  });
  it('keeps unrelated activity requests unprofiled', async () => {
    const f = model();
    try {
      await f.timeSettlement.prepare('another-activity');
      expect(f.hook.snapshot().consumed).toBe(false);
      expect(f.persisted).toHaveLength(0);
      expect(f.observe).not.toHaveBeenCalled();
    } finally {
      f.hook.restore();
    }
  });
  it('does not convert a diagnostic sink failure into native failure', async () => {
    const f = model(undefined, true);
    try {
      await expect(f.timeSettlement.prepare('new-source')).resolves.toBe('native-result');
      expect(f.hook.snapshot().complete).toBe(false);
    } finally {
      f.hook.restore();
    }
  });
  it('does not overwrite a native error with a diagnostic sink failure', async () => {
    const error = new Error('native failure'),
      f = model(error, true);
    try {
      await expect(f.timeSettlement.prepare('new-source')).rejects.toBe(error);
      expect(f.hook.snapshot().complete).toBe(false);
    } finally {
      f.hook.restore();
    }
  });
  it('reports bounded spans with explicit logical-query coverage and no server-time inference', async () => {
    const f = model();
    try {
      await f.timeSettlement.prepare('new-source');
      const s = f.hook.snapshot();
      expect(s.coverage.nativeBudgetChanged).toBe(false);
      expect(s.coverage.fixtureCreated).toBe(false);
      expect(s.coverage.orm).toContain('not physical SQL count');
      expect(
        s.spans.some((x) => x.label === 'ORM/activitySettlementContributionRevision.create'),
      ).toBe(true);
      for (const span of s.spans) expect(span.exclusiveWallMs).toBeGreaterThanOrEqual(0);
    } finally {
      f.hook.restore();
    }
  });
  it('cannot claim complete observation when the independent server probe fails', async () => {
    const f = model();
    f.observe.mockRejectedValueOnce(new Error('independent observation unavailable'));
    try {
      await expect(f.timeSettlement.prepare('new-source')).resolves.toBe('native-result');
      expect(f.hook.snapshot().complete).toBe(false);
    } finally {
      f.hook.restore();
    }
  });
  it('refuses to restore method descriptors while the native transaction is pending', async () => {
    const f = model();
    const pending = f.timeSettlement.prepare('new-source');
    expect(() => f.hook.restore()).toThrow('still active');
    try {
      await expect(pending).resolves.toBe('native-result');
    } finally {
      f.hook.restore();
    }
  });
});
